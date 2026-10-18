from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import threading

import pytest


SPEC = importlib.util.spec_from_file_location("onstage_edge_operator", Path(__file__).resolve().parents[1] / "tools" / "edge_operator.py")
operator = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(operator)
TEST_TOKEN = "test-only-not-a-real-operator-token-0123456789"


class Response(io.BytesIO):
    status = 200
    headers = {"Content-Type": "application/json; charset=utf-8"}


class CaptureOpener:
    def __init__(self, payload):
        self.payload = payload
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return Response(json.dumps(self.payload).encode())


def export_payload():
    tables = {name: [] for name in operator.EXPORT_TABLES}
    tables["sessions"] = [{"id": "test-session", "csrf_token": "private-test-csrf"}]
    return {
        "format": "onstage-confidential-state-v1", "schema_version": 4,
        "contains_private_session_credentials": True, "tables": tables,
        "row_counts": {key: len(value) for key, value in tables.items()},
    }


@pytest.mark.parametrize("value", [
    "http://public.example.org", "https://user:password@example.org", "https://example.org/path",
    "https://example.org?token=value", "https://example.org#fragment", "https://example.org\n",
    "https://example.org:99999", "file:///private", "//example.org",
])
def test_unsafe_origins_rejected_before_token_or_network(value):
    with pytest.raises(argparse.ArgumentTypeError):
        operator.parse_origin(value)


def test_only_explicit_loopback_http_and_clean_https_allowed():
    assert operator.parse_origin("https://demo.example.org/") == "https://demo.example.org"
    assert operator.parse_origin("http://127.0.0.1:8765") == "http://127.0.0.1:8765"
    assert operator.parse_origin("http://[::1]:8765") == "http://[::1]:8765"


def test_token_env_and_hidden_prompt_never_accept_argument(monkeypatch):
    monkeypatch.setenv("ONSTAGE_OPERATOR_TOKEN", TEST_TOKEN)
    monkeypatch.setattr(operator, "getpass", lambda _: pytest.fail("prompt must not run when environment token exists"))
    assert operator.read_token() == TEST_TOKEN
    monkeypatch.delenv("ONSTAGE_OPERATOR_TOKEN")
    prompts = []
    monkeypatch.setattr(operator, "getpass", lambda prompt: prompts.append(prompt) or TEST_TOKEN)
    assert operator.read_token() == TEST_TOKEN
    assert prompts and TEST_TOKEN not in prompts[0]
    with pytest.raises(SystemExit):
        operator.parser().parse_args(["--url", "https://example.org", "--token", TEST_TOKEN, "list"])


def test_invalid_environment_token_does_not_fall_back_to_another_identity(monkeypatch):
    monkeypatch.setenv("ONSTAGE_OPERATOR_TOKEN", "")
    monkeypatch.setattr(operator, "getpass", lambda _: pytest.fail("an explicitly invalid environment token must fail"))
    with pytest.raises(operator.OperatorError, match="operator_token_missing_or_invalid"):
        operator.read_token()


def test_resolve_sends_exact_scoped_api_and_body(monkeypatch, capsys):
    opener = CaptureOpener({"report": {"id": "report_123", "status": "dismissed"}})
    monkeypatch.setenv("ONSTAGE_OPERATOR_TOKEN", TEST_TOKEN)
    monkeypatch.setattr(operator, "make_opener", lambda: opener)
    assert operator.main(["--url", "https://demo.example.org", "resolve", "report_123", "--status", "dismissed", "--note", "自动合成测试结案", "--operator", "local-codex"]) == 0
    request = opener.requests[0]
    assert request.full_url == "https://demo.example.org/api/operator/reports/report_123/resolve"
    assert request.method == "POST"
    assert request.get_header("Authorization") == "Bearer " + TEST_TOKEN
    assert json.loads(request.data) == {"status": "dismissed", "note": "自动合成测试结案", "operator": "local-codex"}
    captured = capsys.readouterr()
    assert TEST_TOKEN not in captured.out + captured.err


