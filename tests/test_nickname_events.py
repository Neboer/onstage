import concurrent.futures
import json
import secrets

import httpx
import pytest
from websockets.exceptions import ConnectionClosed

from conftest import create_room, seat
from test_guest_moderation import report
from test_multiplayer import speech


def named(people, nickname):
    person = people()
    result = person.post("/api/session", {"nickname": nickname})
    assert result["nickname"] == nickname and result["requires_nickname"] is False
    return person


def history(person, room_id):
    return person.get(f"/api/rooms/{room_id}/messages")["messages"]


def drain_before_action(socket):
    socket.send("ping")
    for _ in range(30):
        if json.loads(socket.recv(timeout=2))["type"] == "pong":
            return
    raise AssertionError("No pong after draining old sync notifications")


def expect_sync(socket):
    for _ in range(30):
        if json.loads(socket.recv(timeout=2))["type"] == "sync":
            return
    raise AssertionError("No sync notification for committed event")


def test_new_named_guest_resumes_exact_identity_and_same_nickname_never_merges_users(server):
    with httpx.Client(base_url=server.origin, trust_env=False, headers={"Origin": server.origin}) as host, \
            httpx.Client(base_url=server.origin, trust_env=False, headers={"Origin": server.origin}) as other:
        first = host.post("/api/session", json={"nickname": "  星雨  "})
        assert first.status_code == 200
        session = first.json()
        assert session["nickname"] == "星雨" and session["requires_nickname"] is False
        token, csrf = host.cookies.get("onstage_session"), session["csrf_token"]
        host.headers["X-CSRF-Token"] = csrf
        room = host.post("/api/rooms", json={"scenario_id": "shared_greenroom"}).json()["room"]
        room_id, member_id = room["id"], room["me"]["member_id"]
        original_event = host.get(f"/api/rooms/{room_id}/messages").json()["messages"][0]
        assert original_event["text"] == "星雨 以观众身份进入了房间。"
        for body in ({}, {"nickname": "星雨"}, {"nickname": None}, {"nickname": "  "}):
            resumed = host.post("/api/session", json=body, headers={"X-CSRF-Token": ""})
            assert resumed.status_code == 200 and "set-cookie" not in resumed.headers
            assert resumed.json()["nickname"] == "星雨"
            assert resumed.json()["csrf_token"] == csrf
            assert host.cookies.get("onstage_session") == token
        denied = host.post("/api/session", json={"nickname": "晚星"}, headers={"X-CSRF-Token": ""})
        assert denied.status_code == 403
        changed = host.post("/api/session", json={"nickname": "晚星"})
        assert changed.status_code == 200 and changed.json()["nickname"] == "晚星"
        assert host.cookies.get("onstage_session") == token
        assert changed.json()["csrf_token"] == csrf
        assert host.get(f"/api/rooms/{room_id}").json()["room"]["me"]["member_id"] == member_id
        assert host.get(f"/api/rooms/{room_id}/messages").json()["messages"] == [original_event]
        # The same visible nickname creates a separate opaque identity and grants no host authority.
        second = other.post("/api/session", json={"nickname": "晚星"}).json()
        other.headers["X-CSRF-Token"] = second["csrf_token"]
        assert other.cookies.get("onstage_session") != token
        assert second["csrf_token"] != csrf
        assert other.get(f"/api/rooms/{room_id}").json()["room"]["me"] is None
        joined = other.post(f"/api/rooms/{room_id}/join", json={}).json()["room"]
        assert joined["me"]["member_id"] != member_id
        assert joined["me"]["is_host"] is False
        assert other.post(f"/api/rooms/{room_id}/control", json={"action": "end"}).status_code == 403
        server.restart()
        assert host.get("/api/session").json()["nickname"] == "晚星"
        assert host.get(f"/api/rooms/{room_id}").json()["room"]["me"]["member_id"] == member_id


