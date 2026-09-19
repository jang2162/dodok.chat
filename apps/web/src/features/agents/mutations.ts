import type { Agent } from "@dodok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiRequestError } from "@/api/http";
import { qk } from "@/api/queries";

/** 에이전트 화면의 서버 상태 — 등록·수정 뮤테이션과 Gateway 목록(discover) 쿼리 */

export type CreateAgentInput = { providerAgentId: string; handle: string; name: string };
/** `basePrompt: null` 은 지운다 */
export type AgentPatch = { enabled?: boolean; basePrompt?: string | null; name?: string; handle?: string };
export type DiscoveredAgent = { providerAgentId: string; name?: string };

/** 응답의 agent 로 `["agents"]` 를 직접 고친다(다시 불러오지 않는다). 아직 불러오지 않은 목록은 건드리지 않는다 */
function putAgent(qc: QueryClient, agent: Agent) {
  qc.setQueryData<Agent[]>(qk.agents, (prev) => {
    if (prev === undefined) return prev;
    return prev.some((a) => a.id === agent.id)
      ? prev.map((a) => (a.id === agent.id ? agent : a))
      : [...prev, agent];
  });
}

/** 폼 안에 그릴 서버 오류(VALIDATION·CONFLICT — 전역 토스트에서 빠지는 둘)의 message. 그 밖은 undefined — 전역 토스트가 알린다 */
export function formError(e: unknown): string | undefined {
  return e instanceof ApiRequestError && (e.code === "VALIDATION" || e.code === "CONFLICT")
    ? e.message
    : undefined;
}

export function useCreateAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgentInput) =>
      (await api<{ agent: Agent }>("POST", "/agents", input)).agent,
    onSuccess: (agent) => putAgent(qc, agent),
  });
}

export function usePatchAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: AgentPatch }) =>
      (await api<{ agent: Agent }>("PATCH", `/agents/${id}`, patch)).agent,
    onSuccess: (agent) => putAgent(qc, agent),
  });
}

/**
 * Gateway agents.list. 대화상자가 열렸을 때만(`enabled`), 열 때마다 새로(`staleTime: 0`).
 * 503·403 은 대화상자 안에 그리므로 전역 토스트를 끄고(`silent`), 재시도하지 않는다 — 다시 부르기는 사용자가 누른다.
 * 네트워크가 돌아와도 다시 부르지 않는다 — 열려 있는 동안엔 고르고 고치는 중이다
 */
export function useDiscover(enabled: boolean) {
  return useQuery({
    queryKey: qk.discover,
    queryFn: async () => (await api<{ agents: DiscoveredAgent[] }>("GET", "/agents/discover")).agents,
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnReconnect: false,
    meta: { silent: true },
  });
}
