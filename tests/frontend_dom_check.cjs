/* DOM integration against a real loopback server. This is NOT browser/layout QA.
 * Install the repository's locked development dependencies with npm ci.
 * node tests/frontend_dom_check.cjs http://127.0.0.1:18767 reports/frontend-dom-v06.json
 * ONSTAGE_DOM_MODULES may explicitly select another dependency directory.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const root = path.resolve(__dirname, "..");
const testRequire = createRequire(path.join(process.env.ONSTAGE_DOM_MODULES || path.join(root, "node_modules"), ".onstage-test.cjs"));
const { JSDOM, CookieJar, VirtualConsole } = testRequire("jsdom");
const NodeWebSocket = testRequire("ws");
const base = new URL(process.argv[2] || "http://127.0.0.1:18767");
assert(["127.0.0.1", "localhost", "[::1]"].includes(base.hostname), "This harness is restricted to an isolated loopback test server");
const output = path.resolve(process.argv[3] || path.join(root, "reports/frontend-dom-v06.json"));
const report = { version: process.env.ONSTAGE_EXPECT_VERSION || fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(), started_at_utc: new Date().toISOString(), method: "jsdom 26.1.0 DOM event execution with real HTTP and the server-declared transport; independent nickname guest cookie jars", browser_executed: false, layout_executed: false, steps: [], errors: [], limitations: ["No CSS layout, image decoding, native dialog focus or real clipboard rendering", "Media queries and viewport height are simulated; no physical phone or IME acceptance", "Automated sessions are not human participants", "Loopback only; no public TLS or mainland network evidence"] };
const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
const theme = fs.readFileSync(path.join(root, "static/theme.js"), "utf8");
report.app_js_sha256 = crypto.createHash("sha256").update(app).digest("hex");
report.frontend_sha256 = Object.fromEntries(["static/index.html", "static/app.js", "static/styles.css", "static/theme.js", "tests/frontend_dom_check.cjs"].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex")]));
const clients = [];
let host, peer, observer, roomId, stageStickerMessage, backstageStickerMessage;

async function until(predicate, label, timeout = 6500) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
async function step(name, action) {
  const start = Date.now();
  await action();
  report.steps.push({ name, status: "passed", milliseconds: Date.now() - start });
}
function client({ jar = new CookieJar(), hash = "", local = {}, session = {}, mobile = false, faults = {}, nickname = `验收访客 ${clients.length + 1}` } = {}) {
  const c = { jar, nickname, csrf: "", serverTransport: null, catalog: null, committedMessages: [], requests: [], sockets: [], lostAck: false, holdSync: false, clipboard: "", exceptions: [], activeRequests: 0, activeSyncs: 0, maxActiveSyncs: 0, networkBlocked: false, closed: false, faults: { ...faults }, delayLeave: false, releaseLeave: null };
  const console = new VirtualConsole();
  console.on("jsdomError", error => c.exceptions.push(error.message));
  const dom = new JSDOM(html, { url: base.href + hash, runScripts: "outside-only", pretendToBeVisual: true, cookieJar: jar, virtualConsole: console });
  const w = dom.window;
  c.dom = dom; c.w = w; c.d = w.document;
  c.$ = id => c.d.getElementById(id);
  for (const [key, value] of Object.entries(local)) w.localStorage.setItem(key, value);
  for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, value);
  w.matchMedia = query => ({ matches: mobile && /max-width: 720px/.test(query), media: query, addEventListener() {}, removeEventListener() {} });
  w.scrollTo = () => {};
  w.HTMLElement.prototype.scrollIntoView = function() {};
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
  w.HTMLDialogElement.prototype.close = function(value = "") { this.returnValue = value; this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
  w.TextEncoder = TextEncoder;
  w.AbortController = AbortController;
  Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async text => { c.clipboard = text; } } });
  w.addEventListener("error", event => c.exceptions.push(String(event.error || event.message)));
  c.transport = async (route, options = {}, fromSharedUI = false) => {
    const url = new URL(route, base);
    assert.equal(url.origin, base.origin, "No external requests allowed by this test");
    if (c.holdSync && fromSharedUI && url.pathname.endsWith("/sync")) throw new TypeError("Controlled sync pause for pending recovery");
    if (c.networkBlocked) throw new TypeError("Controlled isolated client network interruption");
    const headers = new Headers(options.headers);
    const cookie = jar.getCookieStringSync(url.href);
    if (cookie) headers.set("Cookie", cookie);
    if ((options.method || "GET") !== "GET") headers.set("Origin", base.origin);
    c.requests.push({ path: url.pathname, search: url.search, source: fromSharedUI ? "shared-ui" : "test-assertion", method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null, csrf_supplied: headers.has("X-CSRF-Token") });
    const fault = url.pathname === "/api/catalog" ? "catalog" : url.pathname.endsWith("/join") ? "join" : "";
    if (c.faults[fault]) {
      c.faults[fault] -= 1;
      return new Response(JSON.stringify({ detail: "Controlled temporary test failure" }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    c.activeRequests += 1;
    // Direct API assertions intentionally query while the live page is polling.
    // Only application fetches measure the page's sync concurrency.
    const syncing = fromSharedUI && url.pathname.endsWith("/sync");
    if (syncing) { c.activeSyncs += 1; c.maxActiveSyncs = Math.max(c.maxActiveSyncs, c.activeSyncs); }
    try {
    const response = await fetch(url, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, url.href);
    if (url.pathname === "/api/session" && response.ok) {
      const accepted = await response.clone().json();
      c.csrf = accepted.csrf_token;
      c.serverTransport = accepted.transport || { type: "websocket" };
    }
    if (url.pathname === "/api/catalog" && response.ok) c.catalog = await response.clone().json();
    if (url.pathname.endsWith("/messages") && options.method === "POST" && response.ok) c.committedMessages.push((await response.clone().json()).message);
    if (c.delayLeave && url.pathname.endsWith("/leave") && options.method === "POST" && response.ok) {
      c.delayLeave = false;
      await new Promise(resolve => { c.releaseLeave = resolve; });
      c.releaseLeave = null;
    }
    if (c.lostAck && url.pathname.endsWith("/messages") && options.method === "POST" && response.ok) {
      c.lostAck = false;
      await response.text();
      throw new TypeError("Controlled test: acknowledgement lost after server commit");
    }
    return response;
    } finally { c.activeRequests -= 1; if (syncing) c.activeSyncs -= 1; }
  };
  c.request = async (route, body) => {
    const response = await c.transport(route, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": c.csrf }, body: JSON.stringify(body) });
    const data = await response.json();
    assert(response.ok, `API ${route}: HTTP ${response.status}: ${data.detail || ""}`);
    return data;
  };
  w.fetch = (route, options) => c.transport(route, options, true);
  w.WebSocket = class extends NodeWebSocket {
    constructor(url) {
      super(url, { origin: base.origin, headers: { Cookie: jar.getCookieStringSync(base.href) }, perMessageDeflate: false });
      c.sockets.push(this);
    }
  };
  c.click = id => { assert(c.$(id), `Missing ${id}`); assert(!c.$(id).disabled, `Disabled ${id}`); c.$(id).click(); };
  c.fill = (id, value) => { c.$(id).value = value; c.$(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  c.submit = id => c.$(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
  c.sync = () => c.click("manual-sync");
  c.capture = () => ({ jar, hash: w.location.hash, local: Object.fromEntries(Object.entries(w.localStorage)), session: Object.fromEntries(Object.entries(w.sessionStorage)), mobile, nickname });
  c.setOnline = value => {
    c.networkBlocked = !value;
    Object.defineProperty(w.navigator, "onLine", { configurable: true, value });
    w.dispatchEvent(new w.Event(value ? "online" : "offline"));
  };
  c.close = async () => {
    if (c.closed) return;
    c.closed = true;
    Object.defineProperty(w.navigator, "onLine", { configurable: true, value: false });
    w.dispatchEvent(new w.Event("offline"));
    await until(() => c.activeRequests === 0, "test DOM transport shutdown");
    await new Promise(resolve => setTimeout(resolve, 25));
    for (const socket of c.sockets) { socket.on("error", () => {}); socket.terminate(); }
    dom.window.close();
  };
  clients.push(c);
  w.eval(theme); w.eval(app);
  return c;
}
function button(c, text, parent = c.d) {
  const result = [...parent.querySelectorAll("button")].find(el => el.textContent.trim() === text);
  assert(result && !result.disabled, `Missing/enabled button: ${text}`);
  return result;
}
async function booted(c, room = false) {
  await enterGuest(c);
  await until(() => {
    if (!c.catalog || c.d.body.dataset.view !== (room ? "room" : "lobby")) return false;
    const current = c.catalog.scenarios.find(item => item.id === c.$("room-backdrop").dataset.sceneId);
    const expected = room ? current?.character_ids.length : c.catalog.scenarios.length;
    return c.d.querySelectorAll(room ? ".seat-card" : ".scenario-card").length === expected;
  }, "nickname guest bootstrap");
  await until(() => !c.$("retry-bootstrap").disabled && !c.$("refresh-rooms").disabled, "bootstrap completion");
  if (room) await until(() => c.$("message-feed").getAttribute("aria-busy") === "false", "initial message sync");
}
async function enterGuest(c) {
  await until(() => !c.$("guest-form").hidden || c.d.body.dataset.view !== "loading", "restored identity or nickname entry");
  if (!c.$("guest-form").hidden) {
    c.fill("guest-nickname", c.nickname);
    c.submit("guest-form");
    await until(() => c.$("guest-form").hidden, "explicit nickname admission");
  }
}
function chooseSticker(c, id) {
  c.click("open-stickers");
  c.d.querySelector('[data-sticker-source="all"]').click();
  c.d.querySelector('[data-sticker-filter="all"]').click();
  c.$("sticker-category").value = "all";
  c.$("sticker-category").dispatchEvent(new c.w.Event("change", { bubbles: true }));
  c.fill("sticker-search", "");
  const choice = [...c.$("sticker-list").querySelectorAll(".sticker-choice")].find(item => item.dataset.stickerId === id);
  assert(choice, `Sticker exists in current catalog: ${id}`); choice.click();
  assert.equal(c.$("sticker-list").querySelector('[aria-pressed="true"]').dataset.stickerId, id);
  assert(!c.$("send-sticker").disabled, "Selected sticker is sendable for this participant/channel");
}
async function sendSticker(c, id) {
  chooseSticker(c, id);
  const before = c.committedMessages.length;
  c.click("send-sticker");
  await until(() => c.committedMessages.length > before && !c.$("message-feed").querySelector("[data-pending-id]"), "sticker confirmation");
  return c.committedMessages[c.committedMessages.length - 1];
}
function messageElement(c, id) {
  return [...c.$("message-feed").querySelectorAll("[data-message-id]")].find(item => item.dataset.messageId === String(id));
}
function reportCard(c, text) {
  return [...c.$("reports-list").querySelectorAll(".report-card")].find(item => item.textContent.includes(text));
}
async function send(c, text) {
  c.fill("message-input", text); assert(!c.$("send-message").disabled, "Composer must allow this participant");
  c.submit("message-form");
  await until(() => !c.$("message-feed").querySelector("[data-pending-id]") && c.$("message-input").value === "", "message confirmed");
}

(async () => {
  try {
    const health = await (await fetch(new URL("/healthz", base))).json();
    assert.equal(health.version, report.version);
    await step("One-field nickname guest entry, dynamic scene and paired portrait catalog, no account or invitation form", async () => {
      host = client({ nickname: "灯下的你" });
      await until(() => !host.$("guest-form").hidden, "fresh guest nickname form");
      assert.equal(host.requests.filter(r => r.path === "/api/session").length, 1);
      assert.equal(host.requests.find(r => r.path === "/api/session").method, "GET");
      assert.equal(host.d.querySelectorAll('#guest-form input').length, 1);
      assert.equal(host.d.querySelector('input[type="password"]'), null);
      host.fill("guest-nickname", "   "); host.submit("guest-form");
      assert(!host.$("guest-error").hidden);
      assert.equal(host.requests.filter(r => r.path === "/api/session" && r.method === "POST").length, 0);
      await booted(host);
      report.server_transport = host.serverTransport;
      assert.equal(host.d.body.dataset.transport, host.serverTransport.type);
      assert.equal(host.$("preview-banner").hidden, true, "A real service keeps the offline-review banner hidden");
      assert.equal(host.w.OnstagePreview, undefined);
      assert.equal(host.d.querySelector('script[src*="preview"]'), null, "The real entry does not load a browser-local adapter");
      const mark = host.d.querySelector('link[rel="icon"]').getAttribute("href");
      for (const image of host.d.querySelectorAll(".brand-symbol, #loading-spark, .footer-brand img")) {
        assert.equal(image.tagName, "IMG");
        assert.equal(image.getAttribute("src"), mark, "Page brand reuses the existing website icon asset");
      }
      assert.equal(host.d.querySelectorAll(".lobby-character").length, host.catalog.characters.length);
      assert.equal(host.$("scene-count-label").textContent, `${host.catalog.scenarios.length} PLACES / YOUR OWN STORY`);
      report.catalog_counts = { bands: host.catalog.bands.length, characters: host.catalog.characters.length, scenarios: host.catalog.scenarios.length, stickers: host.catalog.stickers.length };
      for (const character of host.catalog.characters) {
        assert(character.avatar_image && character.detail_image, "Portrait and detail fields are explicit");
        if (character.avatar_crop) {
          const crop = character.avatar_crop;
          assert(crop.width > 0 && crop.height > 0 && crop.x >= 0 && crop.y >= 0);
          assert(crop.x + crop.width <= (character.avatar_width ?? character.image_width));
          assert(crop.y + crop.height <= (character.avatar_height ?? character.image_height));
        }
        const rendered = [...host.$("lobby-characters").querySelectorAll(".character-avatar")].find(item => item.dataset.character === character.id);
        assert.equal(rendered.querySelector("img").getAttribute("src"), character.avatar_image || character.image);
        if (character.avatar_crop) assert.equal(rendered.dataset.crop, "true", "Avatar crop is applied only from this character's explicit small-image coordinates");
        rendered.closest(".lobby-character").click(); assert(host.$("confirm-dialog").open);
        assert.equal(host.$("confirm-extra").querySelector(".character-full-art img").getAttribute("src"), character.detail_image);
        host.click("confirm-cancel"); await until(() => !host.$("confirm-dialog").open, "full portrait detail closed");
      }
      assert.equal(host.$("login-form"), null);
      assert(!host.d.body.textContent.includes("旅人·"));
      assert.deepEqual(host.requests.find(r => r.path === "/api/session" && r.method === "POST").body, { nickname: "灯下的你" });
      assert.equal(host.d.documentElement.dataset.theme, "light");
    });
    await step("Theme preference and same nickname guest identity survive DOM reload without a second admission", async () => {
      host.click("theme-toggle"); assert.equal(host.w.localStorage.getItem("onstage.theme"), "dark");
      const csrf = host.csrf, saved = host.capture(); await host.close(); host = client(saved); await booted(host);
      assert.equal(host.csrf, csrf); assert.equal(host.d.documentElement.dataset.theme, "dark");
      assert.equal((await host.request("/api/session")).nickname, "灯下的你");
      assert(!host.requests.some(r => r.path === "/api/session" && r.method === "POST"));
      assert(!host.d.body.textContent.includes(csrf));
    });
    await step("A pre-existing unnamed cookie gains a nickname through the UI without rotating identity or CSRF", async () => {
      const response = await fetch(new URL("/api/session", base), { method: "POST", headers: { Origin: base.origin, "Content-Type": "application/json" }, body: "{}" });
      assert(response.ok);
      const before = await response.json();
      assert.equal(before.requires_nickname, true);
      const jar = new CookieJar();
      for (const cookie of response.headers.getSetCookie()) jar.setCookieSync(cookie, base.href);
      const legacy = client({ jar, nickname: "旧身份新昵称" });
      await until(() => !legacy.$("guest-form").hidden, "existing unnamed guest is prompted");
      assert.equal(legacy.csrf, before.csrf_token);
      await booted(legacy);
      const named = await legacy.request("/api/session");
      assert.equal(named.csrf_token, before.csrf_token);
      assert.equal(named.nickname, "旧身份新昵称");
      assert(legacy.requests.find(item => item.path === "/api/session" && item.method === "POST").csrf_supplied);
      await legacy.request("/api/logout", {}); await legacy.close();
    });
    await step("Scene filters, editable creation backdrop and direct character claim", async () => {
      const category = host.catalog.scenarios.find(item => item.category)?.category;
      assert(category, "Catalog contains a location category");
      button(host, category, host.$("scene-filters")).click();
      assert.equal(host.d.querySelectorAll(".scenario-card").length, host.catalog.scenarios.filter(item => item.category === category).length);
      button(host, "全部场景", host.$("scene-filters")).click();
      host.d.querySelector(".scenario-image-button").click(); assert(host.$("create-dialog").open);
      host.fill("new-room-title", "自动化 DOM 验收房");
      host.fill("new-room-background", "自由对话场景。\n<img src=x onerror=alert(1)>");
      host.fill("new-room-announcement", "自动化验收用房间，不是公开用户活动。");
      host.submit("create-form"); await booted(host, true);
      roomId = new URLSearchParams(host.w.location.hash.slice(1)).get("room"); assert(roomId);
      const backdrop = host.catalog.scenarios.find(item => item.id === host.$("room-backdrop").dataset.sceneId);
      assert.equal(host.$("room-backdrop-image").getAttribute("src"), backdrop.image);
      assert.equal(host.$("room-backdrop").parentElement, host.d.body, "Backdrop is a global room layer, outside individual cards");
      assert(host.$("room-background").textContent.includes("<img")); assert.equal(host.$("room-background").querySelector("img"), null);
      assert(host.$("composer-identity").textContent.includes("旁观中"));
      assert.equal((await host.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`)).messages.filter(item => item.text === "灯下的你 以观众身份进入了房间。").length, 1);
      host.d.querySelector('[data-focus-key="claim-mygo.tomori"]').click();
      await until(() => host.$("composer-identity").textContent.includes("高松灯"), "host direct character claim");
      assert(host.d.querySelector('[data-focus-key="control-start"]').disabled);
      assert(host.$("open-stickers").disabled, "Preparing stage cannot send stickers");
    });
    await step("Independent link entry, observer restrictions, second direct actor, mobile panel state", async () => {
      const hash = `#room=${roomId}`;
      peer = client({ hash, nickname: "橘子汽水" }); observer = client({ hash, nickname: "路过听众", mobile: true, faults: { catalog: 1, join: 1 } });
      for (const guest of [peer, observer]) {
        await until(() => !guest.$("guest-form").hidden, "invite retains target while asking for nickname");
        assert.equal(guest.w.location.hash, hash);
        assert.equal(guest.$("guest-submit").textContent.trim(), "以旁观者进入");
      }
      await booted(peer, true);
      await enterGuest(observer);
      await until(() => !observer.$("lobby-error").hidden && !observer.$("retry-bootstrap").disabled, "controlled catalog failure surfaced");
      assert.equal(observer.w.location.hash, hash); observer.click("refresh-rooms");
      await until(() => observer.requests.some(r => r.path.endsWith("/join")) && !observer.$("refresh-rooms").disabled && observer.d.body.dataset.view === "lobby", "controlled first join failure surfaced");
      assert.equal(observer.w.location.hash, hash); observer.click("refresh-rooms"); await booted(observer, true);
      assert.notEqual(host.csrf, peer.csrf); assert.notEqual(peer.csrf, observer.csrf);
      assert(observer.$("backstage-channel").disabled && observer.$("message-input").disabled && observer.$("open-stickers").disabled);
      assert(observer.$("composer-identity").textContent.includes("路过听众") && observer.$("composer-identity").textContent.includes("旁观中"));
      observer.click("audience-label"); assert.equal(observer.$("desk-panel").dataset.active, "true");
      assert.equal(observer.$("member-list").querySelector(".member-remove"), null);
      observer.click("mobile-tab-seats"); assert.equal(observer.$("seats-panel").dataset.active, "true");
      observer.click("mobile-tab-desk"); assert.equal(observer.$("desk-panel").dataset.active, "true");
      observer.click("mobile-tab-stage"); assert.equal(observer.$("stage-panel").dataset.active, "true");
      peer.d.querySelector('[data-focus-key="claim-mujica.sakiko"]').click();
      await until(() => peer.$("composer-identity").textContent.includes("丰川祥子"), "second character claimed");
      host.sync(); await until(() => !host.d.querySelector('[data-focus-key="control-start"]').disabled, "two actors permit start");
      button(host, "开启舞台", host.$("host-controls")).click();
      await until(() => host.$("room-status").textContent === "演出中" && peer.$("room-status").textContent === "演出中", "live status sync");
    });
    await step("Visible member management and durable guest events persist without reconnect or retry duplicates", async () => {
      host.click("audience-label");
      assert.equal(host.$("desk-panel").dataset.active, "true");
      assert.equal(host.$("members-heading").textContent, "成员管理");
      await until(() => host.$("member-list").querySelectorAll(".member-remove").length >= 2, "host sees actual removable peers");
      assert([...host.$("member-list").querySelectorAll(".member-remove")].every(item => item.textContent.trim() === "移出"));
      host.click("mobile-tab-stage");
      const before = (await host.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`)).messages;
      assert.equal(before.filter(item => item.text === "橘子汽水 作为 丰川祥子 入场。").length, 1);
      await peer.request(`/api/rooms/${roomId}/characters/claim`, { character_id: "mujica.sakiko" });
      await observer.request(`/api/rooms/${roomId}/join`, {});
      const saved = observer.capture(), observerCsrf = observer.csrf;
      await observer.close(); observer = client(saved); await booted(observer, true);
      assert.equal(observer.csrf, observerCsrf);
      assert.deepEqual((await host.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`)).messages, before);
      observer.click("leave-room"); observer.click("confirm-accept"); await booted(observer);
      await until(() => host.$("message-feed").textContent.includes("路过听众主动离开了房间。"), "leave event reaches another participant");
      await observer.request(`/api/rooms/${roomId}/leave`, {});
      const target = [...observer.$("room-list").querySelectorAll(".room-row")].find(item => item.textContent.includes("自动化 DOM 验收房"));
      assert(target);
      assert.equal(target.querySelector(".join-room").textContent.trim(), "以旁观者进入");
      target.querySelector(".join-room").click(); await booted(observer, true);
      await until(() => [...host.$("message-feed").querySelectorAll(".system-message")].filter(item => item.textContent.includes("路过听众 以观众身份进入了房间。")).length === 2, "formal reentry has one new durable join event");
      const after = (await observer.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`)).messages;
      assert.equal(after.filter(item => item.text === "路过听众主动离开了房间。").length, 1);
      assert.equal(after.length, before.length + 2);
    });
    await step("Host background and announcement update across sessions with literal text rendering", async () => {
      host.click("room-settings");
      host.fill("settings-background", "雨后的排练室，自由展开。\n<script>test</script>");
      host.fill("settings-announcement", "大家按自己的节奏来。\n第二行公告。"); host.submit("settings-form");
      await until(() => !host.$("settings-dialog").open && peer.$("announcement-body").textContent.includes("第二行"), "settings broadcast");
      assert.equal(peer.$("room-background").querySelector("script"), null);
      assert(observer.$("room-settings").hidden);
      host.click("copy-room-link"); await until(() => !!host.clipboard, "clipboard adapter receives share link");
      assert.equal(new URL(host.clipboard).hash, `#room=${roomId}`);
    });
    await step("Stage message render and backstage exclusion", async () => {
      await send(peer, "这是自动化验收的舞台发言 <b>纯文本</b>");
      await until(() => observer.$("message-feed").textContent.includes("纯文本"), "observer receives stage text");
      assert.equal(observer.$("message-feed").querySelector("b"), null);
      host.click("backstage-channel"); peer.click("backstage-channel");
      await send(host, "后台验收标记：仅演员和房主可见");
      await until(() => peer.$("message-feed").textContent.includes("后台验收标记"), "backstage peer delivery");
      assert(!observer.$("message-feed").textContent.includes("后台验收标记"));
      host.click("stage-channel"); peer.click("stage-channel");
    });
    await step("Sticker filters and search require explicit preview/send, preserve text, and use the actual sender", async () => {
      const selected = host.catalog.stickers.find(item => item.band_id === "mujica" && item.character_id !== "mygo.tomori");
      assert(selected);
      host.fill("message-input", "发送贴纸时保留的文字草稿");
      const postsBefore = host.requests.filter(item => item.method === "POST" && item.path.endsWith("/messages")).length;
      host.click("open-stickers"); assert(host.$("sticker-dialog").open);
      const supplied = host.catalog.stickers.filter(item => item.source_pack === "user-v04");
      assert.equal(host.$("sticker-list").querySelectorAll(".sticker-choice").length, supplied.length);
      assert.equal(supplied.length, 123);
      for (const category of host.catalog.sticker_categories) {
        host.$("sticker-category").value = category.id;
        host.$("sticker-category").dispatchEvent(new host.w.Event("change", { bubbles: true }));
        assert.equal(host.$("sticker-list").querySelectorAll(".sticker-choice").length,
          supplied.filter(item => item.source_category === category.id).length);
      }
      host.$("sticker-category").value = "all";
      host.$("sticker-category").dispatchEvent(new host.w.Event("change", { bubbles: true }));
      host.d.querySelector('[data-sticker-source="all"]').click();
      assert.equal(host.$("sticker-list").querySelectorAll(".sticker-choice").length, host.catalog.stickers.length);
      for (const band of host.catalog.bands) {
        host.d.querySelector(`[data-sticker-filter="${band.id}"]`).click();
        assert.equal(host.$("sticker-list").querySelectorAll(".sticker-choice").length, host.catalog.stickers.filter(item => item.band_id === band.id).length);
      }
      host.d.querySelector('[data-sticker-filter="all"]').click();
      host.fill("sticker-search", selected.label);
      const choice = [...host.$("sticker-list").querySelectorAll(".sticker-choice")].find(item => item.dataset.stickerId === selected.id);
      assert(choice); choice.click();
      assert.equal(host.$("sticker-preview").querySelector("img").getAttribute("src"), selected.image);
      assert.equal(host.$("sticker-preview").querySelector("img").width, 162);
      assert.equal(host.requests.filter(item => item.method === "POST" && item.path.endsWith("/messages")).length, postsBefore, "Selection/search never submits a message");
      host.click("send-sticker");
      await until(() => !host.$("message-feed").querySelector("[data-pending-id]") && host.committedMessages.some(item => item.sticker_id === selected.id), "real sticker commit");
      const message = host.committedMessages.find(item => item.sticker_id === selected.id);
      assert.equal(message.kind, "speech"); assert.equal(message.content_type, "sticker");
      assert.equal(message.character_id, "mygo.tomori"); assert.equal(message.author, "高松灯");
      assert.equal(message.sticker.character_id, selected.character_id);
      assert.equal(host.$("message-input").value, "发送贴纸时保留的文字草稿");
      assert(host.$("sticker-selection-dot").hidden);
      await until(() => !!messageElement(observer, message.id)?.querySelector(".message-sticker img"), "observer receives committed stage sticker");
      assert.equal(messageElement(observer, message.id).querySelector(".message-author").textContent, "高松灯");
      assert.equal(messageElement(observer, message.id).querySelector(".message-sticker img").getAttribute("src"), selected.image);
      assert.equal(messageElement(observer, message.id).querySelector(".message-sticker figcaption"), null);
      assert.equal(messageElement(observer, message.id).querySelector(".message-sticker").textContent, "");
      assert.equal(messageElement(observer, message.id).querySelector(".message-sticker img").alt, selected.label);
      const image = messageElement(observer, message.id).querySelector(".message-sticker img"); image.dispatchEvent(new observer.w.Event("error"));
      assert(messageElement(observer, message.id).querySelector(".message-sticker").textContent.includes(selected.label));
      assert(messageElement(observer, message.id).querySelector(".sticker-image-fallback"), "Unavailable sticker art retains its accessible text fallback");
      const submitted = host.requests.filter(item => item.method === "POST" && item.path.endsWith("/messages")).at(-1).body;
      assert.deepEqual(Object.keys(submitted).sort(), ["channel", "client_message_id", "content_type", "sticker_id"]);
    });
    await step("Server-backed automatic cross-client delivery and a disconnected actor recover text and sticker once without rejoining", async () => {
      if (host.serverTransport.type === "poll") {
        await until(() => [host, peer, observer].every(c => c.$("connection-label").textContent === "多人同步正常"), "confirmed shared polling and presence");
        for (const c of [host, peer, observer]) assert.equal(c.sockets.length, 0, "Polling is server declared and must not construct a WebSocket");
      }
      const before = (await peer.request(`/api/rooms/${roomId}`)).room.me;
      const joinCount = peer.requests.filter(item => item.path.endsWith("/join")).length;
      const first = "自动联机：不同会话收到同一条发言";
      await send(host, first);
      await until(() => [peer, observer].every(c => c.$("message-feed").textContent.includes(first)), "autonomous cross-client delivery without manual refresh");
      peer.setOnline(false);
      assert.equal(peer.$("connection-label").textContent, "浏览器已离线");
      const second = "断线期间的文字将在恢复后补齐";
      await send(host, second);
      const sticker = await sendSticker(host, host.catalog.stickers.find(item => item.source_pack === "user-v04").id);
      await until(() => observer.$("message-feed").textContent.includes(second) && messageElement(observer, sticker.id), "connected spectator continues receiving real shared messages");
      assert(!peer.$("message-feed").textContent.includes(second));
      peer.setOnline(true);
      await until(() => peer.$("message-feed").textContent.includes(second) && messageElement(peer, sticker.id), "actor recovers all missing payloads");
      const after = (await peer.request(`/api/rooms/${roomId}`)).room.me;
      assert(before.member_id);
      assert.equal(after.member_id, before.member_id);
      assert.equal(after.character_id, before.character_id);
      assert.equal(peer.requests.filter(item => item.path.endsWith("/join")).length, joinCount, "Reconnect only synchronizes; it does not add a membership event");
      assert.equal(peer.$("message-feed").querySelectorAll(`[data-message-id="${sticker.id}"]`).length, 1);
      assert.equal([...peer.$("message-feed").querySelectorAll(".message-body")].filter(item => item.textContent === second).length, 1);
    });
    if (host.serverTransport.type === "poll") await step("Two tabs share one member but use distinct presence leases; leaving one view keeps the other tab online and its role held", async () => {
      const sibling = client({ jar: peer.jar, hash: `#room=${roomId}`, nickname: peer.nickname });
      await booted(sibling, true);
      await until(() => sibling.requests.some(item => item.path.endsWith("/presence") && item.body?.active === true), "second tab immediately sends a real heartbeat");
      const peerPresence = peer.requests.find(item => item.path.endsWith("/presence") && item.body?.active === true);
      const siblingPresence = sibling.requests.find(item => item.path.endsWith("/presence") && item.body?.active === true);
      assert(peerPresence.body.connection_id !== siblingPresence.body.connection_id);
      const before = (await peer.request(`/api/rooms/${roomId}`)).room;
      assert.equal(before.members.filter(item => item.id === before.me.member_id).length, 1);
      sibling.click("back-to-lobby");
      await booted(sibling);
      await until(() => sibling.requests.some(item => item.path.endsWith("/presence") && item.body?.active === false) && sibling.activeRequests === 0, "departure marks only the closed room view absent");
      const after = (await peer.request(`/api/rooms/${roomId}`)).room;
      assert.equal(after.me.character_id, before.me.character_id);
      assert.equal(after.members.find(item => item.id === before.me.member_id).online, true);
      assert.equal(sibling.sockets.length, 0);
      await sibling.close();
    });
    await step("Separate stage/backstage sticker choices and text drafts restore without sending and are isolated from a new identity", async () => {
      const stageChoice = host.catalog.stickers.find(item => item.band_id === "mygo");
      const backstageChoice = host.catalog.stickers.find(item => item.band_id === "mujica");
      host.fill("message-input", "舞台文字与贴纸的刷新草稿"); chooseSticker(host, stageChoice.id); host.click("close-stickers");
      host.click("backstage-channel"); host.fill("message-input", "后台文字与贴纸的刷新草稿"); chooseSticker(host, backstageChoice.id); host.click("close-stickers");
      const saved = host.capture(), csrf = host.csrf; await host.close(); host = client(saved); await booted(host, true);
      assert.equal(host.csrf, csrf); assert.equal(host.$("message-input").value, "舞台文字与贴纸的刷新草稿");
      host.click("open-stickers");
      assert.equal(host.$("sticker-preview").querySelector("img").getAttribute("src"), stageChoice.image); host.click("close-stickers");
      host.click("backstage-channel"); assert.equal(host.$("message-input").value, "后台文字与贴纸的刷新草稿");
      host.click("open-stickers");
      assert.equal(host.$("sticker-preview").querySelector("img").getAttribute("src"), backstageChoice.image); host.click("close-stickers");
      assert.equal(host.requests.filter(item => item.method === "POST" && item.path.endsWith("/messages")).length, 0, "Reload does not send either saved choice");
      const isolated = client({ ...saved, jar: new CookieJar() }); await booted(isolated, true);
      assert.notEqual(isolated.csrf, csrf); assert.equal(isolated.$("message-input").value, "");
      assert(!isolated.$("message-feed").querySelector("[data-pending-id]") && isolated.$("sticker-selection-dot").hidden && isolated.$("open-stickers").disabled);
      for (const key of Object.keys(saved.session)) if (/onstage\.phase1\.(pending|drafts|sticker-drafts)\./.test(key)) assert.equal(isolated.w.sessionStorage.getItem(key), null);
      await isolated.request("/api/logout", {}); await isolated.close();
      host.click("stage-channel");
    });
    await step("Lost sticker acknowledgement restores its frozen preview and original retry key across reload", async () => {
      const selected = host.catalog.stickers.find(item => item.band_id === "mygo");
      host.holdSync = true; host.lostAck = true; chooseSticker(host, selected.id); host.click("send-sticker");
      await until(() => host.$("message-feed").querySelector(".message-retry"), "sticker uncertainty is visible");
      const first = host.requests.filter(item => item.method === "POST" && item.path.endsWith("/messages")).at(-1).body;
      const committed = host.committedMessages.at(-1);
      host.fill("message-input", "确认贴纸期间继续编辑的文字");
      const saved = host.capture(); await host.close(); host = client(saved); await booted(host, true);
      await until(() => !host.$("message-feed").querySelector("[data-pending-id]") && messageElement(host, committed.id), "restored pending confirmed by sync");
      assert.equal(messageElement(host, committed.id).querySelector(".message-sticker img").getAttribute("src"), selected.image);
      assert.equal(host.$("message-input").value, "确认贴纸期间继续编辑的文字");
      assert.equal(host.requests.filter(item => item.method === "POST" && item.path.endsWith("/messages")).length, 0);
      assert.equal(committed.client_message_id, first.client_message_id, "sync confirmation uses the original persisted key");
      const sync = await host.request(`/api/rooms/${roomId}/sync?after_stage=0&after_backstage=0`);
      assert.equal(sync.messages.stage.filter(item => item.id === committed.id).length, 1);
      assert.equal(host.$("message-input").value, "确认贴纸期间继续编辑的文字");
      assert(host.$("sticker-selection-dot").hidden);
      assert(messageElement(host, committed.id)?.querySelector(".message-sticker"));
      host.click("backstage-channel"); host.click("stage-channel");
      assert.equal(host.$("message-feed").querySelectorAll('[data-enter="true"]').length, 0, "Re-reading a channel does not animate historical messages again");
    });
    await step("Lost acknowledgement retains original text and idempotency key on retry", async () => {
      host.holdSync = true; host.lostAck = true; host.fill("message-input", "确认包丢失时不得重复的测试消息"); host.submit("message-form");
      await until(() => host.$("message-feed").querySelector(".message-retry"), "uncertain send retained");
      host.$("message-feed").querySelector(".message-retry").click(); await until(() => !host.$("message-feed").querySelector("[data-pending-id]"), "retry acknowledged");
      const sent = host.requests.filter(r => r.path.endsWith("/messages") && r.method === "POST" && r.body.text === "确认包丢失时不得重复的测试消息");
      host.holdSync = false;
      assert.equal(sent.length, 2); assert.equal(sent[0].body.client_message_id, sent[1].body.client_message_id);
      const sync = await host.request(`/api/rooms/${roomId}/sync?after_stage=0&after_backstage=0`);
      assert.equal(sync.messages.stage.filter(m => m.text === "确认包丢失时不得重复的测试消息").length, 1);
    });
    await step("Draft, room route, theme and chosen character survive reload", async () => {
      host.fill("message-input", "刷新后应当保留的未发送草稿");
      const csrf = host.csrf, saved = host.capture(); await host.close(); host = client(saved); await booted(host, true);
      assert.equal(host.csrf, csrf); assert.equal(host.$("message-input").value, "刷新后应当保留的未发送草稿");
      assert(host.$("composer-identity").textContent.includes("高松灯")); assert.equal(host.d.documentElement.dataset.theme, "dark");
    });
    await step("Message report, host resolution, and reporter receipt through DOM controls", async () => {
      const message = [...observer.d.querySelectorAll(".message")].find(el => el.textContent.includes("纯文本")); assert(message);
      message.querySelector(".message-report").click(); observer.fill("report-details", "自动化测试：验证举报和处理回执。"); observer.$("report-reason").value = "spam"; observer.submit("report-form");
      await until(() => observer.$("reports-dialog").open && observer.d.querySelectorAll(".report-card").length === 1, "report receipt");
      host.click("room-reports-button"); await until(() => !![...host.$("reports-list").querySelectorAll("button")].find(el => el.textContent === "处理反馈"), "host sees permitted report");
      button(host, "处理反馈", host.$("reports-list")).click(); host.fill("resolve-note", "自动化验收：处理记录已保存。"); host.submit("resolve-form");
      await until(() => !host.$("resolve-dialog").open && host.$("reports-list").textContent.includes("处理记录已保存"), "host resolution saved");
      observer.click("refresh-reports"); await until(() => observer.$("reports-list").textContent.includes("处理记录已保存"), "reporter resolution receipt");
      host.click("close-reports"); observer.click("close-reports");
    });
    await step("Sticker report keeps the server image snapshot and supports host resolution plus reporter receipt", async () => {
      const selected = peer.catalog.stickers.find(item => item.band_id === "mygo" && item.character_id !== "mygo.tomori");
      stageStickerMessage = await sendSticker(peer, selected.id);
      await until(() => !!messageElement(observer, stageStickerMessage.id), "reported stage sticker arrives");
      messageElement(observer, stageStickerMessage.id).querySelector(".message-report").click();
      assert.equal(observer.$("report-target").querySelector("img").getAttribute("src"), stageStickerMessage.sticker.image);
      observer.fill("report-details", "自动化贴纸反馈：验证图片快照与处理回执。"); observer.submit("report-form");
      await until(() => !!reportCard(observer, "自动化贴纸反馈"), "sticker reporter receipt");
      assert.equal(reportCard(observer, "自动化贴纸反馈").querySelector(".report-sticker img").getAttribute("src"), selected.image);
      host.click("room-reports-button"); await until(() => !!reportCard(host, "自动化贴纸反馈"), "host sees permitted sticker snapshot");
      assert.equal(reportCard(host, "自动化贴纸反馈").querySelector(".report-sticker img").getAttribute("src"), selected.image);
      button(host, "处理反馈", reportCard(host, "自动化贴纸反馈")).click();
      host.fill("resolve-note", "自动化贴纸验收：该反馈已处理。"); host.submit("resolve-form");
      await until(() => !host.$("resolve-dialog").open && reportCard(host, "自动化贴纸反馈")?.textContent.includes("该反馈已处理"), "sticker resolution saved");
      observer.click("refresh-reports"); await until(() => reportCard(observer, "自动化贴纸反馈")?.textContent.includes("该反馈已处理"), "sticker resolution receipt");
      observer.click("close-reports"); host.click("close-reports");
    });
    await step("Backstage sticker delivery and report snapshot remain restricted to permitted participants", async () => {
      host.click("backstage-channel"); peer.click("backstage-channel");
      const selected = host.catalog.stickers.find(item => item.band_id === "mujica");
      backstageStickerMessage = await sendSticker(host, selected.id);
      await until(() => !!messageElement(peer, backstageStickerMessage.id), "backstage actor receives sticker");
      assert.equal(messageElement(peer, backstageStickerMessage.id).querySelector(".message-sticker img").getAttribute("src"), selected.image);
      const visible = await observer.request(`/api/rooms/${roomId}/sync?after_stage=0&after_backstage=0`);
      assert.equal(visible.messages.backstage.length, 0); assert(!messageElement(observer, backstageStickerMessage.id));
      messageElement(peer, backstageStickerMessage.id).querySelector(".message-report").click();
      peer.fill("report-details", "自动化后台贴纸反馈：移出后仅保留回执。"); peer.submit("report-form");
      await until(() => !!reportCard(peer, "自动化后台贴纸反馈"), "private sticker report saved");
      assert(reportCard(peer, "自动化后台贴纸反馈").querySelector(".report-sticker img"));
      assert(reportCard(peer, "自动化后台贴纸反馈").textContent.includes("交维护者处理"));
      host.click("room-reports-button"); await until(() => host.$("reports-list").getAttribute("aria-busy") === "false", "host permissible report list");
      assert(!reportCard(host, "自动化后台贴纸反馈")); host.click("close-reports"); peer.click("close-reports");
      host.click("stage-channel"); peer.click("stage-channel");
    });
    await step("Late leave acknowledgement cannot pull a user out of a subsequently entered room", async () => {
      const second = (await host.request("/api/rooms", { scenario_id: "shared_greenroom", title: "导航竞态验收房", background: "自动化导航测试" })).room;
      observer.delayLeave = true; observer.click("leave-room"); observer.click("confirm-accept");
      await until(() => !!observer.releaseLeave, "leave acknowledgement held after server commit");
      observer.click("back-to-lobby");
      await until(() => observer.d.body.dataset.view === "lobby" && !observer.$("refresh-rooms").disabled, "return to lobby while old acknowledgement pending");
      const target = [...observer.d.querySelectorAll(".room-row")].find(el => el.textContent.includes("导航竞态验收房")); assert(target);
      target.querySelector(".join-room").click(); await booted(observer, true);
      assert.equal(observer.$("room-title").textContent, "导航竞态验收房");
      observer.releaseLeave(); await until(() => !observer.releaseLeave && observer.activeRequests === 0, "old acknowledgement released");
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(observer.d.body.dataset.view, "room"); assert.equal(observer.w.location.hash, `#room=${second.id}`);
      observer.click("back-to-lobby"); await until(() => observer.d.body.dataset.view === "lobby" && !observer.$("refresh-rooms").disabled, "lobby before returning to main test scene");
      const original = [...observer.d.querySelectorAll(".room-row")].find(el => el.textContent.includes("自动化 DOM 验收房")); assert(original);
      original.querySelector(".join-room").click(); await booted(observer, true);
      assert.equal(observer.w.location.hash, `#room=${roomId}`);
      await host.request(`/api/rooms/${second.id}/control`, { action: "end" });
    });
    await step("Room report reaches maintainer queue and is hidden from the host", async () => {
      observer.click("report-room-button"); observer.fill("report-details", "自动化测试：房间反馈独立处理。"); observer.submit("report-form");
      await until(() => observer.$("reports-list").textContent.includes("交维护者处理"), "room report private queue receipt");
      host.click("room-reports-button"); await until(() => host.$("reports-list").getAttribute("aria-busy") === "false", "host report list loaded");
      assert(!host.$("reports-list").textContent.includes("房间反馈独立处理"));
      host.click("close-reports"); observer.click("close-reports");
    });
    await step("Host removal revokes the actor's live UI and room link reentry", async () => {
      host.click("audience-label");
      host.d.querySelector('[aria-label="移出 丰川祥子"]').click(); assert(host.$("confirm-dialog").open);
      assert(host.$("confirm-description").textContent.includes("橘子汽水"));
      host.click("confirm-accept");
      await until(() => peer.d.body.dataset.view === "lobby", "removed peer returned to lobby");
      await until(() => observer.$("message-feed").textContent.includes("橘子汽水（丰川祥子）已被房主移出房间。"), "removal is durable history for remaining members");
      const saved = peer.capture(); saved.hash = `#room=${roomId}`; await peer.close(); peer = client(saved); await booted(peer);
      assert(peer.$("toasts").textContent.includes("移出") || peer.$("toasts").textContent.includes("加入"));
      peer.click("feedback-button"); await until(() => !!reportCard(peer, "自动化后台贴纸反馈"), "removed participant retains own feedback receipt");
      assert.equal(reportCard(peer, "自动化后台贴纸反馈").querySelector(".report-sticker"), null);
      assert.equal(reportCard(peer, "自动化后台贴纸反馈").querySelector(".report-snapshot"), null);
      assert(reportCard(peer, "自动化后台贴纸反馈").textContent.includes("交维护者处理")); peer.click("close-reports");
    });
    await step("End scene freezes posting and settings while retaining readable records", async () => {
      button(host, "结束这一场", host.$("host-controls")).click(); host.click("confirm-accept");
      await until(() => host.$("room-status").textContent === "已落幕" && observer.$("room-status").textContent === "已落幕", "end broadcast");
      assert(host.$("message-input").disabled && host.$("room-settings").hidden && host.$("open-stickers").disabled);
      assert.equal(host.d.querySelectorAll(".member-remove").length, 0);
      assert(observer.$("message-feed").textContent.includes("纯文本"));
      assert(messageElement(observer, stageStickerMessage.id)?.querySelector(".message-sticker"));
      host.click("backstage-channel"); assert(host.$("open-stickers").disabled);
      assert(messageElement(host, backstageStickerMessage.id)?.querySelector(".message-sticker"));
      const frozen = (await host.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`)).messages;
      host.click("leave-room"); await booted(host);
      const archived = [...host.d.querySelectorAll(".room-row")].find(item => item.textContent.includes("自动化 DOM 验收房"));
      if (archived) { archived.querySelector(".join-room").click(); }
      else { host.w.location.hash = `#room=${roomId}`; }
      await booted(host, true); host.click("backstage-channel");
      assert(messageElement(host, backstageStickerMessage.id)?.querySelector(".message-sticker"));
      assert(host.$("open-stickers").disabled);
      assert.deepEqual((await host.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`)).messages, frozen, "Archive navigation adds no new visitor events");
    });
    for (const c of clients) {
      assert.deepEqual(c.exceptions, [], "Unhandled DOM runtime errors");
      assert(c.maxActiveSyncs <= 1, "A slow or interrupted client must not accumulate concurrent sync requests");
      if (c.serverTransport?.type === "poll") assert.equal(c.sockets.length, 0);
    }
    report.autonomous_sync = { independent_sessions: 3, offline_text_and_sticker_recovered: true, duplicate_delivery: false, max_parallel_syncs_per_dom: Math.max(...clients.map(c => c.maxActiveSyncs)), websocket_constructions: clients.reduce((count, c) => count + c.sockets.length, 0) };
    report.result = "passed";
  } catch (error) {
    report.result = "failed"; report.errors.push(error.stack || String(error)); process.exitCode = 1;
  } finally {
    for (const c of clients) if (c.releaseLeave) c.releaseLeave();
    if (host && roomId) try { await host.request(`/api/rooms/${roomId}/control`, { action: "end" }); } catch {}
    for (const c of [host, peer, observer].filter(Boolean)) try { await c.request("/api/logout", {}); } catch {}
    for (const c of clients) try { await c.close(); } catch {}
    report.completed_at_utc = new Date().toISOString();
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ result: report.result, steps: report.steps.length, errors: report.errors, output }, null, 2) + "\n");
  }
})();
