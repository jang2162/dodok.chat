CREATE TABLE `user_sidebar_layouts` (
	`user_id` text PRIMARY KEY NOT NULL,
	`layout_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
