/** 실행 모드(스펙 2.1) — 소스(tsx·vitest)와 운영 번들(esbuild, dist/main.js)의 차이를 한곳에 둔다 */
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

declare const __DODOK_BUNDLED__: boolean | undefined;

export function isBundled(): boolean {
  return typeof __DODOK_BUNDLED__ !== "undefined" && __DODOK_BUNDLED__ === true;
}

/** drizzle 마이그레이션 폴더. 번들에서는 import.meta.url 기준 상대 경로가 바뀌므로 이미지가 DODOK_MIGRATIONS_DIR 를 준다 */
export function migrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.DODOK_MIGRATIONS_DIR;
  if (fromEnv) return fromEnv;
  return fileURLToPath(new URL("../drizzle", import.meta.url));
}

export type UnwritablePath = { path: string; code: string };

/**
 * 부팅 전에 데이터 자리에 쓸 수 있는지 — 못 쓰는 첫 경로, 다 되면 null. 없는 DATA_DIR 은 만든다.
 * 까닭: 비루트 컨테이너(node, 1000)에 root 소유 볼륨(옛 root 이미지가 파일을 만든 것)이 붙으면 better-sqlite3 가
 * 「unable to open database file」과 여러 줄 스택으로 죽어 권한 문제로 안 읽힌다(스펙 5장 「볼륨 권한」).
 * 빈 볼륨은 Docker 가 첫 마운트 때 이미지의 /data 소유자를 입혀 이 경우가 안 생긴다 — 파일이 이미 든 볼륨에서만 난다
 */
export function unwritableDataPath(paths: {
  dataDir: string;
  dbPath: string;
  attachmentsDir: string;
}): UnwritablePath | null {
  const code = (e: unknown) => (e as NodeJS.ErrnoException).code ?? String(e);
  try {
    mkdirSync(paths.dataDir, { recursive: true });
  } catch (e) {
    return { path: paths.dataDir, code: code(e) };
  }
  const db =
    paths.dbPath === ":memory:"
      ? []
      : [dirname(paths.dbPath), paths.dbPath, `${paths.dbPath}-wal`, `${paths.dbPath}-shm`];
  for (const path of [paths.dataDir, ...db, paths.attachmentsDir]) {
    if (!existsSync(path)) continue;
    try {
      accessSync(path, constants.W_OK);
    } catch (e) {
      return { path, code: code(e) };
    }
  }
  return null;
}

export function dataDirErrorMessage(u: UnwritablePath): string {
  return (
    `설정 오류: DATA_DIR 에 쓸 수 없다: ${u.path} (${u.code}) — 컨테이너면 볼륨 소유자를 1000:1000 으로: ` +
    "docker compose run --rm -u 0 app chown -R 1000:1000 /data"
  );
}