def test_legacy_unnamed_session_can_be_named_without_changing_its_cookie_or_membership(people):
    person = people()
    initial = person.get("/api/session")
    assert initial["nickname"] is None and initial["requires_nickname"] is True
    room_id = create_room(person)
    before = person.get(f"/api/rooms/{room_id}")["room"]
    cookie = person.client.cookies.get("onstage_session")
    assert before["me"]["nickname"] is None
    assert before["members"][0]["display_name"] == "观众 1"
    # Programmatic empty entry remains usable, while the webpage can gate on requires_nickname.
    assert person.post("/api/session")["requires_nickname"] is True
    assert person.client.post("/api/session", json={"nickname": "小雨"},
                              headers={"X-CSRF-Token": ""}).status_code == 403
    person.post("/api/session", {"nickname": "小雨"})
    after = person.get(f"/api/rooms/{room_id}")["room"]
    assert person.client.cookies.get("onstage_session") == cookie
    assert after["me"]["member_id"] == before["me"]["member_id"]
    assert after["me"]["is_host"] is True and after["me"]["nickname"] == "小雨"
    assert after["members"][0]["display_name"] == "小雨"
    assert after["members"][0]["alias"] == "观众 1"
    assert history(person, room_id)[0]["text"] == "观众 1 以观众身份进入了房间。"
    for invalid in ("字" * 25, "小\n雨", "小雨\n", "小\t雨", "小\u2028雨", "小\u202e雨", "小\x00雨", 123):
        assert person.client.post("/api/session", json={"nickname": invalid}).status_code == 422
        assert person.get("/api/session")["nickname"] == "小雨"
    assert person.client.post("/api/session", json={"nickname": "小雨", "password": "unused"}).status_code == 422
    # A newly chosen name resembling the old anonymous prefix is still the
    # user's actual text, not a legacy alias to rewrite when reading history.
    person.post("/api/session", {"nickname": "旅人·小雨"})
    message = speech(person, room_id, "未选角房主在后台协调", "backstage")
    assert message["author"] == "旅人·小雨" and message["character_id"] is None
    person.post("/api/session", {"nickname": "晴空"})
    assert person.get(f"/api/rooms/{room_id}/messages?channel=backstage")["messages"][-1] == message


def test_room_events_are_durable_idempotent_named_and_archives_do_not_gain_visitor_events(people):
    host, actor, observer = named(people, "灯台"), named(people, "小雨"), named(people, "看客")
    room_id = create_room(host)
    path = f"/api/rooms/{room_id}"
    # Simultaneous retries represent one transition, including before membership exists.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: actor.post(path + "/join"), range(2)))
    member_id = results[0]["room"]["me"]["member_id"]
    assert all(item["room"]["me"]["member_id"] == member_id for item in results)
    spectator = observer.post(path + "/join")["room"]["me"]
    assert spectator["character_id"] is None and not spectator["can_stage"] and not spectator["can_backstage"]
    assert observer.client.get(path + "/messages?channel=backstage").status_code == 403
    assert observer.client.post(path + "/messages", json={
        "channel": "stage", "text": "不能作为观众发言", "client_message_id": secrets.token_hex(12),
    }).status_code == 403
    seat(host, host, room_id, "mygo.tomori")
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: actor.post(path + "/characters/claim", {"character_id": "mygo.soyo"}), range(2)))
    original = history(host, room_id)
    assert [message["text"] for message in original] == [
        "灯台 以观众身份进入了房间。", "小雨 以观众身份进入了房间。", "看客 以观众身份进入了房间。",
        "灯台 作为 高松灯 入场。", "小雨 作为 长崎素世 入场。",
    ]
    assert all(message["kind"] == "system" and message["author"] == "系统" and
               message["member_id"] is None and message["character_id"] is None for message in original)
    assert host.client.post(path + "/messages", json={
        "channel": "stage", "kind": "system", "text": "伪造入场", "client_message_id": secrets.token_hex(12),
    }).status_code == 422
    actor.post("/api/session", {"nickname": "新昵称"})
    renamed = host.get(path)["room"]
    actor_row = next(member for member in renamed["members"] if member["id"] == member_id)
    assert actor_row["nickname"] == "新昵称" and actor_row["display_name"] == "长崎素世"
    assert history(host, room_id) == original
    actor.post(path + "/leave")
    last_leave = history(host, room_id)[-1]
    assert last_leave["text"] == "新昵称（长崎素世）主动离开了房间。"
    actor.post(path + "/leave")
    assert history(host, room_id)[-1] == last_leave
    rejoined = actor.post(path + "/join")["room"]["me"]
    assert rejoined["member_id"] == member_id and rejoined["character_id"] is None
    assert rejoined["first_character_id"] == "mygo.soyo"
    assert actor.client.post(path + "/characters/claim", json={"character_id": "mygo.anon"}).status_code == 409
    actor.post(path + "/characters/claim", {"character_id": "mygo.soyo"})
    assert history(host, room_id)[-1]["text"] == "新昵称 作为 长崎素世 入场。"
    # Cursor pages include the event stream exactly once, including the last committed event.
    collected, cursor = [], 0
    while True:
        page = observer.get(path + f"/messages?after={cursor}&limit=2")
        collected.extend(page["messages"])
        cursor = page["cursor"]
        if not page["has_more"]:
            break
    assert collected == history(host, room_id)
    assert observer.get(path + f"/sync?after_stage={cursor}")["messages"]["stage"] == []
    host.post(path + "/control", {"action": "end"})
    frozen = history(observer, room_id)
    actor.post(path + "/leave")
    actor.post(path + "/join")
    visitor = named(people, "回看者")
    visitor.post(path + "/join")
    host.post(path + "/leave")
    assert history(observer, room_id) == frozen


