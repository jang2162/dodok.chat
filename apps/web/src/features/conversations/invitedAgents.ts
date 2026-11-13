import type { Agent, InvitedAgent } from "@dodok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/http";
import { useAgents } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { agentSettingsKeys } from "./agentSettings";

/**
 * 세션에 초대한 에이전트(세션 에이전트 초대 스펙 5.3·5.4) — `GET·POST /conversations/:id/agents`, `DELETE …/:agentId`. 키는 대화마다다 —
 * 초대한 에이전트는 그 세션(과 그 스레드)에만 보인다
 */
export const invitedAgentKeys = {
  of: (conversationId: string) => ["invitedAgents", conversationId] as const,
};

/** 새 세션 창(대화가 아직 없다)에서는 부르지 않는다 — 초대는 세션이 생긴 뒤에만 된다 */
export function useInvitedAgents(conversationId: string, { enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: invitedAgentKeys.of(conversationId),
    queryFn: async () =>
      (await api<{ invited: InvitedAgent[] }>("GET", `/conversations/${conversationId}/agents`)).invited,
    enabled: enabled && conversationId !== NEW_CONVERSATION,
    meta: { silent: true },
  });
}

/**
 * 그 세션에 초대한 에이전트(초대한 순) — 에이전트 목록에서 찾고 보관(삭제)한 에이전트는 뺀다(서버도 그 세션에서 부르지 않는다). 새 세션
 * 창이면 빈 목록
 */
export function useSessionInvitedAgents(
  conversationId: string,
  { enabled = true }: { enabled?: boolean } = {},
): Agent[] {
  const invited = useInvitedAgents(conversationId, { enabled });
  const agents = useAgents();
  // 같은 배열을 돌려준다 — 작성기 후보(useMemo)가 렌더마다 다시 만들지 않게
  return useMemo(() => {
    const byId = new Map((agents.data ?? []).map((a) => [a.id, a]));
    return (invited.data ?? []).flatMap((row) => {
      const agent = byId.get(row.agentId);
      return agent && !isArchived(agent) ? [agent] : [];
    });
  }, [invited.data, agents.data]);
}

/**
 * 그 대화의 초대 목록을 갈아 끼운다 — wire `conversation.agents`·초대·내보내기 응답이 같은 길. 상태 줄의 러너 에이전트도 바뀌므로 그
 * 대화의 세션 설정을 다시 받게 둔다
 */
export function applyInvitedAgents(qc: QueryClient, conversationId: string, invited: InvitedAgent[]): void {
  qc.setQueryData<InvitedAgent[]>(invitedAgentKeys.of(conversationId), invited);
  void qc.invalidateQueries({ queryKey: agentSettingsKeys.conversation(conversationId) });
}

/** 초대 — 실패는 부르는 자리(대화상자)가 그 자리에 보인다 */
export function useInviteAgent(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) =>
      (await api<{ invited: InvitedAgent[] }>("POST", `/conversations/${conversationId}/agents`, { agentId }))
        .invited,
    onSuccess: (invited) => applyInvitedAgents(qc, conversationId, invited),
    meta: { silent: true },
  });
}

/** 세션에서 내보내기 — 그 세션에서 돌던 그 에이전트의 실행은 서버가 멈춘다 */
export function useRemoveInvitedAgent(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) =>
      (await api<{ invited: InvitedAgent[] }>("DELETE", `/conversations/${conversationId}/agents/${agentId}`))
        .invited,
    onSuccess: (invited) => applyInvitedAgents(qc, conversationId, invited),
  });
}
