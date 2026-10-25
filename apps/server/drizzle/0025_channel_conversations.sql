-- 채널 세션(채널 세션 스펙 2장) — 대화 표와 messages·runs·agent_sessions·approvals 의 conversation_id(NOT NULL FK).
-- 기존 채널마다 「이전 대화」 하나를 만들고(id = 그 채널 id — 저장된 세션 키 `…:channel:<id>` 와 OpenClaw 쪽 이력이 새로 계산한 키와
-- 그대로 맞는다) 그 채널의 행을 모두 거기로 옮긴다. 스냅숏(meta/0025_snapshot.json)은 생성기 출력 그대로다.
-- 손으로 쓴 까닭 셋:
-- 1) 생성기가 낸 `ALTER TABLE … ADD conversation_id text NOT NULL REFERENCES …` 는 SQLite 가 받지 않는다(기본값 없는 NOT NULL 열 추가
--    불가) — 네 표를 다시 만든다.
-- 2) 마이그레이터는 트랜잭션 안에서 돌고 서버는 foreign_keys = ON 으로 연다 — 트랜잭션 안의 `PRAGMA foreign_keys=OFF` 는 아무 일도
--    하지 않는다. 그래서 자식 행이 남은 채 부모 표를 DROP 하면 암묵 DELETE 가 돌아 ON DELETE no action 자식(첨부·런 이벤트·상호작용·
--    승인)은 FOREIGN KEY constraint failed 로 마이그레이션이 죽고, cascade 자식(리액션)은 조용히 지워진다. 그래서 자식 행을 TEMP
--    표로 옮겨 두고 비운 뒤 부모를 다시 만들고 되돌린다(defer_foreign_keys·legacy_alter_table 로는 실측에서 커밋이 실패했다).
-- 3) messages 를 다시 만들면 FTS 트리거가 사라지고 rowid 가 새로 매겨진다 — 끝에 0007_search_fts.sql 의 트리거 셋과 백필을 다시 넣는다.
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`title` text NOT NULL,
	`title_source` text NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_message_at` integer,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`closed_at` integer,
	`closed_by` text,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `conversations_channel_open_recent` ON `conversations` (`channel_id`,`closed_at`,`last_message_at`);--> statement-breakpoint
-- 「이전 대화」 — 아래 표 복사가 conversation_id 로 이 행을 가리키므로(FK 가 켜져 있다) 복사보다 먼저
INSERT INTO `conversations`("id", "channel_id", "title", "title_source", "created_by_type", "created_by_id", "created_at", "last_message_at", "last_seq")
SELECT c."id", c."id", '이전 대화', 'user', 'user', c."created_by", c."created_at",
  (SELECT m."created_at" FROM `messages` m WHERE m."channel_id" = c."id" ORDER BY m."seq" DESC LIMIT 1),
  coalesce((SELECT max(m."seq") FROM `messages` m WHERE m."channel_id" = c."id"), 0)
FROM `channels` c;--> statement-breakpoint
-- 자식 행을 잠시 옮겨 둔다(머리 주석 2)
CREATE TEMP TABLE `__park_attachments` AS SELECT * FROM `attachments`;--> statement-breakpoint
DELETE FROM `attachments`;--> statement-breakpoint
CREATE TEMP TABLE `__park_component_interactions` AS SELECT * FROM `component_interactions`;--> statement-breakpoint
DELETE FROM `component_interactions`;--> statement-breakpoint
CREATE TEMP TABLE `__park_message_reactions` AS SELECT * FROM `message_reactions`;--> statement-breakpoint
DELETE FROM `message_reactions`;--> statement-breakpoint
CREATE TEMP TABLE `__park_run_events` AS SELECT * FROM `run_events`;--> statement-breakpoint
DELETE FROM `run_events`;--> statement-breakpoint
CREATE TEMP TABLE `__park_approvals` AS SELECT * FROM `approvals`;--> statement-breakpoint
DELETE FROM `approvals`;--> statement-breakpoint
CREATE TABLE `__new_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`author_type` text NOT NULL,
	`author_id` text,
	`body_md` text NOT NULL,
	`mentions_json` text NOT NULL,
	`attachments_json` text DEFAULT '[]' NOT NULL,
	`components_json` text,
	`component_state_json` text,
	`system_meta_json` text,
	`reply_to` text,
	`run_id` text,
	`client_msg_id` text,
	`external_id` text,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	`thread_root_id` text,
	`conversation_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_messages`("id", "channel_id", "seq", "kind", "author_type", "author_id", "body_md", "mentions_json", "attachments_json", "components_json", "component_state_json", "system_meta_json", "reply_to", "run_id", "client_msg_id", "external_id", "created_at", "edited_at", "thread_root_id", "conversation_id") SELECT "id", "channel_id", "seq", "kind", "author_type", "author_id", "body_md", "mentions_json", "attachments_json", "components_json", "component_state_json", "system_meta_json", "reply_to", "run_id", "client_msg_id", "external_id", "created_at", "edited_at", "thread_root_id", "channel_id" FROM `messages`;--> statement-breakpoint
