/**
 * 서버가 품은 러너 tgz(러너 스펙 5장 「같은 빌드」) — 플러그인 tgz(setup/plugin-file.ts)와 같은 방식. 부팅 때 한 번 찾아
 * 파일 sha256·크기와 **안의 번들**(`package/dist/main.js`) sha256 을 잰다 — 러너가 hello 로 보내는 bundleSha256 과 비교하는 값이다
 */
import { fileURLToPath } from "node:url";
import { isBundled } from "../../runtime";
import { type PluginFile, readBundledTgz } from "../setup/plugin-file";

/** pnpm pack 이 만든 러너 tgz 안의 번들 경로(packages/claude-runner 의 bin) */
export const RUNNER_BUNDLE_ENTRY = "package/dist/main.js";

export type RunnerFile = PluginFile;

/** 후보 디렉터리에서 처음 찾은 러너 tgz. 없거나 안에 번들이 없으면 null — 연결 페이지가 받기 대신 만드는 법을 보인다 */
export function readRunnerFile(candidates: string[]): RunnerFile | null {
  return readBundledTgz(candidates, RUNNER_BUNDLE_ENTRY);
}

/** 러너 tgz 를 찾을 곳 — DODOK_RUNNER_DIR(이미지가 /app/runner), 소스 실행이면 저장소의 러너 dist(pack:runner) */
export function runnerDirCandidates(
  env: { DODOK_RUNNER_DIR?: string | undefined },
  bundled = isBundled(),
): string[] {
  const dirs = env.DODOK_RUNNER_DIR ? [env.DODOK_RUNNER_DIR] : [];
  // 번들에서는 import.meta.url 기준 상대 경로가 저장소를 가리키지 않는다
  if (!bundled)
    dirs.push(fileURLToPath(new URL("../../../../../packages/claude-runner/dist", import.meta.url)));
  return dirs;
}
