import { Id } from "@dodok/shared";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProgramDriver } from "../../driver";
import { resolveClaudeConfigDir } from "./config-dir";
import {
  type ClaudeExecutable,
  type IsExecutable,
  isExecutableFile,
  type ReadVersion,
  readClaudeVersion,
  resolveClaudeExecutable,
} from "./executable";
import { CLAUDE_CODE_LABEL, type ClaudeRunSpec, runOnce } from "./run";
import type { SdkPort } from "./sdk";

// Claude Code 드라이버 — Claude Agent SDK 로 머신에 설치된 claude(없으면 SDK 번들 CLI)를 띄운다(런 하나 = query() 하나). 동작은 Claude 러너 스펙
// 「구현과 맞춘 것」 장 그대로이고, 이 파일은 드라이버 계약에 맞춰 묶기만 한다

export type ClaudeDriverOptions = {
  sdk: SdkPort;
  /** 번들 CLI 판본 — 빌드가 굽는다(main.ts). 설치본을 고르면 그 실행 파일의 --version 을 쓴다 */
  claudeCodeVersion: string;
  /** 시험이 바꿔 끼운다 — 기본은 실제 파일 검사·`--version` 실행 */
  isExecutable?: IsExecutable;
  readVersion?: ReadVersion;
  baseEnv?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  /** 세션을 연 길(새로·resume·거절 뒤 resume)을 남기는 줄 */
  logger?: { info(msg: string): void };
};

export function createClaudeDriver(opts: ClaudeDriverOptions): ProgramDriver {
  // 세션별 마지막 누적 비용 — 드라이버(러너 프로세스) 메모리에만 있다
  const costs = new Map<string, number>();
  const isExecutable = opts.isExecutable ?? isExecutableFile;
  const readVersion = opts.readVersion ?? readClaudeVersion;
  // 마지막 detect(연결마다 — hello 직전)가 고른 실행 파일. 런은 이 값을 쓴다 — 화면에 보인 판본과 실제로 띄우는 CLI 가 같게.
  // 천장 검사가 detect 의 available 을 보므로 detect 전에 런이 오지 않지만, 오면 그 자리에서 고른다
  let chosen: ClaudeExecutable | undefined;
  // 고른 CLI 가 바뀔 때만 한 줄 — 경로는 찍지 않는다(로그를 남에게 보여 줄 수 있다)
  let lastChoice = "";
  return {
    program: "claude",
    label: CLAUDE_CODE_LABEL,
    capabilities: {
      serverSessionIds: true,
      approvals: true,
      images: true,
      interrupt: true,
      mcpTools: true,
      costs: true,
    },
    // 실행 파일은 설정 executable → 러너 PATH 의 claude → SDK 번들 CLI 차례로 고른다(executable.ts). 로그인 자격 증명은 읽지 않는다 — 유효 설정 자리(전용이면 configDir, 평소면 셸의
    // CLAUDE_CONFIG_DIR 또는 HOME/.claude)의 디렉터리가 없을 때만 missing, 그 밖은 unknown(로그인 여부는 첫 런의 PROVIDER_AUTH 로 안다).
    // 사유에는 경로 원문을 싣지 않는다
    async detect(ceiling) {
      const env = opts.baseEnv ?? process.env;
      const { login, dir } = resolveClaudeConfigDir(ceiling, env);
      chosen = resolveClaudeExecutable(ceiling, env, isExecutable);
      if (chosen.cli === "unusable")
        return { available: false, auth: "unknown", login, reason: chosen.reason };
      // 설치본 판본을 못 읽으면 비운다 — 실행은 그대로 한다
      const version =
        chosen.cli === "installed" ? await readVersion(chosen.path, env) : opts.claudeCodeVersion;
      const choice = `${chosen.cli === "installed" ? "설치본" : "내장"} ${version ?? "(판 모름)"}`;
      if (choice !== lastChoice) opts.logger?.info(`dodok-runner: Claude Code ${choice}`);
      lastChoice = choice;
      const base = {
        available: true,
        ...(version === undefined ? {} : { version }),
        login,
        cli: chosen.cli,
      } as const;
      if (existsSync(dir ?? join(env.HOME || homedir(), ".claude"))) return { ...base, auth: "unknown" };
      return {
        ...base,
        auth: "missing",
        reason:
          login === "dedicated"
            ? "로그인 디렉터리가 없습니다 — 러너 머신에서 그 디렉터리로 claude /login 하세요"
            : "Claude Code 로그인 디렉터리가 없습니다 — 러너 머신에서 claude 로 /login 하세요",
      };
    },
    async startRun(spec, sink, signal) {
      // 계약은 프로그램이 지은 세션 id(run.session)도 받으려고 글자 하나 이상만 본다 — Claude 는 서버가 정한 UUID 만 연다
      const sessionId = spec.start.providerSessionId;
      if (sessionId === undefined || !Id.safeParse(sessionId).success) {
        sink.error("VALIDATION", "Claude Code 런에는 서버가 정한 세션 id 가 필요합니다");
        return;
      }
      const claudeSpec: ClaudeRunSpec = { ...spec, start: { ...spec.start, providerSessionId: sessionId } };
      const env = opts.baseEnv ?? process.env;
      // detect 전이면 설정의 executable 을 모른다 — PATH·번들만 본다. 못 쓰는 실행 파일이면 천장 검사가 이미 런을 막는다
      const exe = chosen ?? resolveClaudeExecutable({}, env, isExecutable);
      if (exe.cli === "unusable") {
        sink.error("INTERNAL", exe.reason);
        return;
      }
      await runOnce(claudeSpec, {
        sdk: opts.sdk,
        sink,
        baseEnv: env,
        ...(exe.cli === "installed" ? { executable: exe.path } : {}),
        costs,
        signal,
        ...(opts.closeGraceMs === undefined ? {} : { closeGraceMs: opts.closeGraceMs }),
        ...(opts.logger ? { log: (line: string) => opts.logger?.info(line) } : {}),
      });
    },
  };
}
