import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { startTestServer } from "./test-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const started = new Date().toISOString();
const server = await startTestServer();
const checks = [];
let fixture;
const actor = () => ({ cookie: "", csrf: "" });
async function call(person, method, route, body, expected = 200, extra = {}) {
  const headers = { Origin: server.origin, ...extra };
  if (person?.cookie) headers.Cookie = person.cookie;
  if (person?.csrf) headers["X-CSRF-Token"] = person.csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(server.origin + route, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.equal(response.status, expected, `${method} ${route} returned ${response.status}: ${JSON.stringify(value)}`);
  if (response.headers.get("set-cookie") && person) person.cookie = response.headers.get("set-cookie").split(";")[0];
  if (value.csrf_token && person) person.csrf = value.csrf_token;
  return value;
}
async function check(name, run) {
  const before = performance.now();
  await run();
  checks.push({ name, result: "passed", duration_ms: Math.round((performance.now() - before) * 1000) / 1000 });
  console.log(JSON.stringify({ check: name, result: "passed" }));
}
const post = (p, route, body = {}, expected = 200, extra = {}) => call(p, "POST", route, body, expected, extra);
const get = (p, route, expected = 200, extra = {}) => call(p, "GET", route, undefined, expected, extra);
const member = (room, pId) => room.members.find((m) => m.id === pId);
try {
  const a = actor(), b = actor(), c = actor(), d = actor();
  let room, base, bId, cId, dId, catalog, first, hostMessage, backstageMessage, reportId;
  await check("real_d1_schema_and_transport", async () => {
    assert.equal((await get(null, "/readyz")).edge_schema_version, 1);
    assert.equal((await get(null, "/healthz")).backend, "sites-d1");
    const one = await post(a, "/api/session", { nickname: "房主测试" });
    assert.equal(one.transport.type, "poll"); assert.equal(one.transport.presence_ttl_ms, 45000);
    catalog = await get(a, "/api/catalog"); assert.equal(catalog.characters.length, 10);
  });
  await check("session_resume_nickname_csrf_and_unicode", async () => {
    const original = { ...a };
    await post(a, "/api/session", {}); assert.deepEqual(a, original);
    await post({ cookie: a.cookie, csrf: "bad" }, "/api/session", { nickname: "非法更名" }, 403);
    await post(actor(), "/api/session", { nickname: "𠮷".repeat(24) });
    await post(actor(), "/api/session", { nickname: "𠮷".repeat(25) }, 422);
    await post(actor(), "/api/session", { nickname: "换\n行" }, 422);
    await post(actor(), "/api/session", { nickname: "隐藏\u200b格式" }, 422);
    await post(b, "/api/session", { nickname: "同名测试" }); await post(c, "/api/session", { nickname: "同名测试" }); await post(d, "/api/session", { nickname: "待移出" });
    assert.notEqual(b.cookie, c.cookie);
  });
  await check("strict_origin_payload_and_untrusted_system_fields", async () => {
    await get(a, "/api/catalog", 403, { Origin: "https://untrusted.invalid" });
    await post(a, "/api/rooms", { scenario_id: catalog.scenarios[0].id, injected: true }, 422);
    await post(a, "/api/session", { invite_code: "removed" }, 422);
  });
  await check("shared_rooms_and_join_events_are_idempotent", async () => {
    room = (await post(a, "/api/rooms", { scenario_id: catalog.scenarios[0].id, title: "D1 集成验证", background: "由真实参与者自由展开。" })).room;
    base = `/api/rooms/${room.id}`;
    const joined = await Promise.all([post(b, base + "/join"), post(c, base + "/join"), post(d, base + "/join")]);
    [bId, cId, dId] = joined.map((value) => value.room.me.member_id);
    await Promise.all([post(b, base + "/join"), post(b, base + "/join"), post(c, base + "/join")]);
    const sync = await get(a, base + "/sync");
    assert.equal(sync.room.members.length, 4); assert.equal(sync.messages.stage.length, 4); assert.ok(sync.messages.stage.every((m) => m.kind === "system"));
    assert.equal(sync.room.online_count, 0);
    fixture = { a, b, c, d, roomId: room.id };
  });
  await check("transactional_role_race_no_orphan_sequences_or_events", async () => {
    const role = catalog.characters[1].id;
    const race = await Promise.all([fetch(server.origin + base + "/characters/claim", { method: "POST", headers: { Cookie: b.cookie, "X-CSRF-Token": b.csrf, Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ character_id: role }) }), fetch(server.origin + base + "/characters/claim", { method: "POST", headers: { Cookie: c.cookie, "X-CSRF-Token": c.csrf, Origin: server.origin, "Content-Type": "application/json" }, body: JSON.stringify({ character_id: role }) })]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    if (race[0].status !== 200) { [b.cookie, c.cookie] = [c.cookie, b.cookie]; [b.csrf, c.csrf] = [c.csrf, b.csrf]; [bId, cId] = [cId, bId]; }
    await post(b, base + "/characters/claim", { character_id: role });
    await post(a, base + "/characters/claim", { character_id: catalog.characters[0].id });
    const sync = await get(a, base + "/sync");
    assert.equal(sync.messages.stage.length, 6); assert.deepEqual(sync.messages.stage.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
    assert.equal((await server.db.prepare("SELECT COUNT(*) AS count FROM transaction_guards").first()).count, 0);
  });
  await check("spectator_permissions_and_host_control", async () => {
    await get(c, base + "/messages?channel=backstage", 403);
    await post(c, base + "/messages", { channel: "stage", text: "观众不能发送", client_message_id: randomUUID() }, 403);
    await post(c, base + "/control", { action: "start" }, 403);
    await post(a, base + "/messages", { channel: "stage", text: "尚未开场", client_message_id: randomUUID() }, 409);
    backstageMessage = (await post(b, base + "/messages", { channel: "backstage", text: "后台私有消息", client_message_id: randomUUID() })).message;
    await post(a, base + "/control", { action: "start" });
    await post(a, base + "/control", { action: "close_join" });
    await post(c, base + "/characters/claim", { character_id: catalog.characters[2].id }, 409);
    const outsider = actor(); await post(outsider, "/api/session", { nickname: "补位关闭仍可旁观" }); await post(outsider, base + "/join");
  });
  await check("text_and_sticker_idempotency_immutable_snapshots", async () => {
    const clientId = randomUUID();
    const replies = await Promise.all([post(b, base + "/messages", { channel: "stage", text: "真实共享的一条消息", client_message_id: clientId }), post(b, base + "/messages", { channel: "stage", text: "真实共享的一条消息", client_message_id: clientId })]);
    first = replies[0].message; assert.equal(first.id, replies[1].message.id);
    await post(b, base + "/messages", { channel: "stage", text: "复用 ID 修改正文", client_message_id: clientId }, 409);
    const sticker = catalog.stickers.find((item) => item.character_id === null);
    const sent = (await post(b, base + "/messages", { channel: "stage", content_type: "sticker", sticker_id: sticker.id, client_message_id: randomUUID() })).message;
    assert.equal(sent.sticker.character_id, null); assert.equal(sent.character_id, catalog.characters[1].id); assert.equal(sent.text, "[贴纸] " + sticker.label);
    hostMessage = (await post(a, base + "/messages", { channel: "stage", text: "房主本人消息", client_message_id: randomUUID() })).message;
    await post(a, base + "/messages", { channel: "stage", text: "伪造系统", client_message_id: randomUUID(), kind: "system" }, 422);
    await post(a, base + "/messages", { channel: "stage", content_type: "sticker", sticker_id: "unknown-id", client_message_id: randomUUID() }, 422);
    assert.ok((await get(c, base + "/sync")).messages.stage.some((m) => m.id === first.id));
  });
  await check("nickname_change_preserves_role_and_historical_author", async () => {
    const before = { ...b }; await post(b, "/api/session", { nickname: "改名后" }); assert.deepEqual(b, before);
    const state = await get(b, base); assert.equal(state.room.me.member_id, bId); assert.equal(state.room.me.character_id, catalog.characters[1].id);
    const original = (await get(b, base + "/messages")).messages.find((m) => m.id === first.id); assert.equal(original.author, first.author);
  });
  await check("presence_real_heartbeats_multitab_and_expiration", async () => {
    await post(a, base + "/presence", { connection_id: "host-tab-one", active: true });
    await post(a, base + "/presence", { connection_id: "host-tab-two", active: true });
    await post(b, base + "/presence", { connection_id: "guest-tab-one", active: true });
    assert.equal((await get(a, base)).room.online_count, 2);
    await post(a, base + "/presence", { connection_id: "host-tab-one", active: false });
    assert.equal((await get(a, base)).room.online_count, 2);
    await server.db.prepare("UPDATE presence SET last_seen=? WHERE member_id=?").bind(new Date(Date.now() - 46000).toISOString(), bId).run();
    assert.equal((await get(a, base)).room.online_count, 1);
    assert.equal((await get(b, base)).room.me.character_id, catalog.characters[1].id);
    await post(b, base + "/presence", { connection_id: "guest-tab-one", active: true });
    for (let i = 0; i < 5; i++) await post(a, base + "/presence", { connection_id: `capacity-${i}` });
    await post(a, base + "/presence", { connection_id: "capacity-extra" }, 429);
    await server.db.prepare("UPDATE presence SET last_seen=? WHERE connection_id='capacity-0'").bind(new Date(Date.now() - 46000).toISOString()).run();
    await post(a, base + "/presence", { connection_id: "capacity-extra" });
    await post(a, base + "/presence", { connection_id: "capacity-0" }, 429);
    for (const id of [...Array.from({ length: 5 }, (_, i) => `capacity-${i}`), "capacity-extra"]) await post(a, base + "/presence", { connection_id: id, active: false });
  });
  await check("room_isolation_and_report_scope", async () => {
    const other = (await post(a, "/api/rooms", { scenario_id: catalog.scenarios[1].id })).room;
    await post(c, `/api/rooms/${other.id}/join`);
    await post(c, `/api/rooms/${other.id}/reports`, { message_id: first.id, reason: "other" }, 404);
    await post(c, base + "/reports", { message_id: backstageMessage.id, reason: "other" }, 403);
    await post(a, `/api/rooms/${other.id}/control`, { action: "end" });
  });
  await check("report_idempotency_host_boundary_operator_resolution", async () => {
    const one = (await post(c, base + "/reports", { message_id: first.id, reason: "other", details: "集成验证" })).report;
    const retry = (await post(c, base + "/reports", { message_id: first.id, reason: "other", details: "集成验证" })).report;
    assert.equal(one.id, retry.id); assert.equal(one.snapshot.message.id, first.id);
    await post(c, base + "/reports", { message_id: first.id, reason: "spam" }, 409);
    const hostReport = (await post(c, base + "/reports", { message_id: hostMessage.id, reason: "other", details: "房主相关" })).report;
    reportId = hostReport.id;
    assert.equal(hostReport.against_host, true);
    assert.equal((await get(a, base + "/reports")).reports.some((r) => r.id === reportId), false);
    await post(a, base + `/reports/${reportId}/resolve`, { status: "resolved", note: "越权处理" }, 403);
    await post(a, base + `/reports/${one.id}/resolve`, { status: "dismissed", note: "测试回执核对" });
    await get(null, "/api/operator/reports", 401);
    const auth = { Authorization: "Bearer " + server.operatorToken };
    assert.ok((await get(null, "/api/operator/reports", 200, auth)).reports.some((r) => r.id === reportId));
    const resolved = (await post(null, `/api/operator/reports/${reportId}/resolve`, { status: "resolved", note: "维护者核验测试", operator: "integration-test" }, 200, auth)).report;
    assert.equal(resolved.resolved_by, "operator"); assert.equal(resolved.can_resolve, false);
  });
  await check("leave_reenter_original_role_only_and_event_history", async () => {
    const backstageReport = (await post(b, base + "/reports", { message_id: backstageMessage.id, reason: "other", details: "失去后台后的回执" })).report;
    await post(a, base + "/control", { action: "open_join" });
    const before = (await get(a, base + "/sync")).cursors.stage;
    await post(b, base + "/leave"); await post(b, base + "/leave");
    const redacted = (await get(b, "/api/reports")).reports.find((r) => r.id === backstageReport.id); assert.equal(redacted.snapshot_redacted, true); assert.equal(redacted.snapshot, null);
    await post(b, base + "/join");
    await post(b, base + "/characters/claim", { character_id: catalog.characters[3].id }, 409);
    await post(b, base + "/characters/claim", { character_id: catalog.characters[1].id });
    const events = (await get(a, base + `/sync?after_stage=${before}`)).messages.stage;
    assert.equal(events.length, 3); assert.ok(events[0].text.includes("主动离开")); assert.ok(events[1].text.includes("以观众身份")); assert.ok(events[2].text.includes("入场"));
  });
  await check("host_kick_releases_role_revokes_reads_and_persists_ban", async () => {
    await post(d, base + "/characters/claim", { character_id: catalog.characters[2].id });
    await post(d, base + "/presence", { connection_id: "removed-tab" });
    const before = (await get(a, base + "/sync")).cursors.stage;
    await post(a, base + `/members/${dId}/remove`); await post(a, base + `/members/${dId}/remove`);
    const current = (await get(a, base)).room; assert.ok(!current.members.some((m) => m.id === dId));
    for (const endpoint of ["", "/sync", "/messages"]) await get(d, base + endpoint, 403);
    await post(d, base + "/join", {}, 403); await post(d, base + "/presence", { connection_id: "removed-tab" }, 403);
    await post(d, "/api/session", { nickname: "换名仍被移出" }); await post(d, base + "/join", {}, 403);
    assert.equal((await get(a, base + `/sync?after_stage=${before}`)).messages.stage.length, 1);
    assert.ok((await get(a, base + "/messages")).messages.some((m) => m.id === first.id));
  });
  await check("pause_and_ended_freeze_and_archive_visitors", async () => {
    await post(a, base + "/control", { action: "pause" });
    await post(b, base + "/messages", { channel: "stage", text: "暂停舞台", client_message_id: randomUUID() }, 409);
    await post(b, base + "/messages", { channel: "backstage", text: "暂停后台仍可讨论", client_message_id: randomUUID() });
    await post(a, base + "/control", { action: "resume" }); await post(a, base + "/control", { action: "end" }); await post(a, base + "/control", { action: "end" });
    const before = (await get(a, base + "/sync")).cursors.stage;
    await post(b, base + "/leave"); await post(b, base + "/join");
    await post(a, base + "/settings", { background: "不能覆盖", announcement: "" }, 409);
    await post(a, base + `/members/${cId}/remove`, {}, 409);
    await post(b, base + "/characters/claim", { character_id: catalog.characters[1].id }, 409);
    await post(a, base + "/messages", { channel: "stage", text: "已经结束", client_message_id: randomUUID() }, 409);
    assert.equal((await get(a, base + "/sync")).cursors.stage, before);
  });
  await check("confidential_export_and_portable_sqlite_roundtrip", async () => {
    await get(null, "/api/operator/export", 401);
    const exported = await get(null, "/api/operator/export", 200, { Authorization: "Bearer " + server.operatorToken });
    assert.equal(exported.schema_version, 4); assert.equal(exported.contains_private_session_credentials, true);
    assert.equal(exported.tables.messages.length, exported.row_counts.messages); assert.ok(exported.tables.sessions.every((s) => !Object.hasOwn(s, "token")));
    assert.ok(exported.tables.reports.some((r) => r.id === reportId)); assert.ok(!Object.hasOwn(exported.tables, "presence"));
    assert.equal((await server.db.prepare("PRAGMA foreign_key_check").all()).results.length, 0);
    // D1 forbids PRAGMA integrity_check on the binding. Validate the exported
    // business state by restoring it into the portable Python SQLite schema;
    // this does not claim access to D1's underlying file-integrity machinery.
    const restored = new DatabaseSync(":memory:");
    try {
      restored.exec("PRAGMA foreign_keys=ON");
      restored.exec(await readFile(path.join(root, "app/schema.sql"), "utf8"));
      restored.exec("BEGIN IMMEDIATE");
      for (const [name, rows] of Object.entries(exported.tables)) {
        for (const row of rows) {
          const columns = Object.keys(row);
          const statement = restored.prepare(`INSERT INTO ${name}(${columns.map((key) => `"${key}"`).join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
          statement.run(...columns.map((key) => row[key]));
        }
      }
      restored.exec("COMMIT");
      assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(restored.prepare("PRAGMA foreign_key_check").all().length, 0);
      for (const [name, rows] of Object.entries(exported.tables)) {
        const actual = restored.prepare(`SELECT * FROM ${name}`).all();
        const canonical = (row) => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])));
        assert.deepEqual(actual.map(canonical).sort(), rows.map(canonical).sort());
      }
    } finally { restored.close(); }
  });
  await check("logout_isolation_and_csrf", async () => {
    await post({ cookie: c.cookie, csrf: "invalid" }, "/api/logout", {}, 403);
    const priorCookie = c.cookie; await post(c, "/api/logout");
    await get({ cookie: priorCookie, csrf: c.csrf }, "/api/session", 401);
    await get(a, "/api/session");
  });

  // Concurrent clients run against workerd's real D1 binding. They are never
  // inserted into the public service or presented as human online participants.
  await check("twenty_independent_sessions_concurrent_join_and_shared_delivery", async () => {
    const group = Array.from({ length: 20 }, actor);
    await Promise.all(group.map((p, i) => post(p, "/api/session", { nickname: `并发客户端${i}` })));
    const testRoom = (await post(group[0], "/api/rooms", { scenario_id: catalog.scenarios[0].id, title: "隔离 20 会话并发验证" })).room;
    const target = `/api/rooms/${testRoom.id}`;
    await Promise.all(group.slice(1).map((p) => post(p, target + "/join")));
    await Promise.all(group.slice(0, 10).map((p, i) => post(p, target + "/characters/claim", { character_id: catalog.characters[i].id })));
    await post(group[0], target + "/control", { action: "start" });
    await Promise.all(group.map((p, i) => post(p, target + "/presence", { connection_id: `concurrent-${i}` })));
    const initial = await get(group[0], target + "/sync"); assert.equal(initial.room.members.length, 20); assert.equal(initial.room.online_count, 20);
    const sent = await Promise.all(group.slice(0, 10).map((p, i) => post(p, target + "/messages", { channel: "stage", ...(i % 2 ? { content_type: "sticker", sticker_id: catalog.stickers[i].id } : { text: `并发消息${i}` }), client_message_id: randomUUID() })));
    const ids = sent.map((r) => r.message.id); assert.equal(new Set(ids).size, 10);
    const syncs = await Promise.all(group.map((p) => get(p, target + `/sync?after_stage=${initial.cursors.stage}`)));
    for (const sync of syncs) { assert.equal(sync.messages.stage.length, 10); assert.deepEqual(new Set(sync.messages.stage.map((m) => m.id)), new Set(ids)); }
    const seqs = syncs[0].messages.stage.map((m) => m.seq); assert.equal(new Set(seqs).size, 10); assert.equal(Math.max(...seqs) - Math.min(...seqs), 9);
    assert.equal((await server.db.prepare("SELECT COUNT(*) AS count FROM transaction_guards").first()).count, 0);
    await post(group[0], target + "/control", { action: "end" });
    checks.push({ name: "concurrent_delivery_details", result: "passed", sessions: 20, concurrent_messages: 10, verified_fetch_deliveries: 200, expected_fetch_deliveries: 200, duplicate_ids: 0, mismatches: 0, physical_humans: false });
  });
  const report = { report_schema: "onstage-edge-integration-v1", result: "passed", started_at_utc: started, completed_at_utc: new Date().toISOString(), application_version: (await readFile(path.join(root, "VERSION"), "utf8")).trim(), runtime: "actual workerd + Miniflare D1 binding; isolated ephemeral database; HTTP on loopback", scope: { browser_executed: false, layout_executed: false, production_data_accessed: false, mainland_network_verified: false, physical_humans: false }, checks, source_sha256: Object.fromEntries(await Promise.all(["edge/database.ts", "edge/store.ts", "edge/handler.ts", "edge/integration.test.mjs", "db/schema.ts", "drizzle/0000_rapid_edwin_jarvis.sql"].map(async (file) => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")]))), counts: { checks: checks.length, failures: 0 }, confidential_tokens_logged: false };
  const output = process.argv[2] || "reports/edge-integration-v06.json";
  await writeFile(path.resolve(root, output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ result: "passed", checks: checks.length, report: output }));
} finally { await server.dispose(); }
