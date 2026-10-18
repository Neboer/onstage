/* Browser-local review adapter. Only an explicit generated mode script enables it.
 * It never opens API connections, WebSockets, or creates other participants.
 */
(() => {
  "use strict";
  const config = window.OnstagePreviewConfig;
  if (!config || config.enabled !== true) return;

  const DATABASE_KEY = "onstage.preview.v04.data";
  const DRAFT_PREFIX = "onstage.preview.v04.";
  const SCHEMA = 1;
  const subscribers = new Set();
  const clone = value => JSON.parse(JSON.stringify(value));
  const now = () => new Date().toISOString();
  let catalogPromise = null;
  let operationQueue = Promise.resolve();
  let observedIdentity = "";

  function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }

  function checkAbort(signal) {
    if (signal?.aborted) {
      const error = new Error("本机预览操作已取消。");
      error.name = "AbortError";
      throw error;
    }
  }

  function id(prefix) {
    if (window.crypto?.randomUUID) return `${prefix}-${window.crypto.randomUUID()}`;
    if (window.crypto?.getRandomValues) {
      const bytes = new Uint8Array(18);
      window.crypto.getRandomValues(bytes);
      return `${prefix}-${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
    }
    fail(503, "当前浏览器不能创建本机记录编号，请使用支持安全随机数的现代浏览器。");
  }

  function notify(event) {
    for (const listener of subscribers) {
      try { listener(Object.freeze({ ...event })); }
      catch { /* An observer cannot change whether a local write was saved. */ }
    }
  }

  function emptyDatabase() {
    return { schema: SCHEMA, identity: id("local"), nickname: null, created_at: now(), rooms: [] };
  }

  function readDatabase(create = false) {
    let raw;
    try { raw = window.localStorage.getItem(DATABASE_KEY); }
    catch { fail(503, "浏览器未允许本机存储。允许此站点保存数据后，才能使用本机预览。"); }
    if (!raw) {
      if (!create) fail(401, "本机预览身份已重置，请重新打开预览。");
      const database = emptyDatabase();
      saveDatabase(database, null);
      return database;
    }
    let database;
    try { database = JSON.parse(raw); }
    catch { fail(409, "本机预览记录无法读取，可使用顶部“重置预览”重新开始。"); }
    if (database?.schema !== SCHEMA || typeof database.identity !== "string" || !Array.isArray(database.rooms)) fail(409, "本机预览记录格式不兼容，可使用顶部“重置预览”重新开始。");
    // Existing explicit offline review records already retain a receipt-to-message link.
    for (const room of database.rooms) for (const message of room.messages || []) {
      message.client_message_id ??= (room.receipts || []).find(receipt => receipt.message_id === message.id)?.client_message_id || null;
    }
    observedIdentity = database.identity;
    return database;
  }

  function saveDatabase(database, event) {
    try { window.localStorage.setItem(DATABASE_KEY, JSON.stringify(database)); }
    catch { fail(507, "浏览器未能保存这次操作。可能是存储空间不足；本次内容未确认，请保留草稿后重试。"); }
    observedIdentity = database.identity;
    if (event) notify({ ...event, external: false });
  }

  function session(database) {
    return {
      authenticated: true,
      csrf_token: `preview-only-${database.identity}`,
      storage_scope: `preview-${database.identity}`,
      version: String(config.version || "0.5.0-phase1"),
      nickname: database.nickname || null,
      requires_nickname: !database.nickname,
      preview: true,
    };
  }

  async function catalog() {
    if (!catalogPromise) {
      catalogPromise = (async () => {
        const url = new URL(config.catalogUrl || "/preview/catalog.json", window.location.origin);
        if (url.origin !== window.location.origin || url.pathname !== "/preview/catalog.json") fail(500, "预览目录配置无效。");
        const response = await window.fetch(url.pathname, { method: "GET", credentials: "same-origin", cache: "no-cache" });
        if (!response.ok) fail(response.status || 503, "预览素材目录暂未载入，请刷新页面重试。");
        const data = await response.json();
        if (!Array.isArray(data.characters) || !Array.isArray(data.scenarios) || !Array.isArray(data.bands) || !Array.isArray(data.stickers)) fail(500, "预览素材目录格式不完整。");
        return data;
      })().catch(error => { catalogPromise = null; throw error; });
    }
    return catalogPromise;
  }

  function requireRoom(database, roomId) {
    const room = database.rooms.find(item => item.id === roomId);
    if (!room) fail(404, "这个房间不在本机记录里。打开预览的朋友会看到自己的记录，可以从场景创建新房间。");
    return room;
  }

  function requireMember(room) {
    if (!room.joined) fail(403, "请先回到这个本机房间。");
  }

  function requireEditable(room) {
    requireMember(room);
    if (room.status === "ended") fail(409, "这场本机预览已结束，记录可以继续回看。");
  }

  function exactFields(body, allowed) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(422, "本机预览操作包含不支持的字段。");
  }

  function textField(value, maximum, name, fallback = "") {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || Array.from(value).length > maximum) fail(422, `${name}最多 ${maximum} 字。`);
    return value;
  }

  function normalizeNickname(value) {
    if (value === undefined || value === null) return "";
    if (typeof value !== "string" || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value)) fail(422, "昵称不能包含换行或控制字符。");
    const nickname = value.trim();
    if (Array.from(nickname).length > 24) fail(422, "昵称最多 24 字。");
    return nickname;
  }

  function csrfHeader(headers) {
    if (headers && typeof headers.get === "function") return headers.get("X-CSRF-Token");
    if (!headers || typeof headers !== "object") return null;
    const key = Object.keys(headers).find(item => item.toLowerCase() === "x-csrf-token");
    return key ? headers[key] : null;
  }

  function renderRoom(room, directory, database) {
    const character = directory.characters.find(item => item.id === room.character_id);
    const nickname = database.nickname || null;
    const me = room.joined ? {
      member_id: room.member_id, is_host: true, character_id: room.character_id,
      first_character_id: room.first_character_id,
      can_stage: room.status === "live", can_backstage: true,
      can_claim: room.status !== "ended" && !room.character_id && (room.status === "preparing" || room.allow_join),
      can_manage_reports: false,
      nickname,
    } : null;
    return {
      id: room.id, title: room.title, scenario_id: room.scenario_id,
      background: room.background, announcement: room.announcement,
      status: room.status, allow_join: room.allow_join, revision: room.revision,
      created_at: room.created_at, host_member_id: room.member_id,
      online_count: 0,
      members: room.joined ? [{
        id: room.member_id, alias: "观众 1", nickname, display_name: character?.name || nickname || "观众 1",
        character_id: room.character_id, is_host: true, online: false,
      }] : [],
      me, preview: true,
    };
  }

  function appendSystem(room, text) {
    const message = {
      id: id("local-message"), seq: room.next_seq++, channel: "stage",
      member_id: null, character_id: null, author: "系统",
      text, created_at: now(), kind: "system", content_type: "text", sticker_id: null, sticker: null,
    };
    room.messages.push(message);
  }

  function appendMemberEvent(room, database, directory, action) {
    if (room.status === "ended") return;
    const nickname = database.nickname || "观众 1";
    const role = directory.characters.find(item => item.id === room.character_id)?.name;
    if (action === "join") appendSystem(room, `${nickname} 以观众身份进入了房间。`);
    else if (action === "claim") appendSystem(room, `${nickname} 作为 ${role} 入场。`);
    else if (action === "leave") appendSystem(room, `${nickname}${role ? `（${role}）` : ""}主动离开了房间。`);
  }

  function page(room, channel, after, limit = 100) {
    if (!["stage", "backstage"].includes(channel) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(422, "记录分页参数无效。");
    const all = room.messages.filter(message => message.channel === channel && message.seq > after);
    const messages = all.slice(0, limit);
    return { messages: clone(messages), cursor: messages.length ? messages[messages.length - 1].seq : after, has_more: all.length > limit };
  }

  function messagePayload(body) {
    exactFields(body, ["channel", "text", "content_type", "sticker_id", "client_message_id"]);
    if (!["stage", "backstage"].includes(body.channel) || typeof body.client_message_id !== "string" || body.client_message_id.length < 8 || body.client_message_id.length > 80) fail(422, "消息频道或编号不正确。");
    const contentType = body.content_type === undefined ? "text" : body.content_type;
    if (!["text", "sticker"].includes(contentType)) fail(422, "消息类型不正确。");
    if (contentType === "text") {
      if (body.sticker_id !== undefined && body.sticker_id !== null) fail(422, "文字消息不能同时带贴纸。");
      const text = textField(body.text, 2000, "发言");
      if (!text.trim()) fail(422, "先写下一句，再保存到本机。");
      return { content_type: "text", text, sticker_id: null };
    }
    if (typeof body.sticker_id !== "string" || !body.sticker_id || body.sticker_id.length > 80 || (body.text !== undefined && body.text !== "")) fail(422, "请从贴纸面板选择一张，不要混入文字或图片地址。");
    return { content_type: "sticker", text: "", sticker_id: body.sticker_id };
  }

  async function handle(path, options) {
    checkAbort(options.signal);
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) fail(404, "本机预览不提供这个接口。");
    const method = options.method || "GET";
    if (!["GET", "POST"].includes(method)) fail(405, "本机预览不支持这个操作方式。");
    const body = options.body === undefined ? {} : options.body;
    if (url.pathname === "/api/session") {
      if (method === "GET") return session(readDatabase());
      exactFields(body, ["nickname"]);
      const nickname = normalizeNickname(body.nickname);
      let database, existing = true;
      try { database = readDatabase(); }
      catch (error) { if (error.status !== 401) throw error; database = emptyDatabase(); existing = false; }
      if (nickname && nickname !== database.nickname) {
        if (existing && csrfHeader(options.headers) !== session(database).csrf_token) fail(403, "昵称尚未保存。请重新读取当前浏览器身份后再试。");
        database.nickname = nickname;
        saveDatabase(database, { type: "change" });
      } else if (!existing) saveDatabase(database, null);
      return session(database);
    }
    if (url.pathname === "/api/logout" && method === "POST") {
      fail(501, "本机预览没有服务器登录。需要清除记录时，请使用“重置预览”。");
    }
    const directory = await catalog();
    checkAbort(options.signal);
    const database = readDatabase();
    if (url.pathname === "/api/catalog" && method === "GET") return clone(directory);
    if (url.pathname === "/api/reports" && method === "GET") return { reports: [], cursor: 0, has_more: false, preview: true };
    if (url.pathname === "/api/rooms") {
      if (method === "GET") {
        const rawLimit = url.searchParams.get("limit") ?? "50";
        const limit = Number(rawLimit), filter = url.searchParams.get("filter") ?? "all", cursor = url.searchParams.get("cursor");
        if (!/^[0-9]+$/.test(rawLimit) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !["all", "active", "ended", "mine"].includes(filter)) fail(422, "房间分页参数不合法。");
        let rows = database.rooms.filter(room => filter === "active" ? room.status !== "ended" : filter === "ended" ? room.status === "ended" : filter === "mine" ? Boolean(renderRoom(room, directory, database).me) : true).sort((a,b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
        if (cursor !== null) {
          const parts = cursor.length <= 250 ? cursor.split("|") : [];
          if (parts.length !== 4 || parts[0] !== filter || parts[1] !== database.identity || !Number.isFinite(Date.parse(parts[2])) || !/^[A-Za-z0-9_-]{1,80}$/.test(parts[3])) fail(422, "房间游标不合法或不属于当前筛选和身份。");
          rows = rows.filter(room => room.created_at < parts[2] || (room.created_at === parts[2] && room.id > parts[3]));
        }
        const hasMore = rows.length > limit, page = rows.slice(0,limit), last = page[page.length - 1];
        return { rooms: page.map(room => renderRoom(room, directory, database)), has_more: hasMore, next_cursor: hasMore ? [filter, database.identity, last.created_at, last.id].join("|") : null };
      }
      exactFields(body, ["scenario_id", "title", "background", "announcement"]);
      const scene = directory.scenarios.find(item => item.id === body.scenario_id);
      if (!scene) fail(422, "请从目录选择一个场景。");
      if (database.rooms.length >= 100) fail(429, "本机已有 100 个预览房间。需要重新体验时，可先保留所需内容，再重置预览。");
      const room = {
        id: id("local-room"), member_id: id("local-member"), scenario_id: scene.id,
        title: textField(body.title, 80, "房间名称").trim() || `${scene.location || scene.title} · 本机预览`,
        background: textField(body.background, 2000, "房间背景", scene.opening || ""),
        announcement: textField(body.announcement, 500, "公告"),
        status: "preparing", allow_join: true, revision: 1, created_at: now(),
        joined: true, character_id: null, first_character_id: null,
        messages: [], receipts: [], next_seq: 1,
      };
      appendMemberEvent(room, database, directory, "join");
      database.rooms.push(room);
      saveDatabase(database, { type: "change", room_id: room.id });
      return { room: renderRoom(room, directory, database) };
    }
    const match = url.pathname.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
    if (!match) fail(404, "本机预览不提供这个接口。");
    const room = requireRoom(database, decodeURIComponent(match[1]));
    const action = match[2] || "";
    if (action === "reports" || action.startsWith("reports/")) {
      if (method === "GET" && action === "reports") return { reports: [], cursor: 0, has_more: false, preview: true };
      fail(501, "这里只预览举报表单，没有提交给维护者，也不会生成处理回执。");
    }
    if (!action && method === "GET") return { room: renderRoom(room, directory, database) };
    if (action === "join" && method === "POST") {
      exactFields(body, []);
      if (!room.joined) {
        room.joined = true; room.revision += 1;
        appendMemberEvent(room, database, directory, "join");
        saveDatabase(database, { type: "change", room_id: room.id });
      }
      return { room: renderRoom(room, directory, database) };
    }
    if (action === "leave" && method === "POST") {
      exactFields(body, []);
      if (!room.joined) return { ok: true };
      if (room.status !== "ended") fail(409, "请先结束这场本机预览。返回大厅会保留角色和记录。");
      appendMemberEvent(room, database, directory, "leave");
      room.joined = false; room.character_id = null; room.revision += 1;
      saveDatabase(database, { type: "change", room_id: room.id });
      return { ok: true };
    }
    requireMember(room);
    if (action === "sync" && method === "GET") {
      const stage = page(room, "stage", Number(url.searchParams.get("after_stage") || 0));
      const backstage = page(room, "backstage", Number(url.searchParams.get("after_backstage") || 0));
      return { room: renderRoom(room, directory, database), messages: { stage: stage.messages, backstage: backstage.messages }, cursors: { stage: stage.cursor, backstage: backstage.cursor }, has_more: { stage: stage.has_more, backstage: backstage.has_more } };
    }
    if (action === "messages" && method === "GET") return page(room, url.searchParams.get("channel") || "stage", Number(url.searchParams.get("after") || 0), Number(url.searchParams.get("limit") || 100));
    if (action === "messages" && method === "POST") {
      const payload = messagePayload(body);
      const fingerprint = JSON.stringify([body.channel, payload.content_type, payload.text, payload.sticker_id]);
      const existing = room.receipts.find(item => item.client_message_id === body.client_message_id);
      if (existing) {
        if (existing.fingerprint !== fingerprint) fail(409, "这个消息编号已保存过不同内容，请先核对本机记录。");
        const previous = room.messages.find(message => message.id === existing.message_id);
        if (!previous) fail(409, "本机确认记录不完整，请先保留草稿再重试。");
        return { message: clone(previous) };
      }
      requireEditable(room);
      if (body.channel === "stage" && room.status !== "live") fail(403, "舞台还未开始预览，或已暂停；可以先在后台试写。");
      if (room.messages.length >= 5000) fail(429, "本机预览房间已达到记录上限，请新建一个场景继续体验。");
      const chosen = payload.content_type === "sticker" ? directory.stickers.find(item => item.id === payload.sticker_id) : null;
      if (payload.content_type === "sticker" && !chosen) fail(422, "这张贴纸已不在当前目录中，请重新选择。");
      const character = directory.characters.find(item => item.id === room.character_id);
      const message = {
        id: id("local-message"), seq: room.next_seq++, channel: body.channel,
        member_id: room.member_id, character_id: room.character_id, author: character?.name || database.nickname || "观众 1",
        text: chosen ? `[贴纸] ${chosen.label}` : payload.text,
        created_at: now(), kind: "speech", client_message_id: body.client_message_id, content_type: payload.content_type,
        sticker_id: chosen?.id || null,
        sticker: chosen ? { id: chosen.id, label: chosen.label, character_id: chosen.character_id, image: chosen.image } : null,
      };
      room.messages.push(message);
      room.receipts.push({ client_message_id: body.client_message_id, fingerprint, message_id: message.id });
      room.revision += 1;
      saveDatabase(database, { type: "change", room_id: room.id });
      return { message: clone(message) };
    }
    if (action.startsWith("members/") && action.endsWith("/remove")) fail(501, "本机预览里只有你，没有其他参与者可移出。");
    if (action === "characters/claim" && method === "POST") {
      exactFields(body, ["character_id"]); requireEditable(room);
      const scene = directory.scenarios.find(item => item.id === room.scenario_id);
      if (!scene?.character_ids.includes(body.character_id)) fail(422, "这个角色不在本场可选范围内。");
      if (room.character_id === body.character_id) return { room: renderRoom(room, directory, database) };
      if (room.character_id || (room.first_character_id && room.first_character_id !== body.character_id)) fail(409, "一场内保留同一个角色。想体验其他人物，可以新建一个场景。");
      if (room.status !== "preparing" && !room.allow_join) fail(409, "这个房间暂未开放角色补位。");
      room.character_id = body.character_id; room.first_character_id = body.character_id; room.revision += 1;
      appendMemberEvent(room, database, directory, "claim");
      saveDatabase(database, { type: "change", room_id: room.id });
      return { room: renderRoom(room, directory, database) };
    }
    if (action === "settings" && method === "POST") {
      exactFields(body, ["background", "announcement"]); requireEditable(room);
      if (body.background === undefined || body.announcement === undefined) fail(422, "背景和公告须一起保存。");
      room.background = textField(body.background, 2000, "房间背景");
      room.announcement = textField(body.announcement, 500, "公告"); room.revision += 1;
      saveDatabase(database, { type: "change", room_id: room.id });
      return { room: renderRoom(room, directory, database) };
    }
    if (action === "control" && method === "POST") {
      exactFields(body, ["action"]);
      if (!["start", "pause", "resume", "end", "open_join", "close_join"].includes(body.action)) fail(422, "不支持这个房间操作。");
      if (body.action === "end" && room.status === "ended") return { room: renderRoom(room, directory, database) };
      if (body.action === "start" && room.status === "live") return { room: renderRoom(room, directory, database) };
      requireEditable(room);
      let note = "";
      if (body.action === "start") {
        if (room.status !== "preparing") fail(409, "这场预览已开始，请使用继续操作。");
        if (!room.character_id) fail(409, "先选择一个角色，再点击“预览演出”。这里只进行本机单人预览。");
        room.status = "live"; note = "你开始了本机演出预览。";
      } else if (body.action === "pause") {
        if (room.status !== "live") fail(409, "只有正在预览的舞台可以暂停。");
        room.status = "paused"; note = "你暂停了本机演出预览。";
      } else if (body.action === "resume") {
        if (room.status !== "paused") fail(409, "只有暂停中的舞台可以继续。");
        room.status = "live"; note = "你继续了本机演出预览。";
      } else if (body.action === "end") {
        room.status = "ended"; note = "你结束了本机演出预览，记录已保存在当前浏览器。";
      } else {
        room.allow_join = body.action === "open_join";
      }
      if (note) appendSystem(room, note);
      room.revision += 1;
      saveDatabase(database, { type: "change", room_id: room.id });
      return { room: renderRoom(room, directory, database) };
    }
    fail(404, "本机预览不提供这个接口。");
  }

  function enqueue(action) {
    const result = operationQueue.then(action);
    operationQueue = result.catch(() => {});
    return result;
  }

  function reset() {
    return enqueue(() => {
      const database = emptyDatabase();
      saveDatabase(database, null);
      try {
        for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
          const key = window.sessionStorage.key(index);
          if (key?.startsWith(DRAFT_PREFIX)) window.sessionStorage.removeItem(key);
        }
      } catch { /* A browser denying sessionStorage cannot expose its old draft values. */ }
      notify({ type: "reset", external: false });
      return session(database);
    });
  }

  window.addEventListener("storage", event => {
    if (event.key !== DATABASE_KEY) return;
    let identity = "";
    try { identity = event.newValue ? JSON.parse(event.newValue).identity : ""; } catch {}
    const resetEvent = !identity || (observedIdentity && identity !== observedIdentity);
    observedIdentity = identity;
    notify({ type: resetEvent ? "reset" : "change", external: true });
  });

  window.OnstagePreview = Object.freeze({
    version: String(config.version || "0.5.0-phase1"), isLocal: true, draftPrefix: DRAFT_PREFIX,
    request: (path, options = {}) => enqueue(() => handle(path, options)),
    reset,
    subscribe: listener => {
      if (typeof listener !== "function") throw new TypeError("Preview subscriber must be a function");
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  });
})();
