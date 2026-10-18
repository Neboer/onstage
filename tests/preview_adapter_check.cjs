/* Focused browser-local preview checks. No server, browser or external network.
 * npm ci, then node tests/preview_adapter_check.cjs [reports/preview-adapter-v06.json]
 * ONSTAGE_DOM_MODULES may explicitly select another dependency directory.
 * The DOM smoke still performs no external network.
 */
"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const previewDirectory = path.resolve(process.env.ONSTAGE_PREVIEW_DIR || path.join(root, "dist-offline-review"));
const output = path.resolve(process.argv[2] || path.join(root, "reports/preview-adapter-v06.json"));
const started = performance.now();
const sourcePath = path.join(root, "preview/adapter.js");
const catalogPath = path.join(root, "app/catalog.json");
const scopes = [];
const report = {
  version: fs.readFileSync(path.join(root, "VERSION"), "utf8").trim(),
  started_at_utc: new Date().toISOString(),
  method: "Node VM executes the original preview adapter with isolated browser storage; fetch allows only the bundled static catalog and WebSocket construction throws",
  browser_executed: false, layout_executed: false, network_executed: false,
  steps: [], errors: [],
  limitations: ["No rendered layout, real browser storage implementation, image decoding, clipboard, IME or physical phone check", "No public Site, TLS, mainland network or real multiplayer validation", "Production backend integration remains a separate test suite"],
};
const plain = value => JSON.parse(JSON.stringify(value));
const sha = value => crypto.createHash("sha256").update(value).digest("hex");

class MemoryStorage {
  constructor(entries = {}) { this.items = new Map(Object.entries(entries)); this.clearCalls = 0; }
  get length() { return this.items.size; }
  key(index) { return Array.from(this.items.keys())[index] ?? null; }
  getItem(key) { return this.items.get(String(key)) ?? null; }
  setItem(key, value) { this.items.set(String(key), String(value)); }
  removeItem(key) { this.items.delete(String(key)); }
  clear() { this.clearCalls += 1; throw new Error("Global storage.clear() is forbidden by this test"); }
}

function loadAdapter(source, catalog, { enabled = true, missingConfig = false, local = new MemoryStorage(), session = new MemoryStorage(), catalogGate } = {}) {
  const requests = [];
  const events = new Map();
  const timers = new Set();
  const sandbox = {
    localStorage: local, sessionStorage: session,
    crypto: crypto.webcrypto, URL, URLSearchParams, TextEncoder, TextDecoder,
    AbortController, DOMException, structuredClone,
    location: new URL("https://preview-review.invalid/"),
    console: { log() {}, warn() {}, error() {} },
    setTimeout(fn, delay, ...args) { const timer = setTimeout(fn, delay, ...args); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    queueMicrotask,
    addEventListener(type, fn) { if (!events.has(type)) events.set(type, new Set()); events.get(type).add(fn); },
    removeEventListener(type, fn) { events.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of events.get(event.type) || []) fn(event); return true; },
    fetch: async (input, options = {}) => {
      const url = new URL(String(input), "https://preview-review.invalid/");
      requests.push({ origin: url.origin, pathname: url.pathname, method: options.method || "GET" });
      assert.equal(url.origin, "https://preview-review.invalid", "Preview must not access an external origin");
      assert.equal(url.pathname, "/preview/catalog.json", "Only the bundled static catalog may be fetched");
      assert.equal(options.method || "GET", "GET");
      if (catalogGate) await catalogGate();
      return { ok: true, status: 200, json: async () => plain(catalog) };
    },
    WebSocket: class { constructor() { throw new Error("A browser-local preview must not create WebSockets"); } },
  };
  sandbox.window = sandbox;
  if (!missingConfig) sandbox.OnstagePreviewConfig = { enabled, version: report.version + "+preview", catalogUrl: "/preview/catalog.json" };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: sourcePath, timeout: 2000 });
  const result = { api: sandbox.OnstagePreview, sandbox, local, session, requests, close() { for (const timer of timers) clearTimeout(timer); } };
  scopes.push(result);
  return result;
}

async function step(name, fn) {
  const began = performance.now();
  await fn();
  report.steps.push({ name, result: "passed", milliseconds: Number((performance.now() - began).toFixed(3)) });
}
async function rejectsStatus(promise, status) {
  await assert.rejects(promise, error => Number(error.status) === status, `Expected explicit HTTP-style ${status} rejection`);
}
const post = (api, url, body = {}, headers) => api.request(url, { method: "POST", body, headers });