def test_real_redirect_is_not_followed_or_sent_to_receiver():
    paths = []
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            paths.append(self.path)
            if self.path == "/api/operator/reports":
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/receiver")
                self.end_headers()
            else:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with pytest.raises(operator.OperatorError, match="redirect_refused") as raised:
            operator.request_json(f"http://127.0.0.1:{server.server_port}", TEST_TOKEN, "/api/operator/reports")
        assert raised.value.status == 302
        assert paths == ["/api/operator/reports"]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_export_is_exclusive_owner_only_and_stdout_contains_only_metadata(tmp_path, monkeypatch, capsys):
    payload = export_payload()
    opener = CaptureOpener(payload)
    monkeypatch.setattr(operator, "make_opener", lambda: opener)
    monkeypatch.setenv("ONSTAGE_OPERATOR_TOKEN", TEST_TOKEN)
    target = tmp_path / "confidential.json"
    assert operator.main(["--url", "https://demo.example.org", "export", "--output", str(target)]) == 0
    # Windows mode bits do not represent NTFS ACLs (documented in RUNBOOK).
    # Keep the POSIX confidentiality assertion on the platform it measures.
    if os.name == "posix":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert json.loads(target.read_bytes()) == payload
    captured = capsys.readouterr()
    assert "private-test-csrf" not in captured.out + captured.err
    assert TEST_TOKEN not in captured.out + captured.err
    metadata = json.loads(captured.out)
    assert metadata["not_a_public_source_artifact"] is True
    assert metadata["bytes"] == target.stat().st_size
    original = target.read_bytes()
    assert operator.main(["--url", "https://demo.example.org", "export", "--output", str(target)]) == 1
    assert target.read_bytes() == original and len(opener.requests) == 1


def test_export_failure_removes_partial_file_and_preserves_other_files(tmp_path):
    target = tmp_path / "failed.json"
    def failed_fetch():
        raise operator.OperatorError("network_request_failed")
    with pytest.raises(operator.OperatorError, match="network_request_failed"):
        operator.export_private(target, failed_fetch)
    assert not target.exists()
    invalid = export_payload()
    invalid["row_counts"]["sessions"] = 0
    with pytest.raises(operator.OperatorError, match="export_row_count_invalid"):
        operator.export_private(target, lambda: (invalid, json.dumps(invalid).encode()))
    assert not target.exists()
    existing = tmp_path / "existing.json"
    existing.write_text("preserve-me")
    with pytest.raises(operator.OperatorError, match="output_already_exists"):
        operator.export_private(existing, failed_fetch)
    assert existing.read_text() == "preserve-me"


def test_export_refuses_symlink_without_touching_destination(tmp_path):
    existing = tmp_path / "existing.json"
    existing.write_text("preserve-me")
    link = tmp_path / "link.json"
    try:
        link.symlink_to(existing)
    except OSError as exc:
        if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
            pytest.skip("Windows account cannot create symlinks; Linux CI runs this protection check")
        raise
    with pytest.raises(operator.OperatorError, match="output_already_exists"):
        operator.export_private(link, lambda: pytest.fail("must not fetch through a symlink"))
    assert existing.read_text() == "preserve-me" and link.is_symlink()


def test_response_read_is_bounded_and_non_json_rejected(monkeypatch):
    monkeypatch.setattr(operator, "MAX_RESPONSE_BYTES", 64)
    with pytest.raises(operator.OperatorError, match="response_exceeds_size_limit"):
        operator.request_json("https://demo.example.org", TEST_TOKEN, "/api/operator/export", opener=CaptureOpener({"large": "x" * 100}))
    class NonJsonOpener:
        def open(self, *args, **kwargs):
            response = Response(b"<html>not an API</html>")
            response.headers = {"Content-Type": "text/html"}
            return response
    with pytest.raises(operator.OperatorError, match="response_not_json"):
        operator.request_json("https://demo.example.org", TEST_TOKEN, "/api/operator/export", opener=NonJsonOpener())
