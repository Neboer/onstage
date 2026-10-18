-- Frozen schema from the 0.1.0 baseline; migration tests must not derive it from schema 2.
CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE characters (id TEXT PRIMARY KEY);
CREATE TABLE rooms (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, scenario_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('preparing','live','paused','ended')),
    allow_join INTEGER NOT NULL DEFAULT 0 CHECK (allow_join IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 1, host_session_id TEXT NOT NULL REFERENCES sessions(id),
    stage_seq INTEGER NOT NULL DEFAULT 0, backstage_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE room_members (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id),
    session_id TEXT NOT NULL REFERENCES sessions(id), alias TEXT NOT NULL,
    character_id TEXT REFERENCES characters(id), first_character_id TEXT REFERENCES characters(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
    joined_at TEXT NOT NULL, left_at TEXT,
    UNIQUE(room_id,id), UNIQUE(room_id,session_id), UNIQUE(room_id,character_id), UNIQUE(room_id,alias),
    CHECK(status='active' OR character_id IS NULL),
    CHECK(character_id IS NULL OR (first_character_id IS NOT NULL AND first_character_id=character_id))
);
CREATE TABLE role_requests (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), member_id TEXT NOT NULL,
    character_id TEXT NOT NULL REFERENCES characters(id),
    status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')),
    created_at TEXT NOT NULL, decided_at TEXT,
    FOREIGN KEY(room_id,member_id) REFERENCES room_members(room_id,id)
);
CREATE UNIQUE INDEX one_pending_request_per_member ON role_requests(room_id,member_id) WHERE status='pending';
CREATE TABLE messages (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), seq INTEGER NOT NULL,
    channel TEXT NOT NULL CHECK(channel IN ('stage','backstage')), member_id TEXT,
    character_id TEXT REFERENCES characters(id), author TEXT NOT NULL, text TEXT NOT NULL,
    created_at TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('speech','system')), client_message_id TEXT,
    FOREIGN KEY(room_id,member_id) REFERENCES room_members(room_id,id),
    UNIQUE(room_id,channel,seq), UNIQUE(room_id,member_id,client_message_id)
);
CREATE INDEX messages_member_time ON messages(member_id,created_at);
CREATE INDEX members_session ON room_members(session_id);
CREATE INDEX requests_room_status ON role_requests(room_id,status);
