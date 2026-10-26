import {
  type Agent,
  type Channel,
  type DmAccess,
  DmReadOnlyReason,
  type DmSummary,
  roleAtLeast,
} from "@dodok/shared";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { isArchived } from "@/features/agents/archived";

/** DM 채널인가(에이전트 DM 스펙 결정 1) — 옛 오프라인 사본의 채널은 `kind` 가 없다(그때는 채널) */
export const isDmChannel = (channel: Pick<Channel, "kind"> | undefined): boolean => channel?.kind === "dm";

/** 읽기 전용 사유의 문구(에이전트 DM 계획 Global Constraints — 글자 그대로) */
export const DM_READ_ONLY_TEXT: Record<DmReadOnlyReason, string> = {
  agent_archived: "보관된 에이전트라 읽기만 할 수 있습니다",
  agent_disabled: "꺼진 에이전트라 읽기만 할 수 있습니다",
  dm_not_allowed: "이 에이전트와의 DM 이 허용되지 않아 읽기만 할 수 있습니다",
};

/** ack·REST 의 `DM_READ_ONLY` 오류의 `details.reason` — 외부 입력이라 파싱한다. 읽지 못하면 허용 철회로 본다(셋 중 가장 넓은 사유) */
export function dmReadOnlyReasonOf(details: Record<string, unknown> | undefined): DmReadOnlyReason {
  const parsed = DmReadOnlyReason.safeParse(details?.reason);
  return parsed.success ? parsed.data : "dm_not_allowed";
}

/**
 * 저절로 낡지 않는다(`staleTime: Infinity`) — 바뀌는 길마다 realtime 이 다시 받게 한다: 다시 붙기·`agents.changed`(보관·꺼짐·허용 범위)·
 * 내 역할 바뀜(`people.changed` — 강등이면 `dm_not_allowed`)·DM 의 `channel.created`·`channel.updated`·모르는 채널의 활동, 그리고 쓰기가
 * `DM_READ_ONLY` 로 거절됐을 때. 관찰자(사이드바·머리·작성기 자리)가 마운트될 때마다 다시 부르지 않게 한다
 */
export const dmsQuery = queryOptions({
  queryKey: qk.dms,
  queryFn: async () => (await api<{ dms: DmSummary[] }>("GET", "/dms")).dms,
  staleTime: Number.POSITIVE_INFINITY,
});
/** 내 DM 목록(최근 활동순 — 서버 순서 그대로). 글 없는 DM 도 든다(계획 판정 PD1) — 사이드바가 거른다 */
export const useDms = () => useQuery(dmsQuery);

/**
 * 이 DM 채널의 요약(목록에서) — 아직 못 받았거나 목록에 없으면 undefined. `enabled` 가 거짓이면(DM 이 아닌 채널) 목록을 부르지 않는다
 */
export function useDm(channelId: string, enabled = true): DmSummary | undefined {
  return useQuery({
    ...dmsQuery,
    select: (dms) => dms.find((d) => d.channel.id === channelId),
    enabled,
  }).data;
}

/** 캐시에서 DM 채널을 찾는다 — 채널 상세 캐시, 아니면 DM 목록. 라우터 밖(realtime)에서 부른다 */
export function cachedDmChannel(qc: QueryClient, channelId: string): Channel | undefined {
  const detail = qc.getQueryData<Channel>(qk.channel(channelId));
  if (detail) return isDmChannel(detail) ? detail : undefined;
  return qc.getQueryData<DmSummary[]>(qk.dms)?.find((d) => d.channel.id === channelId)?.channel;
}

/**
 * DM 에 새 글이 왔다(wire `channel.activity` — 본문·시각 없음) — 그 DM 을 목록 맨 위로 올리고 마지막 글 시각을 지금으로 둔다. 서버의
 * 최근 활동순과 같은 자리다. 목록에 없는 채널이면 그대로 둔다(부르는 쪽이 다시 받는다)
 */
export function bumpDm(qc: QueryClient, channelId: string): void {
  qc.setQueryData<DmSummary[]>(qk.dms, (list) => {
    const hit = list?.find((d) => d.channel.id === channelId);
    if (!list || !hit) return list;
    return [{ ...hit, lastMessageAt: new Date().toISOString() }, ...list.filter((d) => d !== hit)];
  });
}

/** DM 목록을 다시 받게 낡은 것으로 둔다 — 보고 있는 사이드바만 곧바로 다시 부른다 */
export const invalidateDms = (qc: QueryClient) => qc.invalidateQueries({ queryKey: qk.dms, exact: true });

/**
 * 지금 내 역할로 이 에이전트와 새 DM 을 열 수 있는가 — 서버 판정(`modules/dms/service.ts`)을 흉내 낸다(고르기 후보·「DM 보내기」 숨김은
 * 편의, 판정은 서버가 403 으로 한다). 보관·꺼진 에이전트는 허용 범위와 상관없이 안 된다(계획 Global Constraints)
 */
export function canOpenDm(agent: Agent, role: string | undefined): boolean {
  if (isArchived(agent) || !agent.enabled) return false;
  const access: DmAccess = agent.dmAccess;
  if (access === "everyone") return roleAtLeast(role, "member");
  if (access === "admins") return roleAtLeast(role, "admin");
  return false;
}

/**
 * `POST /dms { agentId }` — (나, 그 에이전트)의 DM 채널을 찾거나 만든다(계획 판정 PD1). 같은 에이전트를 두 번 열어도 서버가 같은 채널을
 * 돌려준다(멱등) — 그래서 쿼리로 두어 두 번 마운트돼도 요청 하나를 같이 기다린다. 결과는 들고 있지 않는다(열 때마다 새로).
 * 오류는 넘김 화면이 그린다(`silent`), 403·404 는 다시 묻지 않는다
 */
export const openDmQuery = (agentId: string) =>
  queryOptions({
    queryKey: ["dmOpen", agentId] as const,
    queryFn: async () => (await api<{ channel: Channel }>("POST", "/dms", { agentId })).channel,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    meta: { silent: true },
  });
