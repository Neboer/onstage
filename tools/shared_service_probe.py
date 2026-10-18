#!/usr/bin/env python3
"""Bounded, independent HTTP acceptance of an authorized Onstage shared service.

Creates four genuinely separate cookie jars, two labelled synthetic rooms and
synthetic messages/reports. Always attempts to end the created rooms and revoke
its own sessions. It never deletes rooms, changes server configuration, or
serializes cookies, CSRF, headers, message bodies or report evidence.

This verifies a real backend through HTTP, not browser rendering, physical
devices, mainland reachability, long-lived load or a WebSocket transport.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import platform
import sys
import threading
import time
from typing import Any, Iterator
from urllib.parse import urlsplit
import uuid

import httpx


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProbeError(Exception):
    """Only fixed error identifiers and numeric statuses may be reported."""

    def __init__(self, code: str, *, expected: int | None = None, actual: int | None = None):
        self.code, self.expected, self.actual = code, expected, actual
        super().__init__(code)


def require(condition: Any, code: str) -> None:
    if not condition:
        raise ProbeError(code)


def safe_error(error: BaseException) -> dict[str, Any]:
    result: dict[str, Any] = {"exception": type(error).__name__}
    if isinstance(error, ProbeError):
        result["code"] = error.code
        if error.expected is not None:
            result["expected_http_status"] = error.expected
        if error.actual is not None:
            result["actual_http_status"] = error.actual
    return result


def origin(value: str) -> str:
    parsed = urlsplit(value)
    try:
        port = parsed.port
    except ValueError:
        raise argparse.ArgumentTypeError("URL has an invalid port") from None
    if (
        parsed.scheme not in {"http", "https"} or not parsed.hostname
        or parsed.username is not None or parsed.password is not None
        or parsed.query or parsed.fragment or parsed.path not in {"", "/"}
        or any(char.isspace() for char in value)
    ):
        raise argparse.ArgumentTypeError("Use an HTTP(S) origin without credentials, query or path")
    if parsed.scheme == "http":
        try:
            loopback = ipaddress.ip_address(parsed.hostname).is_loopback
        except ValueError:
            loopback = parsed.hostname == "localhost"
        if not loopback:
            raise argparse.ArgumentTypeError("HTTP is allowed only for an isolated loopback test")
    if port is not None and not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("URL has an invalid port")
    return value.rstrip("/")


@dataclass
class Person:
    label: str
    client: httpx.Client = field(repr=False)
    csrf: str = field(default="", repr=False)
    authenticated: bool = False
    member_id: str | None = None
    nickname: str = ""


class Probe:
    def __init__(self, args: argparse.Namespace):
        self.args = args
        self.run_id = uuid.uuid4().hex[:12]
        self.people = [
            Person(label, httpx.Client(
                base_url=args.url, timeout=args.timeout, trust_env=args.use_env_proxy,
                follow_redirects=False, headers={"Origin": args.url},
            ), nickname=f"联机检验{label}-{self.run_id[:4]}")
            for label in ("A", "B", "C", "D")
        ]
        self.owned_rooms: list[str] = []
        self.requests = 0
        self.request_lock = threading.Lock()
        self.current_check: str | None = None
        self.report: dict[str, Any] = {
            "report_schema": 1, "run_id": self.run_id, "started_at_utc": utc_now(),
            "target_url": args.url, "network_source": args.source,
            "source_label_is_operator_declared": True,
            "environment_proxy_enabled": args.use_env_proxy,
            "direct_connection_requested": not args.use_env_proxy,
            "site_bypass_used": False,
            "platform_sign_in_used": False,
            "independent_cookie_jars": 4, "authenticated_identities_verified_distinct": False,
            "environment": {"python": platform.python_version(), "platform": platform.system(), "httpx": httpx.__version__},
            "scope": {
                "real_http_backend": True, "browser_executed": False,
                "physical_devices_executed": False, "websocket_executed": False,
                "mainland_location_verified": False, "load_test": False,
                "synthetic_test_content_only": True,
            },
            "checks": [], "cleanup": [], "passed": False,
        }

    def request(
        self, person: Person, method: str, path: str, *, body: dict | None = None,
        expected: int = 200, headers: dict[str, str] | None = None,
    ) -> dict:
        with self.request_lock:
            self.requests += 1
        options: dict[str, Any] = {"headers": headers} if headers is not None else {}
        if body is not None:
            options["json"] = body
        response = person.client.request(method, path, **options)
        if response.status_code != expected:
            raise ProbeError("unexpected_http_status", expected=expected, actual=response.status_code)
        if expected != 200:
            return {}
        try:
            data = response.json()
        except ValueError:
            raise ProbeError("response_not_json") from None
        require(isinstance(data, dict), "response_not_object")
        return data

    def get(self, person: Person, path: str, *, expected: int = 200) -> dict:
        return self.request(person, "GET", path, expected=expected)

    def post(self, person: Person, path: str, body: dict | None = None, *, expected: int = 200) -> dict:
        return self.request(person, "POST", path, body=body or {}, expected=expected)

    @contextmanager
    def check(self, name: str) -> Iterator[dict]:
        self.current_check = name
        started, before = time.monotonic(), self.requests
        entry: dict[str, Any] = {"name": name}
        try:
            yield entry
        except BaseException as error:
            entry.update({"passed": False, "error": safe_error(error)})
            raise
        else:
            entry["passed"] = True
        finally:
            entry["duration_ms"] = round((time.monotonic() - started) * 1000, 3)
            entry["http_requests"] = self.requests - before
            self.report["checks"].append(entry)

    def history(self, person: Person, room: str, channel: str = "stage", *, after: int = 0, limit: int = 100) -> list[dict]:
        messages: list[dict] = []
        cursor = after
        for _ in range(50):
            data = self.get(person, f"/api/rooms/{room}/messages?channel={channel}&after={cursor}&limit={limit}")
            rows = data.get("messages")
            require(isinstance(rows, list), "messages_not_array")
            for item in rows:
                require(isinstance(item.get("seq"), int) and item["seq"] > cursor, "cursor_not_strictly_increasing")
                cursor = item["seq"]
                messages.append(item)
            require(data.get("cursor") == cursor, "cursor_skips_undelivered_messages")
            if not data.get("has_more"):
                require(len({item["id"] for item in messages}) == len(messages), "duplicate_message_in_history")
                return messages
            require(bool(rows), "empty_page_claims_more")
        raise ProbeError("pagination_exceeded_probe_bound")

    def delivered(self, person: Person, room: str, expected: dict, *, after: int = 0) -> float:
        start = time.monotonic()
        while time.monotonic() - start <= self.args.delivery_timeout:
            data = self.get(person, f"/api/rooms/{room}/sync?after_stage={after}&after_backstage=0")
            rows = data.get("messages", {}).get("stage", [])
            matching = [item for item in rows if item.get("id") == expected["id"]]
            if matching:
                require(len(matching) == 1, "duplicate_remote_delivery")
                for field_name in ("id", "seq", "author", "character_id", "text", "kind", "content_type", "sticker_id", "sticker"):
                    require(matching[0].get(field_name) == expected.get(field_name), "remote_payload_mismatch")
                return round((time.monotonic() - start) * 1000, 3)
            time.sleep(0.25)
        raise ProbeError("remote_delivery_timeout")

    def send(self, person: Person, room: str, *, channel: str = "stage", text: str | None = None, sticker: str | None = None) -> tuple[dict, dict]:
        body = {"channel": channel, "client_message_id": uuid.uuid4().hex}
        if sticker is not None:
            body.update({"content_type": "sticker", "sticker_id": sticker})
        else:
            body["text"] = text or f"自动联机检验 {self.run_id}"
        return body, self.post(person, f"/api/rooms/{room}/messages", body)["message"]

    def run_checks(self) -> None:
        host, contender_b, observer, contender_d = self.people
        with self.check("service_health_database_and_unauthenticated_boundaries") as evidence:
            health, ready = self.get(host, "/healthz"), self.get(host, "/readyz")
            require(health.get("status") == "ok" and ready.get("status") == "ready", "backend_not_ready")
            require(ready.get("schema_version") == 4, "unexpected_business_schema")
            if self.args.expect_backend:
                require(health.get("backend") == self.args.expect_backend and ready.get("backend") == self.args.expect_backend, "unexpected_backend")
            if self.args.expect_version:
                require(health.get("version") == self.args.expect_version, "unexpected_version")
            evidence.update({"version": health.get("version"), "backend": health.get("backend"), "schema_version": ready.get("schema_version"), "edge_schema_version": ready.get("edge_schema_version")})
            self.get(host, "/api/rooms", expected=401)
            if health.get("backend") == "sites-d1":
                self.get(host, "/api/operator/reports", expected=401)
                self.get(host, "/api/operator/export", expected=401)

        with self.check("four_independent_nickname_sessions_and_credential_resume") as evidence:
            cookie_digests = set()
            for person in self.people:
                data = self.post(person, "/api/session", {"nickname": person.nickname})
                require(data.get("authenticated") and data.get("nickname") == person.nickname and data.get("requires_nickname") is False, "nickname_entry_failed")
                person.csrf = data["csrf_token"]
                person.authenticated = True
                person.client.headers["X-CSRF-Token"] = person.csrf
                token = person.client.cookies.get("onstage_session")
                require(bool(token), "missing_session_cookie")
                cookie_digests.add(hashlib.sha256(token.encode()).digest())
                restored = self.get(person, "/api/session")
                require(restored.get("csrf_token") == person.csrf and restored.get("nickname") == person.nickname, "session_resume_changed_identity")
            require(len(cookie_digests) == 4, "cookies_not_independent")
            self.report["authenticated_identities_verified_distinct"] = True
            negotiated = data.get("transport", {"type": "websocket"})
            require(isinstance(negotiated, dict), "transport_not_object")
            self.transport = {key: negotiated[key] for key in ("type", "interval_ms", "presence_interval_ms", "presence_ttl_ms") if key in negotiated}
            evidence["transport"] = self.transport
            self.request(host, "POST", "/api/rooms", body={"scenario_id": "mygo_rehearsal"}, headers={"Origin": "https://untrusted.example.org"}, expected=403)
            self.request(host, "POST", "/api/rooms", body={"scenario_id": "mygo_rehearsal"}, headers={"X-CSRF-Token": "invalid-probe-csrf"}, expected=403)
            self.post(host, "/api/session", {"nickname": host.nickname, "unexpected": True}, expected=422)

        catalog = self.get(host, "/api/catalog")
        characters = {item["id"]: item for item in catalog["characters"]}
        require(len(characters) == 10 and "mygo.soyo" in characters and "mygo.tomori" in characters, "character_catalog_mismatch")
        stickers = [item for item in catalog["stickers"] if item.get("source_pack") == "user-v04"]
        require(bool(stickers), "missing_user_stickers")
        sticker_id = stickers[0]["id"]
        with self.check("shared_room_concurrent_role_claim_and_spectator_entry") as evidence:
            room = self.post(host, "/api/rooms", {"scenario_id": "mygo_rehearsal", "title": f"自动联机验收 {self.run_id}"})["room"]
            room_id = room["id"]
            self.owned_rooms.append(room_id)
            self.post(host, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.soyo"})
            for person in (contender_b, contender_d):
                self.post(person, f"/api/rooms/{room_id}/join")
            def claim(person: Person) -> tuple[Person, httpx.Response]:
                with self.request_lock:
                    self.requests += 1
                return person, person.client.post(f"/api/rooms/{room_id}/characters/claim", json={"character_id": "mygo.tomori"})
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(claim, (contender_b, contender_d)))
            require(sorted(response.status_code for _, response in results) == [200, 409], "same_role_race_not_single_winner")
            performer = next(person for person, response in results if response.status_code == 200)
            removed = next(person for person, response in results if response.status_code == 409)
            self.post(host, f"/api/rooms/{room_id}/control", {"action": "start"})
            self.post(host, f"/api/rooms/{room_id}/control", {"action": "close_join"})
            observed = self.post(observer, f"/api/rooms/{room_id}/join")["room"]
            require(observed["me"]["character_id"] is None and not observed["me"]["can_stage"] and not observed["me"]["can_backstage"], "spectator_permissions_wrong")
            self.post(observer, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.taki"}, expected=409)
            self.post(host, f"/api/rooms/{room_id}/control", {"action": "open_join"})
            self.post(removed, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.taki"})
            for person in self.people:
                snapshot = self.get(person, f"/api/rooms/{room_id}")["room"]
                person.member_id = snapshot["me"]["member_id"]
                require(len(snapshot["members"]) == 4, "shared_member_list_mismatch")
            require(len({person.member_id for person in self.people}) == 4, "member_identities_not_independent")
            evidence.update({"room_id": room_id, "role_race_successes": 1, "role_race_conflicts": 1, "distinct_members": 4})

        if self.transport.get("type") == "poll":
            with self.check("presence_uses_real_heartbeats_and_deduplicates_tabs"):
                for person in self.people:
                    self.post(person, f"/api/rooms/{room_id}/presence", {"connection_id": "probe-main-tab"})
                self.post(host, f"/api/rooms/{room_id}/presence", {"connection_id": "probe-second-tab"})
                require(self.get(observer, f"/api/rooms/{room_id}")["room"]["online_count"] == 4, "presence_does_not_deduplicate_members")
                self.post(host, f"/api/rooms/{room_id}/presence", {"connection_id": "probe-main-tab", "active": False})
                require(self.get(observer, f"/api/rooms/{room_id}")["room"]["online_count"] == 4, "closing_one_tab_drops_other_tab")
                self.post(host, f"/api/rooms/{room_id}/presence", {"connection_id": "probe-second-tab", "active": False})
                require(self.get(observer, f"/api/rooms/{room_id}")["room"]["online_count"] == 3, "inactive_heartbeat_still_online")

        with self.check("host_settings_and_backstage_authorization"):
            background, announcement = f"独立会话共享背景 {self.run_id}", f"自动验收公告 {self.run_id}"
            self.post(host, f"/api/rooms/{room_id}/settings", {"background": background, "announcement": announcement})
            snapshot = self.get(observer, f"/api/rooms/{room_id}")["room"]
            require(snapshot["background"] == background and snapshot["announcement"] == announcement, "settings_not_shared")
            self.post(observer, f"/api/rooms/{room_id}/settings", {"background": "", "announcement": ""}, expected=403)
            self.get(observer, f"/api/rooms/{room_id}/messages?channel=backstage", expected=403)
            self.post(observer, f"/api/rooms/{room_id}/messages", {"channel": "stage", "text": "越权检验", "client_message_id": uuid.uuid4().hex}, expected=403)
            self.post(observer, f"/api/rooms/{room_id}/messages", {"channel": "backstage", "text": "越权检验", "client_message_id": uuid.uuid4().hex}, expected=403)
            backstage_body, backstage_message = self.send(removed, room_id, channel="backstage")
            require(any(item["id"] == backstage_message["id"] for item in self.history(host, room_id, "backstage")), "authorized_backstage_not_shared")
            spectator_sync = self.get(observer, f"/api/rooms/{room_id}/sync")
            require(spectator_sync["messages"]["backstage"] == [], "sync_leaks_backstage")

        with self.check("text_sticker_remote_delivery_and_idempotency") as evidence:
            text_body, text_message = self.send(host, room_id)
            sticker_body, sticker_message = self.send(performer, room_id, sticker=sticker_id)
            require(text_message["character_id"] == "mygo.soyo" and sticker_message["character_id"] == "mygo.tomori", "author_role_not_server_assigned")
            require(sticker_message["content_type"] == "sticker" and sticker_message["sticker"]["id"] == sticker_id, "sticker_snapshot_missing")
            # These timers start at each follow-up sync call after both sends
            # returned, not at the original sender acknowledgement timestamp.
            evidence["post_ack_followup_sync_duration_ms"] = [self.delivered(observer, room_id, text_message), self.delivered(host, room_id, sticker_message)]
            before = self.history(observer, room_id)
            require(self.post(host, f"/api/rooms/{room_id}/messages", text_body)["message"]["id"] == text_message["id"], "text_retry_not_idempotent")
            require(self.post(performer, f"/api/rooms/{room_id}/messages", sticker_body)["message"]["id"] == sticker_message["id"], "sticker_retry_not_idempotent")
            self.post(host, f"/api/rooms/{room_id}/messages", {**text_body, "text": "冲突正文"}, expected=409)
            self.post(host, f"/api/rooms/{room_id}/messages", {**text_body, "client_message_id": uuid.uuid4().hex, "kind": "system"}, expected=422)
            self.post(host, f"/api/rooms/{room_id}/messages", {"channel": "stage", "content_type": "sticker", "sticker_id": "not-in-catalog", "client_message_id": uuid.uuid4().hex}, expected=422)
            require([item["id"] for item in self.history(observer, room_id)] == [item["id"] for item in before], "failed_or_retried_message_changed_history")

        with self.check("cursor_recovery_pagination_and_refresh_without_duplicate_events") as evidence:
            before = self.history(observer, room_id)
            after = before[-1]["seq"]
            expected_ids = [self.send(performer, room_id)[1]["id"] for _ in range(3)]
            recovered = self.history(observer, room_id, after=after, limit=2)
            require([item["id"] for item in recovered] == expected_ids, "missed_messages_not_recovered_in_order")
            event_ids = [item["id"] for item in self.history(observer, room_id) if item["kind"] == "system"]
            self.post(performer, f"/api/rooms/{room_id}/join")
            self.post(performer, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.tomori"})
            require([item["id"] for item in self.history(observer, room_id) if item["kind"] == "system"] == event_ids, "refresh_or_retry_added_membership_event")
            require(self.get(performer, "/api/session")["csrf_token"] == performer.csrf, "refresh_rotated_credentials")
            evidence.update({"controlled_no_read_gap_messages": 3, "recovered_messages": len(recovered), "page_size": 2})

        with self.check("report_receipts_host_privacy_and_room_isolation"):
            private_report = self.post(observer, f"/api/rooms/{room_id}/reports", {"message_id": text_message["id"], "reason": "other", "details": "自动验收：房主举报隔离"})["report"]
            require(private_report["against_host"] is True, "host_report_not_private")
            public_report = self.post(observer, f"/api/rooms/{room_id}/reports", {"message_id": sticker_message["id"], "reason": "other", "details": "自动验收：普通举报回执"})["report"]
            require(public_report["against_host"] is False and public_report["snapshot"]["message"]["sticker"]["id"] == sticker_id, "sticker_report_snapshot_wrong")
            host_reports = self.get(host, f"/api/rooms/{room_id}/reports")["reports"]
            require(private_report["id"] not in {row["id"] for row in host_reports} and public_report["id"] in {row["id"] for row in host_reports}, "host_report_visibility_wrong")
            self.post(host, f"/api/rooms/{room_id}/reports/{private_report['id']}/resolve", {"status": "dismissed", "note": "自动越权检验"}, expected=403)
            self.post(host, f"/api/rooms/{room_id}/reports/{public_report['id']}/resolve", {"status": "dismissed", "note": "自动测试结案"})
            require(any(row["id"] == public_report["id"] and row["status"] == "dismissed" for row in self.get(observer, "/api/reports")["reports"]), "report_receipt_not_updated")
            backstage_report = self.post(removed, f"/api/rooms/{room_id}/reports", {"message_id": backstage_message["id"], "reason": "other", "details": "自动验收：离场后后台证据遮蔽"})["report"]
            second = self.post(host, "/api/rooms", {"scenario_id": "mygo_rehearsal", "title": f"隔离验收 {self.run_id}"})["room"]["id"]
            self.owned_rooms.append(second)
            self.get(observer, f"/api/rooms/{second}/messages", expected=403)
            self.post(observer, f"/api/rooms/{second}/reports", {"reason": "other"}, expected=403)
            self.post(observer, f"/api/rooms/{room_id}/reports", {"message_id": self.history(host, second)[0]["id"], "reason": "other"}, expected=404)
            if self.args.expect_backend == "sites-d1":
                self.get(host, "/api/operator/reports", expected=401)
                self.get(host, "/api/operator/export", expected=401)

        with self.check("explicit_leave_rejoin_and_role_events_are_once_only"):
            before = self.history(observer, room_id)
            self.post(performer, f"/api/rooms/{room_id}/leave")
            self.post(performer, f"/api/rooms/{room_id}/leave")
            left = self.history(observer, room_id)
            require(len(left) == len(before) + 1 and left[-1]["kind"] == "system" and performer.nickname in left[-1]["text"] and characters["mygo.tomori"]["name"] in left[-1]["text"], "leave_event_missing_or_duplicated")
            self.get(performer, f"/api/rooms/{room_id}/messages", expected=403)
            self.post(performer, f"/api/rooms/{room_id}/join")
            self.post(performer, f"/api/rooms/{room_id}/join")
            joined = self.history(observer, room_id)
            require(len(joined) == len(left) + 1 and joined[-1]["kind"] == "system", "rejoin_event_missing_or_duplicated")
            self.post(performer, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.anon"}, expected=409)
            self.post(performer, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.tomori"})
            self.post(performer, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.tomori"})
            claimed = self.history(observer, room_id)
            require(len(claimed) == len(joined) + 1 and claimed[-1]["kind"] == "system", "role_entry_event_missing_or_duplicated")

        with self.check("host_removal_releases_role_bans_identity_and_preserves_private_receipt"):
            before = self.history(observer, room_id)
            self.post(observer, f"/api/rooms/{room_id}/members/{performer.member_id}/remove", expected=403)
            self.post(host, f"/api/rooms/{room_id}/members/{host.member_id}/remove", expected=409)
            self.post(host, f"/api/rooms/{room_id}/members/{removed.member_id}/remove")
            self.post(host, f"/api/rooms/{room_id}/members/{removed.member_id}/remove")
            after_removal = self.history(observer, room_id)
            require(len(after_removal) == len(before) + 1 and after_removal[-1]["kind"] == "system", "removal_event_missing_or_duplicated")
            snapshot = self.get(observer, f"/api/rooms/{room_id}")["room"]
            require(all(member["id"] != removed.member_id and member["character_id"] != "mygo.taki" for member in snapshot["members"]), "removed_member_or_role_retained")
            self.get(removed, f"/api/rooms/{room_id}", expected=403)
            self.post(removed, f"/api/rooms/{room_id}/join", expected=403)
            self.post(removed, "/api/session", {"nickname": f"改名检验-{self.run_id[:4]}"})
            self.post(removed, f"/api/rooms/{room_id}/join", expected=403)
            self.post(removed, f"/api/rooms/{room_id}/messages", backstage_body, expected=403)
            receipt = next(row for row in self.get(removed, "/api/reports")["reports"] if row["id"] == backstage_report["id"])
            require(receipt["snapshot"] is None and receipt["snapshot_redacted"] is True, "removed_actor_retains_backstage_snapshot")
            if self.transport.get("type") == "poll":
                self.post(removed, f"/api/rooms/{room_id}/presence", {"connection_id": "probe-main-tab"}, expected=403)

        with self.check("ended_archive_is_durable_and_does_not_gain_visitor_events"):
            self.post(host, f"/api/rooms/{room_id}/control", {"action": "end"})
            before = self.history(observer, room_id)
            self.post(host, f"/api/rooms/{room_id}/control", {"action": "end"})
            self.post(observer, f"/api/rooms/{room_id}/leave")
            self.post(observer, f"/api/rooms/{room_id}/join")
            after_end = self.history(observer, room_id)
            require([item["id"] for item in after_end] == [item["id"] for item in before], "ended_archive_changed_on_revisit")
            self.post(performer, f"/api/rooms/{room_id}/messages", {"channel": "stage", "text": "结束后发言检验", "client_message_id": uuid.uuid4().hex}, expected=409)
            self.post(host, f"/api/rooms/{room_id}/settings", {"background": "", "announcement": ""}, expected=409)
            self.post(host, f"/api/rooms/{room_id}/members/{observer.member_id}/remove", expected=409)
            self.post(performer, f"/api/rooms/{room_id}/characters/claim", {"character_id": "mygo.tomori"}, expected=409)
            require(self.get(observer, f"/api/rooms/{room_id}")["room"]["status"] == "ended", "ended_status_not_shared")

    def cleanup(self) -> None:
        host = self.people[0]
        for room in self.owned_rooms:
            entry: dict[str, Any] = {"operation": "end_owned_room", "room_id": room}
            try:
                result = self.post(host, f"/api/rooms/{room}/control", {"action": "end"})
                require(result["room"]["status"] == "ended", "cleanup_room_not_ended")
                entry["passed"] = True
            except BaseException as error:
                entry.update({"passed": False, "error": safe_error(error)})
            self.report["cleanup"].append(entry)
        for person in self.people:
            if person.authenticated:
                entry = {"operation": "revoke_probe_session", "person": person.label}
                try:
                    self.post(person, "/api/logout")
                    self.get(person, "/api/session", expected=401)
                    entry["passed"] = True
                except BaseException as error:
                    entry.update({"passed": False, "error": safe_error(error)})
                self.report["cleanup"].append(entry)
            person.client.close()

    def execute(self) -> dict:
        try:
            self.run_checks()
            self.report["passed"] = True
        except BaseException as error:
            self.report.update({"passed": False, "failed_check": self.current_check, "error": safe_error(error)})
        finally:
            self.cleanup()
            self.report["cleanup_confirmed"] = bool(self.report["cleanup"]) and all(item["passed"] for item in self.report["cleanup"])
            self.report["passed"] = self.report["passed"] and self.report["cleanup_confirmed"]
            self.report["http_requests"] = self.requests
            self.report["completed_at_utc"] = utc_now()
            self.report["synthetic_room_records_retained"] = self.owned_rooms
            self.report["sensitive_payloads_in_report"] = False
        return self.report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", type=origin, required=True)
    parser.add_argument("--output", type=Path, required=True, help="New JSON report path; existing files are not replaced")
    parser.add_argument("--source", required=True, help="Honest operator-declared network/environment label; not geolocation proof")
    parser.add_argument("--expect-backend", default=None, help="For the deployed Site pass sites-d1")
    parser.add_argument("--expect-version", default=None)
    parser.add_argument("--use-env-proxy", action="store_true", help="Explicitly use the current execution environment's proxy configuration; no proxy URL or credentials are recorded")
    parser.add_argument("--timeout", type=float, default=20)
    parser.add_argument("--delivery-timeout", type=float, default=10)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if not 0 < args.timeout <= 60 or not 0 < args.delivery_timeout <= 60:
        parser.error("Timeouts must be greater than zero and no more than 60 seconds")
    if not args.source.strip() or len(args.source) > 160:
        parser.error("Source label must be 1–160 characters")
    if args.output.exists():
        parser.error("Output already exists; choose a new report filename")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    # Reserve before any network writes; a failure cannot leave an unrecorded run.
    with args.output.open("x", encoding="utf-8") as destination:
        result = Probe(args).execute()
        json.dump(result, destination, ensure_ascii=False, indent=2)
        destination.write("\n")
    print(json.dumps({"passed": result["passed"], "checks": len(result["checks"]), "cleanup_confirmed": result["cleanup_confirmed"], "report": str(args.output), "failed_check": result.get("failed_check")}, ensure_ascii=False))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
