/** 온라인 백업(스펙 3.2). 서버를 멈추지 않는다 — 운영에서는 별도 프로세스(dist/backup.js)로 돈다. 복원은 절차다(스펙 3.3) */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

// 디바이스 아이덴티티는 dev Gateway 면 -dev 접미사가 붙는다(config.ts deviceIdentityPath)
const SIDE_FILES = ["vapid.json", "openclaw-device.json", "openclaw-device-dev.json"];
// 이 이름만 보관 개수로 세고 지운다 — 사람이 backups/ 에 둔 다른 것은 건드리지 않는다
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;

export interface BackupResult {
  dir: string;
  dbBytes: number;
  ms: number;
  /** 보관 개수를 넘쳐 지운 백업 디렉터리의 전체 경로 */
  removed: string[];
}

export async function runBackup(opts: {
  dataDir: string;
  dbPath?: string;
  keep?: number;
  now?: Date;
}): Promise<BackupResult> {
  const started = Date.now();
  const dbPath = opts.dbPath ?? join(opts.dataDir, "dodok.sqlite");
  if (!existsSync(dbPath)) throw new Error(`백업할 DB 가 없다: ${dbPath}`);
  const root = join(opts.dataDir, "backups");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  let dir = join(root, stamp);
  for (let n = 1; existsSync(dir); n++) dir = join(root, `${stamp}-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  const dest = join(dir, "dodok.sqlite");
  try {
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // 한 단계에 전부 복사한다 — 한 읽기 트랜잭션의 스냅숏이라 쓰기와 겹쳐도 온전하다.
      // 기본(단계당 100 페이지)이면 단계 사이에 다른 연결이 쓸 때마다 SQLite 가 처음부터 다시 시작해,
      // 쓰기가 이어지는 동안 끝나지 않는다(backup.test 「쓰는 중에도」가 30초 안에 못 끝냈다).
      // 이 프로세스의 이벤트 루프가 그동안 막히지만 서버와 다른 프로세스라 상관없다
      await src.backup(dest, { progress: () => 0x7fffffff });
    } finally {
      src.close();
    }
    chmodSync(dest, 0o600);
    for (const f of SIDE_FILES) {
      const p = join(opts.dataDir, f);
      if (existsSync(p)) {
        copyFileSync(p, join(dir, f));
        chmodSync(join(dir, f), 0o600);
      }
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  // 방금 만든 것은 후보에서 뺀다 — 시계가 거꾸로 가 이름이 가장 이르더라도 지우지 않게
  const keep = opts.keep ?? 7;
  const older = readdirSync(root)
    .filter((d) => BACKUP_NAME.test(d) && join(root, d) !== dir)
    .filter((d) => statSync(join(root, d)).isDirectory())
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const removed = older.slice(0, Math.max(0, older.length - (keep - 1))).map((d) => join(root, d));
  for (const d of removed) rmSync(d, { recursive: true, force: true });
  return { dir, dbBytes: statSync(dest).size, ms: Date.now() - started, removed };
}
