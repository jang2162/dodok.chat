import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { isBundled, migrationsFolder } from "../runtime";
import * as authSchema from "./auth-schema";
import { assertTrigramSupport } from "./fts";
import { backfillNfcAttachmentNames } from "./nfc-backfill";
import * as schema from "./schema.sqlite";

export type CreateDbOptions = {
  /** 백필이 고친 첨부 행 수(0 포함) — 로거가 없는 이 함수 대신 부르는 쪽(app.ts)이 부팅 로그에 남긴다 */
  onBackfill?: (fixed: number) => void;
};

/** 파일 경로 또는 ":memory:". 연결 후 마이그레이션과 SQL 로 못 하는 데이터 백필(첨부 이름 NFC)까지 적용한다. */
export function createDb(file: string, opts: CreateDbOptions = {}) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema: { ...schema, ...authSchema } });
  if (isBundled() && !process.env.DODOK_MIGRATIONS_DIR) {
    throw new Error(
      "설정 오류: 운영 번들에는 DODOK_MIGRATIONS_DIR 가 필요하다(이미지가 /app/drizzle 로 준다)",
    );
  }
  assertTrigramSupport(sqlite);
  migrate(db, { migrationsFolder: migrationsFolder() });
  const fixed = backfillNfcAttachmentNames(db);
  opts.onBackfill?.(fixed);
  return db;
}

export type Db = ReturnType<typeof createDb>;
/** 트랜잭션 안팎 어디서나 쓰는 쿼리 함수의 첫 인자 타입 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
