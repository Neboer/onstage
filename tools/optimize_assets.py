"""Build or verify committed, strictly lossless artwork delivery variants.

Runtime deployments use the committed files and need neither Pillow nor cwebp.
Authoring: pip install -r requirements-assets.txt
  python tools/optimize_assets.py build --cwebp /path/to/cwebp
  python tools/optimize_assets.py verify --pixels
Normal CI can verify SHA identities without the optional image dependencies:
  python tools/optimize_assets.py verify

Original artwork and its source/rights manifest are never rewritten. This tool
only writes the dedicated optimized directory and delivery manifest. cwebp is
an external, official libwebp authoring tool, deliberately not bundled here.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE_MANIFEST = "docs/ASSET_MANIFEST.json"
DELIVERY_MANIFEST = "static/assets-manifest.json"
OUTPUT = "static/assets/optimized"
STANDARD_CHROMATICITY = (.3127, .329, .64, .33, .3, .6, .15, .06)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def local_file(root: Path, relative: str) -> Path:
    """Never follow an untrusted manifest path outside the repository."""
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"Asset path escapes repository: {relative}")
    return path


def compare_pixels(original: Path, candidate: Path) -> tuple[int, int]:
    from PIL import Image

    with Image.open(original) as before, Image.open(candidate) as after:
        if before.size != after.size or before.convert("RGBA").tobytes() != after.convert("RGBA").tobytes():
            raise ValueError(f"RGBA pixels changed: {original.name}")
        if before.info.get("icc_profile") != after.info.get("icc_profile"):
            raise ValueError(f"ICC profile changed: {original.name}")
        # WebP stores ICC rather than PNG's independent gAMA/cHRM chunks.
        # Without an ICC profile, only known sRGB metadata may be translated.
        if not before.info.get("icc_profile"):
            chroma = before.info.get("chromaticity")
            if chroma and any(abs(a - b) > .00002 for a, b in zip(chroma, STANDARD_CHROMATICITY)):
                raise ValueError(f"Non-sRGB PNG chromaticity needs manual review: {original.name}")
            gamma = before.info.get("gamma")
            if gamma is not None and abs(gamma - .45455) > .00002:
                raise ValueError(f"Non-sRGB PNG gamma needs manual review: {original.name}")
        return before.size


def read_sources(root: Path) -> list[dict]:
    source = json.loads(local_file(root, SOURCE_MANIFEST).read_text(encoding="utf-8"))
    rows = source["assets"]
    if len(rows) != source["asset_count"] or len({r["web_url"] for r in rows}) != len(rows):
        raise ValueError("Source artwork manifest count/URLs are inconsistent")
    return sorted(rows, key=lambda row: row["web_url"])


def source_bytes(root: Path, row: dict) -> bytes:
    data = local_file(root, row["path"]).read_bytes()
    if sha256(data) != row["sha256"] or len(data) != row["bytes"]:
        raise ValueError(f"Original artwork identity changed: {row['path']}")
    if row["web_url"] != "/" + row["path"]:
        raise ValueError("Source URL does not match source path")
    return data


def build(root: Path, encoder: str) -> dict:
    from PIL import Image, __version__ as pillow_version

    version = subprocess.run([encoder, "-version"], check=True, capture_output=True, text=True, timeout=10).stdout.strip()
    rows = read_sources(root)
    # Prepare/validate everything before touching committed output.
    with tempfile.TemporaryDirectory(prefix="onstage-lossless-") as temp:
        temp_path = Path(temp)

        def convert(item: tuple[int, dict]) -> tuple[str, dict, bytes]:
            index, row = item
            original_data = source_bytes(root, row)
            original = local_file(root, row["path"])
            chosen = original_data
            optimized = False
            if original.suffix.lower() == ".png":
                candidate = temp_path / f"{index}.webp"
                subprocess.run([encoder, "-quiet", "-lossless", "-z", "6", "-exact", "-metadata", "all", str(original), "-o", str(candidate)], check=True, capture_output=True, timeout=90)
                compare_pixels(original, candidate)
                candidate_data = candidate.read_bytes()
                if len(candidate_data) < len(original_data):
                    chosen, optimized = candidate_data, True
            with Image.open(original) as image:
                width, height = image.size
            extension = ".webp" if optimized else original.suffix.lower()
            digest = sha256(chosen)
            info = {
                "url": f"/{OUTPUT}/{digest}{extension}",
                "sha256": digest, "bytes": len(chosen), "width": width, "height": height,
                "mime": "image/webp" if extension == ".webp" else "image/png",
                "original_sha256": row["sha256"], "original_bytes": len(original_data),
                "optimized": optimized, "source_manifest": SOURCE_MANIFEST, "source_path": row["path"],
            }
            return row["web_url"], info, chosen

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(convert, enumerate(rows)))
        assets = {url: info for url, info, _ in results}
        manifest = {
            "schema_version": 1,
            "source_manifest": SOURCE_MANIFEST,
            "source_manifest_sha256": sha256(local_file(root, SOURCE_MANIFEST).read_bytes()),
            "rights_note": "Original sources and rights credits remain in docs/ASSET_MANIFEST.json; optimization grants no additional license.",
            "encoding": {"tool": "cwebp", "version": version, "arguments": ["-lossless", "-z", "6", "-exact", "-metadata", "all"], "pillow_verifier": pillow_version, "rgba_and_icc_verified": True, "browser_color_verified": False},
            "totals": {"asset_count": len(assets), "optimized_count": sum(v["optimized"] for v in assets.values()), "original_bytes": sum(v["original_bytes"] for v in assets.values()), "transfer_bytes": sum(v["bytes"] for v in assets.values())},
            "assets": assets,
        }
        output = local_file(root, OUTPUT)
        output.mkdir(parents=True, exist_ok=True)
        for _, info, data in results:
            local_file(root, info["url"].lstrip("/")).write_bytes(data)
        local_file(root, DELIVERY_MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
        # Do not delete older content hashes: clients may still use an old manifest.
        return manifest["totals"]


def verify(root: Path, pixels: bool = False) -> dict:
    manifest = json.loads(local_file(root, DELIVERY_MANIFEST).read_text(encoding="utf-8"))
    if manifest["schema_version"] != 1:
        raise ValueError("Unsupported delivery manifest schema")
    if manifest["source_manifest_sha256"] != sha256(local_file(root, SOURCE_MANIFEST).read_bytes()):
        raise ValueError("Source/rights manifest changed; rebuild delivery manifest")
    rows = read_sources(root)
    if set(manifest["assets"]) != {row["web_url"] for row in rows}:
        raise ValueError("Delivery manifest does not cover exactly the original artwork")
    totals = {"asset_count": len(rows), "optimized_count": 0, "original_bytes": 0, "transfer_bytes": 0}
    for row in rows:
        original = source_bytes(root, row)
        info = manifest["assets"][row["web_url"]]
        expected_suffix = ".webp" if info["optimized"] else Path(row["path"]).suffix.lower()
        expected_url = f"/{OUTPUT}/{info['sha256']}{expected_suffix}"
        if info["url"] != expected_url or info["source_path"] != row["path"] or info["source_manifest"] != SOURCE_MANIFEST:
            raise ValueError(f"Invalid content-addressed mapping: {row['path']}")
        derived = local_file(root, info["url"].lstrip("/"))
        data = derived.read_bytes()
        if sha256(data) != info["sha256"] or len(data) != info["bytes"]:
            raise ValueError(f"Delivery artwork identity changed: {derived.name}")
        if info["original_sha256"] != row["sha256"] or info["original_bytes"] != len(original):
            raise ValueError(f"Original mapping changed: {row['path']}")
        if info["width"] != row["width"] or info["height"] != row["height"]:
            raise ValueError(f"Dimensions changed: {row['path']}")
        if info["mime"] != ("image/webp" if expected_suffix == ".webp" else "image/png"):
            raise ValueError(f"Incorrect media type: {row['path']}")
        if info["optimized"] and (not row["path"].endswith(".png") or len(data) >= len(original)):
            raise ValueError(f"Invalid optimized variant: {row['path']}")
        if not info["optimized"] and data != original:
            raise ValueError(f"Retained original changed: {row['path']}")
        if pixels:
            compare_pixels(local_file(root, row["path"]), derived)
        totals["optimized_count"] += int(info["optimized"])
        totals["original_bytes"] += len(original)
        totals["transfer_bytes"] += len(data)
    if totals != manifest["totals"]:
        raise ValueError("Manifest totals do not match artwork")
    return totals


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["build", "verify"])
    parser.add_argument("--cwebp", default="cwebp", help="Official libwebp cwebp executable (build only)")
    parser.add_argument("--pixels", action="store_true", help="Decode every original and variant and compare full RGBA/ICC (requires Pillow)")
    args = parser.parse_args()
    totals = build(ROOT, args.cwebp) if args.command == "build" else verify(ROOT, args.pixels)
    print(json.dumps({"status": "verified" if args.command == "verify" else "built", **totals}, indent=2))


if __name__ == "__main__":
    main()