DROP TABLE `messages`;--> statement-breakpoint
ALTER TABLE `__new_messages` RENAME TO `messages`;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_channel_seq` ON `messages` (`channel_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_author_client_msg` ON `messages` (`author_id`,`client_msg_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_external_id` ON `messages` (`external_id`);--> statement-breakpoint
CREATE INDEX `messages_run` ON `messages` (`run_id`);--> statement-breakpoint
CREATE INDEX `messages_channel_thread_seq` ON `messages` (`channel_id`,`thread_root_id`,`seq`);--> statement-breakpoint
CREATE INDEX `messages_conversation_thread_seq` ON `messages` (`conversation_id`,`thread_root_id`,`seq`);--> statement-breakpoint
CREATE TABLE `__new_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`trigger_kind` text NOT NULL,
	`trigger_message_id` text,
	`trigger_interaction_id` text,
	`root_message_id` text NOT NULL,
	`relay_depth` integer DEFAULT 0 NOT NULL,
	`parent_run_id` text,
	`session_key` text NOT NULL,
	`provider_run_id` text,
	`status` text NOT NULL,
	`has_canonical` integer DEFAULT false NOT NULL,
	`final_source` text,
	`usage_json` text,
	`error_json` text,
	`relay_hash` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`ended_at` integer,
	`thread_root_id` text,
	`connection_id` text,
	`requested_by` text,
	`conversation_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_runs`("id", "channel_id", "agent_id", "trigger_kind", "trigger_message_id", "trigger_interaction_id", "root_message_id", "relay_depth", "parent_run_id", "session_key", "provider_run_id", "status", "has_canonical", "final_source", "usage_json", "error_json", "relay_hash", "created_at", "started_at", "ended_at", "thread_root_id", "connection_id", "requested_by", "conversation_id") SELECT "id", "channel_id", "agent_id", "trigger_kind", "trigger_message_id", "trigger_interaction_id", "root_message_id", "relay_depth", "parent_run_id", "session_key", "provider_run_id", "status", "has_canonical", "final_source", "usage_json", "error_json", "relay_hash", "created_at", "started_at", "ended_at", "thread_root_id", "connection_id", "requested_by", "channel_id" FROM `runs`;--> statement-breakpoint
DROP TABLE `runs`;--> statement-breakpoint
ALTER TABLE `__new_runs` RENAME TO `runs`;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_connection_provider_run` ON `runs` (`connection_id`,`provider_run_id`);--> statement-breakpoint
CREATE INDEX `runs_channel_created` ON `runs` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_conversation_created` ON `runs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_root` ON `runs` (`root_message_id`);--> statement-breakpoint
CREATE INDEX `runs_session_status` ON `runs` (`session_key`,`status`);--> statement-breakpoint
CREATE INDEX `runs_connection_session_status` ON `runs` (`connection_id`,`session_key`,`status`);--> statement-breakpoint
CREATE TABLE `__new_agent_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`session_key` text NOT NULL,
	`prompt_revision_at_start` integer NOT NULL,
	`session_started_at` integer,
	`lifecycle_revision` text,
	`provider_session_id` text,
	`history_cursor` text,
	`last_synced_at` integer,
	`thread_root_id` text,
	`reactions_seen_at` integer,
	`conversation_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
