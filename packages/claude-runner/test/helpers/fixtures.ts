import { dodokSessionKey, type RunnerRunAgent, RunnerRunStartV2 } from "@dodok/shared";
import type { ClaudeRunSpec } from "../../src/drivers/claude/run";

export const RUN_ID = "0192f000-0000-7000-8000-00000000a001";
export const CHANNEL_ID = "0192f000-0000-7000-8000-00000000c001";
export const SESSION_ID = "0192f000-0000-4000-8000-00000000e001";

/** 런 하나의 에이전트 — id 는 run.start.deliver.agentId, 나머지는 천장 검사를 지난 RunSpec 의 값 */
export const AGENT = {
  id: "coder",
  workdir: "/home/u/src/my-repo",
  configDir: "/home/u/.dodok-runner/claude",
  model: "sonnet",
  permissionMode: "default",
  allowedTools: ["Read", "Bash(git status)"],
  disallowedTools: ["WebFetch"],
} as const satisfies Omit<ClaudeRunSpec, "start"> & { id: string };

/** 서버가 run.start 에 싣는 에이전트 정의 — 루트 src 의 my-repo */
export const RUN_AGENT: RunnerRunAgent = {
  program: "claude",
  project: { rootId: "src", relPath: "my-repo" },
  model: AGENT.model,
  permissionMode: AGENT.permissionMode,
  allowedTools: [...AGENT.allowedTools],
  disallowedTools: [...AGENT.disallowedTools],
};

export function runStart(
  overrides: { runId?: string; agentId?: string; sessionId?: string; agent?: Partial<RunnerRunAgent> } = {},
): RunnerRunStartV2 {
  const agentId = overrides.agentId ?? AGENT.id;
  return RunnerRunStartV2.parse({
    deliver: {
      deliveryId: "0192f000-0000-7000-8000-00000000d001",
      kind: "message",
      channelId: CHANNEL_ID,
      conversationId: CHANNEL_ID,
      conversationTitle: "배포 점검",
      agentId,
      sessionKey: dodokSessionKey(agentId, CHANNEL_ID),
      runId: overrides.runId ?? RUN_ID,
      message: {
        id: "0192f000-0000-7000-8000-00000000b001",
        author: { type: "user", handle: "mia", displayName: "Mia" },
        text: "@coder 테스트 돌려 줘",
        attachments: [],
        ts: "2026-09-27T01:02:03.000Z",
      },
      context: {
        recentMessages: [],
        participants: [
          { type: "user", handle: "mia", displayName: "Mia", isSelf: false },
          { type: "agent", handle: "coder", displayName: "코더", isSelf: true },
        ],
        relayRules: "릴레이 규칙",
      },
    },
    providerSessionId: overrides.sessionId ?? SESSION_ID,
    channelRulesAppend: '# dodok channel settings\n<channel-rules channel="#dev">\n규칙\n</channel-rules>',
    turnFacts: "[dodok context] 이 턴의 사실",
    sessionTitle: "dev · 코더",
    agent: { ...RUN_AGENT, ...overrides.agent },
  });
}

/** claude 드라이버가 받는 런 — runStart 에 천장 검사가 푼 값(작업 디렉터리·로그인 디렉터리)을 더한 것 */
export function runSpec(
  overrides: { runId?: string; sessionId?: string } & Partial<Omit<ClaudeRunSpec, "start">> = {},
): ClaudeRunSpec {
  const { runId, sessionId, ...fields } = overrides;
  const start = runStart({
    ...(runId === undefined ? {} : { runId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
  return {
    start: { ...start, providerSessionId: start.providerSessionId! },
    workdir: AGENT.workdir,
    configDir: AGENT.configDir,
    model: AGENT.model,
    permissionMode: AGENT.permissionMode,
    allowedTools: [...AGENT.allowedTools],
    disallowedTools: [...AGENT.disallowedTools],
    ...fields,
  };
}
