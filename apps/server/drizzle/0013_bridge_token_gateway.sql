-- bridge_tokens.gateway_id 를 NOT NULL 로 — 브리지 토큰은 Gateway 에 묶인다(멀티 Gateway 스펙 3.2). 생성기가 낸 표 다시 만들기에서
-- 옛 행 복사(INSERT … SELECT)에만 `WHERE gateway_id IS NOT NULL` 을 손으로 붙였다: Gateway 에 묶이지 않은 토큰(.env 에서 이어받은
-- 것·Gateway 아래 발급 전에 만든 것)은 새 모델에서 어느 Gateway 에도 붙지 못하고, 그대로 옮기면 NOT NULL 에 걸려 마이그레이션이
-- 실패해 서버가 뜨지 않는다. 스냅숏(meta/0013_snapshot.json)은 생성기 출력 그대로다
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_bridge_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`label` text NOT NULL,
	`hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	`gateway_id` text NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gateway_id`) REFERENCES `gateways`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_bridge_tokens`("id", "workspace_id", "label", "hash", "prefix", "created_at", "last_used_at", "revoked_at", "gateway_id") SELECT "id", "workspace_id", "label", "hash", "prefix", "created_at", "last_used_at", "revoked_at", "gateway_id" FROM `bridge_tokens` WHERE "gateway_id" IS NOT NULL;--> statement-breakpoint
DROP TABLE `bridge_tokens`;--> statement-breakpoint
ALTER TABLE `__new_bridge_tokens` RENAME TO `bridge_tokens`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `bridge_tokens_hash` ON `bridge_tokens` (`hash`);--> statement-breakpoint
CREATE INDEX `bridge_tokens_ws_created` ON `bridge_tokens` (`workspace_id`,`created_at`);