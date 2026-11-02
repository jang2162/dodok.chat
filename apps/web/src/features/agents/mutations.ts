import type { Agent, DmAccess, RunnerPermissionMode, RunnerProgram } from "@dodok/shared";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { api, apiBytes } from "@/api/http";
import { qk } from "@/api/queries";

/** 에이전트 화면의 서버 상태 — 등록·수정 뮤테이션과 제공자별 목록(discover) 쿼리 */

/** OpenClaw 는 gatewayId 가 있어야 한다(멀티 Gateway 스펙 「에이전트 API」 절) */
export type CreateOpenClawAgentInput = {
  provider: "openclaw";
  gatewayId?: string;
  providerAgentId: string;
  handle: string;
  name: string;
};
/**
 * 러너 에이전트는 러너 프로젝트 안에서 만든다(shared `CreateRunnerAgentBody` — 러너 일반화 스펙 7장). id 는 서버가 짓고, 그 프로젝트의
 * 러너에 묶인다. model·allowedTools 의 null 은 「프로그램 기본」이다
 */
export type CreateRunnerAgentInput = {
  provider: "runner";
  runnerProjectId: string;
  program: RunnerProgram;
  handle: string;
  name: string;
  model?: string | null;
  permissionMode: RunnerPermissionMode;
  allowedTools?: string[] | null;
  basePrompt?: string;
  dmAccess?: DmAccess;
};
export type CreateAgentInput = CreateOpenClawAgentInput | CreateRunnerAgentInput;
/** `basePrompt: null` 은 지운다 */
export type AgentPatch = {
  enabled?: boolean;
  basePrompt?: string | null;
  name?: string;
  handle?: string;
  /** 누가 이 에이전트와 DM 을 여나(admin 이상 — 에이전트 DM 계획 판정 PD13: REST 로만) */
  dmAccess?: DmAccess;
  /**
   * 러너 에이전트의 정의(admin 이상, REST 로만). 프로그램·프로젝트는 싣지 않는다 — 서버가 400 으로 거절한다(러너 일반화 계획 판정
   * PR10: 프로젝트는 「다른 러너로 옮기기」로만, 프로그램을 바꾸려면 새 에이전트)
   */
  model?: string | null;
  permissionMode?: RunnerPermissionMode;
  allowedTools?: string[] | null;
};
/** archivedAgentId — 같은 자리의 보관(삭제)한 에이전트(등록 대신 되살린다) */
export type DiscoveredAgent = {
  providerAgentId: string;
  name?: string;
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

/**
 * 러너 에이전트를 만들면 그 프로젝트의 에이전트 수가 바뀐다 — 「러너」 탭의 프로젝트 목록을 낡게 한다. `silent` 면 전역 토스트를 끈다 —
 * 실패를 모두 폼 안에 그리는 곳(러너 에이전트 만들기)이 쓴다
 */
export function useCreateAgent({ silent = false }: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgentInput) =>
      (await api<{ agent: Agent }>("POST", "/agents", input)).agent,
    meta: { silent },
    onSuccess: (agent) => {
      putAgent(qc, agent);
      if (agent.provider === "runner") void qc.invalidateQueries({ queryKey: qk.runnerProjectsAll });
    },
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
 * OpenClaw 등록 후보 — 고른 Gateway 의 agents.list(멀티 Gateway 스펙 「에이전트 API」 절). 러너 에이전트는 알린 목록이 없어 찾기가 없다
 * (러너 프로젝트 안에서 만든다 — `RunnerAgentForm`). 대화상자가 열렸고 Gateway 를 골랐을 때만(`enabled`), 열 때마다 새로(`staleTime: 0`).
 * 503·403 은 대화상자 안에 그리므로 전역 토스트를 끄고(`silent`), 재시도하지 않는다 — 다시 부르기는 사용자가 누른다.
 * 네트워크가 돌아와도 다시 부르지 않는다 — 열려 있는 동안엔 고르고 고치는 중이다
 */
export function useDiscover(enabled: boolean, gatewayId: string | undefined) {
  const path = `/agents/discover?provider=openclaw&gatewayId=${encodeURIComponent(gatewayId ?? "")}`;
  return useQuery({
    // 제공자 키 아래 Gateway 마다 — 제공자 키로 초기화하면 그 Gateway 들이 함께 지워진다
    queryKey: [...qk.discoverOf("openclaw"), gatewayId ?? ""],
    queryFn: async () => (await api<{ agents: DiscoveredAgent[] }>("GET", path)).agents,
    enabled: enabled && gatewayId !== undefined,
    staleTime: 0,
    retry: false,
    refetchOnReconnect: false,
    meta: { silent: true },
  });
}

/** 에이전트 사진(프로필 스펙 3.6, admin 이상) — `PUT·DELETE /agents/:id/avatar`. 응답의 에이전트로 목록 캐시를 고친다. 오류는 고르는 자리 안에서 */
export function useAgentAvatar(agentId: string) {
  const qc = useQueryClient();
  const onSuccess = ({ agent }: { agent: Agent }) => putAgent(qc, agent);
  return {
    upload: useMutation({
      mutationFn: (image: Blob) => apiBytes<{ agent: Agent }>("PUT", `/agents/${agentId}/avatar`, image),
      onSuccess,
      meta: { silent: true },
    }),
    remove: useMutation({
      mutationFn: () => api<{ agent: Agent }>("DELETE", `/agents/${agentId}/avatar`),
      onSuccess,
      meta: { silent: true },
    }),
  };
}
