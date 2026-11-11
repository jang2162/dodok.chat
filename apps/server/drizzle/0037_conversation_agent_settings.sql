CREATE TABLE `conversation_agent_settings` (
	`conversation_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`model` text,
	`effort` text,
	`permission_mode` text,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`conversation_id`, `agent_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `agents` ADD `session_default_model` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `session_default_effort` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `session_default_permission_mode` text;
--> statement-breakpoint
-- 세션 설정 스펙 S8 — 러너 에이전트의 옛 모델·권한 모드를 그 에이전트의 세션이 있는 대화마다 한 번 옮기고(effort 는 기본), 같은 값을
-- 「새 세션 시작값」에도 옮긴다. 옛 allowed_tools 는 버린다. OpenClaw 에이전트는 행을 만들지 않는다
INSERT INTO `conversation_agent_settings` (`conversation_id`, `agent_id`, `model`, `effort`, `permission_mode`, `updated_by`, `updated_at`)
SELECT DISTINCT s.`conversation_id`, a.`id`, a.`model`, NULL, a.`permission_mode`, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM `agent_sessions` s JOIN `agents` a ON a.`id` = s.`agent_id`
WHERE a.`provider` = 'runner';--> statement-breakpoint
UPDATE `agents` SET `session_default_model` = `model`, `session_default_permission_mode` = `permission_mode`
WHERE `provider` = 'runner';--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `permission_mode`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `allowed_tools_json`;