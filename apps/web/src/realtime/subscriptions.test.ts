import type { ChannelSubscribeResult, Message, Result } from "@dodok/shared";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromLatest } from "@/features/messages/timeline";
import { ApiRequestError } from "@/api/http";
import { registerUnauthorized } from "@/app/session";
import { useRunStore } from "@/features/runs/runStore";
import { createFakeSocket } from "../../test/fakeSocket";
import { CH, CH2, msg, RUN, RUN2, runState, textDelta, uid } from "../../test/fixtures";
import { createSubscriptions, type FetchPage, restFetchPage } from "./subscriptions";
import { getTimeline, updateTimeline } from "./timelineCache";

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const subscribed = (messages: Message[], over: Partial<ChannelSubscribeResult> = {}) =>
  ok<ChannelSubscribeResult>({ messages, hasMore: false, activeRuns: [], pendingApprovals: [], ...over });
const seqs = (qc: QueryClient, channelId = CH) => getTimeline(qc, channelId)?.items.map((m) => m.seq);

function setup() {
  const fake = createFakeSocket();
  const queryClient = new QueryClient();
  const fetchPage = vi.fn<FetchPage>();
  const subs = createSubscriptions({ socket: fake.wire, queryClient, fetchPage });
  fake.onAck("channel.unsubscribe", () => ok(null));
  fake.socket.connected = true;
  return { fake, queryClient, fetchPage, subs };
}

/** 캐시에 이미 적재된 채널(앞서 들어갔던 채널) */
const seed = (qc: QueryClient, messages: Message[], channelId = CH) =>
  updateTimeline(qc, channelId, (t) => fromLatest(t, messages, false));

beforeEach(() => useRunStore.getState().reset());

