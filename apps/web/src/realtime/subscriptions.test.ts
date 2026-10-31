import { type ChannelSubscribeResult, ComponentsV1, type Message, type Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { fromLatest, threadFromPage } from "@/features/messages/timeline";
import { useTimelineState } from "@/features/messages/useTimeline";
import { useRunStore } from "@/features/runs/runStore";
import { createFakeSocket } from "../../test/fakeSocket";
import {
  APPROVAL,
  APPROVAL2,
  approval,
  CH,
  CH2,
  msg,
  RUN,
  RUN2,
  runState,
  textDelta,
  uid,
} from "../../test/fixtures";
import { createSubscriptions, restFetchPage } from "./subscriptions";
import { getChannelSeq, getThread, getTimeline, setChannelSeq, updateTimeline } from "./timelineCache";

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const subscribed = (messages: Message[], over: Partial<ChannelSubscribeResult> = {}) =>
  ok<ChannelSubscribeResult>({
    messages,
    hasMore: false,
    latestSeq: messages.reduce((n, m) => Math.max(n, m.seq), 0),
    activeRuns: [],
    pendingApprovals: [],
    ...over,
  });
/** 같은 채널의 둘째 세션 — 픽스처의 기본 세션은 채널 id 와 같은 「이전 대화」다 */
const B = uid(3_001);
const inB = (seq: number, over: Partial<Message> = {}) =>
  msg(seq, { conversationId: B, id: uid(30_000 + seq), ...over });
const seqs = (qc: QueryClient, conversationId = CH, channelId = CH) =>
  getTimeline(qc, channelId, conversationId)?.items.map((m) => m.seq);

function setup() {
  const fake = createFakeSocket();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const subs = createSubscriptions({ socket: fake.wire, queryClient });
  fake.onAck("channel.unsubscribe", () => ok(null));
  fake.socket.connected = true;
  return { fake, queryClient, subs };
}

/** 캐시에 이미 받아 둔 세션(앞서 본 세션) */
const seed = (qc: QueryClient, messages: Message[], channelId = CH, conversationId = channelId) =>
  updateTimeline(qc, channelId, conversationId, (t) => fromLatest(t, messages, false));

/** 세션 REST(`GET /conversations/:id/messages`)를 가짜로 — 세션 id 마다 그 쪽 */
function stubConversationRest(pages: Record<string, Message[]>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      calls.push(url);
      const id = /\/conversations\/([^/]+)\/messages/.exec(url)?.[1] ?? "";
      return new Response(JSON.stringify({ messages: pages[id] ?? [], hasMore: false }), { status: 200 });
    }),
  );
  return calls;
}

const wrapper =
  (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);

beforeEach(() => {
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
});
afterEach(() => vi.unstubAllGlobals());

