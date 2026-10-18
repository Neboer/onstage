import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]


class LiveServer:
    def __init__(self, root):
        self.root = Path(root)
        self.data_dir = self.root / "data"
        self.data_dir.mkdir()
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            self.port = candidate.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.env = {**os.environ, "ONSTAGE_DATA_DIR": str(self.data_dir),
                    "ONSTAGE_PUBLIC_ORIGIN": self.origin, "ONSTAGE_SECURE_COOKIE": "0",
                    "ONSTAGE_VERSION": "integration-test"}
        self.process = None
        self.log = None

    def start(self):
        self.log = (self.root / "server.log").open("ab")
        self.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
             "--port", str(self.port), "--workers", "1", "--no-access-log", "--no-proxy-headers",
             "--ws-per-message-deflate", "false"],
            cwd=ROOT, env=self.env, stdout=self.log, stderr=subprocess.STDOUT)
        deadline = time.monotonic() + 12
        with httpx.Client(trust_env=False, timeout=0.5) as client:
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    break
                try:
                    if client.get(self.origin + "/readyz").status_code == 200:
                        return self
                except httpx.HTTPError:
                    pass
                time.sleep(0.05)
        self.stop()
        raise AssertionError((self.root / "server.log").read_text(errors="replace")[-5000:])

    def stop(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=2)
        if self.log:
            self.log.close()
            self.log = None

    def restart(self):
        self.stop()
        return self.start()


class Person:
    def __init__(self, server):
        self.server = server
        self.client = httpx.Client(base_url=server.origin, timeout=5, trust_env=False,
                                   headers={"Origin": server.origin})
        result = self.client.post("/api/session", json={})
        assert result.status_code == 200, result.text
        self.csrf = result.json()["csrf_token"]
        self.client.headers["X-CSRF-Token"] = self.csrf

    def post(self, path, body=None):
        response = self.client.post(path, json=body or {})
        assert response.status_code in (200, 201), response.text
        return response.json()

    def get(self, path):
        response = self.client.get(path)
        assert response.status_code == 200, response.text
        return response.json()

    def websocket(self, room_id, *, origin=None):
        from websockets.sync.client import connect
        cookie = "; ".join(f"{name}={value}" for name, value in self.client.cookies.items())
        return connect(self.server.origin.replace("http://", "ws://") +
                       f"/api/rooms/{room_id}/stream",
                       origin=self.server.origin if origin is None else origin,
                       additional_headers={"Cookie": cookie}, proxy=None,
                       open_timeout=3, close_timeout=1, compression=None)

    def close(self):
        self.client.close()


@pytest.fixture
def server(tmp_path):
    instance = LiveServer(tmp_path).start()
    try:
        yield instance
    finally:
        instance.stop()


@pytest.fixture
def people(server):
    created = []
    def factory():
        person = Person(server)
        created.append(person)
        return person
    yield factory
    for person in created:
        person.close()


def create_room(host, scenario="mygo_rehearsal"):
    return host.post("/api/rooms", {"scenario_id": scenario})["room"]["id"]


def seat(host, person, room_id, character_id):
    if host is not person:
        person.post(f"/api/rooms/{room_id}/join")
    return person.post(f"/api/rooms/{room_id}/characters/claim", {"character_id": character_id})["room"]



def live_pair(people):
    host, actor = people(), people()
    room_id = create_room(host)
    seat(host, host, room_id, "mygo.tomori")
    seat(host, actor, room_id, "mygo.anon")
    host.post(f"/api/rooms/{room_id}/control", {"action": "start"})
    return host, actor, room_id


def sticker(person, room_id, sticker_id, channel="stage", message_id=None):
    return person.post(f"/api/rooms/{room_id}/messages", {
        "channel": channel, "content_type": "sticker", "sticker_id": sticker_id,
        "client_message_id": message_id or secrets.token_hex(12),
    })["message"]
