#!/usr/bin/env python3
"""Measure real Onstage HTTP/WS sessions, including one controlled reconnect.

Windows and Linux use the same command after installing requirements-dev.txt:
    python tools/network_probe.py --url https://your-host.example --clients 20 \
        --duration 30 --include-stickers --output network-probe.json \
        --city Shanghai --operator Telecom

Omit --include-stickers for the original text-only behavior. Mixed mode selects
real sticker IDs from the site's catalog and verifies each remote content type
and sticker ID against the sender's acknowledged message, including reconnect.

Anonymous sessions are created without an invitation or registration. This
creates a clearly labelled acceptance room and automated messages, then attempts
to end that room, leave its members, and revoke every created session. It never
deletes rooms. Source labels are self-reported; this is not a geolocation check,
browser test, TLS audit, sustained load test, or SLA certification.
"""

from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
import logging
import math
from pathlib import Path
import platform
import sys
import threading
import time
from typing import Any
from urllib.parse import quote, urlsplit
import uuid

import httpx
from websockets.exceptions import InvalidStatus
from websockets.sync.client import connect


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ProbeError(Exception):
    """Only fixed, secret-free error codes may enter a report."""

    def __init__(self, code: str, status: int | None = None):
        self.code = code
        self.status = status
        super().__init__(code)


def safe_error(error: BaseException) -> dict[str, Any]:
    result: dict[str, Any] = {"exception": type(error).__name__}
    if isinstance(error, ProbeError):
        result["code"] = error.code
        if error.status is not None:
            result["http_status"] = error.status
    elif isinstance(error, InvalidStatus):
        result["http_status"] = error.response.status_code
    # Exception text, request/response bodies, and headers are never serialized.
    return result


def request_json(
    client: httpx.Client, method: str, path: str, *,
    body: dict | None = None, expected: int = 200, timeout: float | None = None,
) -> dict:
    options: dict[str, Any] = {}
    if body is not None:
        options["json"] = body
    if timeout is not None:
        options["timeout"] = timeout
    response = client.request(method, path, **options)
    if response.status_code != expected:
        raise ProbeError("unexpected_http_status", response.status_code)
    if expected != 200:
        return {}
    try:
        data = response.json()
    except ValueError:
        raise ProbeError("response_not_json") from None
    if not isinstance(data, dict):
        raise ProbeError("response_not_object")
    return data


