import type { AdapterProvider, Agent } from "@dodok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 에이전트 화면의 서버 상태 — 등록·수정 뮤테이션과 제공자별 목록(discover) 쿼리 */

/** OpenClaw 는 gatewayId 가 있어야 한다(멀티 Gateway 스펙 「에이전트 API」 절) — 러너 에이전트는 싣지 않는다 */
export type CreateAgentInput = {
  provider: AdapterProvider;
  gatewayId?: string;
  providerAgentId: string;
  handle: string;
  name: string;
};
/** `basePrompt: null` 은 지운다 */
export type AgentPatch = { enabled?: boolean; basePrompt?: string | null; name?: string; handle?: string };
/**
 * hint — Claude 러너는 `<러너 라벨> · <작업 디렉터리 라벨> · <모델>`. archivedAgentId — 같은 자리의 보관(삭제)한 에이전트(등록 대신 되살린다)
 */
export type DiscoveredAgent = {
  providerAgentId: string;
  name?: string;
  hint?: string;
  archivedAgentId?: string;
};

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

/** 에이전트를 다른 Gateway 로 옮긴다(owner, 멀티 Gateway 스펙 「에이전트 API」 절). CONFLICT·VALIDATION 은 대화상자가 그린다 */
export function useMoveAgentGateway() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, gatewayId }: { id: string; gatewayId: string }) =>
      (await api<{ agent: Agent }>("PUT", `/agents/${id}/gateway`, { gatewayId })).agent,
    onSuccess: (agent) => putAgent(qc, agent),
  });
}

/**
 * 보관(삭제, admin — 스펙 「에이전트 보관」 절)·되살리기. 응답의 에이전트로 목록 캐시를 고치고, 채널 멤버는 다시 받게 낡은 것으로 둔다 —
 * 서버 멤버 응답이 보관한 에이전트를 읽을 때 거르고, channel.member.changed 는 내지 않는다(다른 탭은 wire agents.changed 로 같은 일을 한다)
 */
export function useArchiveAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api<{ agent: Agent }>("DELETE", `/agents/${id}`)).agent,
    onSuccess: (agent) => {
      putAgent(qc, agent);
      void qc.invalidateQueries({ queryKey: qk.membersAll });
    },
  });
}

export function useRestoreAgent() {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (id: string) => (await api<{ agent: Agent }>("POST", `/agents/${id}/restore`)).agent,
    onSuccess: (agent) => {
      putAgent(qc, agent);
      void qc.invalidateQueries({ queryKey: qk.membersAll });
    },
  });
  // 같은 틱 두 번 클릭에 한 번만 보낸다 — `isPending` 은 다시 그린 뒤에야 참이라 그 사이 두 번째 클릭이 지나간다. 실패는 전역 토스트
  const sending = useRef(false);
  const { mutate } = mutation;
  const restore = useCallback(
    (id: string, onSuccess?: () => void) => {
      if (sending.current) return;
      sending.current = true;
      mutate(id, {
        ...(onSuccess ? { onSuccess } : {}),
        onSettled: () => {
          sending.current = false;
        },
      });
    },
    [mutate],
  );
  return { restore, isPending: mutation.isPending };
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
 * 제공자의 등록 후보 — OpenClaw 는 고른 Gateway 의 agents.list(멀티 Gateway 스펙 「에이전트 API」 절), Claude 러너는 붙은 러너들이 알린 에이전트
 * (러너 계획 판정 P9). 대화상자가 열렸을 때만(`enabled`, OpenClaw 는 Gateway 를 골랐을 때만), 열 때마다 새로(`staleTime: 0`).
 * 503·403 은 대화상자 안에 그리므로 전역 토스트를 끄고(`silent`), 재시도하지 않는다 — 다시 부르기는 사용자가 누른다.
 * 네트워크가 돌아와도 다시 부르지 않는다 — 열려 있는 동안엔 고르고 고치는 중이다
 */
export function useDiscover(enabled: boolean, provider: AdapterProvider, gatewayId: string | undefined) {
  const openclaw = provider === "openclaw";
  const path = openclaw
    ? `/agents/discover?provider=openclaw&gatewayId=${encodeURIComponent(gatewayId ?? "")}`
    : `/agents/discover?provider=${provider}`;
  return useQuery({
    // 제공자 키 아래 Gateway 마다 — 제공자 키로 초기화하면 그 Gateway 들이 함께 지워진다
    queryKey: openclaw ? [...qk.discoverOf(provider), gatewayId ?? ""] : qk.discoverOf(provider),
    queryFn: async () => (await api<{ agents: DiscoveredAgent[] }>("GET", path)).agents,
    enabled: enabled && (!openclaw || gatewayId !== undefined),
    staleTime: 0,
    retry: false,
    refetchOnReconnect: false,
    meta: { silent: true },
  });
}
