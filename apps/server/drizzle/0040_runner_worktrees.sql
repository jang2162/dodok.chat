ALTER TABLE `runner_projects` ADD `parent_project_id` text REFERENCES runner_projects(id);--> statement-breakpoint
ALTER TABLE `runner_projects` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `runner_projects` ADD `is_git` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runner_projects` ADD `worktree_cleanup` text;