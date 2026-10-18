"""CI-only checkpoint across replacement. State contains synthetic credentials.

Keep the state file in runner temp; never upload it or run against a public service.
"""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import urllib.request
from urllib.parse import urlsplit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["write", "verify"])
    parser.add_argument("state", type=Path)
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    args = parser.parse_args()
    target = urlsplit(args.url)
    if (target.scheme != "http" or target.hostname not in ("127.0.0.1", "localhost", "::1")
            or target.path not in ("", "/") or target.query or target.fragment
            or target.username or target.password):
        parser.error("Only an isolated HTTP loopback origin is supported")
    origin = args.url.rstrip("/")
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    headers = {"Origin": origin}

    def request(path, body=None, *, client=opener, client_headers=headers):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(origin + path, data=data, headers={**client_headers, "Content-Type": "application/json"})
        with client.open(req, timeout=8) as response:
            return json.load(response)

    if args.mode == "write":
        session = request("/api/session", {"nickname": "CI persistence synthetic"})
        headers["X-CSRF-Token"] = session["csrf_token"]
        room = request("/api/rooms", {"scenario_id": "mygo_rehearsal"})["room"]["id"]
        request(f"/api/rooms/{room}/characters/claim", {"character_id": "mygo.tomori"})
        # Starting a scene requires two seated actors. A separate cookie jar
        # creates a genuinely independent synthetic identity, not a shared tab.
        peer_jar = http.cookiejar.CookieJar()
        peer = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(peer_jar))
        peer_headers = {"Origin": origin}
        peer_session = request("/api/session", {"nickname": "CI persistence peer"}, client=peer, client_headers=peer_headers)
        peer_headers["X-CSRF-Token"] = peer_session["csrf_token"]
        request(f"/api/rooms/{room}/join", {}, client=peer, client_headers=peer_headers)
        request(f"/api/rooms/{room}/characters/claim", {"character_id": "mygo.anon"}, client=peer, client_headers=peer_headers)
        request(f"/api/rooms/{room}/control", {"action": "start"})
        body = {"channel": "stage", "text": "synthetic persistence checkpoint", "client_message_id": "ci-persistence-checkpoint"}
        message = request(f"/api/rooms/{room}/messages", body)["message"]
        state = {"room": room, "id": message["id"], "csrf": session["csrf_token"], "cookie": "; ".join(f"{c.name}={c.value}" for c in jar)}
        with args.state.open("x") as destination:
            os.chmod(args.state, 0o600)
            json.dump(state, destination)
    else:
        state = json.loads(args.state.read_text())
        headers.update({"Cookie": state["cookie"], "X-CSRF-Token": state["csrf"]})
        messages = request(f"/api/rooms/{state['room']}/messages?channel=stage&after=0&limit=100")["messages"]
        assert len([row for row in messages if row["id"] == state["id"]]) == 1
        request(f"/api/rooms/{state['room']}/control", {"action": "end"})
        args.state.unlink()
    print(f"container persistence {args.mode}: passed (synthetic loopback only)")


if __name__ == "__main__":
    main()
