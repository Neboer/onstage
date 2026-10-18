#!/usr/bin/env python3
"""Private operator client for an authorized Onstage Sites/D1 service.

The token comes from ONSTAGE_OPERATOR_TOKEN or a hidden interactive prompt.
Never put it in an argument, URL, repository or public report. `list` explicitly
prints private report evidence for the operator; do not paste it into logs.
`export` writes a new owner-only file and prints only path/size/hash metadata.
"""

from __future__ import annotations

import argparse
from getpass import getpass, GetPassWarning
import hashlib
from http.client import HTTPException
import ipaddress
import json
import os
from pathlib import Path
import re
import ssl
import sys
import warnings
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener


MAX_RESPONSE_BYTES = 17 * 1024 * 1024
EXPORT_TABLES = {
    "schema_meta", "sessions", "characters", "rooms", "room_members",
    "role_requests", "messages", "room_bans", "reports", "moderation_actions",
}


class OperatorError(Exception):
    def __init__(self, code: str, status: int | None = None):
        self.code, self.status = code, status
        super().__init__(code)


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        return None


def make_opener():
    # No inherited proxy or automatic redirect may copy the bearer elsewhere.
    return build_opener(ProxyHandler({}), HTTPSHandler(context=ssl.create_default_context()), NoRedirects())


def parse_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise argparse.ArgumentTypeError("invalid URL authority or port") from None
    if (
        parsed.scheme not in {"http", "https"} or not parsed.hostname
        or parsed.username is not None or parsed.password is not None
        or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
        or not value.isascii() or "\\" in value
        or any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value)
        or (port is not None and not 1 <= port <= 65535)
    ):
        raise argparse.ArgumentTypeError("use an exact HTTPS origin without credentials or path")
    try:
        ipaddress.ip_address(parsed.hostname)
    except ValueError:
        labels = parsed.hostname.split(".")
        if len(parsed.hostname) > 253 or any(not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label) for label in labels):
            raise argparse.ArgumentTypeError("use a valid ASCII/IDNA hostname or IP address")
    if parsed.scheme == "http":
        try:
            local = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            local = parsed.hostname == "localhost"
        if not local:
            raise argparse.ArgumentTypeError("HTTP is permitted only for explicit isolated loopback tests")
    return value.rstrip("/")


def identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", value):
        raise argparse.ArgumentTypeError("ID must contain 1–80 letters, digits, underscores or hyphens")
    return value


def bounded_text(maximum: int):
    def validate(value: str) -> str:
        if not value.strip() or len(value) > maximum or any(ord(char) == 0 for char in value):
            raise argparse.ArgumentTypeError(f"text must be nonblank and no more than {maximum} characters")
        return value
    return validate


def read_token() -> str:
    token = os.environ.get("ONSTAGE_OPERATOR_TOKEN")
    if token is None:
        try:
            # A redirected stdin must not make getpass silently fall back to
            # visible input. Non-interactive operators can use the environment.
            with warnings.catch_warnings():
                warnings.simplefilter("error", GetPassWarning)
                token = getpass("Onstage operator token (hidden): ")
        except (EOFError, KeyboardInterrupt, GetPassWarning):
            raise OperatorError("token_input_cancelled") from None
    if not 32 <= len(token) <= 256 or any(not 0x21 <= ord(char) <= 0x7E for char in token):
        raise OperatorError("operator_token_missing_or_invalid")
    return token


def request_json(
    origin: str, token: str, path: str, *, body: dict | None = None,
    timeout: float = 20, opener=None,
) -> tuple[dict, bytes]:
    # Callers construct only fixed API paths plus validated opaque IDs.
    if not path.startswith("/api/operator/") or path.startswith("//"):
        raise OperatorError("invalid_operator_path")
    encoded = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    request = Request(origin + path, data=encoded, method="GET" if body is None else "POST", headers={
        "Authorization": "Bearer " + token,
        "Accept": "application/json", "Content-Type": "application/json; charset=utf-8",
        "Origin": origin,
    })
    try:
        with (opener or make_opener()).open(request, timeout=timeout) as response:
            status = response.status
            if status != 200:
                raise OperatorError("unexpected_http_status", status)
            content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
            if content_type != "application/json":
                raise OperatorError("response_not_json")
            size_header = response.headers.get("Content-Length")
            if size_header is not None and (not size_header.isdecimal() or int(size_header) > MAX_RESPONSE_BYTES):
                raise OperatorError("response_size_invalid")
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise OperatorError("response_exceeds_size_limit")
    except HTTPError as error:
        # Do not read or serialize error bodies, headers, Location or URLs.
        status = error.code
        error.close()
        raise OperatorError("redirect_refused" if 300 <= status < 400 else "http_request_failed", status) from None
    except (URLError, TimeoutError, OSError, HTTPException):
        raise OperatorError("network_request_failed") from None
    try:
        result = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError, RecursionError):
        raise OperatorError("response_not_valid_json") from None
    if not isinstance(result, dict):
        raise OperatorError("response_not_object")
    return result, raw


