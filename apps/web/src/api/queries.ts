import {
  type Agent,
  type AdapterStatus,
  type Channel,
  type ChannelMember,
  type Person,
  type Run,
  type RunEvent,
  type TeamRole,
  type User,
  type Workspace,
  roleAtLeast,
  TeamRole as TeamRoleSchema,
} from "@dodok/shared";
import {
  notifyManager,
  type QueryClient,
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "./http";

/**
 * `workspace` 는 이름이 필요한 화면(사이드바 제목)이 본다 — 주지 않는 서버도 있어 선택이다(그때는 기본 이름).
 * `role` 은 그 워크스페이스 membership 의 역할("owner"·"admin"·"member") — 옛 서버·옛 오프라인 사본에는 없어 선택이다(그때는 관리
 * 권한이 없는 것으로 본다)
 */
export type MeResponse = {
  user: User;
  workspaceId: string;
  workspace?: Pick<Workspace, "id" | "name">;
  role?: string;
};
export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };
/** GET /adapter/status 응답 — 붙은 어댑터마다 상태 하나, capabilities 는 provider 로 찾는다(러너 계획 판정 P7) */
export type AdapterStatusList = {
  statuses: AdapterStatus[];
  capabilities: Partial<Record<AdapterStatus["provider"], AdapterCapabilities>>;
};
/**
 * `qk.adapter` 캐시 — OpenClaw 어댑터의 Gateway 별 상태와 capabilities. 연결 점·배너·운영 화면·에이전트 화면이 Gateway 목록을 읽어
 * 저마다 모은다(멀티 Gateway 스펙 「웹」 절). 서버에 OpenClaw 어댑터가 없으면 null. wire `adapter.status` 도 OpenClaw 것만 이 캐시를 고친다
 */
export type AdapterStatusResponse = Extract<AdapterStatus, { provider: "openclaw" }> & {
  capabilities: AdapterCapabilities;
};

/** 목록 응답에서 OpenClaw 줄을 고른다 */
export function openclawAdapterStatus(list: AdapterStatusList): AdapterStatusResponse | null {
  const status = list.statuses.find((s) => s.provider === "openclaw");
  const capabilities = list.capabilities.openclaw;
  return status?.provider === "openclaw" && capabilities ? { ...status, capabilities } : null;
}

/** 러너 어댑터의 붙은 러너 수 / 폐기되지 않은 토큰 수(러너 계획 판정 P7) */
export type RunnerAdapterStatus = Extract<AdapterStatus, { provider: "claude" }>["runners"];

/** 목록 응답에서 Claude 러너 줄을 고른다 — 서버에 러너 어댑터가 없으면 null */
export function runnerAdapterStatus(list: AdapterStatusList): RunnerAdapterStatus | null {
  const status = list.statuses.find((s) => s.provider === "claude");
  return status?.provider === "claude" ? status.runners : null;
}

