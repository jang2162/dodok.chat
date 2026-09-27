import type { AdapterProvider, Agent } from "@dodok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 에이전트 화면의 서버 상태 — 등록·수정 뮤테이션과 제공자별 목록(discover) 쿼리 */

export type CreateAgentInput = {
  provider: AdapterProvider;
  providerAgentId: string;
  handle: string;
  name: string;
};
/** `basePrompt: null` 은 지운다 */
export type AgentPatch = { enabled?: boolean; basePrompt?: string | null; name?: string; handle?: string };
/** hint — Claude 러너는 `<러너 라벨> · <작업 디렉터리 라벨> · <모델>` */
export type DiscoveredAgent = { providerAgentId: string; name?: string; hint?: string };

/** 응답의 agent 로 `["agents"]` 를 직접 고친다(다시 불러오지 않는다). 아직 불러오지 않은 목록은 건드리지 않는다 */
function putAgent(qc: QueryClient, agent: Agent) {
  qc.setQueryData<Agent[]>(qk.agents, (prev) => {
    if (prev === undefined) return prev;
    return prev.some((a) => a.id === agent.id)
      ? prev.map((a) => (a.id === agent.id ? agent : a))
      : [...prev, agent];
  });
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
 * 제공자의 등록 후보 — OpenClaw 는 Gateway agents.list, Claude 러너는 붙은 러너들이 알린 에이전트(러너 계획 판정 P9).
 * 대화상자가 열렸을 때만(`enabled`), 열 때마다 새로(`staleTime: 0`). OpenClaw 는 provider 를 싣지 않는다 — 서버 기본값이다.
 * 503·403 은 대화상자 안에 그리므로 전역 토스트를 끄고(`silent`), 재시도하지 않는다 — 다시 부르기는 사용자가 누른다.
 * 네트워크가 돌아와도 다시 부르지 않는다 — 열려 있는 동안엔 고르고 고치는 중이다
 */
export function useDiscover(enabled: boolean, provider: AdapterProvider) {
  const path = provider === "openclaw" ? "/agents/discover" : `/agents/discover?provider=${provider}`;
  return useQuery({
    queryKey: qk.discoverOf(provider),
    queryFn: async () => (await api<{ agents: DiscoveredAgent[] }>("GET", path)).agents,
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnReconnect: false,
    meta: { silent: true },
  });
}
