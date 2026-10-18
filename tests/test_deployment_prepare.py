"""Offline checks of review-bundle invariants, injection rejection and no-overwrite behavior."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys

import pytest

from tools import prepare_deployment as deployment


ROOT = Path(__file__).resolve().parents[1]


def environment(path):
    return dict(line.split("=", 1) for line in path.read_text().splitlines()
                if line and not line.startswith("#"))


def test_nginx_bundle_keeps_production_invariants_and_never_reads_tls_or_connects(tmp_path, monkeypatch):
    def no_external(*args, **kwargs):
        raise AssertionError("Preparation must not invoke another process or connect to a host")

    monkeypatch.setattr(socket, "create_connection", no_external)
    monkeypatch.setattr(subprocess, "run", no_external)
    monkeypatch.setattr(subprocess, "Popen", no_external)
    output = tmp_path / "nginx-review"
    cert = "/target-only/onstage-certs/fullchain.pem"
    key = "/target-only/onstage-certs/private.key"
    result = deployment.prepare("HTTPS://Onstage.Example.ORG:443", "nginx", output,
                                tls_cert=cert, tls_key=key)
    assert result["origin"] == "https://onstage.example.org"
    assert set(result["files"]) == {"onstage.service", "onstage.env", "nginx-onstage.conf", "deployment-plan.json"}
    assert (output / "onstage.service").read_bytes() == (ROOT / "deploy/onstage.service").read_bytes()
    env = environment(output / "onstage.env")
    assert env["ONSTAGE_PUBLIC_ORIGIN"] == result["origin"]
    assert env["ONSTAGE_SECURE_COOKIE"] == "1"
    assert env["ONSTAGE_DATA_DIR"] == "/var/lib/onstage"
    assert env["ONSTAGE_VERSION"] == (ROOT / "VERSION").read_text().strip()
    proxy = (output / "nginx-onstage.conf").read_text()
    assert proxy.count("server_name onstage.example.org;") == 2
    assert f"ssl_certificate {cert};" in proxy
    assert f"ssl_certificate_key {key};" in proxy
    assert "proxy_pass http://127.0.0.1:8765;" in proxy
    assert "demo.example.invalid" not in proxy
    plan = json.loads((output / "deployment-plan.json").read_text())
    assert plan["documentation_sample"] is True
    assert plan["deployment_executed"] is False and plan["network_access_performed"] is False
    assert plan["tls"]["path_existence_checked"] is False and plan["tls"]["file_contents_read"] is False
    assert plan["verification"]["dns"] == "not_checked"
    assert plan["runtime"]["workers"] == 1 and plan["runtime"]["secure_cookie"] is True
    assert plan["runtime"]["current_release"] == "/opt/onstage/current"
    assert plan["runtime"]["frontend"] == "static/index.html"
    for item in plan["artifacts"]:
        assert item["sha256"] == hashlib.sha256((output / item["file"]).read_bytes()).hexdigest()
    if os.name == "posix":
        assert stat.S_IMODE(output.stat().st_mode) == 0o700
        assert all(stat.S_IMODE(path.stat().st_mode) == 0o600 for path in output.iterdir())


def test_caddy_cli_prepares_only_selected_proxy_with_explicit_sample_status(tmp_path):
    output = tmp_path / "caddy-review"
    result = subprocess.run([sys.executable, str(ROOT / "tools/prepare_deployment.py"),
                             "--origin", "https://review.example.net", "--proxy", "caddy",
                             "--output", str(output)], capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    summary = json.loads(result.stdout)
    assert summary["documentation_sample"] is True and summary["deployment_executed"] is False
    assert "review.example.net {" in (output / "Caddyfile.onstage.snippet").read_text()
    assert not (output / "nginx-onstage.conf").exists()
    plan = json.loads((output / "deployment-plan.json").read_text())
    assert plan["tls"]["mode"] == "existing_caddy_policy"
    assert plan["tls"]["certificate_path"] is None
    assert plan["verification"]["https"] == "not_checked"


@pytest.mark.parametrize("origin", [
    "http://onstage.example.org", "https://onstage.example.org:8443", "https://onstage.example.org:0443",
    "https://onstage.example.org/", "https://onstage.example.org/api", "https://onstage.example.org?",
    "https://onstage.example.org?x=1", "https://onstage.example.org#", "https://user@onstage.example.org",
    "https://user:password@onstage.example.org", "https://onstage.example.org\nInjected=yes",
    " https://onstage.example.org", "https://onstage.example.org\t", "https://onstage.example.org;include",
    "https://onstage.example.org$variable", "https://onstage.example.org%0a", "https://onstage.example.org\\path",
    "https://*.example.org", "https://127.0.0.1", "https://[::1]", "https://localhost",
    "https://demo.example.invalid", "https://replace-with-domain.com", "https://your-domain.com",
    "https://REPLACE_WITH_YOUR_DOMAIN", "https://bad_label.example.org", "https://-bad.example.org",
    "https://bad-.example.org", "https://a..example.org", "https://onstage.example.org.",
    "https://" + "a" * 64 + ".example.org",
])
def test_invalid_origin_is_rejected_before_any_output(origin, tmp_path):
    output = tmp_path / "rejected"
    with pytest.raises(deployment.PreparationError):
        deployment.prepare(origin, "caddy", output)
    assert not output.exists()


@pytest.mark.parametrize("path", [None, "relative/fullchain.pem", "/tmp/full chain.pem", "/tmp/cert.pem\ninclude /etc/passwd;",
                                  "/tmp/cert.pem;", "/tmp/${CERT}.pem", '/tmp/"cert".pem', "/tmp/cert{a}.pem",
                                  "/tmp/cert\\.pem", "/tmp/../key.pem", "/tmp/./key.pem", "//tmp/key.pem", "/tmp/"])
def test_nginx_paths_reject_missing_relative_and_configuration_syntax(path, tmp_path):
    with pytest.raises(deployment.PreparationError):
        deployment.prepare("https://onstage.example.org", "nginx", tmp_path / "rejected",
                           tls_cert=path, tls_key="/target-only/key.pem")
    assert not (tmp_path / "rejected").exists()


def test_proxy_specific_certificate_requirements_are_not_silently_ignored(tmp_path):
    with pytest.raises(deployment.PreparationError):
        deployment.prepare("https://onstage.example.org", "nginx", tmp_path / "missing-key", tls_cert="/target-only/cert.pem")
    with pytest.raises(deployment.PreparationError):
        deployment.prepare("https://onstage.example.org", "caddy", tmp_path / "ignored-cert", tls_key="/target-only/key.pem")
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize("kind", ["directory", "file", "dangling_symlink"])
def test_existing_output_is_never_overwritten_even_when_symlink_is_dangling(kind, tmp_path):
    output = tmp_path / "existing"
    if kind == "directory":
        output.mkdir()
        (output / "keep.txt").write_text("existing user content")
    elif kind == "file":
        output.write_text("existing user content")
    else:
        try:
            output.symlink_to(tmp_path / "missing-target", target_is_directory=True)
        except OSError:
            pytest.skip("Symlink creation is unavailable in this test environment")
    with pytest.raises(deployment.PreparationError, match="already exists"):
        deployment.prepare("https://onstage.example.org", "caddy", output)
    if kind == "directory":
        assert set(p.name for p in output.iterdir()) == {"keep.txt"}
        assert (output / "keep.txt").read_text() == "existing user content"
    elif kind == "file":
        assert output.read_text() == "existing user content"
    else:
        assert output.is_symlink() and not (tmp_path / "missing-target").exists()


def source_fixture(tmp_path, monkeypatch):
    source = tmp_path / "source"
    (source / "deploy").mkdir(parents=True)
    for name in ("deploy/onstage.service", "deploy/nginx-site.conf.example", "deploy/Caddyfile.snippet", ".env.example", "VERSION"):
        shutil.copyfile(ROOT / name, source / name)
    monkeypatch.setattr(deployment, "ROOT", source)
    return source


def test_generated_version_comes_from_root_version_and_secure_cookie_is_forced(tmp_path, monkeypatch):
    source = source_fixture(tmp_path, monkeypatch)
    (source / "VERSION").write_text("9.8.7-prepare-check\n")
    template = (source / ".env.example").read_text().replace("ONSTAGE_SECURE_COOKIE=1", "ONSTAGE_SECURE_COOKIE=0")
    (source / ".env.example").write_text(template)
    output = tmp_path / "review"
    deployment.prepare("https://onstage.example.org", "caddy", output)
    env = environment(output / "onstage.env")
    assert env["ONSTAGE_VERSION"] == "9.8.7-prepare-check"
    assert env["ONSTAGE_SECURE_COOKIE"] == "1"


def test_template_worker_drift_and_injected_version_fail_before_writing(tmp_path, monkeypatch):
    source = source_fixture(tmp_path, monkeypatch)
    unit = source / "deploy/onstage.service"
    original = unit.read_text()
    unit.write_text(original.replace("--workers 1", "--workers 2"))
    with pytest.raises(deployment.PreparationError, match="one worker"):
        deployment.prepare("https://onstage.example.org", "caddy", tmp_path / "bad-worker")
    unit.write_text(original)
    (source / "VERSION").write_text("0.4.0-phase1\nEXTRA=unsafe\n")
    with pytest.raises(deployment.PreparationError, match="VERSION"):
        deployment.prepare("https://onstage.example.org", "caddy", tmp_path / "bad-version")
    assert not (tmp_path / "bad-worker").exists() and not (tmp_path / "bad-version").exists()


def test_cli_requires_output_and_never_creates_a_default_bundle(tmp_path):
    result = subprocess.run([sys.executable, str(ROOT / "tools/prepare_deployment.py"),
                             "--origin", "https://onstage.example.org", "--proxy", "caddy"],
                            cwd=tmp_path, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0 and "--output" in result.stderr
    assert list(tmp_path.iterdir()) == []
