from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


COOKIE_NAME = "onstage_session"


class DomainError(Exception):
    def __init__(self, status_code: int, detail: str):
        self.status_code = status_code
        self.detail = detail
        super().__init__(detail)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_time(value: datetime | None = None) -> str:
    return (value or utc_now()).astimezone(timezone.utc).isoformat(
        timespec="microseconds"
    ).replace("+00:00", "Z")


def parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def token_matches(left: str, right: str) -> bool:
    # Comparing fixed-length digests also supports non-ASCII input safely.
    return hmac.compare_digest(token_hash(left), token_hash(right))


def new_id() -> str:
    return secrets.token_hex(16)


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    public_origin: str
    secure_cookie: bool
    version: str
    session_ttl_seconds: int
    message_limit_per_minute: int
    session_limit_per_minute: int
    session_limit_per_hour: int
    max_active_sessions: int
    room_limit_per_hour: int
    room_ip_limit_per_hour: int
    max_active_rooms: int
    max_active_rooms_per_session: int
    max_room_members: int
    max_room_identities: int
    report_limit_per_hour: int

    database_url: str | None = None

    @classmethod
    def from_values(
        cls,
        *,
        data_dir: str | Path | None = None,
        database_url: str | None = None,
        public_origin: str | None = None,
        secure_cookie: bool | None = None,
        version: str | None = None,
        session_ttl_seconds: int | None = None,
        message_limit_per_minute: int | None = None,
    ) -> "Settings":
        return cls(
            database_url=database_url or os.environ.get("DATABASE_URL") or os.environ.get("ONSTAGE_DATABASE_URL"),
            data_dir=Path(data_dir or os.environ.get("ONSTAGE_DATA_DIR", "./data")),
            public_origin=(
                public_origin if public_origin is not None
                else os.environ.get("ONSTAGE_PUBLIC_ORIGIN", "")
            ).rstrip("/"),
            secure_cookie=(
                secure_cookie if secure_cookie is not None
                else os.environ.get("ONSTAGE_SECURE_COOKIE", "1") != "0"
            ),
            version=version or os.environ.get("ONSTAGE_VERSION", "development"),
            session_ttl_seconds=(
                session_ttl_seconds if session_ttl_seconds is not None
                else int(os.environ.get("ONSTAGE_SESSION_TTL_SECONDS", "604800"))
            ),
            message_limit_per_minute=(
                message_limit_per_minute if message_limit_per_minute is not None
                else int(os.environ.get("ONSTAGE_MESSAGE_LIMIT_PER_MINUTE", "60"))
            ),
            session_limit_per_minute=int(os.environ.get("ONSTAGE_SESSION_LIMIT_PER_MINUTE", "60")),
            session_limit_per_hour=int(os.environ.get("ONSTAGE_SESSION_LIMIT_PER_HOUR", "300")),
            max_active_sessions=int(os.environ.get("ONSTAGE_MAX_ACTIVE_SESSIONS", "500")),
            room_limit_per_hour=int(os.environ.get("ONSTAGE_ROOM_LIMIT_PER_HOUR", "4")),
            room_ip_limit_per_hour=int(os.environ.get("ONSTAGE_ROOM_IP_LIMIT_PER_HOUR", "20")),
            max_active_rooms=int(os.environ.get("ONSTAGE_MAX_ACTIVE_ROOMS", "10")),
            max_active_rooms_per_session=int(os.environ.get("ONSTAGE_MAX_ACTIVE_ROOMS_PER_SESSION", "2")),
            max_room_members=int(os.environ.get("ONSTAGE_MAX_ROOM_MEMBERS", "30")),
            max_room_identities=int(os.environ.get("ONSTAGE_MAX_ROOM_IDENTITIES", "150")),
            report_limit_per_hour=int(os.environ.get("ONSTAGE_REPORT_LIMIT_PER_HOUR", "5")),
        )

    def validate(self) -> None:
        origin = urlsplit(self.public_origin)
        if (
            origin.scheme not in {"http", "https"}
            or not origin.hostname
            or origin.username is not None
            or origin.password is not None
            or origin.path
            or origin.query
            or origin.fragment
        ):
            raise RuntimeError("ONSTAGE_PUBLIC_ORIGIN 必须是完整且不含路径的 HTTP(S) Origin。")
        limits = (
            self.session_ttl_seconds, self.message_limit_per_minute,
            self.session_limit_per_minute, self.session_limit_per_hour,
            self.max_active_sessions, self.room_limit_per_hour,
            self.room_ip_limit_per_hour, self.max_active_rooms,
            self.max_active_rooms_per_session, self.max_room_members,
            self.max_room_identities, self.report_limit_per_hour,
        )
        if any(value < 1 for value in limits):
            raise RuntimeError("会话期限和容量限额必须大于零。")

    @property
    def websocket_origin(self) -> str:
        if self.public_origin.startswith("https://"):
            return "wss://" + self.public_origin[8:]
        return "ws://" + self.public_origin[7:]

    def check_origin(self, origin: str | None, *, required: bool = False) -> None:
        if (required and not origin) or (
            origin is not None and origin != self.public_origin
        ):
            raise DomainError(403, "请求来源不被允许。")
