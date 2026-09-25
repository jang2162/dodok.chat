import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { assertTrigramSupport } from "../modules/search/service";
import { isBundled, migrationsFolder } from "../runtime";
import * as authSchema from "./auth-schema";
import * as schema from "./schema.sqlite";

/** 파일 경로 또는 ":memory:". 연결 후 마이그레이션까지 적용한다. */
export function createDb(file: string) {
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
  return db;
}

export type Db = ReturnType<typeof createDb>;
/** 트랜잭션 안팎 어디서나 쓰는 쿼리 함수의 첫 인자 타입 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
