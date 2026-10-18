"""Delivery identities protect originals, historical URLs and cached variants."""
import base64
import json
from pathlib import Path

import pytest

from tools.optimize_assets import ROOT, SOURCE_MANIFEST, verify, sha256


def sample(root: Path) -> dict:
    image = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==")
    original = "static/assets/stickers/original.png"
    target = f"static/assets/optimized/{sha256(image)}.png"
    source = {"asset_count": 1, "assets": [{"path": original, "web_url": "/" + original, "width": 1, "height": 1, "sha256": sha256(image), "bytes": len(image)}]}
    for relative in (original, target):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(image)
    source_path = root / SOURCE_MANIFEST
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_text(json.dumps(source), encoding="utf-8")
    totals = {"asset_count": 1, "optimized_count": 0, "original_bytes": len(image), "transfer_bytes": len(image)}
    manifest = {"schema_version": 1, "source_manifest_sha256": sha256(source_path.read_bytes()), "totals": totals, "assets": {"/" + original: {"url": "/" + target, "sha256": sha256(image), "bytes": len(image), "width": 1, "height": 1, "mime": "image/png", "original_sha256": sha256(image), "original_bytes": len(image), "optimized": False, "source_manifest": SOURCE_MANIFEST, "source_path": original}}}
    save(root, manifest)
    return manifest


def save(root: Path, manifest: dict) -> None:
    (root / "static/assets-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


def test_all_committed_assets_have_verified_historical_mapping():
    totals = verify(ROOT)
    assert totals["asset_count"] == 185
    assert totals["optimized_count"] == 163
    assert totals["transfer_bytes"] < totals["original_bytes"]


def test_retained_original_and_digest_are_verified(tmp_path):
    manifest = sample(tmp_path)
    assert verify(tmp_path) == manifest["totals"]
    info = next(iter(manifest["assets"].values()))
    (tmp_path / info["url"].lstrip("/")).write_bytes(b"corrupt download")
    with pytest.raises(ValueError, match="Delivery artwork identity changed"):
        verify(tmp_path)


def test_source_cannot_silently_be_replaced(tmp_path):
    sample(tmp_path)
    (tmp_path / "static/assets/stickers/original.png").write_bytes(b"replaced original")
    with pytest.raises(ValueError, match="Original artwork identity changed"):
        verify(tmp_path)


@pytest.mark.parametrize("change", ["outside", "missing", "total"])
def test_mapping_rejects_unsafe_or_incomplete_manifest(tmp_path, change):
    manifest = sample(tmp_path)
    if change == "outside":
        next(iter(manifest["assets"].values()))["url"] = "/../../secret.png"
    elif change == "missing":
        manifest["assets"].clear()
    else:
        manifest["totals"]["transfer_bytes"] = 0
    save(tmp_path, manifest)
    with pytest.raises(ValueError):
        verify(tmp_path)