def test_last_leave_event_propagates_and_normal_ws_reconnect_does_not_create_entries(people):
    host, actor, observer = named(people, "灯台"), named(people, "小雨"), named(people, "看客")
    room_id = create_room(host)
    path = f"/api/rooms/{room_id}"
    seat(host, host, room_id, "mygo.tomori")
    seat(host, actor, room_id, "mygo.soyo")
    host.post(path + "/control", {"action": "start"})
    observer.post(path + "/join")
    with host.websocket(room_id) as host_ws:
        expect_sync(host_ws)
        with actor.websocket(room_id) as actor_ws:
            expect_sync(actor_ws)
            before_gap = history(host, room_id)
            cursor = before_gap[-1]["seq"]
        assert actor.get(path)["room"]["me"]["character_id"] == "mygo.soyo"
        actor.post(path + "/join")  # A normal restore is not a new membership transition.
        assert history(host, room_id) == before_gap
        drain_before_action(host_ws)
        observer.post(path + "/leave")
        expect_sync(host_ws)
        missed = host.get(path + f"/sync?after_stage={cursor}")
        assert [message["text"] for message in missed["messages"]["stage"]] == ["看客主动离开了房间。"]
        with actor.websocket(room_id) as restored:
            expect_sync(restored)
            recovered = actor.get(path + f"/sync?after_stage={cursor}")
            assert recovered["messages"]["stage"] == missed["messages"]["stage"]
            assert recovered["room"]["me"]["character_id"] == "mygo.soyo"
            cursor = recovered["cursors"]["stage"]
            assert actor.get(path + f"/sync?after_stage={cursor}")["messages"]["stage"] == []
            drain_before_action(host_ws)
            actor.post(path + "/leave")
            with pytest.raises(ConnectionClosed):
                while True:
                    restored.recv(timeout=2)
            expect_sync(host_ws)
            last = host.get(path + f"/sync?after_stage={cursor}")["messages"]["stage"]
            assert [message["text"] for message in last] == ["小雨（长崎素世）主动离开了房间。"]
            assert sum("小雨 作为" in message["text"] for message in history(host, room_id)) == 1


def test_removal_freezes_role_label_and_nickname_changes_do_not_bypass_bans(server, people):
    host, actor, observer = named(people, "灯台"), named(people, "小雨"), named(people, "看客")
    room_id = create_room(host)
    path = f"/api/rooms/{room_id}"
    seat(host, host, room_id, "mygo.tomori")
    seat(host, actor, room_id, "mygo.soyo")
    host.post(path + "/control", {"action": "start"})
    observer.post(path + "/join")
    actor_id = actor.get(path)["room"]["me"]["member_id"]
    receipt = report(observer, room_id, speech(actor, room_id, "用于测试举报链路"), details="不应出现在移出事件的私有说明")
    assert receipt["status"] == "open"
    assert observer.client.post(path + f"/members/{actor_id}/remove", json={}).status_code == 403
    with actor.websocket(room_id) as socket:
        expect_sync(socket)
        host.post(path + f"/members/{actor_id}/remove")
        with pytest.raises(ConnectionClosed):
            while True:
                socket.recv(timeout=2)
    removal = history(observer, room_id)[-1]
    assert removal["text"] == "小雨（长崎素世）已被房主移出房间。"
    assert "私有说明" not in json.dumps(removal, ensure_ascii=False)
    host.post(path + f"/members/{actor_id}/remove")
    assert history(observer, room_id)[-1] == removal
    original_cookie = actor.client.cookies.get("onstage_session")
    actor.post("/api/session", {"nickname": "换个昵称"})
    assert actor.client.cookies.get("onstage_session") == original_cookie
    assert actor.client.post(path + "/join", json={}).status_code == 403
    assert actor.client.get(path + "/sync").status_code == 403
    assert observer.client.get(path + "/messages?channel=backstage").status_code == 403
    frozen = history(observer, room_id)
    server.restart()
    assert history(observer, room_id) == frozen
    assert actor.client.post(path + "/join", json={}).status_code == 403