export const qk = {
  me: ["me"] as const,
  channels: ["channels"] as const,
  channel: (id: string) => ["channel", id] as const,
  members: (id: string) => ["members", id] as const,
  agents: ["agents"] as const,
  /** 워크스페이스 사람 전원(나간 멤버 포함) — 작성자·사람 멘션·@ 후보. wire `people.changed` 가 통째로 바꾼다 */
  people: ["people"] as const,
  /** 멤버 관리(admin 이상, 팀 스펙 6장) — 오프라인 사본에 담지 않는다(pwa/persist). 발급 원문은 어느 키에도 넣지 않는다 */
  teamMembers: ["team", "members"] as const,
  /** 멤버 표·대기 초대 둘 다(무효화용 앞머리) */
  team: ["team"] as const,
  invites: ["team", "invites"] as const,
  /** 등록 화면의 제공자별 목록 — `discover` 는 모든 제공자(무효화·초기화용 앞머리) */
  discover: ["agents", "discover"] as const,
  discoverOf: (provider: string) => ["agents", "discover", provider] as const,
  adapter: ["adapter"] as const,
  /** Claude 러너 어댑터 줄(운영 화면 연결 줄) — `adapter` 가 앞머리라 그 무효화에 함께 든다 */
  runnerAdapter: ["adapter", "claude"] as const,
  timeline: (id: string) => ["timeline", id] as const,
  /** 스레드 하나(루트·답글) — 채널 타임라인은 루트만 든다. `threads` 는 한 채널의 스레드 전부(무효화용 앞머리) */
  thread: (channelId: string, rootId: string) => ["thread", channelId, rootId] as const,
  threads: (channelId: string) => ["thread", channelId] as const,
  threadsAll: ["thread"] as const,
  channelRuns: (channelId: string) => ["channels", channelId, "runs"] as const,
  runEvents: (runId: string) => ["runs", runId, "events"] as const,
  /** 최근 본 채널 id(앞이 최근) — 서버 조회가 아니라 오프라인 사본이 무엇을 담을지 정하는 목록(pwa/persist) */
  recentChannels: ["recentChannels"] as const,
  /** 채널마다 마지막으로 연 스레드(채널 id → 루트 id) — 오프라인 사본이 채널마다 그 스레드 하나만 담는다(pwa/persist) */
  recentThreads: ["recentThreads"] as const,
  /** 연결 설정(owner 만) — 오프라인 사본에 담지 않는다(pwa/persist). 발급 원문은 어느 키에도 넣지 않는다 */
  setupStatus: ["setup", "status"] as const,
  bridgeTokens: ["setup", "bridge-tokens"] as const,
  runnerTokens: ["setup", "runner-tokens"] as const,
  /** 운영(admin 이상) — 오프라인 사본에 담지 않는다(pwa/persist). 상태의 `unacked` 가 사이드바 배지다 */
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
 * 캐시에 있는 me — 불러오지 않고 캐시 구독으로 읽기만 한다. 관찰자를 두지 않는 까닭은 pwa/offline.ts `useMeDown` 의 주석
 */
export function useCachedMe(): MeResponse | undefined {
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
  return useSyncExternalStore(subscribe, () => qc.getQueryData<MeResponse>(qk.me));
}
/**
 * 연결 설정 같은 owner 전용 진입점을 가를 때(설정 마법사 스펙 「결정」 — setup 은 owner 만). role 이 없는 옛 me 는 owner 가 아니다.
 * 라우트 가드가 이미 받은 me 를 읽기만 한다(`useCachedMe`)
 */
export const useIsOwner = (): boolean => useCachedMe()?.role === "owner";
/** 내 역할(팀 스펙 2장) — me 캐시에서. 없거나 모르는 값(옛 서버·guest)이면 undefined */
export function useRole(): TeamRole | undefined {
  const parsed = TeamRoleSchema.safeParse(useCachedMe()?.role);
  return parsed.success ? parsed.data : undefined;
}
/**
 * 관리 동작(에이전트 등록·채널 동작 설정·「새 대화」·승인·멤버·운영)을 보이는가 — admin 이상. 서버가 막으므로 숨김은 편의다.
 * 역할이 내려간 뒤 남은 버튼은 서버 403 → 전역 처리(app/queryClient)가 me 를 다시 받아 잠근다
 */
export const useCanManage = (): boolean => roleAtLeast(useCachedMe()?.role, "admin");
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
/**
 * 사람 목록(`GET /people`) — 로그인한 누구나 읽는다. `role` 없는 줄은 나간 멤버다. 조회가 실패해도 작성자가 「알 수 없음」으로
 * 남을 뿐이라 토스트를 띄우지 않는다(`silent`) — 다음 `people.changed` 가 통째로 채운다
 */
export const usePeople = () =>
  useQuery({
    queryKey: qk.people,
    queryFn: async () => (await api<{ people: Person[] }>("GET", "/people")).people,
    meta: { silent: true },
  });
/**
 * `GET /adapter/status` 한 번을 OpenClaw 줄(`qk.adapter`)·러너 줄(`qk.runnerAdapter`)이 나눠 쓴다 — 둘이 함께 불리면(운영 화면 진입,
 * `adapter` 앞머리 무효화) 진행 중인 요청 하나를 기다린다. 끝난 응답은 들고 있지 않는다 — 다음 부름은 새로 받는다.
 * QueryClient 마다 따로 둔다(테스트·로그아웃 뒤 새 클라이언트가 옛 요청을 물려받지 않게)
 */
const adapterListInFlight = new WeakMap<QueryClient, Promise<AdapterStatusList>>();
function fetchAdapterList(client: QueryClient): Promise<AdapterStatusList> {
  let pending = adapterListInFlight.get(client);
  if (!pending) {
    pending = api<AdapterStatusList>("GET", "/adapter/status").finally(() =>
      adapterListInFlight.delete(client),
    );
    adapterListInFlight.set(client, pending);
  }
  return pending;
}
export const useAdapterStatus = () =>
  useQuery({
    queryKey: qk.adapter,
    queryFn: async ({ client }) => openclawAdapterStatus(await fetchAdapterList(client)),
  });
/**
 * 러너 줄(러너 스펙 5장 「운영 화면 연결 줄」) — 같은 목록 응답에서 claude 줄만. wire `adapter.status`(claude)가 곧바로 덮는다.
 * `poll` 이면 주기로 다시 받는다 — wire 가 끊겨 캐시가 멈춘 동안(운영 화면)
 */
export const useRunnerAdapterStatus = ({ poll }: { poll?: number } = {}) =>
  useQuery({
    queryKey: qk.runnerAdapter,
    queryFn: async ({ client }) => runnerAdapterStatus(await fetchAdapterList(client)),
    refetchInterval: poll ?? false,
    meta: { silent: true },
  });

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
