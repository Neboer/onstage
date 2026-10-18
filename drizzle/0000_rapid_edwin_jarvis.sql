CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `edge_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "edge_state_singleton" CHECK("edge_state"."id"=1)
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`channel` text NOT NULL,
	`member_id` text,
	`character_id` text,
	`author` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	`kind` text NOT NULL,
	`client_message_id` text,
	`sticker_id` text,
	`sticker_json` text,
	`content_type` text DEFAULT 'text' NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "messages_channel" CHECK("messages"."channel" IN ('stage','backstage')),
	CONSTRAINT "messages_kind" CHECK("messages"."kind" IN ('speech','system')),
	CONSTRAINT "messages_content_type" CHECK("messages"."content_type" IN ('text','sticker')),
	CONSTRAINT "messages_sticker_shape" CHECK(("messages"."content_type"='text' AND "messages"."sticker_id" IS NULL AND "messages"."sticker_json" IS NULL) OR ("messages"."content_type"='sticker' AND "messages"."kind"='speech' AND "messages"."sticker_id" IS NOT NULL AND length("messages"."sticker_id") BETWEEN 1 AND 80 AND "messages"."sticker_json" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_room_channel_seq` ON `messages` (`room_id`,`channel`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_client_id` ON `messages` (`room_id`,`member_id`,`client_message_id`);--> statement-breakpoint
CREATE INDEX `messages_member_time` ON `messages` (`member_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`action` text NOT NULL,
	`operator_label` text NOT NULL,
	`note` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "moderation_actions_action" CHECK("moderation_actions"."action"='end_room'),
	CONSTRAINT "moderation_actions_note" CHECK(length("moderation_actions"."note") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE `presence` (
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`room_id`, `member_id`, `connection_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "presence_connection_id_length" CHECK(length("presence"."connection_id") BETWEEN 8 AND 80)
);
--> statement-breakpoint
CREATE INDEX `presence_member_seen` ON `presence` (`member_id`,`last_seen`);--> statement-breakpoint
CREATE INDEX `presence_seen` ON `presence` (`last_seen`);--> statement-breakpoint
CREATE TABLE `rate_events` (
	`id` integer PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`subject_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_events_window` ON `rate_events` (`action`,`subject_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `rate_events_age` ON `rate_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `reports` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`room_id` text NOT NULL,
	`reporter_session_id` text NOT NULL,
	`reporter_member_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_key` text NOT NULL,
	`message_id` text,
	`target_member_id` text,
	`against_host` integer NOT NULL,
	`reason` text NOT NULL,
	`details` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolution_note` text,
	`resolved_by` text,
	`resolver_member_id` text,
	`operator_label` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`reporter_member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`target_member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`resolver_member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reports_target_type" CHECK("reports"."target_type" IN ('room','message')),
	CONSTRAINT "reports_against_host" CHECK("reports"."against_host" IN (0,1)),
	CONSTRAINT "reports_reason" CHECK("reports"."reason" IN ('harassment','spam','unsafe','other')),
	CONSTRAINT "reports_details_length" CHECK(length("reports"."details") <= 1000),
	CONSTRAINT "reports_status" CHECK("reports"."status" IN ('open','resolved','dismissed')),
	CONSTRAINT "reports_resolver" CHECK("reports"."resolved_by" IN ('host','operator')),
	CONSTRAINT "reports_target_shape" CHECK(("reports"."target_type"='room' AND "reports"."message_id" IS NULL) OR ("reports"."target_type"='message' AND "reports"."message_id" IS NOT NULL)),
	CONSTRAINT "reports_resolution_shape" CHECK(("reports"."status"='open' AND "reports"."resolved_at" IS NULL AND "reports"."resolved_by" IS NULL) OR ("reports"."status"!='open' AND "reports"."resolved_at" IS NOT NULL AND "reports"."resolved_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_id_unique` ON `reports` (`id`);--> statement-breakpoint
CREATE INDEX `reports_reporter_seq` ON `reports` (`reporter_session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `reports_room_seq` ON `reports` (`room_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `reports_one_open_target` ON `reports` (`reporter_session_id`,`room_id`,`target_key`) WHERE "reports"."status"='open';--> statement-breakpoint
CREATE TABLE `role_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`member_id` text NOT NULL,
	`character_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`decided_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requests_status" CHECK("role_requests"."status" IN ('pending','approved','rejected','cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `one_pending_request_per_member` ON `role_requests` (`room_id`,`member_id`) WHERE "role_requests"."status"='pending';--> statement-breakpoint
CREATE INDEX `requests_room_status` ON `role_requests` (`room_id`,`status`);--> statement-breakpoint
CREATE TABLE `room_bans` (
	`room_id` text NOT NULL,
	`session_id` text NOT NULL,
	`removed_by_member_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`room_id`, `session_id`),
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`room_id`,`removed_by_member_id`) REFERENCES `room_members`(`room_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `room_members` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`session_id` text NOT NULL,
	`alias` text NOT NULL,
	`display_alias` text NOT NULL,
	`character_id` text,
	`first_character_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`joined_at` text NOT NULL,
	`left_at` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`first_character_id`) REFERENCES `characters`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "members_status" CHECK("room_members"."status" IN ('active','left')),
	CONSTRAINT "members_left_no_character" CHECK("room_members"."status"='active' OR "room_members"."character_id" IS NULL),
	CONSTRAINT "members_first_character" CHECK("room_members"."character_id" IS NULL OR ("room_members"."first_character_id" IS NOT NULL AND "room_members"."first_character_id"="room_members"."character_id"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_id` ON `room_members` (`room_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_session` ON `room_members` (`room_id`,`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_character` ON `room_members` (`room_id`,`character_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_alias` ON `room_members` (`room_id`,`alias`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_room_display_alias` ON `room_members` (`room_id`,`display_alias`);--> statement-breakpoint
CREATE INDEX `members_session` ON `room_members` (`session_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`background` text DEFAULT '' NOT NULL,
	`announcement` text DEFAULT '' NOT NULL,
	`scenario_id` text NOT NULL,
	`status` text NOT NULL,
	`allow_join` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`host_session_id` text NOT NULL,
	`stage_seq` integer DEFAULT 0 NOT NULL,
	`backstage_seq` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`host_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rooms_background_length" CHECK(length("rooms"."background") <= 2000),
	CONSTRAINT "rooms_announcement_length" CHECK(length("rooms"."announcement") <= 500),
	CONSTRAINT "rooms_status" CHECK("rooms"."status" IN ('preparing','live','paused','ended')),
	CONSTRAINT "rooms_allow_join" CHECK("rooms"."allow_join" IN (0,1))
);
--> statement-breakpoint
CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`nickname` text DEFAULT '' NOT NULL,
	CONSTRAINT "sessions_nickname_length" CHECK(length("sessions"."nickname") <= 24)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `transaction_guards` (
	`id` text PRIMARY KEY NOT NULL,
	`valid` integer NOT NULL,
	CONSTRAINT "onstage_revision_guard" CHECK("transaction_guards"."valid"=1)
);
