-- attachments.gateway_id — 플러그인이 올린 첨부의 Gateway(멀티 Gateway 스펙 「브리지 첨부 범위」 절). drizzle-kit 이 낸 `ADD … REFERENCES gateways(id)` 는
-- 스냅숏의 ON DELETE set null 을 빠뜨린다(0012 와 같다) — 그 줄에만 손으로 붙였다. 스냅숏(meta/0014_snapshot.json)은 생성기 출력
-- 그대로다. 옛 행은 채우지 않는다 — 배포 이력이 없다
ALTER TABLE `attachments` ADD `gateway_id` text REFERENCES gateways(id) ON DELETE set null;
