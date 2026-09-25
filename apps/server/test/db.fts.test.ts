import type Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client";
import { assertTrigramSupport } from "../src/db/fts";
import { newTestDb } from "./helpers/db";

// createDb 가 부르는 확인을 진짜 구현을 감싼 spy 로 — 부를 때 마이그레이션이 이미 돌았는지 함께 적는다
const calls = vi.hoisted(() => ({ tablesAtCall: [] as number[] }));
vi.mock("../src/db/fts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/fts")>();
  return {
    ...actual,
    assertTrigramSupport: vi.fn((sqlite: Database.Database) => {
      calls.tablesAtCall.push(
        (sqlite.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number }).n,
      );
      actual.assertTrigramSupport(sqlite);
    }),
  };
});

describe("assertTrigramSupport", () => {
  it("createDb 가 마이그레이션 전에 한 번 부른다", () => {
    vi.mocked(assertTrigramSupport).mockClear();
    calls.tablesAtCall.length = 0;
    const db = createDb(":memory:");
    expect(assertTrigramSupport).toHaveBeenCalledTimes(1);
    expect(assertTrigramSupport).toHaveBeenCalledWith(db.$client);
    expect(calls.tablesAtCall).toEqual([0]);
  });

  it("번들 SQLite 에는 trigram 이 있다 — 던지지 않고 탐침 테이블을 남기지 않는다", () => {
    const db = newTestDb();
    expect(() => assertTrigramSupport(db.$client)).not.toThrow();
    expect(db.$client.prepare("SELECT name FROM temp.sqlite_master").all()).toEqual([]);
  });

  it("없으면 사유 한 줄로 던지고 원래 오류를 cause 로 남긴다", () => {
    const original = new Error("no such tokenizer: trigram");
    const sqlite = {
      exec: () => {
        throw original;
      },
      prepare: () => ({ get: () => ({ n: 0 }) }),
    };
    let thrown: unknown;
    try {
      assertTrigramSupport(sqlite as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(
      /^SQLite FTS5 trigram 을 쓸 수 없다 — .*no such tokenizer: trigram/,
    );
    expect((thrown as Error).cause).toBe(original);
  });
});