async function until(predicate, label, timeout = 4000) {
  const began = performance.now();
  while (!(await predicate())) {
    if (performance.now() - began > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

async function domSmoke(catalog, adapterSource) {
  const { createRequire } = require("node:module");
  const testRequire = createRequire(path.join(process.env.ONSTAGE_DOM_MODULES || path.join(root, "node_modules"), ".onstage-preview-test.cjs"));
  const { JSDOM, VirtualConsole } = testRequire("jsdom");
  const appSource = fs.readFileSync(path.join(root, "static/app.js"), "utf8");
  const html = fs.readFileSync(path.join(previewDirectory, "index.html"), "utf8");
  const clients = [];
  function client({ loadMode = true, loadPreviewAdapter = true, local = {}, session = {}, hash = "" } = {}) {
    const errors = [], network = [], calls = [], observers = [];
    const outputConsole = new VirtualConsole();
    outputConsole.on("jsdomError", error => errors.push(error.message));
    const dom = new JSDOM(html, { url: "https://preview-review.invalid/" + hash, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: outputConsole });
    const w = dom.window, d = w.document;
    const c = { dom, w, d, errors, network, calls, clipboard: "", sockets: 0, bannerHeight: 72, observers };
    c.$ = id => d.getElementById(id);
    c.fill = (id, value) => { c.$(id).value = value; c.$(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
    c.submit = id => c.$(id).dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
    c.button = (pattern, parent = d) => [...parent.querySelectorAll("button")].find(item => pattern.test(item.textContent.trim()) && !item.disabled);
    Object.defineProperty(w, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(w, "innerHeight", { value: 844, configurable: true });
    Object.defineProperty(w, "visualViewport", { value: { height: 844, addEventListener() {}, removeEventListener() {} } });
    Object.defineProperty(w.HTMLElement.prototype, "offsetHeight", { get() { return /preview.*(?:banner|notice)|(?:banner|notice).*preview/.test(this.id) ? c.bannerHeight : 0; } });
    w.matchMedia = query => ({ matches: /max-width:\s*720px/.test(query), media: query, addEventListener() {}, removeEventListener() {} });
    w.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} };
    w.scrollTo = () => {};
    w.HTMLElement.prototype.scrollIntoView = function() {};
    w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute("open", ""); };
    w.HTMLDialogElement.prototype.close = function(value = "") { this.returnValue = value; this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
    w.TextEncoder = TextEncoder; w.AbortController = AbortController;
    Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async value => { c.clipboard = value; } } });
    w.WebSocket = class { constructor() { c.sockets++; throw new Error("Shared UI attempted a WebSocket in browser-local preview"); } static OPEN = 1; static CONNECTING = 0; };
    w.fetch = async (input, options = {}) => {
      const url = new URL(String(input), w.location.href);
      network.push({ origin: url.origin, pathname: url.pathname, method: options.method || "GET" });
      assert.equal(url.origin, w.location.origin);
      assert.equal(url.pathname, "/preview/catalog.json", "Shared preview UI must not fetch an API or external URL");
      assert.equal(options.method || "GET", "GET");
      return { ok: true, status: 200, json: async () => plain(catalog) };
    };
    w.addEventListener("error", event => errors.push(String(event.error || event.message)));
    w.localStorage.setItem("onstage.theme", "dark");
    w.sessionStorage.setItem("onstage.phase1.drafts.production", "unrelated production draft");
    for (const [key, value] of Object.entries(local)) w.localStorage.setItem(key, value);
    for (const [key, value] of Object.entries(session)) w.sessionStorage.setItem(key, value);
    w.eval(fs.readFileSync(path.join(root, "static/theme.js"), "utf8"));
    if (loadMode) w.eval(fs.readFileSync(path.join(previewDirectory, "preview/mode.js"), "utf8"));
    if (loadPreviewAdapter) w.eval(adapterSource);
    const original = w.OnstagePreview;
    if (original) w.OnstagePreview = Object.freeze({ ...original, request: async (route, options = {}) => {
      const entry = { pathname: new URL(route, w.location.href).pathname, method: options.method || "GET", body: options.body ? plain(options.body) : null };
      calls.push(entry);
      try { const result = await original.request(route, options); entry.response = result; return result; }
      catch (error) { entry.status = error.status; throw error; }
    } });
    clients.push(c);
    w.eval(appSource);
    return c;
  }
  let a, b;
  try {
    await step("Shared UI preview boot uses only the bundled catalog and keeps another browser's records independent", async () => {
      a = client();
      await until(() => !a.$("guest-form").hidden, "one-field guest entry");
      assert.equal(a.calls.length, 1);
      assert.equal(a.calls[0].pathname, "/api/session");
      assert.equal(a.calls[0].method, "GET", "Restoring never silently creates a new identity");
      assert.equal(a.d.querySelectorAll('#guest-form input').length, 1);
      assert.equal(a.d.querySelector('input[type="password"]'), null);
      a.fill("guest-nickname", " "); a.submit("guest-form");
      assert(!a.$("guest-error").hidden); assert.equal(a.calls.length, 1);
      a.fill("guest-nickname", "本机小雨"); a.submit("guest-form");
      await until(() => a.d.body.dataset.view === "lobby" && a.d.querySelectorAll(".scenario-image-button").length > 0, "preview lobby bootstrap");
      assert.match(a.$("connection-label").textContent, /界面评审/);
      const banner = [...a.d.querySelectorAll("[id]")].find(item => /preview.*(?:banner|notice)|(?:banner|notice).*preview/.test(item.id));
      assert(banner && !banner.hidden, "A persistent local-preview notice must be visible");
      assert(banner.textContent.includes("记录仅在当前浏览器"));
      a.d.querySelector(".scenario-image-button").click();
      a.fill("new-room-title", "单人预览独立 DOM 检查");
      a.fill("new-room-background", "只在当前浏览器保存");
      a.submit("create-form");
      await until(() => a.d.body.dataset.view === "room" && a.d.querySelectorAll(".seat-main").length === catalog.characters.length, "local room and character controls");
      await until(() => a.$("message-feed").textContent.includes("本机小雨 以观众身份进入了房间。"), "own durable spectator entry");
      assert(a.$("composer-identity").textContent.includes("旁观中"));
      a.$("audience-label").click();
      assert.equal(a.$("desk-panel").dataset.active, "true");
      assert.equal(a.$("member-list").children.length, 1);
      assert.equal(a.$("member-list").querySelector(".member-remove"), null);
      a.$("mobile-tab-stage").click();
      b = client();
      await until(() => !b.$("guest-form").hidden, "independent guest nickname");
      b.fill("guest-nickname", "另一浏览器本人"); b.submit("guest-form");
      await until(() => b.d.body.dataset.view === "lobby" && b.calls.some(item => item.pathname === "/api/rooms" && item.response), "independent local browser");
      assert.equal((await b.w.OnstagePreview.request("/api/rooms")).rooms.length, 0);
    });
    await step("An existing unlabelled local identity asks for a nickname and retains its invite target, scope and history", async () => {
      const local = Object.fromEntries(Object.entries(a.w.localStorage));
      const stored = JSON.parse(local["onstage.preview.v04.data"]);
      const oldIdentity = (await a.w.OnstagePreview.request("/api/session")).storage_scope;
      delete stored.nickname;
      local["onstage.preview.v04.data"] = JSON.stringify(stored);
      const oldHash = a.w.location.hash;
      const legacy = client({ local, hash: oldHash });
      await until(() => !legacy.$("guest-form").hidden, "legacy unnamed identity entry");
      assert.equal(legacy.w.location.hash, oldHash);
      assert.equal(legacy.$("guest-submit").textContent.trim(), "继续进入房间");
      legacy.fill("guest-nickname", "升级后的昵称"); legacy.submit("guest-form");
      await until(() => legacy.d.body.dataset.view === "room" && legacy.$("message-feed").textContent.includes("本机小雨 以观众身份进入了房间。"), "legacy room restored after nickname");
      assert.equal((await legacy.w.OnstagePreview.request("/api/session")).storage_scope, oldIdentity);
      assert.equal(legacy.w.location.hash, oldHash);
      assert(legacy.$("my-identity").textContent.includes("升级后的昵称"));
      const roomId = new URLSearchParams(oldHash.slice(1)).get("room");
      const history = await legacy.w.OnstagePreview.request(`/api/rooms/${roomId}/messages?channel=stage&after=0`);
      assert.equal(history.messages.filter(message => message.kind === "system").length, 1, "Restoring an existing membership must not add another join message");
    });
    await step("Shared UI selects one actor, explicitly previews the stage, and renders manual text plus a null-character sticker", async () => {
      a.d.querySelector(".seat-main:not(:disabled)").click();
      await until(() => Boolean(a.button(/预览演出|开始预览/, a.$("host-controls"))), "explicit one-person preview control");
      a.button(/预览演出|开始预览/, a.$("host-controls")).click();
      await until(() => !a.$("message-input").disabled, "preview stage is editable");
      for (const action of ["close_join", "open_join"]) {
        const toggle = a.$("host-controls").querySelector('[data-focus-key="control-join"]');
        assert(toggle && !toggle.disabled);
        toggle.click();
        await until(() => a.calls.some(item => item.pathname.endsWith("/control") && item.body?.action === action && item.response), "local join-setting preview toggle");
        const latest = [...a.$("toasts").children].at(-1)?.textContent || "";
        assert(!/新同伴|同伴仍可旁观|朋友.*加入/.test(latest), "A local setting toggle must not claim that other people can join this room");
      }
      a.fill("message-input", "DOM 检查本人手动输入");
      a.submit("message-form");
      await until(() => a.$("message-feed").textContent.includes("DOM 检查本人手动输入") && !a.$("message-feed").querySelector("[data-pending-id]"), "manual text saved locally");
      const selected = catalog.stickers.find(item => item.character_id === null) || catalog.stickers[0];
      a.$("open-stickers").click();
      a.d.querySelector('[data-sticker-source="all"]')?.click();
      a.d.querySelector('[data-sticker-filter="all"]')?.click();
      if (a.$("sticker-category")) { a.$("sticker-category").value = "all"; a.$("sticker-category").dispatchEvent(new a.w.Event("change", { bubbles: true })); }
      a.fill("sticker-search", "");
      const choice = [...a.$("sticker-list").querySelectorAll(".sticker-choice")].find(item => item.dataset.stickerId === selected.id);
      assert(choice, "The real null-character sticker is selectable without inventing a character");
      choice.click();
      assert(!a.$("send-sticker").disabled);
      a.$("send-sticker").click();
      await until(() => a.calls.some(item => item.pathname.endsWith("/messages") && item.response?.message?.sticker_id === selected.id) && !a.$("message-feed").querySelector("[data-pending-id]"), "manual sticker saved locally");
      const saved = a.calls.find(item => item.response?.message?.sticker_id === selected.id).response.message;
      assert.equal(saved.sticker.character_id, selected.character_id);
      const sent = [...a.$("message-feed").querySelectorAll("[data-message-id]")].find(item => item.dataset.messageId === saved.id);
      assert(sent && sent.querySelector(".message-sticker img"));
      assert.equal(sent.querySelector(".message-sticker figcaption"), null);
      assert.equal(sent.querySelector(".message-sticker").textContent, "", "Sent stickers have no visible filename caption");
      assert.equal(sent.querySelector(".message-sticker img").alt, selected.label);
      assert(choice.querySelector(".sticker-choice-label").textContent.includes(selected.label), "Picker keeps useful searchable labels");
      sent.querySelector(".message-sticker img").dispatchEvent(new a.w.Event("error"));
      assert(sent.querySelector(".sticker-image-fallback").textContent.includes(selected.label));
      assert.equal(a.$("member-list").children.length, 1);
      assert(!a.$("member-list").textContent.includes("在线"));
      report.dom_null_character_sticker_checked = selected.character_id === null;
    });
    await step("Shared preview sharing removes the local room hash and report form cannot create a receipt", async () => {
      assert(a.w.location.hash.includes("room="));
      a.$("copy-room-link").click();
      await until(() => Boolean(a.clipboard), "share preview URL");
      assert.equal(new URL(a.clipboard).hash, "");
      assert.equal(new URL(a.clipboard).search, "");
      a.$("report-room-button").click();
      assert(a.$("report-dialog").open);
      a.fill("report-details", "这里只检查表单，不提交维护者");
      a.submit("report-form");
      await new Promise(resolve => setTimeout(resolve, 30));
      assert(a.$("report-submit").disabled || a.$("report-error").textContent.includes("未提交") || a.$("report-dialog").textContent.includes("不会提交"));
      assert(!a.calls.some(item => item.response?.report));
      a.$("report-dialog").close();
    });
    await step("Preview banner measured height is propagated on resize; CSS subtracts it from the room", async () => {
      a.w.dispatchEvent(new a.w.Event("resize"));
      assert.equal(a.d.documentElement.style.getPropertyValue("--preview-height"), "72px");
      a.bannerHeight = 116;
      for (const observer of a.observers) observer.callback([]);
      a.w.dispatchEvent(new a.w.Event("resize"));
      assert.equal(a.d.documentElement.style.getPropertyValue("--preview-height"), "116px");
      const css = fs.readFileSync(path.join(root, "static/styles.css"), "utf8");
      assert(/\.room-view\s*\{[^}]*height\s*:\s*calc\([^;}]*-\s*var\(--preview-height/.test(css));
      report.dom_banner_measurement = "Injected 72px and 116px offsetHeight values reach --preview-height; CSS subtraction checked. This is not rendered geometry acceptance.";
    });
    await step("Shared preview reset clears local room route and preview drafts while retaining theme and production storage", async () => {
      const before = await a.w.OnstagePreview.request("/api/session", { method: "POST", body: {} });
      a.fill("message-input", "本机预览待清理草稿");
      const resetButton = a.button(/重置.*预览|重置本机/);
      assert(resetButton, "Preview reset control is available");
      resetButton.click();
      if (a.$("confirm-dialog").open) a.$("confirm-accept").click();
      await until(async () => (await a.w.OnstagePreview.request("/api/session", { method: "POST", body: {} })).storage_scope !== before.storage_scope, "preview identity reset");
      await until(() => !a.$("guest-form").hidden && !a.w.location.hash.includes("room="), "reset clears route and asks for a new guest nickname");
      assert.equal((await a.w.OnstagePreview.request("/api/rooms")).rooms.length, 0);
      assert.equal(a.w.localStorage.getItem("onstage.theme"), "dark");
      assert.equal(a.w.sessionStorage.getItem("onstage.phase1.drafts.production"), "unrelated production draft");
      assert.equal(a.$("guest-nickname").value, "");
      assert(!Array.from({ length: a.w.sessionStorage.length }, (_, index) => a.w.sessionStorage.key(index)).some(key => key?.startsWith("onstage.preview.v04.") && /本机预览待清理草稿/.test(a.w.sessionStorage.getItem(key) || "")));
    });
    await step("A generated preview entry with missing mode/adapter scripts fails closed without production transport fallback", async () => {
      for (const options of [{ loadMode: true, loadPreviewAdapter: false }, { loadMode: false, loadPreviewAdapter: false }]) {
        const broken = client(options);
        await until(() => !broken.$("loading-error").hidden && Boolean(broken.$("loading-error").textContent.trim()), "explicit preview component loading error");
        broken.$("retry-bootstrap").click();
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(broken.calls.length, 0);
        assert.equal(broken.network.length, 0, "A preview-marked entry cannot silently request production /api on script failure");
        assert.equal(broken.sockets, 0);
        assert.notEqual(broken.d.body.dataset.view, "room");
      }
    });
    await step("All shared preview DOM paths made zero network API calls and zero WebSocket constructions", async () => {
      for (const c of clients) {
        assert.equal(c.sockets, 0);
        assert(c.network.every(item => item.pathname === "/preview/catalog.json" && item.method === "GET"));
        assert.deepEqual(c.errors, []);
      }
      report.dom_executed = true;
      report.dom_engine = "jsdom 26.1.0; CSS layout is not executed";
      report.dom_catalog_fetches = clients.reduce((sum, c) => sum + c.network.length, 0);
      report.dom_websocket_constructions = 0;
      report.dom_network_api_calls = 0;
    });
  } finally {
    report.dom_diagnostics = clients.map(c => ({
      view: c.d.body.dataset.view || null, websocket_constructions: c.sockets,
      fetches: c.network, exceptions: c.errors,
      latest_calls: c.calls.slice(-8).map(item => ({ pathname: item.pathname, method: item.method, status: item.status || (item.response ? 200 : "pending") })),
      loading_error: c.$("loading-error")?.textContent || "",
    }));
    for (const c of clients) c.dom.window.close();
  }
}

async function main() {
  const source = fs.readFileSync(sourcePath, "utf8");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  report.input_sha256 = { "preview/adapter.js": sha(source), "app/catalog.json": sha(fs.readFileSync(catalogPath)), "static/app.js": sha(fs.readFileSync(path.join(root, "static/app.js"))) };
  report.catalog_counts = { scenarios: catalog.scenarios.length, characters: catalog.characters.length, stickers: catalog.stickers.length };

  await step("Production entry does not load preview scripts; absent/false configuration is inert", async () => {
    const html = fs.readFileSync(path.join(root, "static/index.html"), "utf8");
    assert(!/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/preview\/(?:mode|adapter)\.js/i.test(html));
    for (const option of [{ enabled: false }, { missingConfig: true }]) {
      const inactive = loadAdapter(source, catalog, option);
      assert.equal(inactive.api, undefined);
      assert.equal(inactive.requests.length, 0);
      assert.equal(inactive.local.length, 0);
    }
  });

  const local = new MemoryStorage({ "onstage.theme": "dark", "unrelated.local": "keep" });
  const session = new MemoryStorage({ "onstage.phase1.drafts.production": "preserve production draft", "unrelated.session": "keep" });
  const ctx = loadAdapter(source, catalog, { local, session });
  const api = ctx.api;
  assert.equal(api.isLocal, true);
  assert.equal(typeof api.request, "function");
  assert.equal(typeof api.reset, "function");
  assert.equal(typeof api.subscribe, "function");
  assert.equal(api.draftPrefix, "onstage.preview.v04.");
  const changes = [];
  const unsubscribe = api.subscribe(event => changes.push(plain(event)));
  let identity, room, characterId, stickerMessage, textMessage;
  const route = () => `/api/rooms/${room.id}`;

  await step("Nickname guest identity preserves anonymous compatibility, validates names and restores without creating an account", async () => {
    await rejectsStatus(api.request("/api/session"), 401);
    identity = await post(api, "/api/session");
    assert.equal(identity.authenticated, true);
    assert.equal(identity.nickname, null);
    assert.equal(identity.requires_nickname, true);
    assert.match(identity.csrf_token, /preview/i);
    assert.match(identity.storage_scope, /^preview-/);
    assert.deepEqual(plain(await post(api, "/api/session")), plain(identity));
    await rejectsStatus(post(api, "/api/session", { nickname: "小雨" }), 403);
    for (const nickname of ["小\n雨", "\u200b小雨", "小\u2028雨", "\ud800", "字".repeat(25), 3]) {
      await rejectsStatus(post(api, "/api/session", { nickname }, { "X-CSRF-Token": identity.csrf_token }), 422);
    }
    const initial = identity;
    identity = await post(api, "/api/session", { nickname: "  小雨  " }, { "X-CSRF-Token": identity.csrf_token });
    assert.equal(identity.nickname, "小雨");
    assert.equal(identity.requires_nickname, false);
    assert.equal(identity.csrf_token, initial.csrf_token);
    assert.equal(identity.storage_scope, initial.storage_scope);
    for (const body of [{ nickname: "小雨" }, { nickname: null }, { nickname: "   " }, {}]) {
      assert.deepEqual(plain(await post(api, "/api/session", body)), plain(identity));
    }
    const reloaded = loadAdapter(source, catalog, { local, session });
    const restored = await reloaded.api.request("/api/session");
    assert.equal(restored.csrf_token, identity.csrf_token);
    assert.equal(restored.storage_scope, identity.storage_scope);
    assert.equal(restored.nickname, "小雨");
    const fresh = loadAdapter(source, catalog);
    assert.equal((await post(fresh.api, "/api/session", { nickname: "直达访客" })).requires_nickname, false);
  });

  await step("Bundled catalog is read locally; new room contains only the reviewer's deliberate identity", async () => {
    const data = await api.request("/api/catalog");
    assert.deepEqual(plain(data), catalog);
    assert((await api.request("/api/rooms")).rooms.length === 0);
    const scene = data.scenarios[0];
    characterId = scene.character_ids[0];
    room = (await post(api, "/api/rooms", { scenario_id: scene.id, background: "独立审查用本机背景", announcement: "仅本机预览" })).room;
    assert.equal(room.status, "preparing");
    assert.equal(room.members.length, 1);
    assert.equal(room.members[0].id, room.me.member_id);
    assert.equal(room.me.character_id, null);
    assert.equal(room.me.nickname, "小雨");
    assert.equal(room.members[0].display_name, "小雨");
    assert.equal(room.online_count || 0, 0, "Local-only mode must not claim server connection presence");
    assert(room.members.every(member => !member.online));
    assert.equal((await post(api, route() + "/join")).room.members.length, 1);
    const messages = (await api.request(route() + "/sync?after_stage=0&after_backstage=0")).messages.stage;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "小雨 以观众身份进入了房间。");
    assert.equal(messages[0].kind, "system");
    assert.equal(messages[0].author, "系统");
    assert.equal(messages[0].member_id, null);
    assert.equal(messages[0].character_id, null);
    assert.equal(messages[0].content_type, "text");
  });

  await step("Single-person local stage requires an explicitly selected character and creates no peer", async () => {
    await rejectsStatus(post(api, route() + "/control", { action: "start" }), 409);
    room = (await post(api, route() + "/characters/claim", { character_id: characterId })).room;
    room = (await post(api, route() + "/control", { action: "start" })).room;
    assert.equal(room.status, "live");
    assert.equal(room.members.length, 1);
    assert.equal(room.me.character_id, characterId);
    assert.equal(room.me.can_stage, true);
  });

  await step("Durable member events are frozen and not duplicated by role retries, session restore or idempotent join", async () => {
    const before = await api.request(route() + "/messages?channel=stage&after=0");
    const role = catalog.characters.find(item => item.id === characterId);
    assert.equal(before.messages.filter(message => message.text === `小雨 作为 ${role.name} 入场。`).length, 1);
    await post(api, route() + "/characters/claim", { character_id: characterId });
    await post(api, route() + "/join");
    await api.request("/api/session");
    assert.deepEqual(plain(await api.request(route() + "/messages?channel=stage&after=0")), plain(before));
    await post(api, "/api/session", { nickname: "改名后的小雨" }, { "X-CSRF-Token": identity.csrf_token });
    assert.equal((await api.request(route())).room.me.nickname, "改名后的小雨");
    assert.deepEqual(plain(await api.request(route() + "/messages?channel=stage&after=0")), plain(before), "Current nickname changes cannot rewrite saved event text");
    await rejectsStatus(post(api, route() + "/leave"), 409);
    assert.deepEqual(plain(await api.request(route() + "/messages?channel=stage&after=0")), plain(before), "A blocked host exit adds no pretend leave event");
  });

  await step("Only manual text/sticker writes enter history; retries preserve ID and payload", async () => {
    const text = { channel: "stage", text: "独立检查：本人手动输入", client_message_id: "preview-audit-text-001" };
    textMessage = (await post(api, route() + "/messages", text)).message;
    const firstSticker = catalog.stickers.find(item => item.character_id !== characterId) || catalog.stickers[0];
    const sticker = { channel: "stage", content_type: "sticker", sticker_id: firstSticker.id, client_message_id: "preview-audit-sticker-001" };
    stickerMessage = (await post(api, route() + "/messages", sticker)).message;
    assert.equal(stickerMessage.kind, "speech");
    assert.equal(stickerMessage.content_type, "sticker");
    assert.equal(stickerMessage.sticker_id, firstSticker.id);
    assert.equal(stickerMessage.character_id, characterId);
    assert.equal(stickerMessage.sticker.character_id, firstSticker.character_id);
    assert.equal(stickerMessage.text, "[贴纸] " + firstSticker.label);
    assert.equal((await post(api, route() + "/messages", text)).message.id, textMessage.id);
    assert.equal((await post(api, route() + "/messages", sticker)).message.id, stickerMessage.id);
    await rejectsStatus(post(api, route() + "/messages", { ...sticker, sticker_id: "not-a-real-catalog-sticker", client_message_id: "preview-audit-invalid-001" }), 422);
    await rejectsStatus(post(api, route() + "/messages", { ...text, text: "Same ID, different text" }), 409);
    const sync = await api.request(route() + "/sync?after_stage=0&after_backstage=0");
    const speech = sync.messages.stage.filter(message => message.kind === "speech");
    assert.deepEqual(new Set(speech.map(message => message.id)), new Set([textMessage.id, stickerMessage.id]));
    assert(speech.every(message => message.member_id === room.me.member_id));
  });

  await step("Preview governance is explicitly unavailable; no fake report or resolution receipt", async () => {
    await rejectsStatus(post(api, route() + "/reports", { message_id: stickerMessage.id, reason: "other", details: "预览交互测试" }), 501);
    await rejectsStatus(post(api, route() + "/reports/not-a-report/resolve", { status: "resolved", note: "测试" }), 501);
    assert.deepEqual(plain((await api.request("/api/reports?after=0&limit=50")).reports), []);
    assert.deepEqual(plain((await api.request(route() + "/reports?after=0&limit=50")).reports), []);
  });

  await step("End/readback remains local and readonly; refresh preserves the reviewer's own messages", async () => {
    room = (await post(api, route() + "/control", { action: "end" })).room;
    assert.equal(room.status, "ended");
    await rejectsStatus(post(api, route() + "/messages", { channel: "stage", text: "不可新增", client_message_id: "preview-after-end-001" }), 409);
    const reloaded = loadAdapter(source, catalog, { local, session });
    await post(reloaded.api, "/api/session");
    const sync = await reloaded.api.request(route() + "/sync?after_stage=0&after_backstage=0");
    assert.equal(sync.room.status, "ended");
    assert(sync.messages.stage.some(message => message.id === stickerMessage.id));
    assert.equal(sync.room.members.length, 1);
    const before = sync.messages.stage;
    await post(reloaded.api, route() + "/leave");
    await post(reloaded.api, route() + "/leave");
    await post(reloaded.api, route() + "/join");
    await post(reloaded.api, route() + "/join");
    assert.deepEqual(plain((await reloaded.api.request(route() + "/messages?channel=stage&after=0")).messages), plain(before), "Archive visits never extend a frozen performance's event history");
  });

  await step("Reset rotates local identity, removes local rooms and preview drafts, preserves unrelated storage", async () => {
    const oldRoom = room.id;
    for (const kind of ["drafts", "sticker-drafts", "pending"]) session.setItem(`${api.draftPrefix}${kind}.old-preview-scope`, "preview test content");
    await api.reset();
    const next = await post(api, "/api/session");
    assert.notEqual(next.storage_scope, identity.storage_scope);
    assert.notEqual(next.csrf_token, identity.csrf_token);
    assert.deepEqual(plain((await api.request("/api/rooms")).rooms), []);
    await rejectsStatus(api.request(`/api/rooms/${oldRoom}/sync?after_stage=0&after_backstage=0`), 404);
    assert.equal(local.getItem("onstage.theme"), "dark");
    assert.equal(local.getItem("unrelated.local"), "keep");
    assert.equal(session.getItem("onstage.phase1.drafts.production"), "preserve production draft");
    assert.equal(session.getItem("unrelated.session"), "keep");
    assert(!Array.from(session.items.keys()).some(key => key.startsWith(api.draftPrefix)));
    assert.equal(local.clearCalls + session.clearCalls, 0);
    assert(changes.some(event => event.type === "change"));
    assert(changes.some(event => event.type === "reset"));
    assert(changes.every(event => ["change", "reset"].includes(event.type)));
    if (typeof unsubscribe === "function") unsubscribe();
  });

  await step("Requests never fall through to a network API or WebSocket", async () => {
    await rejectsStatus(api.request("/api/not-implemented"), 404);
    assert(scopes.flatMap(scope => scope.requests).every(item => item.pathname === "/preview/catalog.json" && item.origin === "https://preview-review.invalid" && item.method === "GET"));
    report.allowed_catalog_reads = scopes.reduce((total, scope) => total + scope.requests.length, 0);
  });

  await step("A delayed catalog read in another tab cannot restore an identity or rooms erased by reset", async () => {
    const oldRoom = (await post(api, "/api/rooms", { scenario_id: catalog.scenarios[0].id })).room.id;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const delayed = loadAdapter(source, catalog, { local, session, catalogGate: () => gate });
    await post(delayed.api, "/api/session");
    const pending = post(delayed.api, "/api/rooms", { scenario_id: catalog.scenarios[0].id });
    try {
      for (let index = 0; index < 100 && !delayed.requests.length; index++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(delayed.requests.length, 1, "The controlled catalog request must be pending before reset");
      const newIdentity = await api.reset();
      release();
      await pending;
      assert.equal((await post(api, "/api/session")).storage_scope, newIdentity.storage_scope);
      assert(!(await api.request("/api/rooms")).rooms.some(item => item.id === oldRoom));
    } finally {
      release();
    }
  });

  const dist = previewDirectory;
  if (fs.existsSync(dist)) {
    await step("Offline review build has an explicit preview entry, separate from the live deployment", async () => {
      const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
      assert(html.includes("/preview/mode.js"));
      assert(html.includes("/preview/adapter.js"));
      assert(html.indexOf("/preview/mode.js") < html.indexOf("/preview/adapter.js"));
      assert(html.indexOf("/preview/adapter.js") < html.indexOf("/static/app.js"));
      const files = fs.readdirSync(dist, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => path.relative(dist, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
      assert(files.every(file => file === "index.html" || file.startsWith("static/") || file.startsWith("preview/")));
      const forbidden = files.filter(file => /(?:^|\/)(?:__qa__|\.env(?:\.|$)|data|backups|reports|tests|vendor|\.git|\.venv)(?:\/|$)|\.(?:sqlite3(?:-wal|-shm)?|db|log|har|pem|key|py|whl)$/i.test(file));
      assert.deepEqual(forbidden, []);
      assert.equal(fs.readFileSync(path.join(dist, "preview/adapter.js"), "utf8"), source);
      assert.equal(fs.readFileSync(path.join(dist, "static/app.js"), "utf8"), fs.readFileSync(path.join(root, "static/app.js"), "utf8"));
      const manifestBytes = fs.readFileSync(path.join(dist, "preview/build.json"));
      const manifest = JSON.parse(manifestBytes);
      assert.equal(manifest.mode, "onstage-browser-local-preview");
      assert.equal(manifest.version, report.version);
      assert.deepEqual(new Set(manifest.files.map(item => item.path)), new Set(files.filter(file => file !== "preview/build.json")));
      for (const item of manifest.files) {
        assert(files.includes(item.path));
        const bytes = fs.readFileSync(path.join(dist, item.path));
        assert.equal(bytes.length, item.bytes, `Published size matches manifest: ${item.path}`);
        assert.equal(sha(bytes), item.sha256, `Published hash matches manifest: ${item.path}`);
      }
      report.dist_manifest_sha256 = sha(manifestBytes);
      report.dist_manifest_entries_checked = manifest.files.length;
      report.dist_files_checked = files.length;
    });
    await domSmoke(catalog, source);
  } else {
    report.dist_check = "not_run: offline review build does not exist yet";
  }
}

main().catch(error => {
  report.errors.push({ name: error.name, message: error.message, stack: error.stack });
  process.exitCode = 1;
}).finally(() => {
  report.allowed_catalog_reads = scopes.reduce((total, scope) => total + scope.requests.length, 0);
  for (const scope of scopes) scope.close();
  report.result = report.errors.length ? "failed" : "passed";
  report.finished_at_utc = new Date().toISOString();
  report.elapsed_seconds = Number(((performance.now() - started) / 1000).toFixed(3));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ result: report.result, steps: report.steps.length, seconds: report.elapsed_seconds, output, errors: report.errors.map(error => error.message) }));
});
