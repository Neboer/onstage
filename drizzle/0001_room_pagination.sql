CREATE INDEX IF NOT EXISTS rooms_created_page ON rooms(created_at DESC,id ASC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rooms_status_page ON rooms(status,created_at DESC,id ASC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS members_session_status_room ON room_members(session_id,status,room_id);
--> statement-breakpoint