def latency_stats(values: list[float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {"samples": 0, "p50": None, "p95": None, "max": None}
    return {
        "samples": len(ordered),
        "p50": round(ordered[math.ceil(0.50 * len(ordered)) - 1], 3),
        "p95": round(ordered[math.ceil(0.95 * len(ordered)) - 1], 3),
        "max": round(ordered[-1], 3),
    }


def select_catalog_stickers(catalog: dict) -> tuple[list[str], set[str]]:
    """Keep supplementary artwork distinct from the ten playable characters."""
    characters = {
        "mygo.tomori", "mygo.anon", "mygo.rana", "mygo.soyo", "mygo.taki",
        "mujica.uika", "mujica.mutsumi", "mujica.umiri", "mujica.nyamu", "mujica.sakiko",
    }
    rows = catalog.get("stickers")
    if not isinstance(rows, list):
        raise ProbeError("catalog_missing_stickers")
    grouped: dict[str, list[str]] = {"supplementary": [], "mygo": [], "mujica": []}
    seen: set[str] = set()
    for item in rows:
        if not isinstance(item, dict):
            raise ProbeError("invalid_sticker_catalog_item")
        sticker_id, character = item.get("id"), item.get("character_id")
        if (
            not isinstance(sticker_id, str) or not 1 <= len(sticker_id) <= 80
            or sticker_id.strip() != sticker_id or sticker_id in seen
        ):
            raise ProbeError("invalid_sticker_catalog_id")
        if "character_id" not in item:
            raise ProbeError("invalid_sticker_catalog_character")
        if character is None:
            category = item.get("source_category")
            if not isinstance(category, str) or not category.strip() or len(category) > 40:
                raise ProbeError("invalid_sticker_catalog_category")
            group = "supplementary"
        else:
            if not isinstance(character, str) or character not in characters:
                raise ProbeError("invalid_sticker_catalog_character")
            group = character.split(".")[0]
        seen.add(sticker_id)
        grouped[group].append(sticker_id)
    if not grouped["mygo"] or not grouped["mujica"]:
        raise ProbeError("sticker_catalog_missing_one_band")
    # Start with supplementary artwork when present, so even the shortest
    # mixed run exercises a null material character without adding an actor.
    selected = [
        group[index]
        for index in range(max(map(len, grouped.values())))
        for group in grouped.values() if index < len(group)
    ]
    return selected, set(grouped["supplementary"])


@dataclass
class Participant:
    index: int
    client: httpx.Client = field(repr=False)
    csrf: str = field(default="", repr=False)
    cookie: str = field(default="", repr=False)
    token_digest: bytes = field(default=b"", repr=False)
    session_created: bool = False
    session_confirmed: bool = False
    joined: bool = False
    member_id: str = ""
    backstage_denied: bool | None = None
    receiver: Receiver | None = field(default=None, repr=False)


class Receiver(threading.Thread):
    """Each participant has a real WS connection and an independent cookie jar."""

    def __init__(self, probe: Probe, participant: Participant):
        super().__init__(name=f"probe-client-{participant.index + 1}", daemon=True)
        self.probe, self.person = probe, participant
        self.ready = threading.Event()
        self.initial_done = threading.Event()
        self.ws = None
        self.connection_context: ExitStack | None = None
        self.cursor = 0
        self.last_pull = 0.0
        self.connections = 0
        self.sync_notifications = 0
        self.periodic_pulls = 0
        self.unexpected_disconnects = 0
        self.wrong_origin_rejected = False
        self.initial_sync_received = False
        self.pong_received = False
        self.is_gap_client = participant.index == probe.args.clients - 1
        self.gap_started: float | None = None
        self.gap_reconnected: float | None = None
        self.gap_catchup_finished: float | None = None
        parsed = urlsplit(probe.ws_url)
        self.no_url_secret = not (
            parsed.query or parsed.fragment or parsed.username or parsed.password
        )

    def connection(self, origin: str):
        return connect(
            self.probe.ws_url, origin=origin,
            additional_headers={"Cookie": self.person.cookie},
            open_timeout=10, close_timeout=1, ping_interval=20,
            ping_timeout=20, max_size=65536, compression=None, proxy=None,
        )

    def verify_origin_rejection(self) -> None:
        bad_origin = "https://onstage-probe-origin.invalid"
        if bad_origin == self.probe.origin:
            bad_origin = "https://different-onstage-probe-origin.invalid"
        try:
            with self.connection(bad_origin):
                raise ProbeError("websocket_accepted_wrong_origin")
        except InvalidStatus as error:
            if error.response.status_code != 403:
                raise ProbeError("wrong_origin_rejection_not_403", error.response.status_code)
            self.wrong_origin_rejected = True

    def pull(self, source: str) -> None:
        for _ in range(100):
            previous = self.cursor
            data = request_json(
                self.person.client, "GET", self.probe.room_path + "/sync",
                # Cursor values are constructed integers; no credentials in URLs.
            ) if previous == 0 else request_json(
                self.person.client, "GET",
                f"{self.probe.room_path}/sync?after_stage={previous}&after_backstage=0",
            )
            visible_at = time.monotonic()
            try:
                stage = data["messages"]["stage"]
                backstage = data["messages"]["backstage"]
                cursor = data["cursors"]["stage"]
                more = data["has_more"]["stage"]
                me = data["room"]["me"]
            except (KeyError, TypeError):
                raise ProbeError("invalid_sync_shape") from None
            if not isinstance(stage, list) or type(cursor) is not int or cursor < previous:
                raise ProbeError("invalid_stage_cursor")
            if self.person.index >= 2 and (backstage or me.get("can_backstage") is not False):
                raise ProbeError("observer_backstage_leak")
            for message in stage:
                if not isinstance(message, dict):
                    raise ProbeError("invalid_message_shape")
                if message.get("kind") != "speech":
                    continue
                if message.get("member_id") not in {person.member_id for person in self.probe.people[:2]}:
                    continue
                # Sticker messages have no client-selected text marker. The
                # probe owns a fresh room and these two authenticated identities;
                # capture their messages even when sync beats the sender's ACK.
                if not self.probe.args.include_stickers and not str(message.get("text", "")).startswith(self.probe.message_prefix):
                    continue
                message_id = message.get("id")
                if not isinstance(message_id, str):
                    raise ProbeError("invalid_message_id")
                with self.probe.lock:
                    observations = self.probe.observed[self.person.index]
                    if message_id in observations:
                        self.probe.duplicate_rows += 1
                    else:
                        observations[message_id] = {
                            "time": visible_at, "source": source,
                            "content_type": message.get("content_type", "text"),
                            "sticker_id": message.get("sticker_id"),
                        }
            self.cursor = cursor
            self.last_pull = time.monotonic()
            if not more:
                return
            if cursor <= previous:
                raise ProbeError("sync_pagination_did_not_advance")
        raise ProbeError("sync_pagination_exceeded_bound")

    @staticmethod
    def payload_type(raw: str | bytes) -> str:
        try:
            data = json.loads(raw)
        except (ValueError, UnicodeDecodeError):
            raise ProbeError("invalid_websocket_json") from None
        if not isinstance(data, dict) or data.get("type") not in {"sync", "pong"}:
            raise ProbeError("unexpected_websocket_payload")
        return data["type"]

    def open_checked(self, source: str) -> None:
        if not self.no_url_secret:
            raise ProbeError("websocket_url_contains_disallowed_components")
        # The socket survives multiple receive-loop iterations. ExitStack keeps
        # the supported context-manager lifetime across those iterations and
        # exits it on disconnect, reconnect failure, and final shutdown.
        self.connection_context = ExitStack()
        self.ws = self.connection_context.enter_context(self.connection(self.probe.origin))
        self.connections += 1
        if source == "controlled_reconnect":
            self.gap_reconnected = time.monotonic()
        self.ws.send("ping")
        got_sync = got_pong = False
        deadline = time.monotonic() + 10
        while not (got_sync and got_pong):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ProbeError("initial_sync_or_pong_timeout")
            kind = self.payload_type(self.ws.recv(timeout=remaining))
            if kind == "sync":
                self.sync_notifications += 1
                if not got_sync:
                    self.pull(source)
                got_sync = True
            elif kind == "pong":
                got_pong = True
        self.initial_sync_received = True
        self.pong_received = True
        if source == "controlled_reconnect":
            # Drain again because messages may have committed during the handshake.
            self.pull(source)
            self.gap_catchup_finished = time.monotonic()

    def close_socket(self) -> None:
        context, self.connection_context = self.connection_context, None
        self.ws = None
        if context is not None:
            try:
                context.close()
            except Exception:
                pass

    def run(self) -> None:
        try:
            self.verify_origin_rejection()
            self.open_checked("initial_sync")
            self.ready.set()
        except Exception as error:
            self.probe.record_error("initial_websocket", error, self.person.index)
            self.close_socket()
            return
        finally:
            self.initial_done.set()
        pending_source = "unexpected_reconnect"
        retry_delay = 1.0
        try:
            while not self.probe.stop.is_set():
                started = self.probe.load_started
                if (
                    self.is_gap_client and started is not None and self.gap_started is None
                    and time.monotonic() >= started + self.probe.gap_offset
                ):
                    self.gap_started = time.monotonic()
                    self.close_socket()
                    if self.probe.stop.wait(self.probe.gap_duration):
                        break
                    pending_source = "controlled_reconnect"
                try:
                    if self.ws is None:
                        try:
                            self.open_checked(pending_source)
                        except TimeoutError:
                            # A connect/handshake timeout is a failure; only a
                            # quiet, already-open socket is a normal recv timeout.
                            raise ProbeError("reconnect_timeout") from None
                        pending_source = "unexpected_reconnect"
                        retry_delay = 1.0
                    kind = self.payload_type(self.ws.recv(timeout=0.25))
                    if kind == "sync":
                        self.sync_notifications += 1
                        self.pull("websocket_sync")
                except TimeoutError:
                    if time.monotonic() - self.last_pull >= 5:
                        self.periodic_pulls += 1
                        try:
                            self.pull("periodic_sync")
                        except Exception as error:
                            self.probe.record_error("periodic_sync", error, self.person.index)
                except Exception as error:
                    if self.probe.stop.is_set():
                        break
                    self.unexpected_disconnects += 1
                    self.probe.record_error("receive_or_sync", error, self.person.index)
                    self.close_socket()
                    if self.probe.stop.wait(retry_delay):
                        break
                    retry_delay = min(retry_delay * 2, 8)
        finally:
            self.close_socket()


class Probe:
    def __init__(self, args: argparse.Namespace):
        self.args, self.origin = args, args.url
        self.run_id = uuid.uuid4().hex
        self.message_prefix = f"[network-probe {self.run_id}]"
        self.started_utc = utc_now()
        self.started = time.monotonic()
        self.load_started: float | None = None
        self.load_finished: float | None = None
        self.gap_offset = args.duration / 3
        self.gap_duration = min(5.0, args.duration / 3)
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.people: list[Participant] = []
        self.observed: list[dict[str, dict]] = [{} for _ in range(args.clients)]
        self.acknowledged: dict[str, dict] = {}
        self.sticker_ids: list[str] = []
        self.supplementary_sticker_ids: set[str] = set()
        self.submitted = 0
        self.duplicate_rows = 0
        self.errors: list[dict] = []
        self.checks: dict[str, bool | None] = {}
        self.room_id: str | None = None
        self.room_path = self.ws_url = ""
        self.version: str | None = None
        self.finished_load = False
        self.interrupted = False
        self.cleanup_report: dict = {}

    def record_error(self, phase: str, error: BaseException, index: int | None = None) -> None:
        item = {"phase": phase, **safe_error(error)}
        if index is not None:
            item["client"] = index + 1
        with self.lock:
            self.errors.append(item)

    def setup(self) -> None:
        for index in range(self.args.clients):
            client = httpx.Client(
                base_url=self.origin, headers={"Origin": self.origin},
                timeout=httpx.Timeout(10.0), follow_redirects=False,
                trust_env=False, verify=True,
            )
            person = Participant(index, client)
            self.people.append(person)
            if index == 0:
                if request_json(client, "GET", "/healthz").get("status") != "ok":
                    raise ProbeError("health_check_not_ok")
                if request_json(client, "GET", "/readyz").get("status") != "ready":
                    raise ProbeError("database_not_ready")
                self.checks["health_and_readiness"] = True
            data = request_json(client, "POST", "/api/session", body={})
            person.session_created = True
            csrf = data.get("csrf_token")
            token = client.cookies.get("onstage_session")
            if data.get("authenticated") is not True or not isinstance(csrf, str) or not token:
                raise ProbeError("login_response_missing_session_or_csrf")
            person.csrf = csrf
            person.cookie = f"onstage_session={token}"
            person.token_digest = hashlib.sha256(token.encode()).digest()
            client.headers["X-CSRF-Token"] = csrf
            confirmed = request_json(client, "GET", "/api/session")
            person.session_confirmed = confirmed.get("authenticated") is True
            if not person.session_confirmed:
                raise ProbeError("session_not_confirmed")
            if index == 0:
                self.version = str(confirmed.get("version", ""))[:160]
        self.checks["independent_confirmed_sessions"] = (
            len({p.token_digest for p in self.people}) == self.args.clients
            and all(p.session_confirmed for p in self.people)
        )
        host = self.people[0]
        if self.args.include_stickers:
            catalog = request_json(host.client, "GET", "/api/catalog")
            self.sticker_ids, self.supplementary_sticker_ids = select_catalog_stickers(catalog)
            self.checks["sticker_ids_loaded_from_both_catalog_bands"] = True
        room = request_json(host.client, "POST", "/api/rooms", body={
            "scenario_id": "shared_greenroom",
            "title": f"联机验收用 · {self.started_utc[:16]} · {self.run_id[:8]}",
        }).get("room", {})
        room_id = room.get("id")
        if not isinstance(room_id, str) or not room_id:
            raise ProbeError("create_room_missing_id")
        self.room_id = room_id
        self.room_path = "/api/rooms/" + quote(room_id, safe="")
        self.ws_url = ("wss" if self.origin.startswith("https:") else "ws") + "://" + \
            urlsplit(self.origin).netloc + self.room_path + "/stream"
        host.joined = True
        host.member_id = room["me"]["member_id"]
        for person in self.people[1:]:
            joined = request_json(person.client, "POST", self.room_path + "/join", body={})["room"]
            person.joined = True
            person.member_id = joined["me"]["member_id"]
        self.checks["distinct_room_members"] = (
            len({p.member_id for p in self.people}) == self.args.clients
        )
        for person, character in zip(self.people[:2], ["mygo.tomori", "mujica.sakiko"]):
            request_json(person.client, "POST", self.room_path + "/characters/claim", body={
                "character_id": character,
            })
            me = request_json(person.client, "GET", self.room_path)["room"]["me"]
            if me.get("character_id") != character:
                raise ProbeError("claimed_seat_not_assigned")
            request_json(person.client, "GET", self.room_path + "/messages?channel=backstage")
        self.checks["two_actors_claimed_distinct_seats"] = True
        for person in self.people[2:]:
            request_json(person.client, "GET", self.room_path + "/messages?channel=backstage", expected=403)
            person.backstage_denied = True
        self.checks["every_observer_backstage_http_403"] = True
        live = request_json(host.client, "POST", self.room_path + "/control", body={"action": "start"})
        self.checks["host_started_live_room"] = live.get("room", {}).get("status") == "live"
        if not self.checks["host_started_live_room"]:
            raise ProbeError("room_did_not_start")
        request_json(self.people[2].client, "POST", self.room_path + "/messages", body={
            "channel": "stage", "text": "自动权限验收：此观众消息应被拒绝。",
            "client_message_id": f"probe-denied-{self.run_id}",
        }, expected=403)
        self.checks["observer_stage_send_http_403"] = True
        if self.args.include_stickers:
            request_json(self.people[2].client, "POST", self.room_path + "/messages", body={
                "channel": "stage", "content_type": "sticker", "sticker_id": self.sticker_ids[0],
                "client_message_id": f"probe-sticker-denied-{self.run_id}",
            }, expected=403)
            self.checks["observer_sticker_send_http_403"] = True
        for person in self.people:
            person.receiver = Receiver(self, person)
            person.receiver.start()
        deadline = time.monotonic() + 45
        for person in self.people:
            receiver = person.receiver
            if not receiver.initial_done.wait(max(0, deadline - time.monotonic())) or not receiver.ready.is_set():
                raise ProbeError("not_all_websockets_ready")
        final_room = request_json(host.client, "GET", self.room_path)["room"]
        self.checks["all_clients_counted_online"] = final_room.get("online_count") == self.args.clients
        if not self.checks["all_clients_counted_online"]:
            raise ProbeError("online_count_does_not_match_clients")

    def deliveries_complete(self) -> bool:
        with self.lock:
            return bool(self.acknowledged) and all(
                message_id in self.observed[index]
                and all(self.observed[index][message_id][key] == sent[key] for key in ("content_type", "sticker_id"))
                for message_id, sent in self.acknowledged.items()
                for index in range(self.args.clients) if index != sent["sender"]
            )

    def run_load(self) -> None:
        self.load_started = time.monotonic()
        deadline = self.load_started + self.args.duration
        next_send = self.load_started
        sticker_number = 0
        while time.monotonic() < deadline:
            delay = min(next_send, deadline) - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            if time.monotonic() >= deadline:
                break
            ordinal = self.submitted + 1
            sender = (ordinal - 1) % 2
            use_sticker = self.args.include_stickers and ordinal % 4 in {2, 3}
            body = {
                "channel": "stage", "client_message_id": f"probe-{self.run_id}-{ordinal:03d}",
            }
            if use_sticker:
                expected_type, expected_sticker = "sticker", self.sticker_ids[sticker_number % len(self.sticker_ids)]
                sticker_number += 1
                body.update(content_type="sticker", sticker_id=expected_sticker)
            else:
                expected_type, expected_sticker = "text", None
                body["text"] = f"{self.message_prefix} 自动联机验收消息 {ordinal:03d}"
            send_started = time.monotonic()
            self.submitted += 1
            data = request_json(self.people[sender].client, "POST", self.room_path + "/messages", body=body)
            acknowledged = time.monotonic()
            message = data.get("message", {})
            message_id = message.get("id")
            expected_character = ["mygo.tomori", "mujica.sakiko"][sender]
            if (
                not isinstance(message_id, str) or message.get("character_id") != expected_character
                or message.get("member_id") != self.people[sender].member_id
                or message.get("kind") != "speech" or message.get("channel") != "stage"
            ):
                raise ProbeError("message_ack_invalid_id_or_author")
            if (
                message.get("content_type", "text") != expected_type
                or message.get("sticker_id") != expected_sticker
                or (expected_type == "text" and message.get("text") != body["text"])
            ):
                raise ProbeError("message_ack_does_not_match_requested_payload")
            with self.lock:
                if message_id in self.acknowledged:
                    raise ProbeError("different_sends_returned_duplicate_message_id")
                self.acknowledged[message_id] = {
                    "ordinal": ordinal, "sender": sender, "sent_at": send_started,
                    "acked_at": acknowledged, "seq": message.get("seq"),
                    "content_type": expected_type, "sticker_id": expected_sticker,
                }
            # Never catch up with a burst; alternate actors with >=1s between sends.
            next_send = send_started + 1.0
        self.load_finished = time.monotonic()
        self.finished_load = True
        grace_deadline = time.monotonic() + 10
        while time.monotonic() < grace_deadline:
            gap = self.people[-1].receiver
            if self.deliveries_complete() and gap.gap_catchup_finished is not None:
                break
            time.sleep(0.1)

    def cleanup(self) -> None:
        self.stop.set()
        for person in self.people:
            if person.receiver is not None:
                person.receiver.join(timeout=12)
        self.cleanup_report["receiver_threads_stopped"] = all(
            p.receiver is None or not p.receiver.is_alive() for p in self.people
        )
        ended = None
        if self.room_id and self.people:
            try:
                data = request_json(self.people[0].client, "POST", self.room_path + "/control",
                                    body={"action": "end"}, timeout=5)
                ended = data.get("room", {}).get("status") == "ended"
            except Exception as error:
                ended = False
                self.record_error("cleanup_end_room", error, 0)
        self.cleanup_report["created_room_ended"] = ended

        def clean_person(person: Participant) -> dict:
            result = {"client": person.index + 1, "left_room": None, "session_revoked": None}
            if person.joined and self.room_id:
                try:
                    request_json(person.client, "POST", self.room_path + "/leave", body={}, timeout=4)
                    result["left_room"] = True
                except Exception as error:
                    result["left_room"] = False
                    self.record_error("cleanup_leave", error, person.index)
            if person.session_created:
                try:
                    if not person.csrf or not person.cookie:
                        raise ProbeError("cannot_revoke_unconfirmed_login_response")
                    original_cookie = person.cookie
                    request_json(person.client, "POST", "/api/logout", body={}, timeout=4)
                    # Send the OLD cookie explicitly: an empty cookie jar alone
                    # would not prove that the server revoked the session.
                    response = person.client.get(
                        "/api/session", headers={"Cookie": original_cookie}, timeout=4,
                    )
                    if response.status_code != 401:
                        raise ProbeError("old_session_still_accepted", response.status_code)
                    result["session_revoked"] = True
                except Exception as error:
                    result["session_revoked"] = False
                    self.record_error("cleanup_logout", error, person.index)
            person.client.close()
            return result

        if self.people:
            with ThreadPoolExecutor(max_workers=min(30, len(self.people))) as executor:
                results = list(executor.map(clean_person, self.people))
        else:
            results = []
        self.cleanup_report["clients"] = results
        self.cleanup_report["sessions_revoked"] = sum(x["session_revoked"] is True for x in results)
        self.cleanup_report["members_left"] = sum(x["left_room"] is True for x in results)
        self.cleanup_report["all_attempted_actions_confirmed"] = (
            ended is not False and self.cleanup_report["receiver_threads_stopped"]
            and all(x["left_room"] is not False and x["session_revoked"] is not False for x in results)
        )

    def report(self) -> dict:
        gap = self.people[-1].receiver if len(self.people) == self.args.clients else None
        gap_start = gap.gap_started if gap else None
        gap_end = gap.gap_reconnected if gap else None
        ack_ms, sent_ms, normal_ack_ms, post_ms = [], [], [], []
        source_counts: Counter = Counter()
        observed_before_ack = deliveries = payload_mismatches = 0
        per_message, gap_missing_ids, gap_recovered_ids = [], [], []
        with self.lock:
            acknowledged = dict(self.acknowledged)
            observed = [dict(rows) for rows in self.observed]
        for message_id, sent in acknowledged.items():
            post_ms.append((sent["acked_at"] - sent["sent_at"]) * 1000)
            missing, mismatched, message_latencies = [], [], []
            for index in range(self.args.clients):
                if index == sent["sender"]:
                    continue
                observation = observed[index].get(message_id)
                if observation is None:
                    missing.append(index + 1)
                    continue
                if any(observation[key] != sent[key] for key in ("content_type", "sticker_id")):
                    payload_mismatches += 1
                    mismatched.append(index + 1)
                    continue
                deliveries += 1
                signed = (observation["time"] - sent["acked_at"]) * 1000
                latency = max(0.0, signed)
                observed_before_ack += signed < 0
                ack_ms.append(latency)
                message_latencies.append(latency)
                sent_ms.append((observation["time"] - sent["sent_at"]) * 1000)
                source_counts[observation["source"]] += 1
                was_gap_delivery = (
                    gap_start is not None and gap_end is not None and index == self.args.clients - 1
                    and gap_start <= sent["acked_at"] <= gap_end
                )
                if not was_gap_delivery:
                    normal_ack_ms.append(latency)
            if gap_start is not None and gap_end is not None and gap_start <= sent["acked_at"] <= gap_end:
                gap_observation = observed[-1].get(message_id)
                # Only messages not already seen before disconnect count as missed.
                if gap_observation is None or gap_observation["time"] >= gap_start:
                    gap_missing_ids.append(message_id)
                    if (
                        gap_observation is not None and gap_observation["time"] >= gap_end
                        and all(gap_observation[key] == sent[key] for key in ("content_type", "sticker_id"))
                    ):
                        gap_recovered_ids.append(message_id)
            per_message.append({
                "ordinal": sent["ordinal"], "sender_client": sent["sender"] + 1,
                "server_message_id": message_id, "stage_seq": sent["seq"],
                "content_type": sent["content_type"], "sticker_id": sent["sticker_id"],
                "ack_after_load_start_seconds": round(sent["acked_at"] - self.load_started, 6),
                "expected_remote_deliveries": self.args.clients - 1,
                "remote_deliveries": self.args.clients - 1 - len(missing) - len(mismatched),
                "missing_clients": missing, "payload_mismatch_clients": mismatched,
                "ack_to_remote_visible_ms": latency_stats(message_latencies),
            })
        expected = len(acknowledged) * (self.args.clients - 1)
        receivers = [p.receiver for p in self.people if p.receiver is not None]
        self.checks.update({
            "all_connections_reject_wrong_origin_403": len(receivers) == self.args.clients and all(r.wrong_origin_rejected for r in receivers),
            "all_websocket_urls_have_no_credentials_or_query": len(receivers) == self.args.clients and all(r.no_url_secret for r in receivers),
            "all_initial_connections_received_sync_and_pong": len(receivers) == self.args.clients and all(r.ready.is_set() for r in receivers),
            "scheduled_messages_acknowledged": self.finished_load and len(acknowledged) == self.args.duration,
            "all_acknowledged_messages_delivered_to_other_clients": expected > 0 and deliveries == expected,
            "all_remote_content_types_and_sticker_ids_match_ack": expected > 0 and payload_mismatches == 0 and deliveries == expected,
            "no_duplicate_message_rows": self.duplicate_rows == 0,
            "controlled_observer_reconnected": gap is not None and gap.gap_catchup_finished is not None,
            "controlled_gap_messages_recovered": bool(gap_missing_ids) and len(gap_missing_ids) == len(gap_recovered_ids),
            "cleanup_confirmed": self.cleanup_report.get("all_attempted_actions_confirmed", False),
            "no_unexpected_protocol_or_network_errors": not self.errors,
        })
        union_observed = set().union(*(set(rows) for rows in observed))
        content_counts = dict(Counter(sent["content_type"] for sent in acknowledged.values()))
        supplementary_count = sum(
            sent["content_type"] == "sticker" and sent["sticker_id"] in self.supplementary_sticker_ids
            for sent in acknowledged.values()
        )
        if self.args.include_stickers:
            self.checks["both_text_and_sticker_messages_acknowledged"] = (
                content_counts.get("text", 0) > 0 and content_counts.get("sticker", 0) > 0
            )
            if self.supplementary_sticker_ids:
                self.checks["supplementary_sticker_message_acknowledged"] = supplementary_count > 0
        outcome = "interrupted" if self.interrupted else (
            "pass" if self.finished_load and all(value is True for value in self.checks.values()) else "fail"
        )
        return {
            "report_schema": "onstage.network_probe.v1", "run_id": self.run_id, "outcome": outcome,
            "started_at_utc": self.started_utc, "finished_at_utc": utc_now(),
            "target_origin": self.origin, "server_version": self.version, "created_room_id": self.room_id,
            "source": {"city": self.args.city, "operator": self.args.operator,
                       "self_reported": True, "geolocation_verified": False},
            "scope": {
                "description": "One machine running independent authenticated sessions through real HTTP and WebSocket connections.",
                "automated_protocol_clients": True, "physical_human_participants_measured": False,
                "environment_proxy_settings_used": False,
                "https_certificate_verification_enabled": self.origin.startswith("https:"),
                "not_tested": ["mainland_geolocation", "browser_layout", "public_tls_audit",
                               "sticker_image_rendering", "long_term_load", "sla", "multiple_carriers_or_cities"],
                "no_geographic_or_public_deployment_claim_from_local_success": True,
            },
            "runtime": {"os": platform.system(), "python": platform.python_version(),
                        "httpx": version("httpx"), "websockets": version("websockets")},
            "requested": {"clients": self.args.clients, "duration_seconds": self.args.duration,
                          "messages_per_second": 1, "actors": 2,
                          "include_stickers": self.args.include_stickers,
                          "scheduled_messages": self.args.duration, "periodic_sync_seconds": 5},
            "measured": {
                "total_elapsed_seconds": round(time.monotonic() - self.started, 3),
                "active_send_elapsed_seconds": round(self.load_finished - self.load_started, 3)
                    if self.load_finished is not None and self.load_started is not None else None,
                "confirmed_sessions": sum(p.session_confirmed for p in self.people),
                "unique_session_cookies": len({p.token_digest for p in self.people if p.token_digest}),
                "submitted_messages": self.submitted, "acknowledged_unique_messages": len(acknowledged),
                "acknowledged_messages_by_content_type": content_counts,
                "acknowledged_supplementary_sticker_messages": supplementary_count,
                "unique_probe_messages_observed": len(union_observed),
                "observed_messages_without_http_ack": len(union_observed - set(acknowledged)),
                "expected_remote_deliveries": expected, "unique_remote_deliveries": deliveries,
                "delivery_rate": deliveries / expected if expected else None,
                "remote_payload_mismatches": payload_mismatches,
                "duplicate_message_rows_in_sync": self.duplicate_rows,
                "first_visibility_source_counts": dict(source_counts),
                "http_message_confirmation_ms": latency_stats(post_ms),
                "send_to_remote_visible_ms": latency_stats(sent_ms),
                "ack_to_remote_visible_ms": latency_stats(ack_ms),
                "ack_to_remote_visible_excluding_controlled_gap_ms": latency_stats(normal_ack_ms),
                "remote_deliveries_visible_before_sender_received_ack": observed_before_ack,
                "latency_definition": "Client monotonic clock; remote visibility is first parsed HTTP sync response. Ack-to-visible is max(0, visibility minus sender HTTP acknowledgement); pre-ack visibility is counted separately. All-delivery latency includes the controlled offline gap. Percentiles use nearest rank.",
            },
            "controlled_disconnect": {
                "client": self.args.clients, "role": "observer",
                "planned_offset_seconds": round(self.gap_offset, 3),
                "planned_offline_seconds": round(self.gap_duration, 3),
                "actual_offline_seconds": round(gap_end - gap_start, 3) if gap_start is not None and gap_end is not None else None,
                "http_sync_suspended_while_offline": True if gap_start is not None else None,
                "acknowledged_messages_missed_during_gap": len(gap_missing_ids),
                "missed_messages_recovered_after_reconnect": len(gap_recovered_ids),
            },
            "checks": self.checks,
            "clients": [{
                "client": p.index + 1, "role": "host_actor" if p.index == 0 else "actor" if p.index == 1 else "observer",
                "session_confirmed": p.session_confirmed, "backstage_http_403": p.backstage_denied,
                "websocket_connections": p.receiver.connections if p.receiver else 0,
                "wrong_origin_http_403": p.receiver.wrong_origin_rejected if p.receiver else None,
                "websocket_url_no_credentials_or_query": p.receiver.no_url_secret if p.receiver else None,
                "origin_header_equals_target_origin": True if p.receiver and p.receiver.connections else None,
                "initial_sync_and_pong": p.receiver.ready.is_set() if p.receiver else None,
                "sync_notifications": p.receiver.sync_notifications if p.receiver else 0,
                "periodic_pulls": p.receiver.periodic_pulls if p.receiver else 0,
                "unexpected_disconnects": p.receiver.unexpected_disconnects if p.receiver else 0,
                "unique_probe_messages_observed": len(observed[p.index]),
            } for p in self.people],
            "messages": per_message, "cleanup": self.cleanup_report, "errors": self.errors,
        }


def bounded_int(low: int, high: int):
    def parse(value: str) -> int:
        try:
            number = int(value)
        except ValueError:
            raise argparse.ArgumentTypeError("must be an integer") from None
        if not low <= number <= high:
            raise argparse.ArgumentTypeError(f"must be between {low} and {high}")
        return number
    return parse


def origin_argument(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
        if (
            parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
            or any(char.isspace() for char in value) or (port is not None and port < 1)
        ):
            raise ValueError
    except ValueError:
        raise argparse.ArgumentTypeError("use an exact http(s) origin, without credentials, path, query, or fragment") from None
    return f"{parsed.scheme}://{parsed.netloc}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--url", required=True, type=origin_argument, help="Exact configured public origin; no URL credentials")
    parser.add_argument("--clients", type=bounded_int(3, 30), default=20)
    parser.add_argument("--duration", type=bounded_int(5, 120), default=30, help="Active sending duration in seconds")
    parser.add_argument("--include-stickers", action="store_true", help="Mix text with real catalog stickers and verify remote payload identity")
    parser.add_argument("--output", type=Path, default=Path("network-probe-result.json"), help="JSON report file (also written on failure)")
    parser.add_argument("--city", default=None, help="Optional, self-reported test source city")
    parser.add_argument("--operator", default=None, help="Optional, self-reported network operator")
    args = parser.parse_args()
    # Prevent libraries from logging handshakes, headers, cookies, or request bodies.
    for name in ("httpx", "httpcore", "websockets"):
        logging.getLogger(name).disabled = True
        logging.getLogger(name).setLevel(logging.CRITICAL + 1)
    probe = Probe(args)
    try:
        print(f"Running {args.clients} independent sessions for {args.duration}s; setup and cleanup add time.", flush=True)
        probe.setup()
        probe.run_load()
    except KeyboardInterrupt:
        probe.interrupted = True
        probe.record_error("interrupted", ProbeError("operator_interrupted"))
    except Exception as error:
        probe.record_error("run", error)
    finally:
        if probe.load_started is not None and probe.load_finished is None:
            probe.load_finished = time.monotonic()
        try:
            probe.cleanup()
        except Exception as error:
            probe.record_error("cleanup", error)
            probe.cleanup_report["all_attempted_actions_confirmed"] = False
    report = probe.report()
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except OSError:
        print("Could not write the JSON report; check the output location. No credentials were printed.", file=sys.stderr)
        return 2
    print(f"Probe {report['outcome']}; JSON report: {args.output}")
    print("Source labels are self-reported. This does not certify mainland location, browser layout, TLS configuration, or an SLA.")
    return 130 if probe.interrupted else 0 if report["outcome"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