def validate_export(payload: dict) -> None:
    if (
        payload.get("format") != "onstage-confidential-state-v1"
        or payload.get("schema_version") != 4
        or payload.get("contains_private_session_credentials") is not True
        or not isinstance(payload.get("tables"), dict)
        or not isinstance(payload.get("row_counts"), dict)
        or set(payload["tables"]) != EXPORT_TABLES
    ):
        raise OperatorError("export_shape_invalid")
    total = 0
    for name, rows in payload["tables"].items():
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows) or payload["row_counts"].get(name) != len(rows):
            raise OperatorError("export_row_count_invalid")
        total += len(rows)
    if total > 50000:
        raise OperatorError("export_record_limit_exceeded")


def export_private(path: Path, fetch: Callable[[], tuple[dict, bytes]]) -> dict:
    descriptor: int | None = None
    created = False
    succeeded = False
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        created = True
        if hasattr(os, "fchmod"):
            os.fchmod(descriptor, 0o600)
        payload, raw = fetch()
        validate_export(payload)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise OperatorError("response_exceeds_size_limit")
        with os.fdopen(descriptor, "wb") as destination:
            descriptor = None
            destination.write(raw)
            destination.flush()
            os.fsync(destination.fileno())
        succeeded = True
        return {
            "saved": str(path.resolve()), "bytes": len(raw),
            "sha256": hashlib.sha256(raw).hexdigest(),
            "scope": "confidential_business_state_with_sessions_backstage_and_reports",
            "format": payload["format"], "schema_version": payload["schema_version"],
            "not_a_public_source_artifact": True,
        }
    except FileExistsError:
        raise OperatorError("output_already_exists") from None
    except OSError:
        raise OperatorError("output_file_failed") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if created and not succeeded:
            try:
                path.unlink()
            except OSError:
                pass


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--url", type=parse_origin, required=True)
    result.add_argument("--timeout", type=float, default=20)
    commands = result.add_subparsers(dest="command", required=True)
    listing = commands.add_parser("list", help="Print private report evidence only in an operator-controlled terminal")
    listing.add_argument("--status", choices=("open", "resolved", "dismissed", "all"), default="open")
    listing.add_argument("--after", type=int, default=0)
    listing.add_argument("--limit", type=int, default=50)
    resolving = commands.add_parser("resolve", help="Resolve one report with an auditable note")
    resolving.add_argument("report_id", type=identifier)
    resolving.add_argument("--status", choices=("resolved", "dismissed"), required=True)
    resolving.add_argument("--note", type=bounded_text(500), required=True)
    resolving.add_argument("--operator", type=bounded_text(80), required=True)
    ending = commands.add_parser("end-room", help="End one explicitly selected room; preserves its history")
    ending.add_argument("room_id", type=identifier)
    ending.add_argument("--note", type=bounded_text(500), required=True)
    ending.add_argument("--operator", type=bounded_text(80), required=True)
    export = commands.add_parser("export", help="Save a new private business-state JSON; no payload is printed")
    export.add_argument("--output", type=Path, required=True)
    return result


def main(argv: list[str] | None = None) -> int:
    argument_parser = parser()
    args = argument_parser.parse_args(argv)
    if not 0 < args.timeout <= 60:
        argument_parser.error("timeout must be greater than zero and no more than 60 seconds")
    if args.command == "list" and (not 0 <= args.after <= 9007199254740991 or not 1 <= args.limit <= 100):
        argument_parser.error("after must be a nonnegative safe integer; limit must be 1–100")
    try:
        if args.command == "export" and (args.output.exists() or args.output.is_symlink()):
            raise OperatorError("output_already_exists")
        token = read_token()
        if args.command == "list":
            path = f"/api/operator/reports?status={args.status}&after={args.after}&limit={args.limit}"
            result, _ = request_json(args.url, token, path, timeout=args.timeout)
        elif args.command == "resolve":
            body = {"status": args.status, "note": args.note, "operator": args.operator}
            response, _ = request_json(args.url, token, f"/api/operator/reports/{args.report_id}/resolve", body=body, timeout=args.timeout)
            record = response.get("report", {})
            if not isinstance(record, dict) or record.get("id") != args.report_id or record.get("status") != args.status:
                raise OperatorError("response_receipt_invalid")
            result = {key: record.get(key) for key in ("id", "status", "resolved_at", "resolved_by")}
        elif args.command == "end-room":
            body = {"note": args.note, "operator": args.operator}
            result, _ = request_json(args.url, token, f"/api/operator/rooms/{args.room_id}/end", body=body, timeout=args.timeout)
            if result.get("room_id") != args.room_id or result.get("status") != "ended":
                raise OperatorError("response_receipt_invalid")
        else:
            result = export_private(args.output, lambda: request_json(args.url, token, "/api/operator/export", timeout=args.timeout))
    except OperatorError as error:
        safe: dict[str, Any] = {"error": error.code}
        if error.status is not None:
            safe["http_status"] = error.status
        print(json.dumps(safe), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
