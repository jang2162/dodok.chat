import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.sqlite";

/** 파일 경로 또는 ":memory:". 연결 후 마이그레이션까지 적용한다. */
export function createDb(file: string) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
  return db;
}

export type Db = ReturnType<typeof createDb>;
/** 트랜잭션 안팎 어디서나 쓰는 쿼리 함수의 첫 인자 타입 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