describe("createSubscriptions", () => {
  it("처음 들어가면 lastSeq 없이 구독해 메시지 없이 채널 커서만 세운다(판정 PS5) — 진행 중 런은 처음부터 재생해 텍스트를 쌓는다", async () => {
    const { fake, queryClient, subs } = setup();
    fake.onAck("channel.subscribe", () =>
      subscribed([], {
        latestSeq: 41,
        activeRuns: [runState({ id: RUN, status: "streaming" }), runState({ id: RUN2, status: "queued" })],
      }),
    );
    fake.onAck("run.events.replay", () =>
      ok({ run: runState({ id: RUN }), events: [textDelta(1, "안"), textDelta(2, "녕")] }),
    );

    await subs.enter(CH);

    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }]);
    expect(getChannelSeq(queryClient, CH)).toBe(41);
    // 세션 타임라인은 구독이 만들지 않는다 — 그 세션의 쿼리가 REST 로 받는다
    expect(getTimeline(queryClient, CH, CH)).toBeUndefined();
    // queued 런은 쌓인 텍스트가 없다 — 재생하지 않는다
    expect(fake.sentOf("run.events.replay")).toEqual([{ runId: RUN, afterSeq: 0 }]);
    expect(useRunStore.getState().runs[RUN]).toMatchObject({ text: "안녕", lastEventSeq: 2 });
    expect(useRunStore.getState().runs[RUN2]?.state.status).toBe("queued");
    expect(subs.active()).toBe(CH);
  });

  it("세션의 첫 페이지는 구독이 커서를 세운 뒤에야 세션 REST 로 받는다 — 룸에 들어가기 전에 읽은 페이지는 그 사이 글이 빠진다", async () => {
    const { fake, queryClient, subs } = setup();
    const calls = stubConversationRest({ [B]: [inB(5), inB(9)] });
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 9 }));
    const { result } = renderHook(() => useTimelineState(CH, B), { wrapper: wrapper(queryClient) });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([]);
    expect(result.current.timeline).toBeUndefined();

    await subs.enter(CH);

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(calls).toEqual([`/api/v1/conversations/${B}/messages?limit=200`]);
    expect(result.current.timeline?.items.map((m) => m.seq)).toEqual([5, 9]);
    // 다른 세션(채널의 「이전 대화」)은 받지 않았다
    expect(getTimeline(queryClient, CH, CH)).toBeUndefined();
  });

  it("커서가 있는 채널에 다시 들어가면 그 커서로 구독하고, 응답을 세션별 캐시로 나눈다 — 받은 적 없는 세션은 만들지 않는다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1), msg(2)]);
    setChannelSeq(queryClient, CH, 2);
    fake.onAck("channel.subscribe", () => subscribed([inB(3), msg(4)], { latestSeq: 6 }));

    await subs.enter(CH);

    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 2 }]);
    expect(seqs(queryClient)).toEqual([1, 2, 4]);
    expect(getTimeline(queryClient, CH, B)).toBeUndefined();
    // 커서는 서버가 아는 끝까지 — 읽은 뒤의 글은 룸 이벤트로 온다
    expect(getChannelSeq(queryClient, CH)).toBe(6);
  });

  it("재동기화 응답을 세션별로 나눈다 — 받아 둔 두 세션에 각자의 글만", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1)]);
    seed(queryClient, [inB(2)], CH, B);
    setChannelSeq(queryClient, CH, 2);
    fake.onAck("channel.subscribe", () => subscribed([msg(3), inB(4), msg(5), inB(6)]));

    await subs.catchUp(CH);

    expect(seqs(queryClient)).toEqual([1, 3, 5]);
    expect(seqs(queryClient, B)).toEqual([2, 4, 6]);
  });

  it("[Review Focus 5] 재동기화가 hasMore 면 그 채널의 세션·스레드 캐시를 모두 버리고 지금 세션만 다시 받는다 — 커서는 서버가 아는 끝, 다른 채널은 그대로", async () => {
    const { fake, queryClient, subs } = setup();
    const calls = stubConversationRest({ [CH]: [msg(1), msg(250)] });
    seed(queryClient, [msg(1)]);
    seed(queryClient, [inB(2)], CH, B);
    queryClient.setQueryData(qk.thread(CH, B, inB(2).id), threadFromPage(undefined, inB(2), [], false));
    seed(queryClient, [msg(1, { channelId: CH2, id: uid(20_001) })], CH2);
    setChannelSeq(queryClient, CH, 2);
    fake.onAck("channel.subscribe", () => subscribed([inB(3), msg(4)], { hasMore: true, latestSeq: 250 }));
    // 지금 보는 세션(CH 의 「이전 대화」) — 구독한 채널이라 받기가 켜져 있다
    const { result } = renderHook(() => useTimelineState(CH, CH), { wrapper: wrapper(queryClient) });

    await subs.catchUp(CH);

    expect(getTimeline(queryClient, CH, B)).toBeUndefined();
    expect(getThread(queryClient, CH, B, inB(2).id)).toBeUndefined();
    await waitFor(() => expect(result.current.timeline?.items.map((m) => m.seq)).toEqual([1, 250]));
    expect(calls).toEqual([`/api/v1/conversations/${CH}/messages?limit=200`]);
    expect(getChannelSeq(queryClient, CH)).toBe(250);
    expect(seqs(queryClient, CH2, CH2)).toEqual([1]);
    // 채널 경로 이어 받기(옛 MAX_PAGES)는 없다 — 구독은 한 번
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 2 }]);
  });

  it("[Review Focus 5] 버릴 때도 보내는 중 항목이 든 세션은 지우지 않고 낡은 것으로만 둔다 — ack 를 기다리는 항목이 사라지지 않게", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [inB(2)], CH, B);
    updateTimeline(queryClient, CH, B, (t) => ({
      ...t,
      pending: [
        {
          clientMsgId: "c1",
          channelId: CH,
          bodyMd: "보내는 중",
          createdAt: msg(2).createdAt,
          state: "sending",
        },
      ],
    }));
    setChannelSeq(queryClient, CH, 2);
    fake.onAck("channel.subscribe", () => subscribed([msg(3)], { hasMore: true, latestSeq: 300 }));

    await subs.catchUp(CH);

    expect(getTimeline(queryClient, CH, B)?.pending.map((p) => p.clientMsgId)).toEqual(["c1"]);
    expect(queryClient.getQueryState(qk.timeline(CH, B))?.isInvalidated).toBe(true);
  });

  it("처음 구독(커서 없음)은 그 채널에 받아 둔 세션·스레드 캐시를 낡은 것으로 둔다 — 사본에서 복원한 캐시는 그 사이 글을 모른다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1)]);
    seed(queryClient, [inB(2)], CH, B);
    queryClient.setQueryData(qk.thread(CH, CH, msg(1).id), threadFromPage(undefined, msg(1), [], false));
    seed(queryClient, [msg(1, { channelId: CH2, id: uid(20_001) })], CH2);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 7 }));

    await subs.enter(CH);

    expect(queryClient.getQueryState(qk.timeline(CH, CH))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.timeline(CH, B))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.thread(CH, CH, msg(1).id))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.timeline(CH2, CH2))?.isInvalidated).toBe(false);
  });

  it("leave: channel.unsubscribe 를 보내고 캐시·커서는 남기며 active 는 비운다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1)]);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 1 }));
    await subs.enter(CH);

    subs.leave(CH);

    expect(fake.sentOf("channel.unsubscribe")).toEqual([{ channelId: CH }]);
    expect(seqs(queryClient)).toEqual([1]);
    expect(getChannelSeq(queryClient, CH)).toBe(1);
    expect(subs.active()).toBeUndefined();
  });

  it("연결 전(또는 끊긴 동안) enter·leave 는 보내지 않고 채널만 기억한다 — 붙으면 resubscribeAll 이 구독한다", async () => {
    const { fake, queryClient, subs } = setup();
    fake.socket.connected = false;
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 1 }));

    await subs.enter(CH2);
    subs.leave(CH2);
    await subs.enter(CH);
    expect(fake.sent).toEqual([]);
    expect(subs.active()).toBe(CH);

    fake.socket.connected = true;
    await subs.resubscribeAll();
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }]);
    expect(getChannelSeq(queryClient, CH)).toBe(1);
    expect(getChannelSeq(queryClient, CH2)).toBeUndefined();
  });

  it("resubscribeAll: 지금 보고 있는 채널만 커서로 다시 맞춘다 — 떠난 채널은 건드리지 않는다", async () => {
    const { fake, queryClient, subs } = setup();
    setChannelSeq(queryClient, CH, 1);
    setChannelSeq(queryClient, CH2, 1);
    fake.onAck("channel.subscribe", () => subscribed([]));
    await subs.enter(CH2);
    subs.leave(CH2);
    await subs.enter(CH);
    fake.sent.length = 0;

    await subs.resubscribeAll();
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 1 }]);

    subs.leave(CH);
    fake.sent.length = 0;
    await subs.resubscribeAll();
    expect(fake.sentOf("channel.subscribe")).toEqual([]);
  });

  it("구독 응답의 activeRuns 에 없는 그 채널의 진행 중 런은 끝난 것이다 — 런 스토어에서 뺀다(끊긴 사이 끝난 런)", async () => {
    const { fake, subs } = setup();
    const DONE = uid(103);
    const store = useRunStore.getState();
    store.applyState(runState({ id: RUN, status: "streaming" }));
    store.applyState(runState({ id: DONE, status: "done" }));
    store.applyState(runState({ id: RUN2, channelId: CH2, status: "streaming" }));
    fake.onAck("channel.subscribe", () => subscribed([]));

    await subs.enter(CH);

    const runs = useRunStore.getState().runs;
    expect(runs[RUN]).toBeUndefined();
    // 종료 상태 런은 버블 정리(태스크 8)가, 다른 채널 런은 그 채널이 맡는다
    expect(runs[DONE]?.state.status).toBe("done");
    expect(runs[RUN2]?.state.status).toBe("streaming");
  });

  it("구독 응답의 pendingApprovals 로 승인 카드를 맞춘다 — 늦게 연 탭·재연결한 탭이 카드를 본다", async () => {
    const { fake, subs } = setup();
    fake.onAck("channel.subscribe", () =>
      subscribed([msg(1)], { pendingApprovals: [approval(), approval({ id: APPROVAL2 })] }),
    );

    await subs.enter(CH);

    expect(Object.keys(useApprovalStore.getState().byChannel[CH] ?? {})).toEqual([APPROVAL, APPROVAL2]);
  });

  it("재구독 ack 는 미해결의 정본이다 — 끊긴 동안 확정된 승인은 옛 탭에서도 닫힌다(D8)", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1)]);
    // 끊기기 전에 보고 있던 미해결 카드 둘
    useApprovalStore.getState().apply(approval());
    useApprovalStore.getState().apply(approval({ id: APPROVAL2 }));
    // 끊긴 사이 APPROVAL 이 확정됐다 — 다시 붙은 ack 에는 남은 것만 온다
    fake.onAck("channel.subscribe", () =>
      subscribed([], { pendingApprovals: [approval({ id: APPROVAL2 })] }),
    );

    await subs.enter(CH);

    expect(Object.keys(useApprovalStore.getState().byChannel[CH] ?? {})).toEqual([APPROVAL2]);
  });

  /**
   * 서버는 룸에 **먼저 들어간 뒤** 스냅샷을 읽는다(`apps/server/src/realtime/socket.ts` — 메시지가 빠지지 않게
   * 일부러 그 순서다). 그래서 스냅샷을 읽은 뒤 ack 이 닿기 전에 새 `approval.requested` 가 먼저 도착할 수 있다.
   * ack 의 정본화가 그 승인까지 지우면 카드가 조용히 사라지고 사용자는 요구를 못 본 채 런이 만료된다
   */
  it("ack 을 기다리는 사이에 온 승인은 ack 스냅샷에 없어도 남는다", async () => {
    const { fake, subs } = setup();
    fake.onAck("channel.subscribe", () => {
      // 구독을 보낸 뒤·ack 이 오기 전에 닿은 프레임
      useApprovalStore.getState().apply(approval({ id: APPROVAL2 }));
      return subscribed([msg(1)], { pendingApprovals: [] });
    });

    await subs.enter(CH);

    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL2]?.approval.status).toBe("pending");
  });

  /**
   * 재연결(이어 받기)에서도 같다 — 오히려 여기가 실물에서 더 잦다: 다시 붙는 순간 서버가 룸에 넣고,
   * 그 룸에 새 승인이 방송되고, ack 은 그 뒤에 닿는다. 끊긴 동안 확정된 옛 카드는 여전히 닫혀야 한다
   */
  it("이어 받기에서도 ack 을 기다리는 사이에 온 승인은 남고, 끊긴 동안 확정된 옛 카드는 닫힌다", async () => {
    const { fake, queryClient, subs } = setup();
    setChannelSeq(queryClient, CH, 1);
    // 끊기기 전에 보고 있던 미해결 카드 — 그 사이 확정됐고 ack 에는 오지 않는다
    useApprovalStore.getState().apply(approval());
    fake.onAck("channel.subscribe", () => {
      useApprovalStore.getState().apply(approval({ id: APPROVAL2 }));
      return subscribed([msg(2)], { pendingApprovals: [] });
    });

    await subs.enter(CH);

    expect(Object.keys(useApprovalStore.getState().byChannel[CH] ?? {})).toEqual([APPROVAL2]);
  });

  it("이어 받기(lastSeq) 구독에서도 pendingApprovals 를 반영한다 — 끊긴 사이 온 승인", async () => {
    const { fake, queryClient, subs } = setup();
    setChannelSeq(queryClient, CH, 1);
    fake.onAck("channel.subscribe", () => subscribed([msg(2)], { pendingApprovals: [approval()] }));

    await subs.enter(CH);

    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 1 }]);
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.approval.status).toBe("pending");
  });
});