INSERT INTO `__new_agent_sessions`("id", "channel_id", "agent_id", "session_key", "prompt_revision_at_start", "session_started_at", "lifecycle_revision", "provider_session_id", "history_cursor", "last_synced_at", "thread_root_id", "reactions_seen_at", "conversation_id") SELECT "id", "channel_id", "agent_id", "session_key", "prompt_revision_at_start", "session_started_at", "lifecycle_revision", "provider_session_id", "history_cursor", "last_synced_at", "thread_root_id", "reactions_seen_at", "channel_id" FROM `agent_sessions`;--> statement-breakpoint
DROP TABLE `agent_sessions`;--> statement-breakpoint
ALTER TABLE `__new_agent_sessions` RENAME TO `agent_sessions`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_conversation_agent_thread` ON `agent_sessions` (`conversation_id`,`agent_id`,`thread_root_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_sessions_conversation_session` ON `agent_sessions` (`conversation_id`,`agent_id`) WHERE thread_root_id IS NULL;--> statement-breakpoint
-- approvals 는 위에서 비웠다 — 새로 만들고 옮겨 둔 행을 conversation_id = channel_id 로 넣는다
DROP TABLE `approvals`;--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_approval_id` text NOT NULL,
	`kind` text NOT NULL,
	`channel_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`tool_call_id` text,
	`tool_name` text,
	`plugin_id` text,
	`title` text NOT NULL,
	`description` text,
	`detail` text,
	`severity` text NOT NULL,
	`allowed_decisions_json` text NOT NULL,
	`url_path` text,
	`status` text NOT NULL,
	`decision` text,
	`reason` text,
	`decided_by` text,
	`decided_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`connection_id` text,
	`requested_by` text,
	`conversation_id` text NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_connection_provider` ON `approvals` (`connection_id`,`provider_approval_id`);--> statement-breakpoint
CREATE INDEX `approvals_channel_status` ON `approvals` (`channel_id`,`status`);--> statement-breakpoint
CREATE INDEX `approvals_run` ON `approvals` (`run_id`);--> statement-breakpoint
INSERT INTO `approvals`("id", "provider_approval_id", "kind", "channel_id", "agent_id", "run_id", "tool_call_id", "tool_name", "plugin_id", "title", "description", "detail", "severity", "allowed_decisions_json", "url_path", "status", "decision", "reason", "decided_by", "decided_at", "expires_at", "created_at", "connection_id", "requested_by", "conversation_id") SELECT "id", "provider_approval_id", "kind", "channel_id", "agent_id", "run_id", "tool_call_id", "tool_name", "plugin_id", "title", "description", "detail", "severity", "allowed_decisions_json", "url_path", "status", "decision", "reason", "decided_by", "decided_at", "expires_at", "created_at", "connection_id", "requested_by", "channel_id" FROM `__park_approvals`;--> statement-breakpoint
-- 옮겨 둔 자식 행을 되돌린다 — TEMP 표는 원래 표의 열 순서 그대로다
INSERT INTO `attachments` SELECT * FROM `__park_attachments`;--> statement-breakpoint
INSERT INTO `component_interactions` SELECT * FROM `__park_component_interactions`;--> statement-breakpoint
INSERT INTO `message_reactions` SELECT * FROM `__park_message_reactions`;--> statement-breakpoint
INSERT INTO `run_events` SELECT * FROM `__park_run_events`;--> statement-breakpoint
DROP TABLE `__park_attachments`;--> statement-breakpoint
DROP TABLE `__park_component_interactions`;--> statement-breakpoint
DROP TABLE `__park_message_reactions`;--> statement-breakpoint
DROP TABLE `__park_run_events`;--> statement-breakpoint
DROP TABLE `__park_approvals`;--> statement-breakpoint
-- FTS(머리 주석 3) — 트리거는 DROP TABLE messages 와 함께 사라졌고 색인의 rowid 는 옛 표 것이다. 0007_search_fts.sql 과 같은 트리거 셋과 백필
DELETE FROM messages_fts;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` WHEN new.kind = 'normal' BEGIN
  INSERT INTO messages_fts(rowid, body, attachment_names)
  VALUES (new.rowid, new.body_md, (SELECT coalesce(group_concat(json_extract(value, '$.name'), ' '), '') FROM json_each(new.attachments_json)));
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` WHEN old.kind = 'normal' BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;--> statement-breakpoint
CREATE TRIGGER `messages_fts_au` AFTER UPDATE OF body_md, attachments_json, kind ON `messages` BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, body, attachment_names)
  SELECT new.rowid, new.body_md, (SELECT coalesce(group_concat(json_extract(value, '$.name'), ' '), '') FROM json_each(new.attachments_json))
  WHERE new.kind = 'normal';
END;--> statement-breakpoint
INSERT INTO messages_fts(rowid, body, attachment_names)
SELECT m.rowid, m.body_md, (SELECT coalesce(group_concat(json_extract(value, '$.name'), ' '), '') FROM json_each(m.attachments_json))
FROM messages m WHERE m.kind = 'normal';
