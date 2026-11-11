import type { AgentSettingsPatch, ConversationAgentSettings } from "@dodok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { NEW_CONVERSATION } from "@/features/messages/timeline";

/**
 * 러너 에이전트의 세션 설정(세션 설정 스펙 5.2) — `GET /conversations/:id/agent-settings[?threadRootId]` 와 `PATCH …/:agentId`.
 * 키는 대화마다, 스레드면 그 스레드까지 — 값(모델·effort·권한)은 대화의 것이고 컨텍스트 % 만 스레드 세션의 것이다(S9)
 */
export const agentSettingsKeys = {
  conversation: (conversationId: string) => ["agentSettings", conversationId] as const,
  of: (conversationId: string, threadRootId?: string) =>
    ["agentSettings", conversationId, threadRootId ?? null] as const,
};

/** 새 세션 창(대화가 아직 없다)에서는 부르지 않는다 — 그 창은 에이전트 시작값에서 출발한다(S11) */
export function useAgentSettings(
  conversationId: string,
  threadRootId?: string,
  { enabled = true }: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: agentSettingsKeys.of(conversationId, threadRootId),
    queryFn: async () =>
      (
        await api<{ settings: ConversationAgentSettings[] }>(
          "GET",
          `/conversations/${conversationId}/agent-settings${threadRootId ? `?threadRootId=${threadRootId}` : ""}`,
        )
      ).settings,
    enabled: enabled && conversationId !== NEW_CONVERSATION,
    meta: { silent: true },
  });
}

/**
 * 한 줄을 그 대화의 캐시 모두에 넣는다 — wire `conversation.agent_settings`·PATCH 응답이 같은 길. 대화 키는 줄 그대로, 스레드 키는 값만
 * 바꾸고 컨텍스트 % 는 그 스레드의 것을 둔다(실린 % 는 대화 세션의 것이다)
 */
export function applyAgentSettings(
  qc: QueryClient,
  conversationId: string,
  settings: ConversationAgentSettings,
): void {
  for (const [key, rows] of qc.getQueriesData<ConversationAgentSettings[]>({
    queryKey: agentSettingsKeys.conversation(conversationId),
  })) {
    if (!rows) continue;
    const thread = key[2] !== null && key[2] !== undefined;
    qc.setQueryData<ConversationAgentSettings[]>(
      key,
      rows.map((row) =>
        row.agentId !== settings.agentId
          ? row
          : thread
            ? { ...settings, contextPercent: row.contextPercent }
            : settings,
      ),
    );
  }
}

/** 실행이 끝나면 컨텍스트 % 가 바뀐다 — 그 대화의 줄을 다시 받게 낡게 둔다 */
export function invalidateAgentSettings(qc: QueryClient, conversationId: string): void {
  void qc.invalidateQueries({ queryKey: agentSettingsKeys.conversation(conversationId) });
}

/** 저장하면 바로 반영(S6 — 다음 실행부터 쓰인다). 실패는 부르는 자리(팝오버)가 그 자리에 보인다 — 전역 토스트를 끈다 */
export function usePatchAgentSettings(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ agentId, patch }: { agentId: string; patch: AgentSettingsPatch }) =>
      api<ConversationAgentSettings>(
        "PATCH",
        `/conversations/${conversationId}/agent-settings/${agentId}`,
        patch,
      ),
    onSuccess: (settings) => applyAgentSettings(qc, conversationId, settings),
    meta: { silent: true },
  });
}