describe("재동기화의 스레드(Review Focus 3 — 끊긴 사이 온 스레드 답글)", () => {
  const ROOT = msg(1);
  const OTHER = msg(2);
  const reply = (seq: number, root = ROOT) => msg(seq, { threadRootId: root.id });
  const summary = (count: number, at: number) => ({ count, lastAt: msg(at).createdAt, agentIds: [] });
  const openThread = (qc: QueryClient) =>
    qc.setQueryData(qk.thread(CH, CH, ROOT.id), threadFromPage(undefined, ROOT, [reply(3)], false));

  it("답글은 연 스레드 캐시에, 닫힌 스레드의 답글은 버리고 요약(threadRoots)만 세션 캐시의 루트에", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [ROOT, OTHER]);
    setChannelSeq(queryClient, CH, 3);
    openThread(queryClient);
    const root = msg(1, { threadSummary: summary(2, 5) });
    const other = msg(2, { threadSummary: summary(1, 6) });
    fake.onAck("channel.subscribe", () =>
      subscribed([reply(5), reply(6, OTHER), msg(7)], { threadRoots: [root, other] }),
    );

    await subs.catchUp(CH);

    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 3 }]);
    // 세션: 루트만, 요약은 새것, lastSeq 는 답글까지
    const t = getTimeline(queryClient, CH, CH);
    expect(t?.items.map((m) => m.seq)).toEqual([1, 2, 7]);
    expect(t?.items[0]?.threadSummary).toEqual(summary(2, 5));
    expect(t?.items[1]?.threadSummary).toEqual(summary(1, 6));
    expect(t?.lastSeq).toBe(7);
    // 연 스레드: 답글이 들어오고 루트의 요약도 맞다
    const thread = getThread(queryClient, CH, CH, ROOT.id);
    expect(thread?.items.map((m) => m.seq)).toEqual([1, 3, 5]);
    expect(thread?.items[0]?.threadSummary).toEqual(summary(2, 5));
    // 닫힌 스레드는 캐시를 만들지 않는다
    expect(getThread(queryClient, CH, CH, OTHER.id)).toBeUndefined();
  });

  it("다른 세션의 답글·요약은 그 세션의 캐시로만 — 같은 루트 id 자리가 아니라 그 세션의 연 스레드에", async () => {
    const { fake, queryClient, subs } = setup();
    const rootB = inB(2);
    seed(queryClient, [ROOT]);
    seed(queryClient, [rootB], CH, B);
    setChannelSeq(queryClient, CH, 3);
    openThread(queryClient);
    queryClient.setQueryData(qk.thread(CH, B, rootB.id), threadFromPage(undefined, rootB, [], false));
    const replyB = inB(4, { threadRootId: rootB.id });
    fake.onAck("channel.subscribe", () =>
      subscribed([replyB], { threadRoots: [inB(2, { threadSummary: summary(1, 4) })] }),
    );

    await subs.catchUp(CH);

    expect(getThread(queryClient, CH, B, rootB.id)?.items.map((m) => m.seq)).toEqual([2, 4]);
    expect(getThread(queryClient, CH, CH, ROOT.id)?.items.map((m) => m.seq)).toEqual([1, 3]);
    expect(getTimeline(queryClient, CH, B)?.items[0]?.threadSummary).toEqual(summary(1, 4));
    expect(getTimeline(queryClient, CH, B)?.lastSeq).toBe(4);
    expect(getTimeline(queryClient, CH, CH)?.lastSeq).toBe(1);
  });
});

