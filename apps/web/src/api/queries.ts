import type {
  Agent,
  AdapterStatus,
  Channel,
  ChannelMember,
  Run,
  RunEvent,
  User,
  Workspace,
} from "@dodok/shared";
import { notifyManager, queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "./http";

/**
 * `workspace` 는 이름이 필요한 화면(사이드바 제목)이 본다 — 주지 않는 서버도 있어 선택이다(그때는 기본 이름).
 * `role` 은 그 워크스페이스 membership 의 역할("owner"·"member") — 옛 서버·옛 오프라인 사본에는 없어 선택이다(그때는 owner 가 아닌 것으로 본다)
 */
export type MeResponse = {
  user: User;
  workspaceId: string;
  workspace?: Pick<Workspace, "id" | "name">;
  role?: string;
};
export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };
export type AdapterStatusResponse = AdapterStatus & { capabilities: AdapterCapabilities };

export const qk = {
  me: ["me"] as const,
  channels: ["channels"] as const,
  channel: (id: string) => ["channel", id] as const,
  members: (id: string) => ["members", id] as const,
  agents: ["agents"] as const,
  discover: ["agents", "discover"] as const,
  adapter: ["adapter"] as const,
  timeline: (id: string) => ["timeline", id] as const,
  channelRuns: (channelId: string) => ["channels", channelId, "runs"] as const,
  runEvents: (runId: string) => ["runs", runId, "events"] as const,
  /** 최근 본 채널 id(앞이 최근) — 서버 조회가 아니라 오프라인 사본이 무엇을 담을지 정하는 목록(pwa/persist) */
  recentChannels: ["recentChannels"] as const,
  /** 연결 설정(owner 만) — 오프라인 사본에 담지 않는다(pwa/persist). 발급 원문은 어느 키에도 넣지 않는다 */
  setupStatus: ["setup", "status"] as const,
  bridgeTokens: ["setup", "bridge-tokens"] as const,
  /** 운영(owner 만) — 오프라인 사본에 담지 않는다(pwa/persist). 상태의 `unacked` 가 사이드바 배지다 */
  opsStatus: ["ops", "status"] as const,
  opsRuns: (days: 1 | 7) => ["ops", "runs", days] as const,
  /** 사건 목록(무한 쿼리) — severity 가 없으면 전부 */
  opsEvents: (severity?: string) => ["ops", "events", severity ?? "all"] as const,
  opsEventsAll: ["ops", "events"] as const,
};

/** 활동 패널이 한 번에 받는 런 수(REST 상한 200) */
export const RUNS_PAGE = 50;

export const meQuery = queryOptions({
  queryKey: qk.me,
  queryFn: () => api<MeResponse>("GET", "/auth/me"),
  staleTime: Infinity,
});
export const useMe = () => useQuery(meQuery);
/**
 * 연결 설정 같은 owner 전용 진입점을 가를 때(설정 마법사 스펙 「결정」 — setup 은 owner 만). role 이 없는 옛 me 는 owner 가 아니다.
 * 라우트 가드가 이미 받은 me 를 캐시 구독으로 읽기만 한다 — 관찰자를 두지 않는 까닭은 pwa/offline.ts `useMeDown` 의 주석
 */
export function useIsOwner(): boolean {
  const qc = useQueryClient();
  const subscribe = useCallback(
    (onChange: () => void) => {
      const notify = notifyManager.batchCalls(onChange);
      return qc.getQueryCache().subscribe((e) => {
        if (e.query.queryKey[0] === qk.me[0]) notify();
      });
    },
    [qc],
  );
  return useSyncExternalStore(subscribe, () => qc.getQueryData<MeResponse>(qk.me)?.role === "owner");
}
export const useChannels = () =>
  useQuery({
    queryKey: qk.channels,
    queryFn: async () => (await api<{ channels: Channel[] }>("GET", "/channels")).channels,
  });
/**
 * 조회 오류는 채널 화면(ChannelPage)이 화면 안에 그린다(없는 채널 등) — 전역 토스트를 끈다(`silent`).
 * meta 는 같은 키의 관찰자 중 마지막 것이 이기므로 `["channel", id]` 는 이 훅으로만 부른다.
 * 채널 목록에 있으면 그 값을 자리값으로 먼저 보인다(채널을 옮길 때 빈 화면 없이) — 캐시에는 넣지 않는다
 */
export const useChannel = (id: string) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.channel(id),
    queryFn: async () => (await api<{ channel: Channel }>("GET", `/channels/${id}`)).channel,
    placeholderData: () => qc.getQueryData<Channel[]>(qk.channels)?.find((c) => c.id === id),
    meta: { silent: true },
  });
};
export const useMembers = (channelId: string) =>
  useQuery({
    queryKey: qk.members(channelId),
    queryFn: async () =>
      (await api<{ members: ChannelMember[] }>("GET", `/channels/${channelId}/members`)).members,
  });
export const useAgents = () =>
  useQuery({
    queryKey: qk.agents,
    queryFn: async () => (await api<{ agents: Agent[] }>("GET", "/agents")).agents,
  });
export const useAdapterStatus = () =>
  useQuery({ queryKey: qk.adapter, queryFn: () => api<AdapterStatusResponse>("GET", "/adapter/status") });

/**
 * 활동 탭의 런 목록(설계 5.2). 실시간 `run.state` 는 런 스토어에서 덮는다(`mergeRuns`).
 * 조회 실패는 패널 안에 상태 문구 + 「다시 시도」로 보인다 — 전역 토스트와 이중 표시하지 않는다(`silent`)
 */
export const useChannelRuns = (channelId: string) =>
  useQuery({
    queryKey: qk.channelRuns(channelId),
    queryFn: async () =>
      (await api<{ runs: Run[] }>("GET", `/channels/${channelId}/runs?limit=${RUNS_PAGE}`)).runs,
    meta: { silent: true },
  });

/** 고른 런의 이벤트 전부(afterSeq 0). 실시간 `run.event` 는 `mergeRunEvents` 로 잇는다 */
export const useRunEvents = (runId: string | undefined) =>
  useQuery({
    queryKey: qk.runEvents(runId ?? ""),
    queryFn: async () => (await api<{ events: RunEvent[] }>("GET", `/runs/${runId}/events`)).events,
    enabled: runId !== undefined,
    meta: { silent: true },
  });
