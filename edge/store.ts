import catalogData from "../app/catalog.json";
import { AtomicDatabase, Database, DomainError, Row, Transaction, cutoff, digest, newId, now, secret, secretEqual } from "./database";

export const TRANSPORT = Object.freeze({ type: "poll", interval_ms: 1500, presence_interval_ms: 15000, presence_ttl_ms: 45000 });
export const CATALOG = catalogData;
const characters = new Map<string, Row>(catalogData.characters.map((item) => [item.id, item]));
const scenarios = new Map<string, Row>(catalogData.scenarios.map((item) => [item.id, item]));
const stickers = new Map<string, Row>(catalogData.stickers.map((item) => [item.id, item]));
const initialized = new WeakMap<object, Promise<void>>();
const codepoints = (value: string) => Array.from(value).length;

export async function initializeConstants(db: Database): Promise<void> {
  let promise = initialized.get(db);
  if (!promise) {
    promise = (async () => {
      const meta = await db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").first<Row>();
      if (meta && meta.value !== "4") throw new DomainError(503, "共享数据库结构版本不匹配，未修改原数据。");
      const edge = await db.prepare("SELECT value FROM schema_meta WHERE key='edge_schema_version'").first<Row>();
      if (edge && edge.value !== "1") throw new DomainError(503, "共享服务数据库版本不匹配。");
      // Migrations are schema-only. These immutable constants contain no demo
      // users, rooms, messages, or secrets. Concurrent cold starts are safe.
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('schema_version','4')"),
        db.prepare("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('edge_schema_version','1')"),
        db.prepare("INSERT OR IGNORE INTO edge_state(id,revision) VALUES(1,0)"),
        ...Array.from(characters.keys(), (id) => db.prepare("INSERT OR IGNORE INTO characters(id) VALUES(?)").bind(id)),
      ]);
    })();
    initialized.set(db, promise);
    promise.catch(() => initialized.delete(db));
  }
  return promise;
}

export function normalizeNickname(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new DomainError(422, "昵称须为文字。");
  if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(value) || codepoints(value.trim()) > 24)
    throw new DomainError(422, "昵称最多 24 字，不能包含换行或控制字符。");
  return value.trim();
}

