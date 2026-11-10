import { execFile } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { RunnerProgramCli } from "@dodok/shared";
import type { ProgramCeiling } from "../../config";
import { ENV_ALLOWLIST } from "./run";

// 러너가 띄울 Claude Code 실행 파일 — 설정 programs.claude.executable, 없으면 러너 PATH 의 claude, 그것도 없으면 SDK 번들 CLI.
// 사람이 적은 경로가 없거나 실행할 수 없으면 번들로 돌아가지 않는다 — 명시한 것을 조용히 바꾸지 않게 그 프로그램을 못 쓴다고 낸다

export type ClaudeExecutable =
  | { cli: Extract<RunnerProgramCli, "installed">; path: string }
  | { cli: Extract<RunnerProgramCli, "bundled"> }
  | { cli: "unusable"; reason: string };

/** 실행할 수 있는 일반 파일이면 참 — 디렉터리·없는 파일·x 비트 없는 파일은 거짓 */
export type IsExecutable = (path: string) => boolean;

export const isExecutableFile: IsExecutable = (path) => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** 러너 PATH 에서 처음 찾은 claude — 상대 경로·빈 항목은 건너뛴다(러너 cwd 에 따라 다른 파일을 고르지 않게) */
export function findOnPath(
  name: string,
  pathEnv: string | undefined,
  isExecutable: IsExecutable,
): string | undefined {
  for (const dir of (pathEnv ?? "").split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export function resolveClaudeExecutable(
  ceiling: Pick<ProgramCeiling, "executable">,
  env: NodeJS.ProcessEnv,
  isExecutable: IsExecutable = isExecutableFile,
): ClaudeExecutable {
  if (ceiling.executable !== undefined) {
    if (isExecutable(ceiling.executable)) return { cli: "installed", path: ceiling.executable };
    // 사유에 경로 원문을 싣지 않는다 — hello 로 서버에 간다
    return {
      cli: "unusable",
      reason:
        "설정의 executable 이 없거나 실행할 수 없습니다 — 러너 설정의 programs.claude.executable 을 확인하세요",
    };
  }
  const found = findOnPath("claude", env.PATH, isExecutable);
  return found === undefined ? { cli: "bundled" } : { cli: "installed", path: found };
}

/** `--version` 을 부르는 시간 제한 */
export const VERSION_TIMEOUT_MS = 5000;

/** `2.1.322 (Claude Code)` 꼴의 앞 semver. 못 읽으면 undefined */
export function parseClaudeVersion(output: string): string | undefined {
  const m = /^\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(output);
  return m && m[1]!.length <= 64 ? m[1] : undefined;
}

export type ReadVersion = (path: string, env: NodeJS.ProcessEnv) => Promise<string | undefined>;

/** 고른 실행 파일의 판본 — 러너 env 허용 목록만 넘긴다. 실패·시간 초과·못 읽음은 undefined(실행은 그대로 한다) */
export const readClaudeVersion: ReadVersion = (path, baseEnv) => {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = baseEnv[key];
    if (value !== undefined) env[key] = value;
  }
  return new Promise((resolve) => {
    execFile(
      path,
      ["--version"],
      { env, timeout: VERSION_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? undefined : parseClaudeVersion(String(stdout))),
    );
  });
};
