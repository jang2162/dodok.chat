import { eq, sql } from "drizzle-orm";
import type { Db } from "./client";
import { attachments, messages } from "./schema.sqlite";

/**
 * 첨부 이름을 NFC 로 맞춘다 — macOS 가 올린 한글 파일 이름(NFD)이 NFC 검색어로 안 찾혔다. 저장 경계(attachments/service)는 이제 NFC 로
 * 받고, 이 함수는 그 전에 저장된 행을 고친다. SQLite 는 유니코드 정규화를 못 해 번호 있는 SQL 마이그레이션이 아니라 createDb 가
 * migrate 뒤 부팅마다 부르는 멱등 백필이다(고칠 행이 없으면 아무것도 쓰지 않는다).
 * 첨부 행과 그 메시지의 attachments_json 속 같은 첨부(id)의 이름을 한 트랜잭션에서 고친다 — attachments_json 을 고치면
 * messages_fts_au 트리거가 그 메시지를 다시 색인한다. 고친 첨부 행 수를 돌려준다
 */
export function backfillNfcAttachmentNames(db: Db): number {
  // ASCII 만인 이름은 늘 NFC 다 — 그 밖(인쇄 가능한 ASCII 가 아닌 글자를 품은 것)만 읽어 판정한다
  const stale = db
    .select({ id: attachments.id, name: attachments.name, messageId: attachments.messageId })
    .from(attachments)
    .where(sql`${attachments.name} GLOB '*[^ -~]*'`)
    .all()
    .filter((row) => row.name !== row.name.normalize("NFC"));
  if (stale.length === 0) return 0;
  db.transaction((tx) => {
    for (const row of stale) {
      const name = row.name.normalize("NFC");
      tx.update(attachments).set({ name }).where(eq(attachments.id, row.id)).run();
      if (row.messageId === null) continue;
      const bound = tx
        .select({ attachments: messages.attachments })
        .from(messages)
        .where(eq(messages.id, row.messageId))
        .get()?.attachments;
      if (!bound?.some((a) => a.id === row.id && a.name !== name)) continue;
      tx.update(messages)
        .set({ attachments: bound.map((a) => (a.id === row.id ? { ...a, name } : a)) })
        .where(eq(messages.id, row.messageId))
        .run();
    }
  });
  return stale.length;
}