export class Store {
  private atomic: AtomicDatabase;
  private tokenHash: Promise<string>;
  constructor(readonly db: Database, readonly token: string | null, readonly csrf: string | null, readonly source: string, readonly version: string) {
    this.atomic = new AtomicDatabase(db);
    this.tokenHash = digest(token ?? "");
  }
  async session(tx: Transaction, requireCsrf = false): Promise<Row> {
    if (!this.token || this.token.length > 256) throw new DomainError(401, "匿名会话尚未建立，请重新进入。");
    const session = await tx.first("SELECT * FROM sessions WHERE token_hash=?", await this.tokenHash);
    if (!session || session.revoked_at || !Number.isFinite(Date.parse(session.expires_at)) || Date.parse(session.expires_at) <= Date.now())
      throw new DomainError(401, "会话已失效或到期，请重新进入。");
    if (requireCsrf && (!this.csrf || this.csrf.length > 256 || !await secretEqual(this.csrf, session.csrf_token)))
      throw new DomainError(403, "CSRF 校验失败，请刷新页面后重试。");
    return session;
  }
  sessionDto(session: Row): Row {
    return { authenticated: true, csrf_token: session.csrf_token, version: this.version, nickname: session.nickname || null, requires_nickname: !session.nickname, transport: TRANSPORT };
  }
  private async rate(tx: Transaction, action: string, key: string, limit: number, seconds: number): Promise<void> {
    const count = await tx.count("SELECT COUNT(*) FROM rate_events WHERE action=? AND subject_key=? AND created_at>=?", action, key, cutoff(seconds));
    if (count >= limit) throw new DomainError(429, "操作过于频繁，请稍后再试。");
  }
  private recordRate(tx: Transaction, action: string, key: string): void {
    tx.add("DELETE FROM rate_events WHERE created_at<?", cutoff(86400));
    tx.add("INSERT INTO rate_events(action,subject_key,created_at) VALUES(?,?,?)", action, key, now());
  }
  async getSession(): Promise<Row> { return this.atomic.run(false, async (tx) => this.sessionDto(await this.session(tx))); }
  async createSession(nicknameValue: unknown): Promise<Row> {
    const nickname = normalizeNickname(nicknameValue);
    return this.atomic.run(true, async (tx) => {
      let existing: Row | null = null;
      try { existing = await this.session(tx); } catch (error) { if (!(error instanceof DomainError) || error.status !== 401) throw error; }
      if (existing) {
        if (nickname && nickname !== existing.nickname) {
          await this.session(tx, true);
          tx.add("UPDATE sessions SET nickname=? WHERE id=?", nickname, existing.id);
          tx.add("UPDATE rooms SET revision=revision+1,updated_at=? WHERE id IN(SELECT room_id FROM room_members WHERE session_id=? AND status='active')", now(), existing.id);
          existing.nickname = nickname;
        }
        return { ...this.sessionDto(existing), token: null };
      }
      const sourceHash = await digest(this.source);
      await this.rate(tx, "session", sourceHash, 60, 60);
      await this.rate(tx, "session", sourceHash, 300, 3600);
      if (await tx.count("SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL AND expires_at>?", now()) >= 500)
        throw new DomainError(429, "当前体验人数已满，请稍后再来。");
      const token = secret();
      const session = { id: newId(), token_hash: await digest(token), csrf_token: secret(), created_at: now(), expires_at: new Date(Date.now() + 604800000).toISOString(), nickname };
      tx.add("INSERT INTO sessions(id,token_hash,csrf_token,created_at,expires_at,nickname) VALUES(?,?,?,?,?,?)", session.id, session.token_hash, session.csrf_token, session.created_at, session.expires_at, nickname);
      this.recordRate(tx, "session", sourceHash);
      return { ...this.sessionDto(session), token };
    });
  }
  async logout(): Promise<Row> {
    return this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true);
      tx.add("UPDATE sessions SET revoked_at=? WHERE id=?", now(), session.id);
      tx.add("DELETE FROM presence WHERE member_id IN(SELECT id FROM room_members WHERE session_id=?)", session.id);
      return { ok: true };
    });
  }
  async getCatalog(): Promise<typeof CATALOG> { return this.atomic.run(false, async (tx) => { await this.session(tx); return CATALOG; }); }
  private async room(tx: Transaction, id: string): Promise<Row> {
    const room = await tx.first("SELECT r.*,(SELECT id FROM room_members WHERE room_id=r.id AND session_id=r.host_session_id) AS host_member_id FROM rooms r WHERE r.id=?", id);
    if (!room) throw new DomainError(404, "房间不存在。");
    return room;
  }
  private async notBanned(tx: Transaction, roomId: string, sessionId: string): Promise<void> {
    if (await tx.first("SELECT 1 FROM room_bans WHERE room_id=? AND session_id=?", roomId, sessionId))
      throw new DomainError(403, "你已被房主移出，本次匿名身份不能再次进入该房间。");
  }
  private async member(tx: Transaction, roomId: string, sessionId: string, required = true): Promise<Row | null> {
    const member = await tx.first("SELECT m.*,s.nickname FROM room_members m JOIN sessions s ON s.id=m.session_id WHERE m.room_id=? AND m.session_id=? AND m.status='active' AND NOT EXISTS(SELECT 1 FROM room_bans b WHERE b.room_id=m.room_id AND b.session_id=m.session_id)", roomId, sessionId);
    if (!member && required) throw new DomainError(403, "请先加入本房间。");
    return member;
  }
  private async host(tx: Transaction, room: Row, sessionId: string): Promise<Row> {
    if (room.host_session_id !== sessionId) throw new DomainError(403, "只有本房房主可以执行此操作。");
    return (await this.member(tx, room.id, sessionId))!;
  }
  private backstage(room: Row, member: Row): boolean { return !!member.character_id || room.host_session_id === member.session_id; }
  private canClaim(room: Row, member: Row): boolean { return !member.character_id && room.status !== "ended" && (room.status === "preparing" || !!room.allow_join); }
  private bump(tx: Transaction, roomId: string): void { tx.add("UPDATE rooms SET revision=revision+1,updated_at=? WHERE id=?", now(), roomId); }
  private messageJson(message: Row): Row {
    const result: Row = {};
    for (const key of ["id", "seq", "channel", "member_id", "character_id", "author", "text", "created_at", "kind", "content_type", "sticker_id", "client_message_id"]) result[key] = message[key];
    result.sticker = message.sticker_json ? JSON.parse(message.sticker_json) : null;
    if (!message.character_id && message.legacy_alias?.startsWith("旅人·") && message.author === message.legacy_alias) result.author = message.legacy_display_alias;
    return result;
  }
  private memberRowsSql = "SELECT m.*,s.expires_at,s.revoked_at,s.nickname,EXISTS(SELECT 1 FROM presence p WHERE p.member_id=m.id AND p.room_id=m.room_id AND p.last_seen>=?) AS recently_seen FROM room_members m JOIN sessions s ON s.id=m.session_id WHERE m.room_id=? AND m.status='active' AND NOT EXISTS(SELECT 1 FROM room_bans b WHERE b.room_id=m.room_id AND b.session_id=m.session_id) ORDER BY m.joined_at,m.id";
  private snapshotRows(room: Row, sessionId: string, rows: Row[]): Row {
    const own = rows.find((row) => row.session_id === sessionId);
    const members = rows.map((row) => ({ id: row.id, alias: row.display_alias, nickname: row.nickname || null, display_name: row.character_id ? characters.get(row.character_id)?.name : row.nickname || row.display_alias, character_id: row.character_id, is_host: row.session_id === room.host_session_id, online: !!row.recently_seen && !row.revoked_at && Date.parse(row.expires_at) > Date.now() }));
    return { id: room.id, title: room.title, scenario_id: room.scenario_id, background: room.background, announcement: room.announcement, status: room.status, allow_join: !!room.allow_join, revision: room.revision, created_at: room.created_at, host_member_id: room.host_member_id ?? null, online_count: members.filter((member) => member.online).length, members, me: own ? { member_id: own.id, is_host: room.host_session_id === sessionId, nickname: own.nickname || null, character_id: own.character_id, first_character_id: own.first_character_id, can_stage: room.status === "live" && this.backstage(room, own), can_backstage: this.backstage(room, own), can_claim: this.canClaim(room, own), can_manage_reports: room.host_session_id === sessionId } : null };
  }
  private async snapshot(tx: Transaction, room: Row, sessionId: string): Promise<Row> {
    return this.snapshotRows(room, sessionId, await tx.all(this.memberRowsSql, cutoff(45), room.id));
  }
  async getRoom(roomId: string): Promise<Row> {
    return this.atomic.run(false, async (tx) => { const session = await this.session(tx); const room = await this.room(tx, roomId); await this.notBanned(tx, roomId, session.id); return { room: await this.snapshot(tx, room, session.id) }; });
  }
  async listRooms(limit = 50, cursor: string | null = null, filter = "all"): Promise<Row> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !["all", "active", "ended", "mine"].includes(filter)) throw new DomainError(422, "房间分页参数不合法。");
    return this.atomic.run(false, async (tx) => {
      const session = await this.session(tx);
      const scope = (await digest(session.id)).slice(0, 16);
      const where = ["NOT EXISTS(SELECT 1 FROM room_bans b WHERE b.room_id=r.id AND b.session_id=?)"];
      const values: unknown[] = [session.id];
      if (filter === "active") where.push("r.status<>'ended'");
      if (filter === "ended") where.push("r.status='ended'");
      if (filter === "mine") { where.push("EXISTS(SELECT 1 FROM room_members own WHERE own.room_id=r.id AND own.session_id=? AND own.status='active')"); values.push(session.id); }
      if (cursor !== null) {
        const parts = cursor.length <= 200 ? cursor.split("|") : [];
        if (parts.length !== 4 || parts[0] !== filter || parts[1] !== scope || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(parts[2]) || !Number.isFinite(Date.parse(parts[2])) || !/^[A-Za-z0-9_-]{1,80}$/.test(parts[3])) throw new DomainError(422, "房间游标不合法或不属于当前筛选和身份。");
        where.push("(r.created_at<? OR (r.created_at=? AND r.id>?))"); values.push(parts[2], parts[2], parts[3]);
      }
      const result = await tx.all("SELECT r.*,(SELECT id FROM room_members h WHERE h.room_id=r.id AND h.session_id=r.host_session_id) AS host_member_id FROM rooms r WHERE " + where.join(" AND ") + " ORDER BY r.created_at DESC,r.id ASC LIMIT ?", ...values, limit + 1);
      const hasMore = result.length > limit;
      const rooms = result.slice(0, limit);
      const members = rooms.length ? await tx.all("SELECT m.*,s.expires_at,s.revoked_at,s.nickname,EXISTS(SELECT 1 FROM presence p WHERE p.member_id=m.id AND p.room_id=m.room_id AND p.last_seen>=?) AS recently_seen FROM room_members m JOIN sessions s ON s.id=m.session_id WHERE m.status='active' AND NOT EXISTS(SELECT 1 FROM room_bans b WHERE b.room_id=m.room_id AND b.session_id=m.session_id) AND m.room_id IN(" + rooms.map(() => "?").join(",") + ") ORDER BY m.joined_at,m.id", cutoff(45), ...rooms.map((room) => room.id)) : [];
      const byRoom = new Map<string, Row[]>();
      for (const member of members) { const list = byRoom.get(member.room_id) ?? []; list.push(member); byRoom.set(member.room_id, list); }
      const last = rooms[rooms.length - 1];
      return { rooms: rooms.map((room) => this.snapshotRows(room, session.id, byRoom.get(room.id) ?? [])), has_more: hasMore, next_cursor: hasMore ? [filter, scope, last.created_at, last.id].join("|") : null };
    });
  }
  private async newMember(tx: Transaction, roomId: string, session: Row): Promise<Row> {
    const number = await tx.count("SELECT COUNT(*) FROM room_members WHERE room_id=?", roomId) + 1;
    const member = { id: newId(), room_id: roomId, session_id: session.id, alias: `观众 ${number}`, display_alias: `观众 ${number}`, nickname: session.nickname, character_id: null, first_character_id: null, status: "active", joined_at: now() };
    tx.add("INSERT INTO room_members(id,room_id,session_id,alias,display_alias,joined_at) VALUES(?,?,?,?,?,?)", member.id, roomId, session.id, member.alias, member.display_alias, member.joined_at);
    return member;
  }
  private insertMessage(tx: Transaction, room: Row, fields: Row): Row {
    const column = fields.channel === "stage" ? "stage_seq" : "backstage_seq";
    const message: Row = { id: newId(), room_id: room.id, seq: Number(room[column]) + 1, created_at: now(), member_id: null, character_id: null, author: "系统", kind: "system", client_message_id: null, content_type: "text", sticker_id: null, sticker_json: null, ...fields };
    room[column] = message.seq;
    tx.add(`UPDATE rooms SET ${column}=${column}+1 WHERE id=?`, room.id);
    tx.add("INSERT INTO messages(id,room_id,seq,channel,member_id,character_id,author,text,created_at,kind,client_message_id,content_type,sticker_id,sticker_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)", message.id, room.id, message.seq, message.channel, message.member_id, message.character_id, message.author, message.text, message.created_at, message.kind, message.client_message_id, message.content_type, message.sticker_id, message.sticker_json);
    return this.messageJson(message);
  }
  private event(tx: Transaction, room: Row, member: Row, action: string, characterId: string | null = null): void {
    if (room.status === "ended") return;
    const name = member.nickname || member.display_alias;
    const role = characterId || member.character_id;
    const label = role ? `${name}（${characters.get(role)!.name}）` : name;
    const texts: Record<string, string> = { join: `${name} 以观众身份进入了房间。`, claim: `${name} 作为 ${characterId ? characters.get(characterId)!.name : ""} 入场。`, leave: `${label}主动离开了房间。`, remove: `${label}已被房主移出房间。` };
    this.insertMessage(tx, room, { channel: "stage", text: texts[action] });
  }
  async createRoom(body: Row): Promise<Row> {
    const roomId = await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true);
      const scene = scenarios.get(body.scenario_id);
      if (!scene) throw new DomainError(400, "场景不存在。");
      const title = (body.title ?? "").trim() || scene.title;
      const background = body.background ?? scene.opening ?? "";
      const announcement = body.announcement ?? "";
      await this.rate(tx, "room_session", session.id, 4, 3600);
      const sourceHash = await digest(this.source);
      await this.rate(tx, "room_source", sourceHash, 20, 3600);
      if (await tx.count("SELECT COUNT(*) FROM rooms WHERE status!='ended'") >= 10) throw new DomainError(429, "当前开放房间已满，请先结束旧场次。");
      if (await tx.count("SELECT COUNT(*) FROM rooms WHERE host_session_id=? AND status!='ended'", session.id) >= 2) throw new DomainError(429, "你已有未结束房间，请先结束旧场次。");
      const room = { id: newId(), title, scenario_id: body.scenario_id, background, announcement, status: "preparing", host_session_id: session.id, stage_seq: 0, backstage_seq: 0, created_at: now() };
      tx.add("INSERT INTO rooms(id,title,scenario_id,background,announcement,status,host_session_id,created_at,updated_at) VALUES(?,?,?,?,?,'preparing',?,?,?)", room.id, title, room.scenario_id, background, announcement, session.id, room.created_at, room.created_at);
      const member = await this.newMember(tx, room.id, session);
      this.event(tx, room, member, "join");
      this.recordRate(tx, "room_session", session.id);
      this.recordRate(tx, "room_source", sourceHash);
      return room.id;
    });
    return this.getRoom(roomId);
  }
  async join(roomId: string): Promise<Row> {
    await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); await this.notBanned(tx, roomId, session.id);
      let member = await tx.first("SELECT m.*,s.nickname FROM room_members m JOIN sessions s ON s.id=m.session_id WHERE m.room_id=? AND m.session_id=?", roomId, session.id);
      if (member?.status === "active") return;
      if (await tx.count("SELECT COUNT(*) FROM room_members WHERE room_id=? AND status='active'", roomId) >= 30) throw new DomainError(429, "本房人数已满，请稍后再来。");
      if (!member) {
        if (await tx.count("SELECT COUNT(*) FROM room_members WHERE room_id=?", roomId) >= 150) throw new DomainError(429, "本房已达到本次体验的身份容量，请进入其他房间。");
        member = await this.newMember(tx, roomId, session);
      } else tx.add("UPDATE room_members SET status='active',character_id=NULL,left_at=NULL,joined_at=? WHERE id=?", now(), member.id);
      this.bump(tx, roomId); this.event(tx, room, member, "join");
    });
    return this.getRoom(roomId);
  }
  async leave(roomId: string): Promise<Row> {
    return this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId);
      if (room.host_session_id === session.id && room.status !== "ended") throw new DomainError(409, "房主须先结束本场，再离开房间。");
      const member = await this.member(tx, roomId, session.id, false);
      if (!member) return { ok: true };
      tx.add("UPDATE room_members SET status='left',character_id=NULL,left_at=? WHERE id=?", now(), member.id);
      tx.add("UPDATE role_requests SET status='cancelled',decided_at=? WHERE room_id=? AND member_id=? AND status='pending'", now(), roomId, member.id);
      tx.add("DELETE FROM presence WHERE member_id=?", member.id);
      this.bump(tx, roomId); this.event(tx, room, member, "leave");
      return { ok: true };
    });
  }
  async claim(roomId: string, characterId: string): Promise<Row> {
    await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); const member = (await this.member(tx, roomId, session.id))!;
      if (room.status === "ended") throw new DomainError(409, "本场已经结束，不能再选择角色。");
      if (member.character_id === characterId) return;
      if (!this.canClaim(room, member)) throw new DomainError(409, "当前状态不能选择空角色，请重新同步房间。");
      if (!scenarios.get(room.scenario_id)?.character_ids.includes(characterId)) throw new DomainError(409, "该角色不在本场角色范围内。");
      if (member.first_character_id && member.first_character_id !== characterId) throw new DomainError(409, "同一场只能重新选择最初扮演的角色。");
      if (await tx.first("SELECT id FROM room_members WHERE room_id=? AND character_id=?", roomId, characterId)) throw new DomainError(409, "该角色已被其他成员占用。");
      tx.add("UPDATE room_members SET character_id=?,first_character_id=COALESCE(first_character_id,?) WHERE id=?", characterId, characterId, member.id);
      this.bump(tx, roomId); this.event(tx, room, member, "claim", characterId);
    });
    return this.getRoom(roomId);
  }
  async updateSettings(roomId: string, background: string, announcement: string): Promise<Row> {
    await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); await this.host(tx, room, session.id);
      if (room.status === "ended") throw new DomainError(409, "本场已经结束，背景与公告保留为只读。");
      if (room.background === background && room.announcement === announcement) return;
      tx.add("UPDATE rooms SET background=?,announcement=? WHERE id=?", background, announcement, roomId); this.bump(tx, roomId);
    });
    return this.getRoom(roomId);
  }
  async remove(roomId: string, memberId: string): Promise<Row> {
    await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); const host = await this.host(tx, room, session.id);
      if (room.status === "ended") throw new DomainError(409, "本场已经结束，成员记录保留为只读。");
      const target = await tx.first("SELECT m.*,s.nickname FROM room_members m JOIN sessions s ON s.id=m.session_id WHERE m.room_id=? AND m.id=?", roomId, memberId);
      if (!target) throw new DomainError(404, "本房没有该成员。");
      if (target.session_id === session.id) throw new DomainError(409, "房主不能移出自己，请先结束并离房。");
      if (await tx.first("SELECT 1 FROM room_bans WHERE room_id=? AND session_id=?", roomId, target.session_id)) return;
      tx.add("INSERT INTO room_bans(room_id,session_id,removed_by_member_id,created_at) VALUES(?,?,?,?)", roomId, target.session_id, host.id, now());
      tx.add("UPDATE room_members SET status='left',character_id=NULL,left_at=? WHERE id=?", now(), memberId);
      tx.add("UPDATE role_requests SET status='cancelled',decided_at=? WHERE room_id=? AND member_id=? AND status='pending'", now(), roomId, memberId);
      tx.add("DELETE FROM presence WHERE member_id=?", memberId);
      this.bump(tx, roomId); this.event(tx, room, target, "remove");
    });
    return this.getRoom(roomId);
  }
  async control(roomId: string, action: string): Promise<Row> {
    await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); await this.host(tx, room, session.id);
      let status = room.status, join = !!room.allow_join, text = "";
      if (action === "start") {
        if (status === "live") return;
        if (status !== "preparing") throw new DomainError(409, "只有准备中的场次可以开场；暂停后请使用继续。");
        if (await tx.count("SELECT COUNT(*) FROM room_members WHERE room_id=? AND status='active' AND character_id IS NOT NULL", roomId) < 2) throw new DomainError(409, "至少需要两名已选角色的演员才能开场。");
        status = "live"; text = "本场演出开始。\n" + room.background;
      } else if (action === "pause") {
        if (status === "paused") return;
        if (status !== "live") throw new DomainError(409, "只有演出中的场次可以暂停。");
        status = "paused"; text = "主持人暂停了舞台发言，可在后台继续讨论。";
      } else if (action === "resume") {
        if (status === "live") return;
        if (status !== "paused") throw new DomainError(409, "只有暂停中的场次可以继续。");
        status = "live"; text = "主持人继续了本场演出。";
      } else if (action === "end") {
        if (status === "ended") return;
        status = "ended"; join = false; text = "本场演出已结束，记录保留供本房成员阅读。";
        tx.add("UPDATE role_requests SET status='cancelled',decided_at=? WHERE room_id=? AND status='pending'", now(), roomId);
      } else if (action === "open_join" || action === "close_join") {
        if (status === "ended") throw new DomainError(409, "已结束的场次不能修改入场规则。");
        join = action === "open_join";
        if (join === !!room.allow_join) return;
        text = join ? "主持人开放了中途选角。" : "主持人关闭了中途选角。";
      } else throw new DomainError(422, "未知主持操作。");
      tx.add("UPDATE rooms SET status=?,allow_join=?,revision=revision+1,updated_at=? WHERE id=?", status, Number(join), now(), roomId);
      this.insertMessage(tx, room, { channel: "stage", text });
    });
    return this.getRoom(roomId);
  }
  async sendMessage(roomId: string, body: Row): Promise<Row> {
    const channel = body.channel, contentType = body.content_type ?? "text", text = body.text ?? "", stickerId = body.sticker_id ?? null, clientId = body.client_message_id;
    if (contentType === "text" && (stickerId !== null || !text.trim())) throw new DomainError(422, "文字消息须为非空正文，不能同时包含贴纸 ID。");
    if (contentType === "sticker" && (text !== "" || !stickerId)) throw new DomainError(422, "贴纸消息须有贴纸 ID，不能同时包含文字。");
    return this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); const member = (await this.member(tx, roomId, session.id))!;
      const backstage = this.backstage(room, member);
      if (channel === "backstage" && !backstage) throw new DomainError(403, "后台仅向房主和现任演员开放。");
      const existing = await tx.first("SELECT msg.*,m.alias AS legacy_alias,m.display_alias AS legacy_display_alias FROM messages msg LEFT JOIN room_members m ON m.id=msg.member_id WHERE msg.room_id=? AND msg.member_id=? AND msg.client_message_id=?", roomId, member.id, clientId);
      if (existing) {
        if (existing.channel !== channel || existing.content_type !== contentType || existing.sticker_id !== stickerId || (contentType === "text" && existing.text !== text)) throw new DomainError(409, "同一客户端消息 ID 已用于不同的内容类型、内容或频道。");
        return { message: this.messageJson(existing) };
      }
      if (room.status === "ended") throw new DomainError(409, "本场已经结束，不能继续发言。");
      if (channel === "stage") {
        if (!backstage) throw new DomainError(403, "观众不能在舞台发言，请先选择空角色。");
        if (room.status !== "live") throw new DomainError(409, "舞台尚未开场或已暂停，可在后台讨论。");
      }
      let sticker: Row | null = null;
      if (contentType === "sticker") {
        const source = stickers.get(stickerId);
        if (!source) throw new DomainError(422, "贴纸 ID 不在当前目录中。");
        sticker = Object.fromEntries(["id", "label", "character_id", "image"].map((key) => [key, source[key]]));
      }
      if (await tx.count("SELECT COUNT(*) FROM messages msg JOIN room_members m ON m.id=msg.member_id WHERE m.session_id=? AND msg.kind='speech' AND msg.created_at>=?", session.id, cutoff(60)) >= 60) throw new DomainError(429, "发言过于频繁，请稍后再试。");
      const message = this.insertMessage(tx, room, { channel, text: sticker ? "[贴纸] " + sticker.label : text, member_id: member.id, character_id: member.character_id, author: member.character_id ? characters.get(member.character_id)!.name : session.nickname || "主持人", kind: "speech", client_message_id: clientId, content_type: contentType, sticker_id: stickerId, sticker_json: sticker ? JSON.stringify(sticker) : null });
      return { message };
    });
  }
  private messageRowsSql = "SELECT msg.*,m.alias AS legacy_alias,m.display_alias AS legacy_display_alias FROM messages msg LEFT JOIN room_members m ON m.id=msg.member_id WHERE msg.room_id=? AND msg.channel=? AND msg.seq>? ORDER BY msg.seq LIMIT ?";
  private pageRows(rows: Row[], after: number, limit: number): Row {
    const selected = rows.slice(0, limit);
    return { messages: selected.map((row) => this.messageJson(row)), cursor: selected.length ? selected.at(-1)!.seq : after, has_more: rows.length > limit };
  }
  private async page(tx: Transaction, roomId: string, channel: string, after: number, limit: number): Promise<Row> {
    return this.pageRows(await tx.all(this.messageRowsSql, roomId, channel, after, limit + 1), after, limit);
  }
  async messages(roomId: string, channel: string, after: number, limit: number): Promise<Row> {
    return this.atomic.run(false, async (tx) => {
      const session = await this.session(tx); const room = await this.room(tx, roomId); const member = (await this.member(tx, roomId, session.id))!;
      if (channel === "backstage" && !this.backstage(room, member)) throw new DomainError(403, "后台仅向房主和现任演员开放。");
      return this.page(tx, roomId, channel, after, limit);
    });
  }
  async sync(roomId: string, afterStage: number, afterBackstage: number): Promise<Row> {
    return this.atomic.run(false, async (tx) => {
      const session = await this.session(tx); const room = await this.room(tx, roomId); const member = (await this.member(tx, roomId, session.id))!;
      const allowed = this.backstage(room, member);
      const [stageRows, backstageRows, memberRows] = await tx.readBatch([
        { sql: this.messageRowsSql, values: [roomId, "stage", afterStage, 101] },
        allowed ? { sql: this.messageRowsSql, values: [roomId, "backstage", afterBackstage, 101] } : { sql: "SELECT 1 WHERE 0" },
        { sql: this.memberRowsSql, values: [cutoff(45), roomId] },
      ]);
      const stage = this.pageRows(stageRows, afterStage, 100), backstage = this.pageRows(backstageRows, afterBackstage, 100);
      return { room: this.snapshotRows(room, session.id, memberRows), messages: { stage: stage.messages, backstage: backstage.messages }, cursors: { stage: stage.cursor, backstage: backstage.cursor }, has_more: { stage: stage.has_more, backstage: backstage.has_more } };
    });
  }
  async presence(roomId: string, connectionId: string, active: boolean): Promise<Row> {
    // These writes change only last-seen telemetry. SQL repeats authentication
    // and membership checks in the same statement as the upsert. A stale
    // heartbeat can never resurrect a kicked/revoked/left member's presence.
    const session = await this.atomic.run(false, async (tx) => { const value = await this.session(tx, true); await this.member(tx, roomId, value.id); return value; });
    if (!active) {
      await this.db.prepare("DELETE FROM presence WHERE room_id=? AND connection_id=? AND member_id IN(SELECT id FROM room_members WHERE room_id=? AND session_id=?)").bind(roomId, connectionId, roomId, session.id).run();
      return { ok: true, presence_ttl_ms: 45000 };
    }
    const result = await this.db.prepare("INSERT INTO presence(room_id,member_id,connection_id,last_seen) SELECT m.room_id,m.id,?,? FROM room_members m JOIN sessions s ON s.id=m.session_id WHERE m.room_id=? AND m.session_id=? AND m.status='active' AND s.revoked_at IS NULL AND s.expires_at>? AND NOT EXISTS(SELECT 1 FROM room_bans b WHERE b.room_id=m.room_id AND b.session_id=m.session_id) AND ((SELECT COUNT(*) FROM presence p JOIN room_members pm ON pm.id=p.member_id WHERE pm.session_id=? AND p.last_seen>=?)<6 OR EXISTS(SELECT 1 FROM presence p WHERE p.room_id=m.room_id AND p.member_id=m.id AND p.connection_id=? AND p.last_seen>=?)) AND ((SELECT COUNT(*) FROM presence WHERE last_seen>=?)<100 OR EXISTS(SELECT 1 FROM presence p WHERE p.room_id=m.room_id AND p.member_id=m.id AND p.connection_id=? AND p.last_seen>=?)) ON CONFLICT(room_id,member_id,connection_id) DO UPDATE SET last_seen=excluded.last_seen").bind(connectionId, now(), roomId, session.id, now(), session.id, cutoff(45), connectionId, cutoff(45), cutoff(45), connectionId, cutoff(45)).run();
    if (!result.meta?.changes) {
      await this.atomic.run(false, async (tx) => { await this.session(tx, true); await this.member(tx, roomId, session.id); });
      throw new DomainError(429, "在线连接已达上限，请关闭多余页面后重试。");
    }
    // Bound expired connection rows without touching live state or domain revision.
    await this.db.prepare("DELETE FROM presence WHERE last_seen<?").bind(cutoff(86400)).run();
    return { ok: true, presence_ttl_ms: 45000 };
  }
  private async reportJson(tx: Transaction, report: Row, sessionId: string | null, operator = false, context?: { room: Row; member: Row | null }): Promise<Row> {
    const room = context?.room ?? await this.room(tx, report.room_id);
    const member = context ? context.member : sessionId ? await this.member(tx, room.id, sessionId, false) : null;
    const isHost = !!member && room.host_session_id === sessionId;
    const snapshot = JSON.parse(report.snapshot_json);
    const redacted = !operator && snapshot.message?.channel === "backstage" && (!member || !this.backstage(room, member));
    const result: Row = {};
    for (const key of ["id", "seq", "room_id", "target_type", "message_id", "reason", "details", "status", "created_at", "resolved_at", "resolution_note", "resolved_by"]) result[key] = report[key];
    Object.assign(result, { against_host: !!report.against_host, is_own: report.reporter_session_id === sessionId, can_resolve: report.status === "open" && (operator || (isHost && !report.against_host)), snapshot: redacted ? null : snapshot, snapshot_redacted: redacted });
    if (operator) Object.assign(result, { reporter_member_id: report.reporter_member_id, target_member_id: report.target_member_id, operator_label: report.operator_label });
    return result;
  }
  async createReport(roomId: string, messageId: string | null, reason: string, details: string): Promise<Row> {
    const reportId = await this.atomic.run(true, async (tx) => {
      const session = await this.session(tx, true); const room = await this.room(tx, roomId); const reporter = (await this.member(tx, roomId, session.id))!;
      const host = await tx.first("SELECT id FROM room_members WHERE room_id=? AND session_id=?", roomId, room.host_session_id);
      let targetMemberId = host?.id ?? null, againstHost = true, targetType = "room", targetKey = "room", snapshot: Row;
      if (messageId) {
        const message = await tx.first("SELECT msg.*,m.alias AS legacy_alias,m.display_alias AS legacy_display_alias FROM messages msg LEFT JOIN room_members m ON m.id=msg.member_id WHERE msg.id=? AND msg.room_id=?", messageId, roomId);
        if (!message) throw new DomainError(404, "本房没有这条消息。");
        if (message.channel === "backstage" && !this.backstage(room, reporter)) throw new DomainError(403, "你无权读取或举报这条后台消息。");
        targetMemberId = message.member_id; againstHost = !targetMemberId || targetMemberId === host?.id; targetType = "message"; targetKey = "message:" + messageId; snapshot = { message: this.messageJson(message) };
      } else snapshot = { room: Object.fromEntries(["id", "title", "background", "announcement"].map((key) => [key, room[key]])) };
      const existing = await tx.first("SELECT * FROM reports WHERE reporter_session_id=? AND room_id=? AND target_key=? AND status='open'", session.id, roomId, targetKey);
      if (existing) {
        if (existing.reason === reason && existing.details === details) return existing.id;
        throw new DomainError(409, "这个目标已有待处理反馈，请先查看原回执。");
      }
      await this.rate(tx, "report", session.id, 5, 3600);
      const id = newId();
      tx.add("INSERT INTO reports(id,room_id,reporter_session_id,reporter_member_id,target_type,target_key,message_id,target_member_id,against_host,reason,details,snapshot_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, roomId, session.id, reporter.id, targetType, targetKey, messageId, targetMemberId, Number(againstHost), reason, details, JSON.stringify(snapshot), now());
      this.recordRate(tx, "report", session.id); this.bump(tx, roomId); return id;
    });
    return this.atomic.run(false, async (tx) => { const session = await this.session(tx); const report = await tx.first("SELECT * FROM reports WHERE id=? AND reporter_session_id=?", reportId, session.id); if (!report) throw new DomainError(404, "反馈不存在。"); return { report: await this.reportJson(tx, report, session.id) }; });
  }
  async listReports(roomId: string | null, after: number, limit: number, operator = false, status = "all"): Promise<Row> {
    return this.atomic.run(false, async (tx) => {
      const session = operator ? null : await this.session(tx);
      const clauses = ["r.seq>?"]; const values: unknown[] = [session?.id ?? null, after];
      if (operator) { if (status !== "all") { clauses.push("r.status=?"); values.push(status); } }
      else if (roomId) {
        const room = await this.room(tx, roomId);
        if (!await tx.first("SELECT id FROM room_members WHERE room_id=? AND session_id=?", roomId, session!.id)) throw new DomainError(403, "你没有本房反馈记录的查看权限。");
        const member = await this.member(tx, roomId, session!.id, false);
        clauses.push("r.room_id=?"); values.push(roomId);
        clauses.push(member && room.host_session_id === session!.id ? "(r.reporter_session_id=? OR r.against_host=0)" : "r.reporter_session_id=?"); values.push(session!.id);
      } else { clauses.push("r.reporter_session_id=?"); values.push(session!.id); }
      values.push(limit + 1);
      const rows = await tx.all("SELECT r.*,room.host_session_id AS context_host_session_id,m.id AS context_member_id,m.session_id AS context_session_id,m.character_id AS context_character_id FROM reports r JOIN rooms room ON room.id=r.room_id LEFT JOIN room_members m ON m.room_id=r.room_id AND m.session_id=? AND m.status='active' AND NOT EXISTS(SELECT 1 FROM room_bans b WHERE b.room_id=m.room_id AND b.session_id=m.session_id) WHERE " + clauses.join(" AND ") + " ORDER BY r.seq LIMIT ?", ...values);
      const selected = rows.slice(0, limit); const reports = [];
      for (const row of selected) reports.push(await this.reportJson(tx, row, session?.id ?? null, operator, { room: { id: row.room_id, host_session_id: row.context_host_session_id }, member: row.context_member_id ? { id: row.context_member_id, session_id: row.context_session_id, character_id: row.context_character_id } : null }));
      return { reports, cursor: selected.length ? selected.at(-1)!.seq : after, has_more: rows.length > limit };
    });
  }
  async resolveReport(roomId: string | null, reportId: string, status: string, note: string, operatorLabel: string | null = null): Promise<Row> {
    await this.atomic.run(true, async (tx) => {
      const session = operatorLabel === null ? await this.session(tx, true) : null;
      const report = await tx.first("SELECT * FROM reports WHERE id=?", reportId);
      if (!report || (roomId && report.room_id !== roomId)) throw new DomainError(404, "本房没有该反馈。");
      const room = await this.room(tx, report.room_id);
      const host = session ? await this.host(tx, room, session.id) : null;
      if (session && report.against_host) throw new DomainError(403, "涉及房主或房间本身的反馈须由服务器维护者处理。");
      if (report.status !== "open") {
        if (report.status === status && report.resolution_note === note) return;
        throw new DomainError(409, "反馈已结案，不能覆盖原处理记录。");
      }
      tx.add("UPDATE reports SET status=?,resolution_note=?,resolved_at=?,resolved_by=?,resolver_member_id=?,operator_label=? WHERE id=?", status, note, now(), operatorLabel === null ? "host" : "operator", host?.id ?? null, operatorLabel, reportId);
      this.bump(tx, room.id);
    });
    return this.atomic.run(false, async (tx) => { const session = operatorLabel === null ? await this.session(tx) : null; const report = (await tx.first("SELECT * FROM reports WHERE id=?", reportId))!; return { report: await this.reportJson(tx, report, session?.id ?? null, operatorLabel !== null) }; });
  }
  async operatorEndRoom(roomId: string, note: string, operator: string): Promise<Row> {
    return this.atomic.run(true, async (tx) => {
      const room = await this.room(tx, roomId);
      if (room.status === "ended") return { room_id: roomId, status: "ended", changed: false };
      const auditId = newId();
      tx.add("UPDATE rooms SET status='ended',allow_join=0 WHERE id=?", roomId);
      tx.add("UPDATE role_requests SET status='cancelled',decided_at=? WHERE room_id=? AND status='pending'", now(), roomId);
      tx.add("INSERT INTO moderation_actions(id,room_id,action,operator_label,note,created_at) VALUES(?,?,'end_room',?,?,?)", auditId, roomId, operator, note, now());
      this.bump(tx, roomId); this.insertMessage(tx, room, { channel: "stage", text: "服务器维护者结束了本场，记录保留供本房成员阅读。" });
      return { room_id: roomId, status: "ended", changed: true, audit_id: auditId };
    });
  }
  async exportPrivate(): Promise<Row> {
    return this.atomic.run(false, async (tx) => {
      const tables: Record<string, Row[]> = {}; let rows = 0, bytes = 0;
      // Fixed allowlist; never interpolate a client-supplied table name.
      for (const name of ["schema_meta", "sessions", "characters", "rooms", "room_members", "role_requests", "messages", "room_bans", "reports", "moderation_actions"]) {
        const count = await tx.count(`SELECT COUNT(*) FROM ${name}`);
        rows += count;
        if (rows > 50000) throw new DomainError(503, "数据量超过在线导出上限，请使用受保护的 D1 数据库导出。");
        tables[name] = await tx.all(`SELECT * FROM ${name}`);
        bytes += new TextEncoder().encode(JSON.stringify(tables[name])).byteLength;
        if (bytes > 16 * 1024 * 1024) throw new DomainError(503, "数据体积超过在线导出上限，请使用受保护的 D1 数据库导出。");
      }
      return { format: "onstage-confidential-state-v1", application_version: this.version, schema_version: 4, edge_schema_version: 1, exported_at: now(), catalog_sha256: await digest(JSON.stringify(CATALOG)), contains_private_session_credentials: true, omitted_tables: ["presence", "rate_events", "edge_state", "transaction_guards"], row_counts: Object.fromEntries(Object.entries(tables).map(([name, values]) => [name, values.length])), tables };
    });
  }
}
