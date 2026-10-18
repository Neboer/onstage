#!/usr/bin/env python3
"""Prepare reviewable Onstage deployment files; never connect to or change a host.

Example (reserved documentation domain; not a deployed or DNS-verified site):
  python tools/prepare_deployment.py --origin https://onstage.example.org \
      --proxy caddy --output /tmp/onstage-deployment-review

Nginx also requires --tls-cert and --tls-key, naming existing target-host paths
for later operator verification. This tool only validates their syntax: it never
reads certificate/private-key contents or claims those files exist.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
CURRENT = "/opt/onstage/current"
DATA = "/var/lib/onstage"
TEMPLATE_HOST = "demo.example.invalid"
DOCUMENTATION_DOMAINS = ("example.com", "example.net", "example.org")


class PreparationError(ValueError):
    """Invalid input or unexpected source template; no deployment was attempted."""


def normalized_origin(value: str) -> tuple[str, str, bool]:
    # Full matching rejects even an empty query/fragment or a trailing slash.
    # Only ASCII DNS names are put into nginx, Caddy and systemd env syntax.
    match = re.fullmatch(r"https://([A-Za-z0-9.-]+)(?::443)?", value, re.IGNORECASE | re.ASCII)
    if not match:
        raise PreparationError("Origin must be https://DOMAIN with optional :443 and no path, query, fragment, userinfo, whitespace or configuration syntax.")
    host = match.group(1).lower()
    labels = host.split(".")
    if (len(host) > 253 or len(labels) < 2 or labels[-1].isdigit()
            or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)):
        raise PreparationError("Origin must contain a complete ASCII DNS name, not an IP address or local hostname; use punycode for international domains.")
    if labels[-1] in {"invalid", "localhost", "local", "test", "internal", "example"}:
        raise PreparationError("Local and placeholder domain suffixes cannot be deployment targets. For a labelled documentation sample use a subdomain of example.org.")
    if any(re.search(r"(?:^|-)(?:your|replace|placeholder)(?:-|$)", label) for label in labels):
        raise PreparationError("Replace placeholder domain labels with an explicitly selected domain.")
    sample = any(host == domain or host.endswith("." + domain) for domain in DOCUMENTATION_DOMAINS)
    return "https://" + host, host, sample


def certificate_path(value: str | None, option: str) -> str:
    if not value or len(value) > 4096 or not re.fullmatch(r"/(?:[A-Za-z0-9._+-]+/)*[A-Za-z0-9._+-]+", value):
        raise PreparationError(f"{option} requires an explicit absolute POSIX file path using only letters, digits, / . _ + -; variables and configuration syntax are not allowed.")
    if any(part in {".", ".."} for part in value.split("/")):
        raise PreparationError(f"{option} must not contain . or .. path components.")
    return value


def read_source(relative: str) -> str:
    path = ROOT / relative
    if path.is_symlink() or not path.is_file():
        raise PreparationError(f"Missing or symlinked source template: {relative}")
    text = path.read_text(encoding="utf-8")
    if not text.strip():
        raise PreparationError(f"Empty source template: {relative}")
    return text


def one_replacement(text: str, old: str, new: str, count: int = 1) -> str:
    if text.count(old) != count:
        raise PreparationError("A deployment template changed; review its expected placeholders before generating files.")
    return text.replace(old, new)


def verify_unit(unit: str) -> None:
    def directive(name: str) -> str:
        values = re.findall(r"^" + re.escape(name) + r"=(.*)$", unit, re.MULTILINE)
        if len(values) != 1:
            raise PreparationError(f"The service template requires exactly one {name} directive.")
        return values[0]

    fixed = {"User": "onstage", "Group": "onstage", "WorkingDirectory": CURRENT,
             "EnvironmentFile": "/etc/onstage.env", "ReadWritePaths": DATA}
    if any(directive(name) != expected for name, expected in fixed.items()):
        raise PreparationError("The service template changed its isolated user, release or data-directory invariant.")
    try:
        command = shlex.split(directive("ExecStart"))
    except ValueError as exc:
        raise PreparationError("The service template ExecStart syntax is invalid; review it before preparation.") from exc
    if command[:4] != [CURRENT + "/.venv/bin/python", "-m", "uvicorn", "app.main:app"]:
        raise PreparationError("The service template must run the full Onstage application from the current release.")
    for flag, value in {"--host": "127.0.0.1", "--port": "8765", "--workers": "1", "--forwarded-allow-ips": "127.0.0.1"}.items():
        if command.count(flag) != 1 or command[command.index(flag) + 1:command.index(flag) + 2] != [value]:
            raise PreparationError("The service template must retain one worker and its trusted loopback upstream.")


def render_environment(template: str, origin: str, version: str) -> str:
    values = {"ONSTAGE_PUBLIC_ORIGIN": origin, "ONSTAGE_SECURE_COOKIE": "1",
              "ONSTAGE_DATA_DIR": DATA, "ONSTAGE_VERSION": version}
    for key, value in values.items():
        pattern = r"^" + re.escape(key) + r"=.*$"
        if len(re.findall(pattern, template, re.MULTILINE)) != 1:
            raise PreparationError(f"The public environment template requires exactly one {key} assignment.")
        template = re.sub(pattern, lambda _: key + "=" + value, template, flags=re.MULTILINE)
    return template


def prepare(origin: str, proxy: str, output: Path, *, tls_cert: str | None = None,
            tls_key: str | None = None) -> dict:
    origin, host, sample = normalized_origin(origin)
    if proxy not in {"nginx", "caddy"}:
        raise PreparationError("Proxy must be nginx or caddy.")
    if proxy == "nginx":
        tls_cert = certificate_path(tls_cert, "--tls-cert")
        tls_key = certificate_path(tls_key, "--tls-key")
    elif tls_cert is not None or tls_key is not None:
        raise PreparationError("Certificate path options belong to nginx; the Caddy snippet uses the host's existing Caddy certificate policy.")

    # Everything is validated and rendered before creating the output directory.
    source_paths = ("deploy/onstage.service", "deploy/nginx-site.conf.example",
                    "deploy/Caddyfile.snippet", ".env.example", "VERSION")
    sources = {path: read_source(path) for path in source_paths}
    version = sources["VERSION"].strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9._-]+)?", version):
        raise PreparationError("The root VERSION file must contain a single release version.")
    verify_unit(sources["deploy/onstage.service"])
    environment = render_environment(sources[".env.example"], origin, version)
    if proxy == "nginx":
        fragment = one_replacement(sources["deploy/nginx-site.conf.example"],
            "/etc/letsencrypt/live/" + TEMPLATE_HOST + "/fullchain.pem", tls_cert)
        fragment = one_replacement(fragment,
            "/etc/letsencrypt/live/" + TEMPLATE_HOST + "/privkey.pem", tls_key)
        fragment = one_replacement(fragment, "server_name " + TEMPLATE_HOST + ";", "server_name " + host + ";", count=2)
        proxy_name = "nginx-onstage.conf"
    else:
        fragment = one_replacement(sources["deploy/Caddyfile.snippet"], TEMPLATE_HOST + " {", host + " {")
        proxy_name = "Caddyfile.onstage.snippet"
    upstream = "proxy_pass http://127.0.0.1:8765;" if proxy == "nginx" else "reverse_proxy 127.0.0.1:8765"
    if fragment.count(upstream) != 1:
        raise PreparationError("The proxy template must retain the application's loopback upstream.")

    files = {"onstage.service": sources["deploy/onstage.service"], "onstage.env": environment,
             proxy_name: fragment}
    plan = {
        "schema_version": 1, "operation": "prepare_only", "status": "ready_for_review",
        "version": version, "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "origin": origin, "hostname": host, "proxy": proxy,
        "documentation_sample": sample,
        "sample_note": "Reserved documentation domain; not a real deployment target." if sample else None,
        "deployment_executed": False, "network_access_performed": False,
        "verification": {"origin_syntax": "passed", "dns": "not_checked", "domain_control": "not_checked",
                         "target_host": "not_selected", "target_permissions": "not_checked",
                         "proxy_configuration": "not_checked_on_target", "https": "not_checked",
                         "multiplayer": "not_checked_on_target", "mainland_network": "not_checked"},
        "tls": {"mode": "explicit_nginx_paths" if proxy == "nginx" else "existing_caddy_policy",
                "certificate_path": tls_cert, "private_key_path": tls_key,
                "path_existence_checked": False, "file_contents_read": False, "certificate_validated": False},
        "runtime": {"entrypoint": "app.main:app", "frontend": "static/index.html",
                    "current_release": CURRENT, "data_directory": DATA,
                    "listen_host": "127.0.0.1", "listen_port": 8765, "workers": 1,
                    "secure_cookie": True, "proxy_public_ports": [80, 443]},
        "artifacts": [
            {"file": name, "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
             "mode": "0600", "target": "/etc/systemd/system/onstage.service" if name == "onstage.service"
             else "/etc/onstage.env" if name == "onstage.env" else None,
             "integration": "merge into the existing proxy configuration after review" if name == proxy_name else "install only after target permissions and paths are verified"}
            for name, content in files.items()
        ],
        "source_templates": [{"path": path, "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest()}
                             for path, content in sources.items()],
        "required_before_apply": [
            "Select and verify the authorized SSH target and project subdomain; preserve existing sites and Headscale.",
            "Check platform, Python/SQLite, free ports and local persistent storage; prepare an isolated release.",
            "Review target certificate paths or existing Caddy policy; validate the merged proxy configuration.",
            "Back up any existing database; install only this service and its reviewed configuration.",
            "Verify HTTPS, real multiplayer, recovery, backup restoration and target mainland networks.",
        ],
    }
    files["deployment-plan.json"] = json.dumps(plan, ensure_ascii=False, indent=2) + "\n"

    output = Path(output).expanduser().absolute()
    # mkdir is the no-overwrite check: existing files, directories, and even
    # dangling symlinks fail. Never resolve a supplied leaf symlink beforehand.
    try:
        output.mkdir(mode=0o700, parents=False, exist_ok=False)
    except FileExistsError as exc:
        raise PreparationError("Output already exists; choose a new directory. Nothing was replaced.") from exc
    except FileNotFoundError as exc:
        raise PreparationError("The output parent directory must already exist.") from exc
    created: list[Path] = []
    try:
        for name, content in files.items():
            target = output / name
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            created.append(target)
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(content)
    except BaseException:
        # Remove only files created by this attempt, never an arbitrary tree.
        for target in reversed(created):
            try:
                target.unlink()
            except OSError:
                pass
        try:
            output.rmdir()
        except OSError:
            pass
        raise
    return {"operation": "prepare_only", "output": str(output), "plan": str(output / "deployment-plan.json"),
            "origin": origin, "proxy": proxy, "version": version,
            "documentation_sample": sample, "deployment_executed": False, "files": list(files)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--origin", required=True, help="Selected HTTPS domain; default port 443 only, without a trailing slash")
    parser.add_argument("--proxy", required=True, choices=("nginx", "caddy"))
    parser.add_argument("--output", required=True, type=Path, help="New directory in an existing parent, preferably a task-specific temporary directory")
    parser.add_argument("--tls-cert", help="Nginx only: absolute target-host certificate-chain file path; not read or verified")
    parser.add_argument("--tls-key", help="Nginx only: absolute target-host private-key file path; not read or verified")
    args = parser.parse_args()
    try:
        result = prepare(args.origin, args.proxy, args.output, tls_cert=args.tls_cert, tls_key=args.tls_key)
    except (PreparationError, OSError, UnicodeError) as exc:
        parser.exit(1, f"Preparation failed: {exc}\nNo deployment was attempted.\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
