import type { RunnerProgramLogin } from "@dodok/shared";
import { isAbsolute, resolve } from "node:path";
import type { ProgramCeiling } from "../../config";

// 러너 프로세스(SDK 세션 도우미 getSessionInfo)와 CLI 는 CLAUDE_CONFIG_DIR 을 각자 읽는다 — 둘이 갈리면 새 세션/resume 판정이
// 틀리므로 둘 다 없거나 같은 값이어야 한다(ADR 0007 5.2).
// 번들 CLI 는 CLAUDE_CONFIG_DIR 이 있기만 하면 값과 무관하게 키체인 이름에 경로 해시를 붙인다 — 평소 로그인을 쓰려면 아예 넣지 않는다

type ConfigDirCeiling = Pick<ProgramCeiling, "configDir">;

/** 유효 설정 자리 — configDir 을 적었으면 전용, 아니면 평소(셸의 CLAUDE_CONFIG_DIR, 없으면 ~/.claude 라 dir 없음) */
export function resolveClaudeConfigDir(
  ceiling: ConfigDirCeiling,
  env: NodeJS.ProcessEnv,
): { login: RunnerProgramLogin; dir: string | undefined } {
  if (ceiling.configDir !== undefined) return { login: "dedicated", dir: ceiling.configDir };
  return { login: "default", dir: env.CLAUDE_CONFIG_DIR || undefined };
}

/**
 * 러너 프로세스 env 를 유효 자리에 맞춘다 — 빈 값은 지운다(SDK 도우미가 빈 값을 경로로 쓰지 않게). 셸의 상대 경로는 러너 cwd 기준
 * 절대 경로로 굳힌다 — CLI 는 프로젝트 workdir 을 cwd 로 돌아 같은 글자를 다른 디렉터리로 풀기 때문이다(run.ts 는 이 env 를 읽는다).
 * 절대 경로는 글자 그대로 둔다 — CLI 가 키체인 이름에 그 값의 해시를 붙이므로 정규화(끝 / 제거 등)하면 사람이 로그인한 항목과 갈린다.
 * ceiling 이 없으면 claude 가 꺼져 있다
 */
export function applyClaudeConfigDirEnv(
  env: NodeJS.ProcessEnv,
  ceiling: ConfigDirCeiling | undefined,
  cwd: string = process.cwd(),
): void {
  if (!ceiling) return;
  const { dir } = resolveClaudeConfigDir(ceiling, env);
  if (dir === undefined) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = isAbsolute(dir) ? dir : resolve(cwd, dir);
}
