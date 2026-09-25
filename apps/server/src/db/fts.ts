import type Database from "better-sqlite3";

/**
 * better-sqlite3 가 번들한 SQLite 에 FTS5 trigram·contentless_delete 가 있는지. createDb 가 마이그레이션 **전에** 부른다 —
 * 없으면 검색 마이그레이션(drizzle/*_search_fts.sql)이 drizzle 오류 여러 줄로 죽어 사유가 안 읽힌다.
 * temp 스키마에 만들었다 지우므로 DB 파일은 그대로다
 */
export function assertTrigramSupport(sqlite: Pick<Database.Database, "exec">): void {
  try {
    sqlite.exec(
      "CREATE VIRTUAL TABLE temp.trigram_probe USING fts5(x, content='', tokenize='trigram case_sensitive 0', contentless_delete=1); DROP TABLE temp.trigram_probe",
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SQLite FTS5 trigram 을 쓸 수 없다 — better-sqlite3 가 번들한 SQLite 를 확인하라(${reason})`,
      {
        cause: err,
      },
    );
  }
}
