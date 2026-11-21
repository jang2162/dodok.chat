import {
  type Agent,
  type AgentCommand,
  type AgentCommandsResponse,
  checkCommand,
  type CommandVerdict,
  parseAgentCommand,
  skillAliasesOf,
} from "@dodok/shared";
import type { JSONContent } from "@tiptap/core";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { NEW_CONVERSATION } from "@/features/messages/timeline";

/** 에이전트별 명령 목록(에이전트 명령 스펙 5.2) — 자동완성 도움말일 뿐 허용 목록이 아니다(C5) */
export const agentCommandsKeys = {
  of: (channelId: string, conversationId: string) => ["agentCommands", channelId, conversationId] as const,
  all: ["agentCommands"] as const,
};

/**
 * 그 대화에서 부를 수 있는 에이전트의 명령 목록. 새 세션 창(대화가 아직 없다)이면 채널의 것(`GET /channels/:id/agent-commands`).
 * 서버가 러너 목록을 10분 캐시하므로 여기서도 1분은 다시 묻지 않는다. 처음 `/` 를 칠 때만 부른다(enabled)
 */
export function useAgentCommands(
  channelId: string,
  conversationId: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: agentCommandsKeys.of(channelId, conversationId),
    queryFn: async () =>
      (
        await api<AgentCommandsResponse>(
          "GET",
          conversationId === NEW_CONVERSATION
            ? `/channels/${channelId}/agent-commands`
            : `/conversations/${conversationId}/agent-commands`,
        )
      ).agents,
    enabled,
    staleTime: 60_000,
    meta: { silent: true },
  });
}

/** 명령 이름 글자 — shared parseAgentCommand 와 같다. 입력 중인 앞부분이라 빈 글도 된다 */
const QUERY = /^[A-Za-z0-9:_-]{0,64}$/;

/**
 * 지금 문서가 명령을 치는 중인가(에이전트 명령 스펙 5.5) — 문단 하나에 「에이전트 멘션 칩 하나 + 공백 + `/` + 이름 앞부분」, 또는 1:1
 * 에이전트 DM(`directAgentId`)의 맨 앞 `/` + 이름 앞부분. 그 에이전트와 친 앞부분(`/` 뒤)을 돌려준다. 이름 뒤에 공백(인자)이 오면 끝
 */
export function commandTrigger(
  doc: JSONContent,
  opts: { directAgentId?: string },
): { agentId: string; query: string } | null {
  const blocks = doc.content ?? [];
  if (blocks.length !== 1 || blocks[0]?.type !== "paragraph") return null;
  const parts = blocks[0].content ?? [];
  const [first, second] = parts;
  if (parts.length === 2 && first?.type === "mention" && second?.type === "text") {
    const id = String(first.attrs?.id ?? "");
    if (!id.startsWith("a:")) return null;
    const m = /^\s\/(.*)$/s.exec(second.text ?? "");
    if (!m || !QUERY.test(m[1] as string)) return null;
    return { agentId: id.slice(2), query: m[1] as string };
  }
  if (opts.directAgentId !== undefined && parts.length === 1 && first?.type === "text") {
    const m = /^\/(.*)$/s.exec(first.text ?? "");
    if (!m || !QUERY.test(m[1] as string)) return null;
    return { agentId: opts.directAgentId, query: m[1] as string };
  }
  return null;
}

/** 목록에 보이는 최대 수 */
export const MAX_COMMANDS = 8;

/** 이름이나 별칭이 친 앞부분으로 시작하는 것(대소문자 무시) — 스킬의 접두사 없는 별칭(`user-skill`)으로도 찾는다(C16) */
export function matchCommands(
  commands: readonly AgentCommand[],
  query: string,
  limit = MAX_COMMANDS,
): AgentCommand[] {
  const q = query.toLowerCase();
  return commands
    .filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n.toLowerCase().startsWith(q)))
    .slice(0, limit);
}

/** 명령을 받는 프로그램 — 러너 에이전트는 Claude Code, 그 밖(OpenClaw)은 허용 목록(서버 commandProgramOf 와 같다) */
export const commandProgramOf = (agent: Pick<Agent, "provider">): "claude" | "openclaw" =>
  agent.provider === "runner" ? "claude" : "openclaw";

/**
 * 보내기 전 막기(에이전트 명령 C4·C10) — 글이 명령이고 그 에이전트를 알면 checkCommand. 명령이 아니거나(첨부가 있음 포함) 에이전트를
 * 모르면 null(보낸다 — 서버가 다시 본다). 그 에이전트의 명령 목록을 받아 두었으면 러너 스킬 별칭도 본다 — 못 받았으면 별칭을 모르는
 * 채 보내고 서버가 다시 본다(목록 묻기가 실패한 줄도 같다)
 */
export function commandBlock(
  bodyMd: string,
  opts: {
    attachments: number;
    directAgentId?: string;
    agents: readonly Agent[] | undefined;
    commands?: AgentCommandsResponse["agents"] | undefined;
  },
): Extract<CommandVerdict, { ok: false }> | null {
  if (opts.attachments > 0) return null;
  const parsed = parseAgentCommand(
    bodyMd,
    opts.directAgentId === undefined ? {} : { directAgentId: opts.directAgentId },
  );
  if (!parsed) return null;
  const agent = opts.agents?.find((a) => a.id === parsed.agentId);
  if (!agent) return null;
  const row = opts.commands?.find((a) => a.agentId === agent.id);
  const verdict = checkCommand(
    commandProgramOf(agent),
    parsed.name,
    parsed.args,
    // 목록 묻기가 실패한 줄(listFailed)은 별칭을 모른다 — 「쓸 수 없다」로 막지 않고 서버·러너가 본다(재리뷰 N3)
    row?.supported === true && row.listFailed !== true ? { skillAliases: skillAliasesOf(row.commands) } : {},
  );
  return verdict.ok ? null : verdict;
}
