/** 온라인 백업(스펙 3.2). 서버를 멈추지 않는다 — 운영에서는 별도 프로세스(dist/backup.js)로 돈다. 복원은 절차다(스펙 3.3) */
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

const SIDE_FILES = ["vapid.json"];
// Gateway 마다 디바이스 아이덴티티·디바이스 토큰 디렉터리(멀티 Gateway 스펙 「디바이스 아이덴티티」 절) — 통째로 담는다. 빠지면 복원 뒤 Gateway 마다 다시
// 페어링해야 한다
const SIDE_DIRS = ["gateways"];
// 이 이름만 보관 개수로 세고 지운다 — 사람이 backups/ 에 둔 다른 것은 건드리지 않는다
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(-\d+)?$/;
// 백업은 이 접두어의 임시 디렉터리에서 만들고 다 된 뒤에 rename 한다 — 신호·SIGKILL 로 중단돼도
// 백업 이름으로 남지 않아 보관 개수를 차지하거나 「가장 최근 백업」으로 복원되지 않는다
const PARTIAL = ".partial-";
// 이보다 오래 손대지 않은 .partial-* 만 지운다 — 동시에 도는 다른 백업의 것은 지우지 않게.
// 복사는 1 GB DB 에 1초 남짓이라(쓰는 중인 DB 에 node dist/backup.js 로 잼) 한 시간이면 넉넉하다
export const STALE_PARTIAL_MS = 60 * 60 * 1000;

export interface BackupResult {
  dir: string;
  dbBytes: number;
  ms: number;
  /** 보관 개수를 넘쳐 지운 백업 디렉터리의 전체 경로 */
  removed: string[];
  /** 중단된 백업이 남긴 오래된 .partial-* 중 지운 것의 전체 경로 */
  removedPartials: string[];
}

export async function runBackup(opts: {
  dataDir: string;
  dbPath?: string;
  keep?: number;
  now?: Date;
  /** 임시 디렉터리를 만든 직후에 부른다 — CLI 가 신호를 받으면 이 경로를 지운다 */
  onPartial?: (partialDir: string) => void;
}): Promise<BackupResult> {
  const started = Date.now();
  const dbPath = opts.dbPath ?? join(opts.dataDir, "dodok.sqlite");
  if (!existsSync(dbPath)) throw new Error(`백업할 DB 가 없다: ${dbPath}`);
  const root = join(opts.dataDir, "backups");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const removedPartials = removeStalePartials(root);
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const tmp = mkdtempSync(join(root, `${PARTIAL}${stamp}-`));
  opts.onPartial?.(tmp);
  let dir: string;
  let dbBytes: number;
  try {
    const tmpDb = join(tmp, "dodok.sqlite");
    const src = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // 한 단계에 전부 복사한다 — 한 읽기 트랜잭션의 스냅숏이라 쓰기와 겹쳐도 온전하다.
      // 기본(단계당 100 페이지)이면 단계 사이에 다른 연결이 쓸 때마다 SQLite 가 처음부터 다시 시작해,
      // 쓰기가 이어지는 동안 끝나지 않는다(backup.test 「쓰는 중에도」가 30초 안에 못 끝냈다).
      // 이 프로세스의 이벤트 루프가 그동안 막히지만 서버와 다른 프로세스라 상관없다
      await src.backup(tmpDb, { progress: () => 0x7fffffff });
    } finally {
      src.close();
    }
    // 원본이 잠겨(SQLITE_BUSY — 롤백 저널 DB 에서 다른 연결이 쓰기 잠금을 쥠) 첫 단계가 실패하면 better-sqlite3 는 「완료」로
    // resolve 하고 close() 가 사본을 지운다 — 뒤따른 chmod 의 ENOENT 대신 원인을 낸다
    if (!existsSync(tmpDb)) throw new Error("원본 DB 가 잠겨 복사하지 못했다(SQLITE_BUSY)");
    chmodSync(tmpDb, 0o600);
    dbBytes = statSync(tmpDb).size;
    for (const f of SIDE_FILES) {
      const p = join(opts.dataDir, f);
      if (existsSync(p)) {
        copyFileSync(p, join(tmp, f));
        chmodSync(join(tmp, f), 0o600);
      }
    }
    for (const d of SIDE_DIRS) {
      const p = join(opts.dataDir, d);
      if (existsSync(p)) copyPrivateTree(p, join(tmp, d));
    }
    dir = join(root, stamp);
    for (let n = 1; existsSync(dir); n++) dir = join(root, `${stamp}-${n}`);
    renameSync(tmp, dir);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
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
  return { dir, dbBytes, ms: Date.now() - started, removed, removedPartials };
}

/** 디렉터리를 통째로 복사하고 사본을 주인만 읽게(디렉터리 0700·파일 0600) 둔다 */
function copyPrivateTree(from: string, to: string): void {
  cpSync(from, to, { recursive: true });
  const walk = (p: string) => {
    if (statSync(p).isDirectory()) {
      chmodSync(p, 0o700);
      for (const f of readdirSync(p)) walk(join(p, f));
    } else chmodSync(p, 0o600);
  };
  walk(to);
}

/** 디렉터리와 그 안 파일의 mtime 이 모두 STALE_PARTIAL_MS 보다 오래된 .partial-* 를 지운다.
 * 안 파일까지 보는 것은 복사 중에는 디렉터리 mtime 이 아니라 사본 파일 mtime 만 바뀌기 때문이다 */
function removeStalePartials(root: string): string[] {
  const cutoff = Date.now() - STALE_PARTIAL_MS;
  const stale = readdirSync(root)
    .filter((d) => d.startsWith(PARTIAL))
    .map((d) => join(root, d))
    .filter((p) => {
      try {
        const st = statSync(p);
        if (!st.isDirectory()) return false;
        const newest = readdirSync(p).reduce((m, f) => Math.max(m, statSync(join(p, f)).mtimeMs), st.mtimeMs);
        return newest < cutoff;
      } catch {
        // 도중에 다른 백업이 rename·삭제한 것 — 이미 없으니 건너뛴다
        return false;
      }
    });
  for (const p of stale) rmSync(p, { recursive: true, force: true });
  return stale;
}
