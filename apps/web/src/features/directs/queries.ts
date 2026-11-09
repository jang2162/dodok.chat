import {
  type Agent,
  type Channel,
  type CreateDirectBody,
  DIRECT_MAX_PARTICIPANTS,
  type DirectSummary,
  type DmSummary,
  type OpenDirectResult,
  type Person,
} from "@dodok/shared";
import { type QueryClient, queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 사람 DM·그룹 DM 채널인가(사람 간 DM 스펙 「데이터」) */
export const isDirectChannel = (channel: Pick<Channel, "kind"> | undefined): boolean =>
  channel?.kind === "direct";

/** 「새 메시지」 대화상자에서 고를 수 있는 상대 수 — 나를 빼고 */
export const DIRECT_PICK_MAX = DIRECT_MAX_PARTICIPANTS - 1;

/** 그룹 DM 첫 안내(에이전트가 있는 그룹, 세션이 하나도 없을 때 — 사람 간 DM 계획 Global Constraints, 글자 그대로) */
export const GROUP_DM_FIRST_NOTICE =
  "이 대화는 참여자만 봅니다. 다만 에이전트는 자기 기억(메모리·작업 디렉터리의 파일)을 거쳐 여기서 들은 것을 다른 자리의 답에 쓸 수 있습니다 — dodok 은 이것을 막지 못합니다.";

/**
 * 에이전트 DM 목록(`dmsQuery`)과 같은 규칙 — 저절로 낡지 않고 바뀌는 길마다 realtime 이 다시 받게 한다: 다시 붙기·`agents.changed`·
 * `people.changed`(1:1 상대 비활성화 → `peer_deactivated`, 이름·아바타)·`direct` 의 `channel.created`·`channel.updated`·모르는 채널의
 * 활동, 쓰기가 `DM_READ_ONLY` 로 거절됐을 때(`invalidateDms` 가 함께 낡게 한다), `POST /directs` 뒤
 */
export const directsQuery = queryOptions({
  queryKey: qk.directs,
  queryFn: async () => (await api<{ directs: DirectSummary[] }>("GET", "/directs")).directs,
  staleTime: Number.POSITIVE_INFINITY,
});
/** 내가 참여한 direct 전부(글 없는 것도 — 사이드바가 거른다) */
export const useDirects = () => useQuery(directsQuery);

/** 이 direct 채널의 요약 — 아직 못 받았거나 목록에 없으면 undefined. `enabled` 가 거짓이면 목록을 부르지 않는다 */
export function useDirect(channelId: string, enabled = true): DirectSummary | undefined {
  return useQuery({
    ...directsQuery,
    select: (directs) => directs.find((d) => d.channel.id === channelId),
    enabled,
  }).data;
}

/** 세션 없이 한 줄기인가 — 에이전트 참여자가 없으면(계획 판정 PH3) */
export const isOneStream = (direct: Pick<DirectSummary, "agents">): boolean => direct.agents.length === 0;

/** 사람 1:1 이면 그 상대 — 사람 참여자 둘(나 포함)에 에이전트 없음 */
export const directPeer = (direct: Pick<DirectSummary, "users" | "agents">): Person | undefined =>
  direct.agents.length === 0 && direct.users.length === 1 ? direct.users[0] : undefined;

/** 사람의 보이는 이름 — 표시 이름이 비었으면 핸들 */
export const personName = (p: Pick<Person, "displayName" | "handle">): string => p.displayName || p.handle;

/** 그룹 줄에 이름을 몇 개까지 적나 — 넘치면 「외 N」 */
const GROUP_NAMES_SHOWN = 3;

/** 그룹 DM 의 이름 나열(나를 뺀 참여자 — 사람은 이름, 에이전트는 @핸들). 넘치면 「mia, jun, @dev 외 2」 */
export function directNames(direct: Pick<DirectSummary, "users" | "agents">): string {
  const names = [...direct.users.map(personName), ...direct.agents.map((a: Agent) => `@${a.handle}`)];
  const shown = names.slice(0, GROUP_NAMES_SHOWN).join(", ");
  const rest = names.length - GROUP_NAMES_SHOWN;
  return rest > 0 ? `${shown} 외 ${rest}` : shown;
}

/** 머리·검색 결과에 쓰는 이름 — 1:1 이면 상대 이름, 그룹이면 이름 나열 */
export function directTitle(direct: Pick<DirectSummary, "users" | "agents">): string {
  const peer = directPeer(direct);
  return peer ? personName(peer) : directNames(direct);
}

/** 캐시에서 direct 채널을 찾는다 — 채널 상세 캐시, 아니면 direct 목록. 라우터 밖(realtime)에서 부른다 */
export function cachedDirectChannel(qc: QueryClient, channelId: string): Channel | undefined {
  const detail = qc.getQueryData<Channel>(qk.channel(channelId));
  if (detail) return isDirectChannel(detail) ? detail : undefined;
  return qc.getQueryData<DirectSummary[]>(qk.directs)?.find((d) => d.channel.id === channelId)?.channel;
}

/** 새 글이 왔다 — 그 direct 의 마지막 글 시각을 지금으로(사이드바는 두 목록을 합쳐 시각으로 줄 세운다). 목록에 없으면 그대로 */
export function bumpDirect(qc: QueryClient, channelId: string): void {
  qc.setQueryData<DirectSummary[]>(qk.directs, (list) =>
    list?.some((d) => d.channel.id === channelId)
      ? list.map((d) => (d.channel.id === channelId ? { ...d, lastMessageAt: new Date().toISOString() } : d))
      : list,
  );
}

export const invalidateDirects = (qc: QueryClient) =>
  qc.invalidateQueries({ queryKey: qk.directs, exact: true });

/** 사이드바 「다이렉트 메시지」 한 줄 — 에이전트 DM 이나 사람 DM·그룹 DM */
export type DmEntry = { kind: "dm"; dm: DmSummary } | { kind: "direct"; direct: DirectSummary };

const entryChannel = (e: DmEntry): Channel => (e.kind === "dm" ? e.dm.channel : e.direct.channel);
const entryLast = (e: DmEntry): string | null =>
  e.kind === "dm" ? e.dm.lastMessageAt : e.direct.lastMessageAt;

/**
 * 두 목록을 한 목록으로(사람 간 DM 스펙 결정 9 — Slack 방식) — 마지막 글 시각(없으면 연 시각) 내림차순. 같은 시각이면 받은 순서
 * (에이전트 DM 먼저)를 지킨다. 거름(글이 있는 것 + 지금 연 것)은 부르는 쪽이 한다
 */
export function mergeDmEntries(
  dms: readonly DmSummary[] | undefined,
  directs: readonly DirectSummary[] | undefined,
): DmEntry[] {
  const entries: DmEntry[] = [
    ...(dms ?? []).map((dm): DmEntry => ({ kind: "dm", dm })),
    ...(directs ?? []).map((direct): DmEntry => ({ kind: "direct", direct })),
  ];
  const at = (e: DmEntry) => Date.parse(entryLast(e) ?? entryChannel(e).createdAt);
  return entries
    .map((e, i) => ({ e, i, t: at(e) }))
    .sort((a, b) => b.t - a.t || a.i - b.i)
    .map(({ e }) => e);
}

export const dmEntryChannelId = (e: DmEntry): string => entryChannel(e).id;
export const dmEntryLastMessageAt = entryLast;

/**
 * `POST /directs` — 같은 참여자 묶음이면 서버가 같은 채널을 준다(찾거나 만든다). 성공하면 채널 상세를 넣어 두고 direct 목록을 다시
 * 받는다(사이드바가 「지금 연 것」을 그린다). 오류는 부르는 자리가 그린다(`silent`) — 403 은 서버 문구 그대로
 */
export function useOpenDirect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateDirectBody) => api<OpenDirectResult>("POST", "/directs", body),
    meta: { silent: true },
    onSuccess: ({ channel }) => {
      qc.setQueryData<Channel>(qk.channel(channel.id), channel);
      void invalidateDirects(qc);
    },
  });
}
