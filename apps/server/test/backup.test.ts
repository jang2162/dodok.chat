import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runBackup, STALE_PARTIAL_MS } from "../src/backup";
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
const partials = () => readdirSync(backupsRoot()).filter((d) => d.startsWith(".partial-"));
/** 중단된 백업이 남긴 것처럼 .partial-* 를 만든다. ageMs 를 주면 디렉터리와 안 파일의 mtime 을 그만큼 과거로 */
function leavePartial(name: string, ageMs = 0, fileAgeMs = ageMs) {
  const p = join(backupsRoot(), name);
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "dodok.sqlite"), "부분 사본");
  const at = (ms: number) => new Date(Date.now() - ms);
  utimesSync(join(p, "dodok.sqlite"), at(fileAgeMs), at(fileAgeMs));
  utimesSync(p, at(ageMs), at(ageMs));
  return p;
}

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
         Atomics.notify(workerData.shared, 1);
       }
       db.close();`,
      { eval: true, workerData: { sqlitePath, file: dbPath(), shared } },
    );
    const exited = new Promise((r) => worker.once("exit", r));
    while (Atomics.load(shared, 1) < 200) await new Promise((r) => setTimeout(r, 5));

    const before = 4000 + Atomics.load(shared, 1);
    // 「백업이 도는 동안 쓰기가 있었다」를 시간이 아니라 순서로 보장한다 — 백업이 시작되면(임시 디렉터리를 만든 직후, 복사 전) 워커가
    // 한 행을 더 커밋할 때까지 백업을 세운다. 시간에만 맡기면 부하에서 워커가 짧은 백업 창 안에 한 번도 돌지 못해 during 이 0 이었다
    const result = await runBackup({
      dataDir,
      onPartial: () => {
        const seen = Atomics.load(shared, 1);
        if (Atomics.wait(shared, 1, seen, 10_000) === "timed-out")
          throw new Error("쓰기 워커가 백업 시작 뒤 10초 안에 커밋하지 않았다");
      },
    });
    const during = 4000 + Atomics.load(shared, 1) - before;
    Atomics.store(shared, 0, 1);
    await exited;
    const after = 4000 + Atomics.load(shared, 1);

    // 백업이 도는 동안 쓰기가 실제로 있었다 — 없었다면 이 테스트는 「쓰는 중」을 재지 않은 것이다
    // onPartial 문이 커밋 한 번을 보장하므로(못 하면 던진다) 늘 참이다 — 문이 깨지지 않았음을 가리키는 보험일 뿐, 아래 rows 단언이 본체다
    expect(during).toBeGreaterThan(0);
    const copy = new Database(join(result.dir, "dodok.sqlite"), { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    const rows = (copy.prepare("SELECT count(*) AS n FROM probe").get() as { n: number }).n;
    // 백업 시작 뒤·복사 전에 커밋된 행(문이 보장)이 사본에 있다
    expect(rows).toBeGreaterThan(before);
    expect(rows).toBeLessThanOrEqual(after);
    const tables = copy
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
      .all();
    expect(tables).toHaveLength(1);
    copy.close();
  }, 30_000);

  it("백업 디렉터리는 UTC 시각 이름이고 vapid.json 사본을 0600 으로 둔다", async () => {
    makeDb();
    writeFileSync(join(dataDir, "vapid.json"), `{"name":"vapid"}`, { mode: 0o644 });
    // 옛 단일 Gateway 의 디바이스 파일 이름 — 더는 쓰지 않는다
    writeFileSync(join(dataDir, "openclaw-device.json"), "{}");
    writeFileSync(join(dataDir, "other.json"), "{}");

    const r = await runBackup({ dataDir, now: new Date("2026-09-24T01:02:03.456Z") });

    expect(r.dir).toBe(join(backupsRoot(), "2026-09-24T01-02-03-456Z"));
    expect(readdirSync(r.dir).sort()).toEqual(["dodok.sqlite", "vapid.json"]);
    for (const f of readdirSync(r.dir)) expect(mode(join(r.dir, f))).toBe(0o600);
    expect(mode(r.dir)).toBe(0o700);
    expect(mode(backupsRoot())).toBe(0o700);
    expect(r.dbBytes).toBe(statSync(join(r.dir, "dodok.sqlite")).size);
    expect(r.dbBytes).toBeGreaterThan(0);
    expect(r.removed).toEqual([]);
  });

  it("Gateway 마다의 디바이스 디렉터리 DATA_DIR/gateways/ 를 통째로 담는다(멀티 Gateway 스펙 「디바이스 아이덴티티」 절)", async () => {
    makeDb();
    const gw1 = join(dataDir, "gateways", "0f0f0f0f-0000-4000-8000-000000000001");
    const gw2 = join(dataDir, "gateways", "0f0f0f0f-0000-4000-8000-000000000002");
    mkdirSync(gw1, { recursive: true });
    mkdirSync(gw2, { recursive: true });
    writeFileSync(join(gw1, "device.json"), `{"id":"gw1"}`, { mode: 0o644 });
    writeFileSync(join(gw1, "device-tokens.json"), `{"t":"gw1"}`, { mode: 0o644 });
    writeFileSync(join(gw2, "device.json"), `{"id":"gw2"}`, { mode: 0o644 });

    const r = await runBackup({ dataDir });

    const copied = join(r.dir, "gateways");
    expect(readdirSync(copied).sort()).toEqual(readdirSync(join(dataDir, "gateways")).sort());
    for (const [dir, files] of [
      [gw1, ["device-tokens.json", "device.json"]],
      [gw2, ["device.json"]],
    ] as const) {
      const copy = join(copied, dir.split("/").pop() as string);
      expect(readdirSync(copy).sort()).toEqual(files);
      expect(mode(copy)).toBe(0o700);
      for (const f of files) {
        expect(readFileSync(join(copy, f), "utf8")).toBe(readFileSync(join(dir, f), "utf8"));
        expect(mode(join(copy, f))).toBe(0o600);
      }
    }
    expect(mode(copied)).toBe(0o700);
  });

  it("아바타 디렉터리 DATA_DIR/avatars/ 를 통째로 담는다(프로필 스펙 1장)", async () => {
    makeDb();
    const avatars = join(dataDir, "avatars");
    mkdirSync(avatars, { recursive: true });
    const file = `${"a".repeat(64)}.webp`;
    writeFileSync(join(avatars, file), "webp-bytes");
    const r = await runBackup({ dataDir });
    expect(readdirSync(join(r.dir, "avatars"))).toEqual([file]);
    expect(readFileSync(join(r.dir, "avatars", file), "utf8")).toBe("webp-bytes");
  });

  it("Gateway 디렉터리가 없어도 백업한다", async () => {
    makeDb();
    const r = await runBackup({ dataDir });
    expect(readdirSync(r.dir)).toEqual(["dodok.sqlite"]);
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
    let partial = "";
    await expect(runBackup({ dataDir, onPartial: (p) => (partial = p) })).rejects.toThrow();
    expect(partial).toMatch(/\/backups\/\.partial-2\d{3}-/);
    expect(readdirSync(backupsRoot())).toEqual([]);
  });

  it("원본 DB 가 잠겨(SQLITE_BUSY) 복사하지 못하면 chmod ENOENT 가 아니라 그 원인으로 던지고 부분 디렉터리를 남기지 않는다", async () => {
    // 서버 DB 는 WAL 이라 잠겨도 스냅숏을 읽는다 — 롤백 저널 DB 에서 다른 연결이 쓰기 잠금을 쥔 때만 난다
    const holder = new Database(dbPath());
    holder.pragma("journal_mode = DELETE");
    holder.exec("CREATE TABLE t (x)");
    holder.exec("BEGIN EXCLUSIVE");
    try {
      await expect(runBackup({ dataDir })).rejects.toThrow("원본 DB 가 잠겨 복사하지 못했다(SQLITE_BUSY)");
      expect(readdirSync(backupsRoot())).toEqual([]);
    } finally {
      holder.exec("ROLLBACK");
      holder.close();
    }
  }, 20_000);

  it("사본은 .partial-* 에서 만들고 다 된 뒤에 백업 이름으로 옮긴다 — 옮긴 사본이 열린다", async () => {
    makeDb();
    writeFileSync(join(dataDir, "vapid.json"), "{}");
    let during: string[] = [];
    let partial = "";
    const r = await runBackup({
      dataDir,
      now: new Date("2026-09-24T01:02:03.456Z"),
      onPartial: (p) => {
        partial = p;
        during = readdirSync(backupsRoot());
      },
    });
    // 임시 디렉터리를 만든 시점에 백업 이름은 아직 없다
    expect(during).toEqual([partial.slice(backupsRoot().length + 1)]);
    expect(partial).toMatch(/\/\.partial-2026-09-24T01-02-03-456Z-[^/]+$/);
    expect(existsSync(partial)).toBe(false);
    expect(readdirSync(backupsRoot())).toEqual(["2026-09-24T01-02-03-456Z"]);
    expect(mode(r.dir)).toBe(0o700);
    const copy = new Database(join(r.dir, "dodok.sqlite"), { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    copy.close();
  });

  it("중단된 백업(.partial-*)은 보관 개수로 세지도, 이름 충돌로 보지도 않는다", async () => {
    makeDb();
    const at = (h: number) => new Date(Date.UTC(2026, 8, 24, h));
    const a = await runBackup({ dataDir, now: at(0) });
    const b = await runBackup({ dataDir, now: at(1) });
    // 새 백업과 같은 시각 이름의 partial 이 있어도 최종 이름은 접미사 없이 그 시각이다
    const fresh = leavePartial(".partial-2026-09-24T02-00-00-000Z-abc123");
    const c = await runBackup({ dataDir, now: at(2), keep: 2 });

    expect(c.dir).toBe(join(backupsRoot(), "2026-09-24T02-00-00-000Z"));
    expect(c.removed).toEqual([a.dir]);
    expect(c.removedPartials).toEqual([]);
    expect(existsSync(fresh)).toBe(true);
    expect(readdirSync(backupsRoot()).sort()).toEqual(
      [fresh, b.dir, c.dir].map((d) => d.slice(backupsRoot().length + 1)).sort(),
    );
  });

  it("오래된 .partial-* 는 다음 실행이 지우고, 지금 쓰이는 것은 남긴다", async () => {
    makeDb();
    mkdirSync(backupsRoot(), { recursive: true });
    const hour = STALE_PARTIAL_MS;
    const stale = leavePartial(".partial-2026-09-24T00-00-00-000Z-old111", hour + 60_000);
    const fresh = leavePartial(".partial-2026-09-24T00-00-00-000Z-new222", 60_000);
    // 긴 복사 중이면 디렉터리 mtime 은 오래돼도 사본 파일 mtime 이 새롭다
    const copying = leavePartial(".partial-2026-09-24T00-00-00-000Z-cpy333", 3 * hour, 1_000);
    // 한 시간 넘은 진짜 백업은 .partial- 정리 대상이 아니다(보관 개수만 지운다 — 변이 M13)
    const oldBackup = join(backupsRoot(), "2026-09-23T00-00-00-000Z");
    mkdirSync(oldBackup);
    writeFileSync(join(oldBackup, "dodok.sqlite"), "진짜 백업");
    utimesSync(join(oldBackup, "dodok.sqlite"), new Date(0), new Date(0));
    utimesSync(oldBackup, new Date(0), new Date(0));
    // .partial- 로 시작해도 파일은 사람이 둔 것일 수 있다
    writeFileSync(join(backupsRoot(), ".partial-notes"), "x");
    utimesSync(join(backupsRoot(), ".partial-notes"), new Date(0), new Date(0));

    const r = await runBackup({ dataDir });

    expect(r.removedPartials).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(copying)).toBe(true);
    expect(existsSync(join(backupsRoot(), ".partial-notes"))).toBe(true);
    expect(existsSync(join(oldBackup, "dodok.sqlite"))).toBe(true);
    expect(r.removed).toEqual([]);
    expect(existsSync(join(r.dir, "dodok.sqlite"))).toBe(true);
  });

  it("같은 밀리초에 11개를 넘어도 접미사를 수로 정렬해 오래된 것부터 지운다", async () => {
    makeDb();
    const stamp = "2026-09-24T01-02-03-000Z";
    mkdirSync(join(backupsRoot(), stamp), { recursive: true });
    for (let n = 1; n <= 11; n++) mkdirSync(join(backupsRoot(), `${stamp}-${n}`));
    const r = await runBackup({ dataDir, now: new Date("2026-09-24T01:02:03.000Z"), keep: 3 });
    expect(r.dir).toBe(join(backupsRoot(), `${stamp}-12`));
    expect(readdirSync(backupsRoot()).sort()).toEqual([`${stamp}-10`, `${stamp}-11`, `${stamp}-12`]);
  });

  it("백업 이름을 앞뒤로 품은 이름과 백업 이름의 파일은 보관 정리가 건드리지 않는다", async () => {
    makeDb();
    mkdirSync(backupsRoot(), { recursive: true });
    const human = [
      "keep-2026-01-01T00-00-00-000Z",
      "2026-01-01T00-00-00-000Z.bak",
      "2026-01-01T00-00-00-000Z-x",
    ];
    for (const d of human) mkdirSync(join(backupsRoot(), d));
    writeFileSync(join(backupsRoot(), "2026-01-01T00-00-00-001Z"), "파일");
    const r = await runBackup({ dataDir, keep: 1 });
    expect(r.removed).toEqual([]);
    expect(readdirSync(backupsRoot()).sort()).toEqual(
      [...human, "2026-01-01T00-00-00-001Z", r.dir.slice(backupsRoot().length + 1)].sort(),
    );
  });

  it("사본 파일에 WAL·SHM 이 따라가지 않는다(단일 파일)", async () => {
    makeDb();
    // 체크포인트되지 않은 커밋이 WAL 에만 있는 상태에서 백업한다 — 열어 둔 연결이 WAL 을 붙들고 있다
    const live = new Database(dbPath());
    live.pragma("wal_autocheckpoint = 0");
    // 행을 크게 — 마이그레이션이 표를 다시 만들며 남긴 빈 페이지에 다 들어가면 원본 파일 크기가 우연히 사본과 같아진다
    live.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, pad TEXT)");
    live.prepare("INSERT INTO probe (pad) VALUES (?)").run("x".repeat(256 * 1024));
    expect(existsSync(`${dbPath()}-wal`)).toBe(true);

    const r = await runBackup({ dataDir });
    // 닫기 전의 원본 파일에는 WAL 의 커밋이 없어 사본과 크기가 다르다 — dbBytes 는 사본의 크기다
    expect(r.dbBytes).not.toBe(statSync(dbPath()).size);
    live.close();

    expect(readdirSync(r.dir)).toEqual(["dodok.sqlite"]);
    expect(r.dbBytes).toBe(statSync(join(r.dir, "dodok.sqlite")).size);
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

  it("오래된 .partial-* 를 지우면 한 줄에 그 수를 덧붙인다", () => {
    makeDb();
    mkdirSync(backupsRoot(), { recursive: true });
    leavePartial(".partial-2026-09-24T00-00-00-000Z-old111", 2 * STALE_PARTIAL_MS);
    const r = cli([], { DATA_DIR: dataDir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ \(\d+ bytes, \d+ ms, 지움 0, 중단된 것 지움 1\)\n$/);
    expect(partials()).toEqual([]);
  }, 20_000);

  /**
   * 자식(backup-main.ts)을 정해진 단계에 세우는 문 — 단계에 닿으면 fd 3 에 그 이름 한 줄을 쓰고, 테스트가 한 바이트를 돌려줄 때까지
   * 동기로 기다린다. 그 사이에 보낸 신호는 처리기가 돌지 못하고 쌓였다가 자식이 다시 이벤트 루프로 돌아갈 때 닿는다 — 신호가 닿는
   * 단계를 파일 존재 폴링이 아니라 자식이 정한다. 운영 코드는 건드리지 않는다(--import 로 fs 를 감싼다)
   * - partial: 임시 디렉터리(.partial-*)를 만든 직후 — 복사 전
   * - copied: 사본을 다 쓴 직후의 첫 chmod — 동기 복사 구간(복사 도중 닿은 신호와 같다 — 이벤트 루프로 돌아가지 않고 끝까지 간다)
   */
  const GATE_PRELOAD = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const gateAt = process.env.DODOK_TEST_BACKUP_GATE;
    const gate = (name) => {
      if (name !== gateAt) return;
      fs.writeSync(3, name + "\\n");
      const buf = Buffer.alloc(1);
      for (;;) {
        try {
          if (fs.readSync(3, buf, 0, 1, null) === 1) return;
        } catch (err) {
          if (err.code !== "EAGAIN") throw err;
        }
      }
    };
    const mkdtempSync = fs.mkdtempSync;
    fs.mkdtempSync = (...args) => {
      const dir = mkdtempSync(...args);
      if (dir.includes(".partial-")) gate("partial");
      return dir;
    };
    const chmodSync = fs.chmodSync;
    let copied = false;
    fs.chmodSync = (path, mode) => {
      chmodSync(path, mode);
      if (!copied && String(path).includes(".partial-") && String(path).endsWith("dodok.sqlite")) {
        copied = true;
        gate("copied");
      }
    };
    syncBuiltinESMExports();
  `;

  /** 백업 CLI 를 gate 단계에 세우고 거기서 sig 를 보낸 뒤 놓아준다 */
  async function signalAt(gate: "partial" | "copied", sig: NodeJS.Signals) {
    makeDb();
    const child = spawn(
      process.execPath,
      [
        "--import",
        `data:text/javascript,${encodeURIComponent(GATE_PRELOAD)}`,
        "--import",
        "tsx",
        "src/backup-main.ts",
      ],
      {
        cwd: serverDir,
        env: { PATH: process.env.PATH, DATA_DIR: dataDir, DODOK_TEST_BACKUP_GATE: gate },
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let reached = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const control = child.stdio[3] as import("node:net").Socket;
    control.on("data", (d) => {
      reached += String(d);
      // 자식이 그 단계에 서 있다 — 신호를 보내고 놓아준다
      child.kill(sig);
      control.write("g");
    });
    const [status, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((r) =>
      child.once("exit", (c, s) => r([c, s])),
    );
    return { status, signal, stdout, stderr, reached: reached.trim() };
  }

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "복사 전에 %s 를 받으면 .partial-* 를 지우고 exit %i",
    async (sig, code) => {
      const r = await signalAt("partial", sig);
      expect(r.reached).toBe("partial"); // 신호가 실제로 그 단계에서 갔다
      expect(r.signal).toBeNull();
      expect(r.status).toBe(code);
      expect(r.stderr).toBe(`백업 중단: ${sig}\n`);
      expect(r.stdout).toBe("");
      expect(readdirSync(backupsRoot())).toEqual([]);
    },
    30_000,
  );

  it.each(["SIGINT", "SIGTERM"] as const)(
    "복사 중(동기 구간)에 %s 를 받으면 끝까지 복사하고 exit 0 — .partial-* 없이 온전한 사본 하나",
    async (sig) => {
      const r = await signalAt("copied", sig);
      expect(r.reached).toBe("copied");
      expect(r.signal).toBeNull();
      // 신호가 동기 복사 도중에 닿았다 — 처리기는 돌지 못하고 복사가 끝난다(backup-main.ts 주석)
      expect(r.status).toBe(0);
      expect(r.stderr).toBe("");
      expect(r.stdout).toMatch(/^백업 완료: /);
      expect(partials()).toEqual([]);
      const [d, ...rest] = readdirSync(backupsRoot());
      expect(rest).toEqual([]);
      const copy = new Database(join(backupsRoot(), d!, "dodok.sqlite"), { readonly: true });
      expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      copy.close();
    },
    30_000,
  );

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
