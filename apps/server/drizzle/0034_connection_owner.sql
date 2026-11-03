ALTER TABLE `gateways` ADD `approved_at` integer;--> statement-breakpoint
ALTER TABLE `gateways` ADD `approved_by` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `runner_tokens` ADD `owner_user_id` text REFERENCES users(id);--> statement-breakpoint
-- 옛 연결은 모두 owner 가 만든 것이다(1단계까지 Gateway·러너 토큰은 owner 만 만들었다) — 주인은 그 워크스페이스의 owner, 옛 Gateway 는 만든 시각에 그 owner 가 승인한 것으로 채운다(연결 탭 통합 스펙 5.1)
UPDATE `gateways` SET `owner_user_id` = (SELECT `user_id` FROM `memberships` WHERE `memberships`.`workspace_id` = `gateways`.`workspace_id` AND `memberships`.`role` = 'owner' LIMIT 1) WHERE `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `gateways` SET `approved_at` = `created_at`, `approved_by` = `owner_user_id` WHERE `approved_at` IS NULL;--> statement-breakpoint
UPDATE `runner_tokens` SET `owner_user_id` = (SELECT `user_id` FROM `memberships` WHERE `memberships`.`workspace_id` = `runner_tokens`.`workspace_id` AND `memberships`.`role` = 'owner' LIMIT 1) WHERE `owner_user_id` IS NULL;
