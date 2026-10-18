#!/usr/bin/env python3
"""Build the public browser-local review bundle using only the Python stdlib.

The real server entry stays in static/index.html. Only this generated dist entry
loads the explicit preview mode and local adapter. No database, server source,
tests, reports, or repository metadata belong in the output.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
RUNTIME_FILES = ("app.js", "styles.css", "theme.js", "onstage-mark.svg")
MARKER = "onstage-browser-local-preview"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checked_copy(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_file() or not source.stat().st_size:
        raise RuntimeError(f"Refusing missing, empty, or symlinked runtime file: {source.relative_to(PROJECT)}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def build(output: Path) -> dict:
    output = output.resolve()
    if output.parent != PROJECT or not re.fullmatch(r"dist(?:-[a-zA-Z0-9_-]+)?", output.name):
        raise RuntimeError("Output must be a dist or dist-NAME directory directly inside this checkout.")
    if output.exists():
        marker = output / "preview" / "build.json"
        if output.is_symlink() or not output.is_dir() or not marker.is_file():
            raise RuntimeError("Refusing to replace an output directory without this builder's marker.")
        try:
            previous = json.loads(marker.read_text(encoding="utf-8"))
        except (ValueError, OSError) as exc:
            raise RuntimeError("The existing output marker is unreadable; no files were replaced.") from exc
        if previous.get("mode") != MARKER:
            raise RuntimeError("Refusing to replace output produced by another tool.")

    version = (PROJECT / "VERSION").read_text(encoding="utf-8").strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9._-]+)?", version):
        raise RuntimeError("VERSION must contain a release version, not executable code.")
    directory = json.loads((PROJECT / "app" / "catalog.json").read_text(encoding="utf-8"))
    for group in ("bands", "characters", "scenarios", "stickers"):
        if not isinstance(directory.get(group), list):
            raise RuntimeError(f"Missing catalog list: {group}")
        for item in directory[group]:
            for field in ("image", "avatar_image", "detail_image"):
                path = item.get(field)
                if path is None:
                    continue
                if not isinstance(path, str) or not path.startswith("/static/assets/") or any(part in ("", ".", "..") for part in path[1:].split("/")):
                    raise RuntimeError(f"Unexpected public asset path in {group}: {field}")
                asset = PROJECT / path.lstrip("/")
                if asset.is_symlink() or not asset.is_file() or not asset.stat().st_size:
                    raise RuntimeError(f"Catalog asset is unavailable: {path}")

    staging = Path(tempfile.mkdtemp(prefix=f".{output.name}-staging-", dir=PROJECT))
    backup = None
    try:
        for name in RUNTIME_FILES:
            checked_copy(PROJECT / "static" / name, staging / "static" / name)
        asset_count = 0
        # Keep every runtime asset, including older immutable sticker image paths.
        for source in sorted((PROJECT / "static" / "assets").rglob("*")):
            if source.is_symlink():
                raise RuntimeError("Symlinks cannot enter the public asset bundle.")
            if source.is_file():
                if source.suffix.lower() not in {".png", ".webp", ".jpg", ".jpeg", ".gif", ".svg"}:
                    raise RuntimeError(f"Unexpected non-image runtime asset: {source.relative_to(PROJECT)}")
                checked_copy(source, staging / source.relative_to(PROJECT))
                asset_count += 1
        checked_copy(PROJECT / "preview" / "adapter.js", staging / "preview" / "adapter.js")
        (staging / "preview" / "catalog.json").write_text(json.dumps(directory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        mode = {"enabled": True, "version": version, "catalogUrl": "/preview/catalog.json"}
        (staging / "preview" / "mode.js").write_text(
            "/* Generated public review mode. Absent from the production entry. */\n"
            + "window.OnstagePreviewConfig = Object.freeze(" + json.dumps(mode, ensure_ascii=False) + ");\n",
            encoding="utf-8",
        )
        html = (PROJECT / "static" / "index.html").read_text(encoding="utf-8")
        app_entry = '<script src="/static/app.js" defer></script>'
        if html.count(app_entry) != 1 or "/preview/adapter.js" in html or "/preview/mode.js" in html:
            raise RuntimeError("The shared production entry must contain one app script and no preview scripts.")
        html = html.replace(app_entry,
            '<script src="/preview/mode.js" defer></script>\n'
            '  <script src="/preview/adapter.js" defer></script>\n  ' + app_entry)
        html = html.replace('<html lang="zh-CN"', '<html data-onstage-mode="preview" lang="zh-CN"', 1)
        html = re.sub(r"<title>.*?</title>", "<title>上皮 ONSTAGE · 界面评审</title>", html, count=1)
        html = re.sub(r'<meta name="description" content="[^"]*">',
            '<meta name="description" content="少女乐队场景、角色与贴纸的离线界面评审。此产物只在当前浏览器留存记录；真实多人使用单独部署的同源服务。">', html, count=1)
        (staging / "index.html").write_text(html, encoding="utf-8")
        files = [{"path": path.relative_to(staging).as_posix(), "bytes": path.stat().st_size, "sha256": sha256(path)} for path in sorted(staging.rglob("*")) if path.is_file()]
        manifest = {
            "mode": MARKER, "version": version,
            "built_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "storage": "browser-local; no shared backend or moderator delivery",
            "catalog_counts": {key: len(directory[key]) for key in ("bands", "characters", "scenarios", "stickers")},
            "default_stickers": sum(item.get("source_pack") == "user-v04" for item in directory["stickers"]),
            "image_assets": asset_count, "files": files,
        }
        (staging / "preview" / "build.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        if output.exists():
            backup = Path(tempfile.mkdtemp(prefix=f".{output.name}-previous-", dir=PROJECT))
            backup.rmdir()
            output.rename(backup)
        try:
            staging.rename(output)
        except BaseException:
            if backup is not None and not output.exists():
                backup.rename(output)
            raise
        if backup is not None:
            shutil.rmtree(backup)
        return {"output": str(output), "version": version, "mode": MARKER, "catalog_counts": manifest["catalog_counts"], "default_stickers": manifest["default_stickers"], "image_assets": asset_count, "files": len(files) + 1}
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="dist-offline-review", help="dist or dist-NAME, directly inside this checkout; defaults away from the live Worker build")
    args = parser.parse_args()
    output = Path(args.output)
    if not output.is_absolute():
        output = PROJECT / output
    print(json.dumps(build(output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
