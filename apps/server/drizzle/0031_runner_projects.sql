CREATE TABLE `runner_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`runner_token_id` text NOT NULL,
	`root_id` text NOT NULL,
	`rel_path` text NOT NULL,
	`label` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`runner_token_id`) REFERENCES `runner_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runner_projects_runner_root_path` ON `runner_projects` (`runner_token_id`,`root_id`,`rel_path`) WHERE archived_at IS NULL;--> statement-breakpoint
ALTER TABLE `agent_sessions` ADD `instructions_revision_at_start` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `runner_project_id` text REFERENCES runner_projects(id);--> statement-breakpoint
ALTER TABLE `agents` ADD `model` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `permission_mode` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `allowed_tools_json` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `disallowed_tools_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `instructions_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- 손으로 덧붙인 옮기기(러너 일반화 계획 판정 PR6) — 서버는 옛 러너 에이전트의 작업 디렉터리를 모른다(러너 로컬 설정에만 있었다).
-- 프로젝트가 없는 러너 에이전트는 보관한다: 메시지·런의 작성자로 남고 되살릴 수 없다(새로 만든다). 보관 시각은 ms(timestamp_ms)
UPDATE `agents` SET `archived_at` = cast(unixepoch('subsecond') * 1000 as integer)
  WHERE `provider` = 'runner' AND `runner_project_id` IS NULL AND `archived_at` IS NULL;
