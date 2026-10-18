CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    nickname TEXT NOT NULL DEFAULT '' CHECK (length(nickname) <= 24)
);

CREATE TABLE IF NOT EXISTS characters (
    id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    background TEXT NOT NULL DEFAULT '' CHECK (length(background) <= 2000),
    announcement TEXT NOT NULL DEFAULT '' CHECK (length(announcement) <= 500),
    scenario_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('preparing', 'live', 'paused', 'ended')),
    allow_join INTEGER NOT NULL DEFAULT 0 CHECK (allow_join IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1,
    host_session_id TEXT NOT NULL REFERENCES sessions(id),
    stage_seq INTEGER NOT NULL DEFAULT 0,
    backstage_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS room_members (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    alias TEXT NOT NULL,
    display_alias TEXT NOT NULL,
    character_id TEXT REFERENCES characters(id),
    first_character_id TEXT REFERENCES characters(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'left')),
    joined_at TEXT NOT NULL,
    left_at TEXT,
    UNIQUE (room_id, id),
    UNIQUE (room_id, session_id),
    UNIQUE (room_id, character_id),
    UNIQUE (room_id, alias),
    CHECK (status = 'active' OR character_id IS NULL),
    CHECK (character_id IS NULL OR (first_character_id IS NOT NULL AND first_character_id = character_id))
);

CREATE TABLE IF NOT EXISTS role_requests (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    member_id TEXT NOT NULL,
    character_id TEXT NOT NULL REFERENCES characters(id),
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    created_at TEXT NOT NULL,
    decided_at TEXT,
    FOREIGN KEY (room_id, member_id) REFERENCES room_members(room_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_pending_request_per_member
    ON role_requests(room_id, member_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    seq INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('stage', 'backstage')),
    member_id TEXT,
    character_id TEXT REFERENCES characters(id),
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('speech', 'system')),
    client_message_id TEXT,
    sticker_id TEXT,
    sticker_json TEXT,
    content_type TEXT NOT NULL DEFAULT 'text' CHECK (content_type IN ('text', 'sticker')),
    FOREIGN KEY (room_id, member_id) REFERENCES room_members(room_id, id),
    UNIQUE (room_id, channel, seq),
    UNIQUE (room_id, member_id, client_message_id),
    CHECK ((content_type = 'text' AND sticker_id IS NULL AND sticker_json IS NULL) OR
           (content_type = 'sticker' AND kind = 'speech' AND sticker_id IS NOT NULL AND
            length(sticker_id) BETWEEN 1 AND 80 AND sticker_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS messages_member_time ON messages(member_id, created_at);
CREATE INDEX IF NOT EXISTS members_session ON room_members(session_id);
CREATE INDEX IF NOT EXISTS requests_room_status ON role_requests(room_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS members_room_display_alias
    ON room_members(room_id, display_alias);

CREATE TABLE IF NOT EXISTS room_bans (
    room_id TEXT NOT NULL REFERENCES rooms(id),
    session_id TEXT NOT NULL REFERENCES sessions(id),
    removed_by_member_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (room_id, session_id),
    FOREIGN KEY (room_id, removed_by_member_id) REFERENCES room_members(room_id, id)
);

CREATE TABLE IF NOT EXISTS rate_events (
    id INTEGER PRIMARY KEY,
    action TEXT NOT NULL,
    subject_key TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_window ON rate_events(action, subject_key, created_at);
CREATE INDEX IF NOT EXISTS rate_events_age ON rate_events(created_at);

CREATE TABLE IF NOT EXISTS reports (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    reporter_session_id TEXT NOT NULL REFERENCES sessions(id),
    reporter_member_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('room', 'message')),
    target_key TEXT NOT NULL,
    message_id TEXT REFERENCES messages(id),
    target_member_id TEXT,
    against_host INTEGER NOT NULL CHECK (against_host IN (0, 1)),
    reason TEXT NOT NULL CHECK (reason IN ('harassment', 'spam', 'unsafe', 'other')),
    details TEXT NOT NULL CHECK (length(details) <= 1000),
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution_note TEXT,
    resolved_by TEXT CHECK (resolved_by IN ('host', 'operator')),
    resolver_member_id TEXT,
    operator_label TEXT,
    FOREIGN KEY (room_id, reporter_member_id) REFERENCES room_members(room_id, id),
    FOREIGN KEY (room_id, target_member_id) REFERENCES room_members(room_id, id),
    FOREIGN KEY (room_id, resolver_member_id) REFERENCES room_members(room_id, id),
    CHECK ((target_type = 'room' AND message_id IS NULL) OR
           (target_type = 'message' AND message_id IS NOT NULL)),
    CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by IS NULL) OR
           (status != 'open' AND resolved_at IS NOT NULL AND resolved_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS reports_reporter_seq ON reports(reporter_session_id, seq);
CREATE INDEX IF NOT EXISTS reports_room_seq ON reports(room_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS reports_one_open_target
    ON reports(reporter_session_id, room_id, target_key) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS moderation_actions (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id),
    action TEXT NOT NULL CHECK (action = 'end_room'),
    operator_label TEXT NOT NULL,
    note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 500),
    created_at TEXT NOT NULL
);