describe("재진입 때 보이는 세션의 최신 한 쪽으로 가진 메시지를 갈아 끼운다(plan.md 이월 「lastSeq 재구독이 옛 카드의 결과 줄을 갱신하지 않는다」)", () => {
  const FUTURE = "2099-01-01T00:00:00.000Z";
  /** 버튼 하나짜리 카드 — 떠나 있는 사이 다른 탭이 눌러 결과 줄(interactions)·소비(consumed)가 생긴다 */
  const card = (pressed: boolean): Message =>
    msg(2, {
      bodyMd: "배포할까요?",
      components: ComponentsV1.parse({
        id: "cmp_1",
        blocks: [{ type: "actions", items: [{ type: "button", id: "ok", label: "배포" }] }],
      }),
      componentState: { expiresAt: FUTURE, consumed: pressed ? ["ok"] : [] },
      interactions: pressed
        ? [
            {
              id: uid(9_001),
              componentId: "ok",
              userId: uid(9_002),
              itemId: "ok",
              values: {},
              createdAt: "2027-01-15T08:01:00.000Z",
            },
          ]
        : [],
    });
  /** 그 세션을 보고 있다(관찰자) — 캐시를 채운 뒤 훅으로 붙는다 */
  async function watching(qc: QueryClient, conversationId = CH) {
    const view = renderHook(() => useTimelineState(CH, conversationId), { wrapper: wrapper(qc) });
    await waitFor(() => expect(view.result.current.timeline).toBeDefined());
    return view;
  }
  const latest = (id: string) => `/api/v1/conversations/${id}/messages?limit=200`;

  it("떠난 사이 다른 탭이 누른 카드 — 재진입하면 결과 줄·consumed 가 맞는다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1), card(false)]);
    setChannelSeq(queryClient, CH, 2);
    const calls = stubConversationRest({ [CH]: [msg(1), card(true)] });
    await watching(queryClient);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 2 }));

    await subs.enter(CH);

    await waitFor(() =>
      expect(getTimeline(queryClient, CH, CH)?.items[1]?.componentState?.consumed).toEqual(["ok"]),
    );
    expect(getTimeline(queryClient, CH, CH)?.items[1]?.interactions).toHaveLength(1);
    expect(calls).toEqual([latest(CH)]);
  });

  it("반응·본문 고침도 함께 갈아 끼운다 — 같은 응답에 실린, 이미 가진 메시지면 카드가 아니어도", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1, { bodyMd: "옛 본문" }), msg(2)]);
    setChannelSeq(queryClient, CH, 2);
    stubConversationRest({
      [CH]: [
        msg(1, { bodyMd: "고친 본문" }),
        msg(2, { reactions: [{ emoji: "👍", count: 1, userIds: [uid(9_002)] }] }),
      ],
    });
    await watching(queryClient);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 2 }));

    await subs.enter(CH);

    await waitFor(() => expect(getTimeline(queryClient, CH, CH)?.items[0]?.bodyMd).toBe("고친 본문"));
    expect(getTimeline(queryClient, CH, CH)?.items[1]?.reactions).toEqual([
      { emoji: "👍", count: 1, userIds: [uid(9_002)] },
    ]);
  });

  it("캐시에 없는 메시지는 넣지 않는다 — 이어 받기의 몫이다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(5), msg(6)]);
    setChannelSeq(queryClient, CH, 6);
    const calls = stubConversationRest({ [CH]: [msg(3), msg(4), msg(5, { bodyMd: "새 본문" }), msg(6)] });
    await watching(queryClient);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 6 }));

    await subs.enter(CH);

    await waitFor(() => expect(calls).toEqual([latest(CH)]));
    await waitFor(() => expect(getTimeline(queryClient, CH, CH)?.items[0]?.bodyMd).toBe("새 본문"));
    expect(seqs(queryClient)).toEqual([5, 6]);
  });

  it("관찰자 없는 세션(받아 둔 다른 세션)은 부르지 않는다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1)]);
    seed(queryClient, [inB(2)], CH, B);
    setChannelSeq(queryClient, CH, 2);
    const calls = stubConversationRest({ [CH]: [msg(1)], [B]: [inB(2, { bodyMd: "바뀜" })] });
    await watching(queryClient);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 2 }));

    await subs.enter(CH);

    await waitFor(() => expect(calls).toEqual([latest(CH)]));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([latest(CH)]);
    expect(getTimeline(queryClient, CH, B)?.items[0]?.bodyMd).not.toBe("바뀜");
  });

  it("처음 입장(커서 없음)과 넘친 재동기화(hasMore)에서는 부르지 않는다 — 그때는 캐시를 새로 받는다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1), card(false)]);
    const calls = stubConversationRest({ [CH]: [msg(1), card(true)] });
    await watching(queryClient);

    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 2 }));
    await subs.enter(CH);
    // 처음 입장 — 낡은 것으로 둔 지금 세션을 첫 페이지 쿼리가 다시 받는다(그 한 번뿐)
    await waitFor(() => expect(calls).toEqual([latest(CH)]));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([latest(CH)]);

    calls.length = 0;
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 900, hasMore: true }));
    await subs.resubscribeAll();
    // 넘친 재동기화 — 지금 세션을 다시 받는 것(첫 페이지 쿼리) 한 번뿐이다
    await waitFor(() => expect(calls).toEqual([latest(CH)]));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([latest(CH)]);
  });

  it("받다가 실패하면 조용히 둔다 — 캐시는 그대로", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1), card(false)]);
    setChannelSeq(queryClient, CH, 2);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("{}", { status: 500 })),
    );
    await watching(queryClient);
    fake.onAck("channel.subscribe", () => subscribed([], { latestSeq: 2 }));

    await expect(subs.enter(CH)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(getTimeline(queryClient, CH, CH)?.items[1]?.componentState?.consumed).toEqual([]);
  });
});

describe("restFetchPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("REST /conversations/:id/messages 에 limit·afterSeq·beforeSeq 를 싣는다", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ messages: [], hasMore: false }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(restFetchPage(CH, { afterSeq: 5, limit: 200 })).resolves.toEqual({
      messages: [],
      hasMore: false,
    });
    await restFetchPage(CH, { beforeSeq: 9, limit: 50 });

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      `/api/v1/conversations/${CH}/messages?limit=200&afterSeq=5`,
      `/api/v1/conversations/${CH}/messages?limit=50&beforeSeq=9`,
    ]);
  });
});
