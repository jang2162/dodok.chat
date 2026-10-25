import { dodokSessionKey, RunnerRunStart } from "@dodok/shared";
import type { ResolvedAgent } from "../../src/config";

export const RUN_ID = "0192f000-0000-7000-8000-00000000a001";
export const CHANNEL_ID = "0192f000-0000-7000-8000-00000000c001";
export const SESSION_ID = "0192f000-0000-4000-8000-00000000e001";

export const AGENT: ResolvedAgent = {
  id: "coder",
  name: "코더",
  workdir: "/home/u/src/my-repo",
  workdirLabel: "my-repo",
  model: "sonnet",
  permissionMode: "default",
  allowedTools: ["Read", "Bash(git status)"],
  disallowedTools: ["WebFetch"],
};

export function runStart(
  overrides: { runId?: string; agentId?: string; sessionId?: string } = {},
): RunnerRunStart {
  const agentId = overrides.agentId ?? AGENT.id;
  return RunnerRunStart.parse({
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
  });
}
