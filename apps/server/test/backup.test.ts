import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackup } from "../src/backup";
import { createDb } from "../src/db/client";

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "dodok-backup-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const dbPath = () => join(dataDir, "dodok.sqlite");
/** 서버가 만드는 것과 같은 DB(WAL·마이그레이션)를 만들고 닫는다 */
function makeDb(file = dbPath()) {
  createDb(file).$client.close();
}
const backupsRoot = () => join(dataDir, "backups");
const mode = (p: string) => statSync(p).mode & 0o777;

describe("runBackup", () => {
  it("쓰는 중에도 온전한 사본을 만든다 [Review Focus 5]", async () => {
    makeDb();
    const seedDb = new Database(dbPath());
    seedDb.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, pad TEXT NOT NULL)");
    // 사본이 한 단계(100 페이지)로 끝나지 않을 만큼 키운다 — 약 4 MB, 1000 페이지 남짓
    const pad = "x".repeat(1000);
    const insert = seedDb.prepare("INSERT INTO probe (pad) VALUES (?)");
    seedDb.transaction(() => {
      for (let i = 0; i < 4000; i++) insert.run(pad);
    })();
    seedDb.close();

    // 쓰기는 다른 스레드의 다른 연결에서 — 한 스레드면 동기 API 라 백업과 실제로 겹치지 않는다.
    // 자동 체크포인트를 꺼 새 행이 WAL 에 남게 한다 — 파일만 복사하는 구현이면 그 행을 잃어 하한 단언에서 걸린다
    const shared = new Int32Array(new SharedArrayBuffer(8)); // [0] 멈춤 신호, [1] 커밋한 행 수
    const sqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
    const worker = new Worker(
      `const { workerData } = require("node:worker_threads");
       const Database = require(workerData.sqlitePath);
       const db = new Database(workerData.file);
       db.pragma("busy_timeout = 5000");
       db.pragma("wal_autocheckpoint = 0");
       const insert = db.prepare("INSERT INTO probe (pad) VALUES (?)");
       const pad = "y".repeat(1000);
       while (Atomics.load(workerData.shared, 0) === 0) {
         insert.run(pad);
         Atomics.add(workerData.shared, 1, 1);
       }
       db.close();`,
      { eval: true, workerData: { sqlitePath, file: dbPath(), shared } },
    );
    const exited = new Promise((r) => worker.once("exit", r));
    while (Atomics.load(shared, 1) < 200) await new Promise((r) => setTimeout(r, 5));

    const before = 4000 + Atomics.load(shared, 1);
    const result = await runBackup({ dataDir });
    const during = 4000 + Atomics.load(shared, 1) - before;
    Atomics.store(shared, 0, 1);
    await exited;
    const after = 4000 + Atomics.load(shared, 1);

    // 백업이 도는 동안 쓰기가 실제로 있었다 — 없었다면 이 테스트는 「쓰는 중」을 재지 않은 것이다
    expect(during).toBeGreaterThan(0);
    const copy = new Database(join(result.dir, "dodok.sqlite"), { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    const rows = (copy.prepare("SELECT count(*) AS n FROM probe").get() as { n: number }).n;
    expect(rows).toBeGreaterThanOrEqual(before);
    expect(rows).toBeLessThanOrEqual(after);
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .all();
    expect(tables).toHaveLength(1);
    copy.close();
  }, 30_000);

  it("백업 디렉터리는 UTC 시각 이름이고 vapid.json·openclaw-device*.json 사본을 0600 으로 둔다", async () => {
    makeDb();
    for (const f of ["vapid.json", "openclaw-device.json", "openclaw-device-dev.json"])
      writeFileSync(join(dataDir, f), `{"name":"${f}"}`, { mode: 0o644 });
    writeFileSync(join(dataDir, "other.json"), "{}");

    const r = await runBackup({ dataDir, now: new Date("2026-09-24T01:02:03.456Z") });

    expect(r.dir).toBe(join(backupsRoot(), "2026-09-24T01-02-03-456Z"));
    expect(readdirSync(r.dir).sort()).toEqual([
      "dodok.sqlite",
      "openclaw-device-dev.json",
      "openclaw-device.json",
      "vapid.json",
    ]);
    for (const f of readdirSync(r.dir)) expect(mode(join(r.dir, f))).toBe(0o600);
    expect(mode(r.dir)).toBe(0o700);
    expect(mode(backupsRoot())).toBe(0o700);
    expect(r.dbBytes).toBe(statSync(join(r.dir, "dodok.sqlite")).size);
    expect(r.dbBytes).toBeGreaterThan(0);
    expect(r.removed).toEqual([]);
  });

  it("dbPath 를 주면 DATA_DIR 밖의 DB 를 백업한다", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "dodok-backup-db-"));
    try {
      makeDb(join(elsewhere, "custom.sqlite"));
      const r = await runBackup({ dataDir, dbPath: join(elsewhere, "custom.sqlite") });
      expect(readdirSync(r.dir)).toEqual(["dodok.sqlite"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("같은 초에 두 번 돌려도 서로 덮지 않는다(두 번째는 -1 접미사)", async () => {
    makeDb();
    const now = new Date("2026-09-24T01:02:03.000Z");
    const a = await runBackup({ dataDir, now });
    const b = await runBackup({ dataDir, now });
    const c = await runBackup({ dataDir, now });
    expect(a.dir).toBe(join(backupsRoot(), "2026-09-24T01-02-03-000Z"));
    expect(b.dir).toBe(join(backupsRoot(), "2026-09-24T01-02-03-000Z-1"));
    expect(c.dir).toBe(join(backupsRoot(), "2026-09-24T01-02-03-000Z-2"));
    for (const r of [a, b, c]) expect(existsSync(join(r.dir, "dodok.sqlite"))).toBe(true);
  });

  it("keep 을 넘치면 오래된 것부터 지운다(기본 7)", async () => {
    makeDb();
    const at = (h: number) => new Date(Date.UTC(2026, 8, 24, h));
    const dirs: string[] = [];
    for (let h = 0; h < 7; h++) dirs.push((await runBackup({ dataDir, now: at(h) })).dir);
    const eighth = await runBackup({ dataDir, now: at(7) });
    expect(eighth.removed).toEqual([dirs[0]]);
    expect(existsSync(dirs[0]!)).toBe(false);
    expect(readdirSync(backupsRoot())).toHaveLength(7);

    const kept = await runBackup({ dataDir, now: at(8), keep: 2 });
    expect(kept.removed).toEqual(dirs.slice(1, 7));
    expect(readdirSync(backupsRoot()).sort()).toEqual(
      [eighth.dir, kept.dir].map((d) => d.slice(backupsRoot().length + 1)),
    );
  });

  it("방금 만든 백업은 시계가 거꾸로 가도 지우지 않고, 백업 이름이 아닌 것은 건드리지 않는다", async () => {
    makeDb();
    const later = await runBackup({ dataDir, now: new Date("2026-09-24T10:00:00.000Z") });
    mkdirSync(join(backupsRoot(), "before-upgrade"));
    writeFileSync(join(backupsRoot(), "notes.txt"), "사람이 둔 것");

    const earlier = await runBackup({
      dataDir,
      now: new Date("2026-09-24T09:00:00.000Z"),
      keep: 1,
    });

    expect(existsSync(join(earlier.dir, "dodok.sqlite"))).toBe(true);
    expect(earlier.removed).toEqual([later.dir]);
    expect(existsSync(join(backupsRoot(), "before-upgrade"))).toBe(true);
    expect(existsSync(join(backupsRoot(), "notes.txt"))).toBe(true);
  });

  it("DB 가 없으면 사유와 함께 던지고 부분 디렉터리를 남기지 않는다", async () => {
    await expect(runBackup({ dataDir })).rejects.toThrow(`백업할 DB 가 없다: ${dbPath()}`);
    expect(existsSync(backupsRoot()) ? readdirSync(backupsRoot()) : []).toEqual([]);
  });

  it("DB 가 망가져 백업이 도중에 실패해도 부분 디렉터리를 남기지 않는다", async () => {
    writeFileSync(dbPath(), "이것은 SQLite 파일이 아니다".repeat(200));
    writeFileSync(join(dataDir, "vapid.json"), "{}");
    await expect(runBackup({ dataDir })).rejects.toThrow();
    expect(readdirSync(backupsRoot())).toEqual([]);
  });

  it("사본 파일에 WAL·SHM 이 따라가지 않는다(단일 파일)", async () => {
    makeDb();
    // 체크포인트되지 않은 커밋이 WAL 에만 있는 상태에서 백업한다 — 열어 둔 연결이 WAL 을 붙들고 있다
    const live = new Database(dbPath());
    live.pragma("wal_autocheckpoint = 0");
    live.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    live.prepare("INSERT INTO probe DEFAULT VALUES").run();
    expect(existsSync(`${dbPath()}-wal`)).toBe(true);

    const r = await runBackup({ dataDir });
    live.close();

    expect(readdirSync(r.dir)).toEqual(["dodok.sqlite"]);
    // 파일 하나만 다른 자리로 옮겨도 내용이 다 있다 — 복원이 이 파일 하나를 되돌리는 절차이기 때문이다
    const alone = mkdtempSync(join(tmpdir(), "dodok-restore-"));
    try {
      copyFileSync(join(r.dir, "dodok.sqlite"), join(alone, "dodok.sqlite"));
      const restored = new Database(join(alone, "dodok.sqlite"));
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(restored.prepare("SELECT count(*) AS n FROM probe").get()).toEqual({ n: 1 });
      restored.close();
    } finally {
      rmSync(alone, { recursive: true, force: true });
    }
  });
});

describe("backup CLI (src/backup-main.ts)", () => {
  const serverDir = join(import.meta.dirname, "..");
  function cli(args: string[], env: Record<string, string>) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/backup-main.ts", ...args], {
      cwd: serverDir,
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  it("성공하면 exit 0 에 한 줄(경로·크기·시간), DB_PATH·--keep 을 따른다", () => {
    makeDb(join(dataDir, "other.sqlite"));
    const r = cli(["--keep", "3"], { DATA_DIR: dataDir, DB_PATH: join(dataDir, "other.sqlite") });
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.stdout).toMatch(/^백업 완료: .*\/backups\/\S+ \(\d+ bytes, \d+ ms, 지움 0\)\n$/);
  }, 20_000);

  it("DB 가 없으면 exit 1 에 사유 한 줄", () => {
    const r = cli([], { DATA_DIR: dataDir });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(`백업 실패: 백업할 DB 가 없다: ${dbPath()}\n`);
  }, 20_000);

  it.each([["0"], ["-1"], ["2.5"], ["abc"], [undefined]])(
    "--keep %s 은 거부한다",
    (n) => {
      makeDb();
      const r = cli(n === undefined ? ["--keep"] : ["--keep", n], { DATA_DIR: dataDir });
      expect(r.code).toBe(1);
      expect(r.stderr).toBe("백업 실패: --keep 은 1 이상의 정수\n");
      expect(existsSync(backupsRoot())).toBe(false);
    },
    20_000,
  );
});
