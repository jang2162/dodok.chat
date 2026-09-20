PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_approvals` (
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
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- 기존 approvals 행은 옮기지 않는다: 옛 표(run_id·summary·payload_json)와 겹치는 열이 없고,
-- 그 표를 쓴 코드가 없어 행도 개발 DB 에만 있을 수 있다. drizzle-kit 이 만든 INSERT ... SELECT 는
-- 옛 표에 없는 열(channel_id·title·severity…)을 읽어 빈 DB 에서도 실패하므로 지웠다(설계 4.2, 태스크 4).
DROP TABLE `approvals`;--> statement-breakpoint
ALTER TABLE `__new_approvals` RENAME TO `approvals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_provider` ON `approvals` (`provider_approval_id`);--> statement-breakpoint
CREATE INDEX `approvals_channel_status` ON `approvals` (`channel_id`,`status`);--> statement-breakpoint
CREATE INDEX `approvals_run` ON `approvals` (`run_id`);