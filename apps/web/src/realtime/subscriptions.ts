import type { ChannelSubscribeResult, Message, RunState } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { applyToTimeline, refreshRoots, upsert, upsertMany } from "@/features/messages/timeline";
import { TERMINAL, useRunStore } from "@/features/runs/runStore";
import { createRunReplay } from "./runReplay";
import {
  dropChannelCaches,
  getChannelSeq,
  noteChannelSeq,
  patchTimeline,
  setChannelSeq,
  staleChannelCaches,
  updateThread,
} from "./timelineCache";
import { emitAck, type WireSocket } from "./wire";

/** 쌓인 텍스트가 있을 수 있는 상태 — 입장 때 처음부터 재생한다 */
const REPLAY_STATUSES: ReadonlySet<RunState["status"]> = new Set([
  "streaming",
  "tool",
  "finalizing",
  "awaiting_approval",
]);

/** 히스토리 쪽 인자 — `around` 는 그 seq 를 가운데 둔 한 쪽(결과로 가기)이라 before·after 와 함께 쓰지 않는다 */
export type PageQuery = { afterSeq?: number; beforeSeq?: number; around?: number; limit: number };
/** `hasMoreAfter` 는 around 페이지에만 — 더 새것이 있다 */
export type FetchPage = (
  conversationId: string,
  q: PageQuery,
) => Promise<{ messages: Message[]; hasMore: boolean; hasMoreAfter?: boolean }>;

export function pageParams(q: PageQuery): URLSearchParams {
  const params = new URLSearchParams({ limit: String(q.limit) });
  if (q.afterSeq !== undefined) params.set("afterSeq", String(q.afterSeq));
  if (q.beforeSeq !== undefined) params.set("beforeSeq", String(q.beforeSeq));
  if (q.around !== undefined) params.set("around", String(q.around));
  return params;
}

/** REST `GET /conversations/:id/messages` — 세션의 첫 페이지·과거 페이지(beforeSeq)·아래로 이어 받기(afterSeq)·결과로 가기(around) */
export const restFetchPage: FetchPage = (conversationId, q) =>
  api("GET", `/conversations/${conversationId}/messages?${pageParams(q)}`);

export type Subscriptions = ReturnType<typeof createSubscriptions>;

/**
 * 채널 구독 관리자(스펙 4.3·채널 세션 계획 판정 PS6). 한 번에 한 채널(지금 보는 채널)만 구독한다 — 그 채널의 모든 세션 이벤트가
 * 채널 룸 하나로 온다. 처음 구독은 메시지 없이 채널 커서(`qk.channelSeq`)만 세운다 — 세션의 첫 페이지는 세션 타임라인 쿼리가 REST 로
 * 받는다(`useTimeline` — 커서가 선 뒤에만 부른다: 룸에 들어간 뒤 읽어야 그 사이 글이 빠지지 않는다). 진행 중 런은 런 스토어에 넣는다.
 * `runReplay` 는 핸들러가 실시간 `run.event`·resync 를 같은 버퍼로 흘리는 데 쓴다.
 */