describe("createSubscriptions", () => {
  it("처음 들어가면 lastSeq 없이 구독해 최근 페이지로 시작하고, 진행 중 런은 처음부터 재생해 텍스트를 쌓는다", async () => {
    const { fake, queryClient, subs } = setup();
    fake.onAck("channel.subscribe", () =>
      subscribed([msg(2), msg(1)], {
        hasMore: true,
        activeRuns: [runState({ id: RUN, status: "streaming" }), runState({ id: RUN2, status: "queued" })],
      }),
    );
    fake.onAck("run.events.replay", () =>
      ok({ run: runState({ id: RUN }), events: [textDelta(1, "안"), textDelta(2, "녕")] }),
    );

    await subs.enter(CH);

    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }]);
    expect(seqs(queryClient)).toEqual([1, 2]);
    expect(getTimeline(queryClient, CH)).toMatchObject({ lastSeq: 2, hasOlder: true });
    // queued 런은 쌓인 텍스트가 없다 — 재생하지 않는다
    expect(fake.sentOf("run.events.replay")).toEqual([{ runId: RUN, afterSeq: 0 }]);
    expect(useRunStore.getState().runs[RUN]).toMatchObject({ text: "안녕", lastEventSeq: 2 });
    expect(useRunStore.getState().runs[RUN2]?.state.status).toBe("queued");
    expect(subs.active()).toBe(CH);
  });

  it("캐시가 있는 채널에 다시 들어가면 lastSeq 로 구독해 병합한다(처음부터 다시 쌓지 않는다)", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1), msg(2)]);
    fake.onAck("channel.subscribe", () => subscribed([msg(3)]));

    await subs.enter(CH);

    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 2 }]);
    expect(seqs(queryClient)).toEqual([1, 2, 3]);
    expect(getTimeline(queryClient, CH)?.lastSeq).toBe(3);
  });

  it("catchUp: 구독 응답이 hasMore 면 hasMore 가 끝날 때까지 REST afterSeq 로 200개씩 이어 받는다", async () => {
    const { fake, queryClient, fetchPage, subs } = setup();
    seed(queryClient, [msg(1), msg(2)]);
    fake.onAck("channel.subscribe", () => subscribed([msg(3)], { hasMore: true }));
    fetchPage
      .mockResolvedValueOnce({ messages: [msg(4)], hasMore: true })
      .mockResolvedValueOnce({ messages: [msg(5)], hasMore: false });

    await subs.catchUp(CH);

    expect(fetchPage.mock.calls).toEqual([
      [CH, { afterSeq: 3, limit: 200 }],
      [CH, { afterSeq: 4, limit: 200 }],
    ]);
    expect(seqs(queryClient)).toEqual([1, 2, 3, 4, 5]);
  });

  it("catchUp: REST 이어 받기가 401 이면 앱의 401 처리(로그인)를 한 번 부르고 실패로 끝난다", async () => {
    const { fake, queryClient, fetchPage, subs } = setup();
    const onUnauthorized = vi.fn();
    const unregister = registerUnauthorized(onUnauthorized);
    seed(queryClient, [msg(1), msg(2)]);
    fake.onAck("channel.subscribe", () => subscribed([msg(3)], { hasMore: true }));
    fetchPage.mockRejectedValue(new ApiRequestError(401, "UNAUTHORIZED", "로그인이 필요하다"));

    await expect(subs.catchUp(CH)).rejects.toBeInstanceOf(ApiRequestError);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("catchUp: 5쪽(구독 1 + REST 4)을 넘기면 타임라인을 버리고 lastSeq 없이 처음부터 다시 구독한다", async () => {
    const { fake, queryClient, fetchPage, subs } = setup();
    seed(queryClient, [msg(1), msg(2)]);
    fake.onAck("channel.subscribe", (p) =>
      (p as { lastSeq?: number }).lastSeq === undefined
        ? subscribed([msg(1500), msg(1501)], { hasMore: true })
        : subscribed([msg(3)], { hasMore: true }),
    );
    let next = 4;
    fetchPage.mockImplementation(async () => ({ messages: [msg(next++)], hasMore: true }));

    await subs.catchUp(CH);

    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 2 }, { channelId: CH }]);
    expect(seqs(queryClient)).toEqual([1500, 1501]);
    expect(getTimeline(queryClient, CH)).toMatchObject({ lastSeq: 1501, hasOlder: true });
  });

  it("leave: channel.unsubscribe 를 보내고 캐시는 남기며 active 는 비운다", async () => {
    const { fake, queryClient, subs } = setup();
    fake.onAck("channel.subscribe", () => subscribed([msg(1)]));
    await subs.enter(CH);

    subs.leave(CH);

    expect(fake.sentOf("channel.unsubscribe")).toEqual([{ channelId: CH }]);
    expect(seqs(queryClient)).toEqual([1]);
    expect(subs.active()).toBeUndefined();
  });

  it("연결 전(또는 끊긴 동안) enter·leave 는 보내지 않고 채널만 기억한다 — 붙으면 resubscribeAll 이 구독한다", async () => {
    const { fake, queryClient, subs } = setup();
    fake.socket.connected = false;
    fake.onAck("channel.subscribe", () => subscribed([msg(1)]));

    await subs.enter(CH2);
    subs.leave(CH2);
    await subs.enter(CH);
    expect(fake.sent).toEqual([]);
    expect(subs.active()).toBe(CH);

    fake.socket.connected = true;
    await subs.resubscribeAll();
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }]);
    expect(seqs(queryClient)).toEqual([1]);
  });

  it("resubscribeAll: 지금 보고 있는 채널만 lastSeq 로 다시 맞춘다 — 떠난 채널은 건드리지 않는다", async () => {
    const { fake, queryClient, subs } = setup();
    seed(queryClient, [msg(1)], CH);
    seed(queryClient, [msg(1, { channelId: CH2, id: uid(20_001) })], CH2);
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
});

describe("restFetchPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("REST /channels/:id/messages 에 limit·afterSeq·beforeSeq 를 싣는다", async () => {
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
      `/api/v1/channels/${CH}/messages?limit=200&afterSeq=5`,
      `/api/v1/channels/${CH}/messages?limit=50&beforeSeq=9`,
    ]);
  });
});
