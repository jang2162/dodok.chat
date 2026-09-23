/** 실행 모드(스펙 2.1) — 소스(tsx·vitest)와 운영 번들(esbuild, dist/main.js)의 차이를 한곳에 둔다 */
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
