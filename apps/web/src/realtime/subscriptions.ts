import type { ChannelSubscribeResult, Message, RunState } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { ApiRequestError, api } from "@/api/http";
import { notifyUnauthorized } from "@/app/session";
import { fromLatest, upsertMany } from "@/features/messages/timeline";
import { TERMINAL, useRunStore } from "@/features/runs/runStore";
import { createRunReplay } from "./runReplay";
import { getTimeline, updateTimeline } from "./timelineCache";
import { emitAck, type WireSocket } from "./wire";

const PAGE = 200;
/** 빈틈을 이어 받는 최대 쪽 수(구독 1 + REST). 넘기면 타임라인을 버리고 처음부터(스펙 4.3-4) */
const MAX_PAGES = 5;
/** 쌓인 텍스트가 있을 수 있는 상태 — 입장 때 처음부터 재생한다 */
const REPLAY_STATUSES: ReadonlySet<RunState["status"]> = new Set([
  "streaming",
  "tool",
  "finalizing",
  "awaiting_approval",
]);

export type FetchPage = (
  channelId: string,
  q: { afterSeq?: number; beforeSeq?: number; limit: number },
) => Promise<{ messages: Message[]; hasMore: boolean }>;

/** REST `GET /channels/:id/messages` — 빈틈 이어 받기(afterSeq)와 과거 페이지(beforeSeq) */
export const restFetchPage: FetchPage = (channelId, q) => {
  const params = new URLSearchParams({ limit: String(q.limit) });
  if (q.afterSeq !== undefined) params.set("afterSeq", String(q.afterSeq));
  if (q.beforeSeq !== undefined) params.set("beforeSeq", String(q.beforeSeq));
  return api("GET", `/channels/${channelId}/messages?${params}`);
};

/** REST 직접 호출이라 Query 의 전역 401 처리를 타지 않는다 — 401 이면 로그인으로(스펙 8장) 보내고 오류는 그대로 올린다 */
function toLoginOn401(e: unknown): never {
  if (e instanceof ApiRequestError && e.status === 401) notifyUnauthorized();
  throw e;
}

export type Subscriptions = ReturnType<typeof createSubscriptions>;

/**
 * 채널 구독 관리자(스펙 4.3). 한 번에 한 채널(지금 보는 채널)만 구독한다. 타임라인은 Query 캐시에,
 * 진행 중 런은 런 스토어에 넣는다. `runReplay` 는 핸들러가 실시간 `run.event`·resync 를 같은 버퍼로 흘리는 데 쓴다.
 */
export function createSubscriptions(deps: {
  socket: WireSocket;
  queryClient: QueryClient;
  fetchPage?: FetchPage;
}) {
  const { socket, queryClient: qc } = deps;
  const fetchPage = deps.fetchPage ?? restFetchPage;
  const runReplay = createRunReplay(socket);
  let current: string | undefined;

  async function applyRuns(channelId: string, res: ChannelSubscribeResult): Promise<void> {
    const store = useRunStore.getState();
    // 그 채널에서 진행 중이던 런이 activeRuns 에 없으면 끊긴 사이 끝난 것 — 버블이 남지 않게 뺀다(답은 메시지로 온다)
    const active = new Set(res.activeRuns.map((r) => r.id));
    for (const v of Object.values(store.runs)) {
      if (v.state.channelId === channelId && !TERMINAL.has(v.state.status) && !active.has(v.state.id))
        store.remove(v.state.id);
    }
    for (const run of res.activeRuns) store.applyState(run);
    await Promise.all(res.activeRuns.filter((r) => REPLAY_STATUSES.has(r.status)).map(runReplay.fromStart));
  }

  async function fresh(channelId: string): Promise<void> {
    const res = await emitAck(socket, "channel.subscribe", { channelId });
    updateTimeline(qc, channelId, (prev) => fromLatest(prev, res.messages, res.hasMore));
    await applyRuns(channelId, res);
  }

  /** 가진 것(lastSeq) 뒤를 받아 병합한다. 처음(캐시 없음·lastSeq 0)이면 최근 페이지로 새로 시작한다 */
  async function catchUp(channelId: string): Promise<void> {
    const t = getTimeline(qc, channelId);
    if (!t || t.lastSeq === 0) return fresh(channelId);
    const res = await emitAck(socket, "channel.subscribe", { channelId, lastSeq: t.lastSeq });
    updateTimeline(qc, channelId, (prev) => upsertMany(prev, res.messages));
    await applyRuns(channelId, res);
    let hasMore = res.hasMore;
    for (let pages = 1; hasMore; pages += 1) {
      if (pages >= MAX_PAGES) return fresh(channelId);
      const lastSeq = getTimeline(qc, channelId)?.lastSeq ?? 0;
      const page = await fetchPage(channelId, { afterSeq: lastSeq, limit: PAGE }).catch(toLoginOn401);
      updateTimeline(qc, channelId, (prev) => upsertMany(prev, page.messages));
      hasMore = page.hasMore;
    }
  }

  return {
    /**
     * 채널에 들어간다 — 캐시가 있으면 lastSeq 로 이어 받는다(스펙 4.3-1·5). 연결 전·끊긴 동안은 채널만 기억한다:
     * socket.io 는 보내지 못한 ack 요청을 버퍼에 두다 시간 초과로 버리므로, 붙은 뒤 `resubscribeAll` 이 구독한다
     */
    async enter(channelId: string): Promise<void> {
      current = channelId;
      if (socket.connected) await catchUp(channelId);
    },
    /** 채널을 떠난다. 캐시는 남긴다(되돌아오면 곧바로 보이고 lastSeq 로 맞춘다). 끊긴 동안은 서버 쪽 룸도 없다 */
    leave(channelId: string): void {
      if (current === channelId) current = undefined;
      if (socket.connected) void emitAck(socket, "channel.unsubscribe", { channelId }).catch(() => undefined);
    },
    catchUp,
    /** 붙을 때마다(처음 포함): 보고 있는 채널을 lastSeq 로 다시 맞춘다(스펙 4.2) */
    async resubscribeAll(): Promise<void> {
      if (current) await catchUp(current);
    },
    active: (): string | undefined => current,
    runReplay,
  };
}
