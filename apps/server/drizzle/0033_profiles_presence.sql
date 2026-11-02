ALTER TABLE `agents` ADD `created_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `users` ADD `status_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `status_mode_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `status_emoji` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status_text` text;--> statement-breakpoint
ALTER TABLE `users` ADD `status_text_until` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `dnd_allow_approvals` integer DEFAULT true NOT NULL;--> statement-breakpoint
-- 아바타 주소 계약이 https URL·올린 사진 주소(AvatarUrl)로 좁혀졌다 — 옛 z.url() 이 받은 http·data·공백 든 주소는 지운다(읽기가 500 으로 깨지지 않게, 화면은 이니셜)
UPDATE `agents` SET `avatar_url` = NULL WHERE `avatar_url` IS NOT NULL AND (`avatar_url` NOT GLOB 'https://?*' OR `avatar_url` GLOB '*[' || char(9, 10, 11, 12, 13, 32) || ']*');--> statement-breakpoint
UPDATE `users` SET `avatar_url` = NULL WHERE `avatar_url` IS NOT NULL AND (`avatar_url` NOT GLOB 'https://?*' OR `avatar_url` GLOB '*[' || char(9, 10, 11, 12, 13, 32) || ']*');
