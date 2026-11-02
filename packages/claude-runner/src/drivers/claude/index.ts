import { Id } from "@dodok/shared";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProgramDriver } from "../../driver";
import { CLAUDE_CODE_LABEL, type ClaudeRunSpec, runOnce } from "./run";
import type { SdkPort } from "./sdk";

// Claude Code 드라이버 — Claude Agent SDK 로 번들 CLI 를 띄운다(런 하나 = query() 하나). 동작은 Claude 러너 스펙
// 「구현과 맞춘 것」 장 그대로이고, 이 파일은 드라이버 계약에 맞춰 묶기만 한다

export type ClaudeDriverOptions = {
  sdk: SdkPort;
  /** 번들 CLI 판본 — 빌드가 굽는다(main.ts) */
  claudeCodeVersion: string;
  baseEnv?: NodeJS.ProcessEnv;
  closeGraceMs?: number;
  /** 세션을 연 길(새로·resume·거절 뒤 resume)을 남기는 줄 */
  logger?: { info(msg: string): void };
};

export function createClaudeDriver(opts: ClaudeDriverOptions): ProgramDriver {
  // 세션별 마지막 누적 비용 — 드라이버(러너 프로세스) 메모리에만 있다
  const costs = new Map<string, number>();
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
    // CLI 는 SDK 에 함께 깔려 늘 있다. 로그인 자격 증명은 읽지 않는다 — 로그인 디렉터리가 없을 때만 missing, 그 밖은 unknown
    // (로그인 여부는 첫 런의 PROVIDER_AUTH 로 안다)
    async detect(ceiling) {
      return existsSync(ceiling.configDir ?? join(homedir(), ".claude"))
        ? { available: true, version: opts.claudeCodeVersion, auth: "unknown" }
        : {
            available: true,
            version: opts.claudeCodeVersion,
            auth: "missing",
            reason: "로그인 디렉터리가 없습니다 — 러너 머신에서 그 디렉터리로 claude /login 하세요",
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
      await runOnce(claudeSpec, {
        sdk: opts.sdk,
        sink,
        baseEnv: opts.baseEnv ?? process.env,
        costs,
        signal,
        ...(opts.closeGraceMs === undefined ? {} : { closeGraceMs: opts.closeGraceMs }),
        ...(opts.logger ? { log: (line: string) => opts.logger?.info(line) } : {}),
      });
    },
  };
}