export function createSubscriptions(deps: { socket: WireSocket; queryClient: QueryClient }) {
  const { socket, queryClient: qc } = deps;
  const runReplay = createRunReplay(socket);
  let current: string | undefined;
  // 채널 커서는 관찰자가 없는 동안에도 남아야 한다 — 기본 gcTime(5분) 뒤 빠지면 다음 입장이 처음 구독처럼 캐시를 모두 다시 받는다
  qc.setQueryDefaults(["channelSeq"], { gcTime: Number.POSITIVE_INFINITY });

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
   * 이 연결에서 처음 들어간 채널 — 메시지 없이 커서만 세운다. 이 연결 전에 받아 둔 세션·스레드 캐시(사본 복원·지난 연결)는 그 사이의
   * 글을 모르니 낡은 것으로 둔다 — 커서보다 먼저: 커서가 서는 순간 지금 세션의 타임라인 쿼리가 켜지며 곧바로 다시 받는다
   */
  async function fresh(channelId: string): Promise<void> {
    const known = knownApprovals(channelId);
    const res = await emitAck(socket, "channel.subscribe", { channelId });
    staleChannelCaches(qc, channelId);
    setChannelSeq(qc, channelId, res.latestSeq);
    await applySubscribed(channelId, res, known);
  }

  /**
   * lastSeq 재동기화 응답을 나눈다(Review Focus 3·계획 판정 PS6): 메시지는 그 세션의 타임라인에(받은 적 있는 세션만 — 루트는 병합하고
   * 답글은 seq 만), 답글은 **연 스레드의 캐시에만**(연 적 없는 스레드의 답글은 버린다), `threadRoots`(끊긴 사이 요약이 바뀐 옛 루트)는
   * 그 세션 타임라인이 가진 루트를 갈아 끼운다
   */
  function distribute(
    channelId: string,
    messages: readonly Message[],
    threadRoots: readonly Message[],
  ): void {
    const group = (list: readonly Message[], key: (m: Message) => string) => {
      const out = new Map<string, Message[]>();
      for (const m of list) out.set(key(m), [...(out.get(key(m)) ?? []), m]);
      return out;
    };
    const byConversation = group(messages, (m) => m.conversationId);
    const rootsByConversation = group(threadRoots, (m) => m.conversationId);
    for (const conversationId of new Set([...byConversation.keys(), ...rootsByConversation.keys()])) {
      const list = byConversation.get(conversationId) ?? [];
      const roots = rootsByConversation.get(conversationId) ?? [];
      patchTimeline(qc, channelId, conversationId, (prev) =>
        refreshRoots(applyToTimeline(prev, list), roots),
      );
    }
    for (const [rootId, list] of group(
      messages.filter((m) => m.threadRootId !== undefined),
      (m) => m.threadRootId ?? "",
    )) {
      const conversationId = list[0]?.conversationId ?? "";
      updateThread(qc, channelId, conversationId, rootId, (t) => upsertMany(t, list));
    }
    for (const root of [...threadRoots, ...messages.filter((m) => m.threadRootId === undefined)]) {
      updateThread(qc, channelId, root.conversationId, root.id, (t) => upsert(t, root));
    }
  }

  /**
   * 본 것(채널 커서) 뒤를 받아 세션별로 나눈다. 처음(커서 없음)이면 `fresh`. 끊긴 사이의 글이 한 쪽(200)을 넘으면(`hasMore` — Review
   * Focus 5) 이어 받지 않는다: 그 채널의 세션·스레드 캐시를 모두 버리고(지금 세션만 곧바로 다시 받는다) 커서를 서버가 아는 끝으로 맞춘다.
   * 다른 세션은 열 때 받는다 — 여러 세션에 흩어진 빈틈을 채널 이어 받기로 메우던 쪽 수(옛 `MAX_PAGES`)는 채널 경로 REST 와 함께 걷었다
   */
  async function catchUp(channelId: string): Promise<void> {
    const seen = getChannelSeq(qc, channelId);
    if (seen === undefined) return fresh(channelId);
    const known = knownApprovals(channelId);
    const res = await emitAck(socket, "channel.subscribe", { channelId, lastSeq: seen });
    if (res.hasMore) {
      dropChannelCaches(qc, channelId);
      setChannelSeq(qc, channelId, Math.max(seen, res.latestSeq));
    } else {
      distribute(channelId, res.messages, res.threadRoots ?? []);
      // 커서는 서버가 아는 끝까지 — 읽은 뒤에 생긴 글은 룸 이벤트로 온다(서버는 룸에 먼저 들어간 뒤 읽는다)
      noteChannelSeq(qc, channelId, res.latestSeq);
    }
    await applySubscribed(channelId, res, known);
  }

  return {
    /**
     * 채널에 들어간다 — 커서가 있으면 그 뒤를 이어 받는다(스펙 4.3-1·5). 연결 전·끊긴 동안은 채널만 기억한다:
     * socket.io 는 보내지 못한 ack 요청을 버퍼에 두다 시간 초과로 버리므로, 붙은 뒤 `resubscribeAll` 이 구독한다
     */
    async enter(channelId: string): Promise<void> {
      current = channelId;
      if (socket.connected) await catchUp(channelId);
    },
    /** 채널을 떠난다. 캐시·커서는 남긴다(되돌아오면 곧바로 보이고 커서로 맞춘다). 끊긴 동안은 서버 쪽 룸도 없다 */
    leave(channelId: string): void {
      if (current === channelId) current = undefined;
      if (socket.connected) void emitAck(socket, "channel.unsubscribe", { channelId }).catch(() => undefined);
    },
    catchUp,
    /** 붙을 때마다(처음 포함): 보고 있는 채널을 커서로 다시 맞춘다(스펙 4.2) */
    async resubscribeAll(): Promise<void> {
      if (current) await catchUp(current);
    },
    active: (): string | undefined => current,
    runReplay,
  };
}
