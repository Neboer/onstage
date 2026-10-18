import { Database, DomainError, Row, secretEqual } from "./database";
import { Store, TRANSPORT, initializeConstants } from "./store";

export interface Env {
  DB: Database;
  ONSTAGE_PUBLIC_ORIGIN?: string;
  ONSTAGE_VERSION?: string;
  ONSTAGE_OPERATOR_TOKEN?: string;
  ONSTAGE_WRITE_FROZEN?: string;
}
const COOKIE_NAME = "onstage_session";
const bytes = new TextEncoder();
const length = (value: string) => Array.from(value).length;

function json(value: unknown, status = 200, additions: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", ...additions } });
}
function cookie(request: Request): string | null {
  const item = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + "="));
  if (!item) return null;
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return null; }
}
function cookieHeader(token: string, secure: boolean, clear = false): string {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${clear ? "0" : "604800"}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}
function fields(body: Row, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) throw new DomainError(422, "请求包含未支持的字段。");
}
function text(body: Row, key: string, max: number, options: { min?: number; optional?: boolean; nullable?: boolean; nonblank?: boolean } = {}): void {
  const value = body[key];
  if (value === undefined && options.optional) return;
  if (value === null && options.nullable) return;
  if (typeof value !== "string" || length(value) > max || length(value) < (options.min ?? 0) || (options.nonblank && !value.trim())) throw new DomainError(422, `请求参数不合法：${key}`);
}
function choice(body: Row, key: string, values: string[], optional = false): void {
  if (body[key] === undefined && optional) return;
  if (!values.includes(body[key])) throw new DomainError(422, `请求参数不合法：${key}`);
}
function queryNumber(url: URL, key: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw new DomainError(422, `请求参数不合法：${key}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new DomainError(422, `请求参数不合法：${key}`);
  return number;
}
async function bodyJson(request: Request): Promise<Row> {
  const stated = request.headers.get("content-length");
  if (stated && (!/^\d+$/.test(stated) || Number(stated) > 65536)) throw new DomainError(413, "请求正文过大或长度无效。");
  // Count streamed bytes as they arrive; a missing Content-Length cannot bypass
  // the limit or make the worker buffer an arbitrarily large request.
  const reader = request.body?.getReader();
  if (!reader) return {};
  const parts: Uint8Array[] = []; let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 65536) { await reader.cancel(); throw new DomainError(413, "请求正文过大。"); }
    parts.push(value);
  }
  if (!total) return {};
  const combined = new Uint8Array(total); let offset = 0;
  for (const part of parts) { combined.set(part, offset); offset += part.byteLength; }
  let body: unknown;
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)); } catch { throw new DomainError(422, "请求正文须为有效 JSON。"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new DomainError(422, "请求正文须为 JSON 对象。");
  return body as Row;
}
async function operator(request: Request, env: Env): Promise<void> {
  if (!env.ONSTAGE_OPERATOR_TOKEN || env.ONSTAGE_OPERATOR_TOKEN.length < 32) throw new DomainError(503, "维护入口尚未配置，操作未执行。");
  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || auth.length > 512 || !await secretEqual(auth.slice(7), env.ONSTAGE_OPERATOR_TOKEN)) throw new DomainError(401, "维护入口认证失败。");
}

/** Stable HTTP adapter: one shared D1 service, no browser storage or fake peers. */
export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";
    const origin = env.ONSTAGE_PUBLIC_ORIGIN || url.origin;
    const originHeader = request.headers.get("origin");
    if (originHeader !== null && originHeader !== origin) throw new DomainError(403, "请求来源不被允许。");
    const version = env.ONSTAGE_VERSION || "0.6.0-phase1";
    if (path === "/healthz" && request.method === "GET") return json({ status: "ok", version, backend: "sites-d1" });
    // Freeze the old business write entry before its final private export.
    // Read APIs and authenticated operator export remain available. Setting
    // this flag requires a controlled deployment; source code is not a cutover.
    if (env.ONSTAGE_WRITE_FROZEN === "1" && path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      return json({ detail: "站点正在迁移，当前入口已暂停写入。请保留身份与草稿。" }, 503, { "Retry-After": "60" });
    }
    if (!env.DB) throw new DomainError(503, "共享数据库绑定尚未就绪。");
    if (path.startsWith("/api/operator/")) await operator(request, env);
    await initializeConstants(env.DB);
    if (path === "/readyz" && request.method === "GET") {
      const value = await env.DB.prepare("SELECT (SELECT value FROM schema_meta WHERE key='schema_version') AS schema_version,(SELECT value FROM schema_meta WHERE key='edge_schema_version') AS edge_schema_version,(SELECT revision FROM edge_state WHERE id=1) AS revision").first<Row>();
      if (!value || value.schema_version !== "4" || value.edge_schema_version !== "1" || value.revision === null) throw new DomainError(503, "共享数据库结构未就绪。");
      return json({ status: "ready", schema_version: 4, edge_schema_version: 1, version, backend: "sites-d1" });
    }
    const method = request.method;
    const body = method === "POST" ? await bodyJson(request) : {};
    // CF-Connecting-IP is overwritten by the Workers edge, unlike untrusted
    // X-Forwarded-For. It is only hashed before persistent rate accounting.
    const store = new Store(env.DB, cookie(request), request.headers.get("x-csrf-token"), request.headers.get("cf-connecting-ip") || "local-test", version);
    if (path === "/api/session") {
      if (method === "GET") return json(await store.getSession());
      if (method === "POST") {
        fields(body, ["nickname"]);
        const created = await store.createSession(body.nickname);
        const token = created.token; delete created.token;
        return json(created, 200, token ? { "Set-Cookie": cookieHeader(token, origin.startsWith("https://")) } : {});
      }
    }
    if (path === "/api/logout" && method === "POST") { fields(body, []); return json(await store.logout(), 200, { "Set-Cookie": cookieHeader("", origin.startsWith("https://"), true) }); }
    if (path === "/api/catalog" && method === "GET") return json(await store.getCatalog());
    if (path === "/api/rooms") {
      if (method === "GET") return json(await store.listRooms());
      if (method === "POST") {
        fields(body, ["scenario_id", "title", "background", "announcement"]);
        text(body, "scenario_id", 80, { min: 1 }); text(body, "title", 80, { optional: true, nullable: true }); text(body, "background", 2000, { optional: true, nullable: true }); text(body, "announcement", 500, { optional: true });
        return json(await store.createRoom(body));
      }
    }
    if (path === "/api/reports" && method === "GET") return json(await store.listReports(null, queryNumber(url, "after", 0), queryNumber(url, "limit", 50, 1, 100)));
    if (path === "/api/operator/reports" && method === "GET") {
      const status = url.searchParams.get("status") ?? "open";
      if (!["open", "resolved", "dismissed", "all"].includes(status)) throw new DomainError(422, "未知反馈状态。");
      return json(await store.listReports(null, queryNumber(url, "after", 0), queryNumber(url, "limit", 50, 1, 100), true, status));
    }
    if (path === "/api/operator/export" && method === "GET") {
      const exported = await store.exportPrivate();
      return json(exported, 200, { "Content-Disposition": 'attachment; filename="onstage-confidential-state.json"', "X-Onstage-Data-Sensitivity": "confidential-session-and-moderation-data" });
    }
    let match = path.match(/^\/api\/operator\/reports\/([a-zA-Z0-9_-]{1,80})\/resolve$/);
    if (match && method === "POST") {
      fields(body, ["status", "note", "operator"]); choice(body, "status", ["resolved", "dismissed"]); text(body, "note", 500, { min: 1, nonblank: true }); text(body, "operator", 80, { min: 1, nonblank: true });
      return json(await store.resolveReport(null, match[1], body.status, body.note, body.operator.trim()));
    }
    match = path.match(/^\/api\/operator\/rooms\/([a-zA-Z0-9_-]{1,80})\/end$/);
    if (match && method === "POST") {
      fields(body, ["note", "operator"]); text(body, "note", 500, { min: 1, nonblank: true }); text(body, "operator", 80, { min: 1, nonblank: true });
      return json(await store.operatorEndRoom(match[1], body.note, body.operator.trim()));
    }
    match = path.match(/^\/api\/rooms\/([a-zA-Z0-9_-]{1,80})(?:\/(.*))?$/);
    if (match) {
      const roomId = match[1], operation = match[2] || "";
      if (!operation && method === "GET") return json(await store.getRoom(roomId));
      if (method === "POST" && ["join", "leave"].includes(operation)) { fields(body, []); return json(operation === "join" ? await store.join(roomId) : await store.leave(roomId)); }
      if (operation === "characters/claim" && method === "POST") { fields(body, ["character_id"]); text(body, "character_id", 80, { min: 1 }); return json(await store.claim(roomId, body.character_id)); }
      if (operation === "settings" && method === "POST") { fields(body, ["background", "announcement"]); text(body, "background", 2000); text(body, "announcement", 500); return json(await store.updateSettings(roomId, body.background, body.announcement)); }
      const removal = operation.match(/^members\/([a-zA-Z0-9_-]{1,80})\/remove$/);
      if (removal && method === "POST") { fields(body, []); return json(await store.remove(roomId, removal[1])); }
      if (operation === "control" && method === "POST") { fields(body, ["action"]); choice(body, "action", ["start", "pause", "resume", "end", "open_join", "close_join"]); return json(await store.control(roomId, body.action)); }
      if (operation === "messages" && method === "POST") {
        fields(body, ["channel", "content_type", "text", "sticker_id", "client_message_id"]); choice(body, "channel", ["stage", "backstage"]); choice(body, "content_type", ["text", "sticker"], true); text(body, "text", 2000, { optional: true }); text(body, "sticker_id", 80, { min: 1, optional: true, nullable: true }); text(body, "client_message_id", 80, { min: 8 });
        return json(await store.sendMessage(roomId, body));
      }
      if (operation === "messages" && method === "GET") {
        const channel = url.searchParams.get("channel") ?? "stage";
        if (!["stage", "backstage"].includes(channel)) throw new DomainError(422, "未知消息频道。");
        return json(await store.messages(roomId, channel, queryNumber(url, "after", 0), queryNumber(url, "limit", 100, 1, 100)));
      }
      if (operation === "sync" && method === "GET") return json(await store.sync(roomId, queryNumber(url, "after_stage", 0), queryNumber(url, "after_backstage", 0)));
      if (operation === "presence" && method === "POST") {
        fields(body, ["connection_id", "active"]); text(body, "connection_id", 80, { min: 8, optional: true });
        if (body.active !== undefined && typeof body.active !== "boolean") throw new DomainError(422, "请求参数不合法：active");
        return json(await store.presence(roomId, body.connection_id ?? "default-http", body.active !== false));
      }
      if (operation === "stream") return json({ detail: "本服务通过共享数据库与 HTTP 轮询同步，请使用会话返回的传输配置。", transport: TRANSPORT }, 426);
      if (operation === "reports" && method === "POST") {
        fields(body, ["message_id", "reason", "details"]); text(body, "message_id", 80, { min: 1, optional: true, nullable: true }); choice(body, "reason", ["harassment", "spam", "unsafe", "other"]); text(body, "details", 1000, { optional: true });
        return json(await store.createReport(roomId, body.message_id ?? null, body.reason, body.details ?? ""));
      }
      if (operation === "reports" && method === "GET") return json(await store.listReports(roomId, queryNumber(url, "after", 0), queryNumber(url, "limit", 50, 1, 100)));
      const resolution = operation.match(/^reports\/([a-zA-Z0-9_-]{1,80})\/resolve$/);
      if (resolution && method === "POST") {
        fields(body, ["status", "note"]); choice(body, "status", ["resolved", "dismissed"]); text(body, "note", 500, { min: 1, nonblank: true });
        return json(await store.resolveReport(roomId, resolution[1], body.status, body.note));
      }
    }
    return json({ detail: "接口不存在。" }, 404);
  } catch (error) {
    if (error instanceof DomainError) return json({ detail: error.message }, error.status, error.status === 429 || error.status === 503 ? { "Retry-After": error.status === 429 ? "60" : "2" } : {});
    if (/constraint failed|SQLITE_CONSTRAINT/i.test(String(error))) return json({ detail: "当前状态与操作冲突，请重新同步房间。" }, 409);
    // Never expose or log raw D1 errors: they can contain SQL and user input.
    return json({ detail: "共享数据库暂不可用，操作未被确认；请保留原消息 ID 重试。" }, 503, { "Retry-After": "2" });
  }
}
