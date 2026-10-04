-- drizzle-kit 이 낸 `ALTER TABLE ADD gateway_id text REFERENCES gateways(id)` 두 줄은 스냅숏의 ON DELETE(agents 는 set null,
-- bridge_tokens 는 cascade)를 빠뜨린다 — SQLite 는 받지만 Gateway 를 지울 때 조용히 다르게 동작한다. 그 두 줄에만 ON DELETE 를
-- 손으로 붙였다. 스냅숏(meta/0012_snapshot.json)은 생성기 출력 그대로다. 옛 행은 옮기지 않는다 — 배포 이력이 없다
CREATE TABLE `gateways` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`token` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`owner_user_id` text,
	`last_version` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gateways_ws_name` ON `gateways` (`workspace_id`,`name`);--> statement-breakpoint
DROP INDEX `agents_ws_provider_agent`;--> statement-breakpoint
ALTER TABLE `agents` ADD `gateway_id` text REFERENCES gateways(id) ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX `agents_openclaw_gateway_agent` ON `agents` (`gateway_id`,`provider_agent_id`) WHERE provider = 'openclaw';--> statement-breakpoint
CREATE UNIQUE INDEX `agents_claude_ws_agent` ON `agents` (`workspace_id`,`provider`,`provider_agent_id`) WHERE provider = 'claude';--> statement-breakpoint
DROP INDEX `approvals_provider`;--> statement-breakpoint
ALTER TABLE `approvals` ADD `connection_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_connection_provider` ON `approvals` (`connection_id`,`provider_approval_id`);--> statement-breakpoint
DROP INDEX `runs_provider_run`;--> statement-breakpoint
ALTER TABLE `runs` ADD `connection_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `runs_connection_provider_run` ON `runs` (`connection_id`,`provider_run_id`);--> statement-breakpoint
CREATE INDEX `runs_connection_session_status` ON `runs` (`connection_id`,`session_key`,`status`);--> statement-breakpoint
ALTER TABLE `bridge_tokens` ADD `gateway_id` text REFERENCES gateways(id) ON DELETE cascade;