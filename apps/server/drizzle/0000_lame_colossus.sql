CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_agent_id` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`base_prompt` text,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_ws_handle` ON `agents` (`workspace_id`,`handle`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_ws_provider_agent` ON `agents` (`workspace_id`,`provider`,`provider_agent_id`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`provider_approval_id` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text,
	`status` text NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_provider` ON `approvals` (`provider_approval_id`);--> statement-breakpoint
CREATE TABLE `channel_members` (
	`id` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`member_type` text NOT NULL,
	`member_id` text NOT NULL,
	`prompt_override` text,
	`auto_respond` integer DEFAULT false NOT NULL,
	`aliases_json` text DEFAULT '[]' NOT NULL,
	`joined_at` integer NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_members_unique` ON `channel_members` (`channel_id`,`member_type`,`member_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`topic` text,
	`prompt` text,
	`relay_policy_json` text NOT NULL,
	`visibility` text NOT NULL,
	`created_by` text NOT NULL,
	`last_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `component_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`component_id` text NOT NULL,
	`user_id` text NOT NULL,
	`block_id` text,
	`item_id` text NOT NULL,
	`values_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `component_interactions_message` ON `component_interactions` (`message_id`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_ws_user` ON `memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE TABLE `messages` (
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
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_channel_seq` ON `messages` (`channel_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_author_client_msg` ON `messages` (`author_id`,`client_msg_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `messages_external_id` ON `messages` (`external_id`);--> statement-breakpoint
CREATE INDEX `messages_run` ON `messages` (`run_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`keys_json` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_run_seq` ON `run_events` (`run_id`,`seq`);--> statement-breakpoint
CREATE TABLE `runs` (
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
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_provider_run` ON `runs` (`provider_run_id`);--> statement-breakpoint
CREATE INDEX `runs_channel_created` ON `runs` (`channel_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `runs_root` ON `runs` (`root_message_id`);--> statement-breakpoint
CREATE INDEX `runs_session_status` ON `runs` (`session_key`,`status`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`handle` text NOT NULL,
	`display_name` text NOT NULL,
	`email` text,
	`auth_provider` text NOT NULL,
	`avatar_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_ws_handle` ON `users` (`workspace_id`,`handle`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
