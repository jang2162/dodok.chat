-- 메시지 전문 검색(스레드·검색 스펙 5.1). drizzle-kit 이 가상 테이블·트리거를 못 만들어 손으로 쓴 커스텀 마이그레이션이다.
-- content='' + contentless_delete=1: 본문 사본을 두지 않고(messages 가 정본) 행 삭제·갱신은 된다(SQLite 3.43+).
-- rowid 는 messages 의 암묵 rowid(text PK 라 별명이 아니다). VACUUM·backup API 는 rowid 를 지킨다.
-- ⚠ drizzle 이 messages 를 다시 만드는 마이그레이션(__new_messages 로 복사 → DROP → RENAME)을 내면 트리거가 DROP 과 함께
-- 사라지고 rowid 가 새로 매겨진다 — 오류 없이 검색만 낡는다. 그런 마이그레이션 뒤에는 이 파일의 트리거 셋과
-- 백필(DELETE FROM messages_fts 뒤 INSERT … SELECT)을 새 커스텀 마이그레이션으로 다시 넣는다.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(body, attachment_names, content='', tokenize='trigram case_sensitive 0', contentless_delete=1);
--> statement-breakpoint
-- 대상은 kind = 'normal' 만 — 시스템 메시지는 찾지 않는다
CREATE TRIGGER `messages_fts_ai` AFTER INSERT ON `messages` WHEN new.kind = 'normal' BEGIN
  INSERT INTO messages_fts(rowid, body, attachment_names)
  VALUES (new.rowid, new.body_md, (SELECT coalesce(group_concat(json_extract(value, '$.name'), ' '), '') FROM json_each(new.attachments_json)));
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_ad` AFTER DELETE ON `messages` WHEN old.kind = 'normal' BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;
--> statement-breakpoint
-- components 상태 갱신(component_state_json)처럼 본문·첨부가 그대로인 UPDATE 는 색인을 건드리지 않는다
CREATE TRIGGER `messages_fts_au` AFTER UPDATE OF body_md, attachments_json, kind ON `messages` BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts(rowid, body, attachment_names)
  SELECT new.rowid, new.body_md, (SELECT coalesce(group_concat(json_extract(value, '$.name'), ' '), '') FROM json_each(new.attachments_json))
  WHERE new.kind = 'normal';
END;
--> statement-breakpoint
INSERT INTO messages_fts(rowid, body, attachment_names)
SELECT m.rowid, m.body_md, (SELECT coalesce(group_concat(json_extract(value, '$.name'), ' '), '') FROM json_each(m.attachments_json))
FROM messages m WHERE m.kind = 'normal';
