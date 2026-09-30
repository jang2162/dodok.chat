-- drizzle-kit 이 낸 `ALTER TABLE ADD session_id text NOT NULL REFERENCES session(id)` 는 SQLite 가 받지 않는다(기본값 없는
-- NOT NULL 열 추가 불가, ON DELETE CASCADE 도 빠진다) — 표를 새로 만든다. 스냅숏(meta/0010_snapshot.json)은 생성기 출력 그대로다.
-- 기존 행은 옮기지 않는다: 어느 세션이 등록했는지 모르고, 사용자의 아무 세션에 붙이면 그 세션이 사는 동안 「세션 없는 발송」이
-- 그대로 이어진다. 웹은 로그인한 채 앱을 열 때마다 이 기기의 구독을 다시 등록하므로(pwa/push.ts syncPushSubscription)
-- 쓰이는 기기는 다음에 앱을 열 때 그 세션으로 돌아온다 — 그때까지 그 기기에는 알림이 가지 않는다.
DROP TABLE `push_subscriptions`;--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`keys_json` text NOT NULL,
	`user_agent` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_subscriptions_session` ON `push_subscriptions` (`session_id`);
