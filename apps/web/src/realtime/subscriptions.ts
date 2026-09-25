import type { ChannelSubscribeResult, Message, RunState } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { ApiRequestError, api } from "@/api/http";
import { notifyUnauthorized } from "@/app/session";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { qk } from "@/api/queries";
import { applyToChannel, fromLatest, refreshRoots, upsert, upsertMany } from "@/features/messages/timeline";
import { TERMINAL, useRunStore } from "@/features/runs/runStore";
import { createRunReplay } from "./runReplay";
import { getTimeline, updateThread, updateTimeline } from "./timelineCache";
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

  /**
   * 구독을 보내기 **전에** 아는 승인 id. 서버는 룸에 먼저 들어간 뒤 스냅샷을 읽으므로 ack 을 기다리는 사이에
   * 새 `approval.requested` 가 닿을 수 있다 — 그것까지 ack 스냅샷으로 지우면 카드가 조용히 사라진다
   */
  const knownApprovals = (channelId: string): readonly string[] =>
    Object.keys(useApprovalStore.getState().byChannel[channelId] ?? {});

  /** 구독 응답의 스냅샷 — 진행 중 런과 미해결 승인. 재연결한 탭·늦게 연 탭이 여기서 카드를 다시 맞춘다(설계 5.5·6장) */
  async function applySubscribed(
    channelId: string,
    res: ChannelSubscribeResult,
    known: readonly string[],
  ): Promise<void> {
    // ack 의 미해결 목록이 그 채널의 정본이다 — 끊긴 동안 놓친 확정이 미해결 카드로 남지 않게(브라우저 검증 D8).
    // 다만 정본으로 삼는 범위는 구독 전에 알던 것까지다(`known`)
    useApprovalStore.getState().syncPending(channelId, res.pendingApprovals, known);
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

  /**
   * 이 채널의 스레드 캐시를 낡은 것으로 둔다 — 보고 있는 스레드는 곧바로 다시 받고, 닫힌 것은 다시 열 때 받는다.
   * 답글을 다 받았다고 말할 수 없는 재동기화(루트만 싣는 새 구독·REST 이어 받기) 뒤에 부른다
   */
  const staleThreads = (channelId: string) =>
    void qc.invalidateQueries({ queryKey: qk.threads(channelId) }).catch(() => undefined);

  async function fresh(channelId: string): Promise<void> {
    const known = knownApprovals(channelId);
    const had = getTimeline(qc, channelId) !== undefined;
    const res = await emitAck(socket, "channel.subscribe", { channelId });
    updateTimeline(qc, channelId, (prev) => fromLatest(prev, res.messages, res.hasMore));
    // 처음 들어간 채널의 스레드는 방금 REST 로 받는 중이다 — 가진 캐시를 버릴 때만
    if (had) staleThreads(channelId);
    await applySubscribed(channelId, res, known);
  }

  /**
   * lastSeq 재동기화 응답을 나눈다(Review Focus 3): 루트는 채널 타임라인에, 답글은 **연 스레드의 캐시에만**(연 적 없는
   * 스레드의 답글은 버린다), `threadRoots`(끊긴 사이 요약이 바뀐 옛 루트)는 가진 루트를 갈아 끼운다
   */
  function distribute(
    channelId: string,
    messages: readonly Message[],
    threadRoots: readonly Message[],
  ): void {
    updateTimeline(qc, channelId, (prev) => refreshRoots(applyToChannel(prev, messages), threadRoots));
    const replies = new Map<string, Message[]>();
    for (const m of messages) {
      if (m.threadRootId !== undefined)
        replies.set(m.threadRootId, [...(replies.get(m.threadRootId) ?? []), m]);
    }
    for (const [rootId, list] of replies) updateThread(qc, channelId, rootId, (t) => upsertMany(t, list));
    for (const root of [...threadRoots, ...messages.filter((m) => m.threadRootId === undefined)]) {
      updateThread(qc, channelId, root.id, (t) => upsert(t, root));
    }
  }

  /** 가진 것(lastSeq) 뒤를 받아 병합한다. 처음(캐시 없음·lastSeq 0)이면 최근 페이지로 새로 시작한다 */
  async function catchUp(channelId: string): Promise<void> {
    const t = getTimeline(qc, channelId);
    if (!t || t.lastSeq === 0) return fresh(channelId);
    const known = knownApprovals(channelId);
    const res = await emitAck(socket, "channel.subscribe", { channelId, lastSeq: t.lastSeq });
    distribute(channelId, res.messages, res.threadRoots ?? []);
    await applySubscribed(channelId, res, known);
    let hasMore = res.hasMore;
    // REST 이어 받기는 루트만 준다 — 그 사이 답글은 스레드 캐시가 다시 받는다
    if (hasMore) staleThreads(channelId);
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
