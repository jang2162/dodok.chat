import { Channel, ChannelMember, type ChannelSubscribeResult, type Result } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdapterStatusResponse, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { fromLatest } from "@/features/messages/timeline";
import { useRunStore } from "@/features/runs/runStore";
import { createFakeSocket } from "../../test/fakeSocket";
import { AGENT, CH, CH2, msg, RUN, runState, textDelta, uid, USER } from "../../test/fixtures";
import { attachHandlers, NOTICE_DURATION_MS, WIRE_RETRY_MS } from "./handlers";
import { createSubscriptions } from "./subscriptions";
import { getTimeline, updateTimeline } from "./timelineCache";
import { typingActors, useTypingStore } from "./typing";
import { useWireStatus } from "./wire";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: USER, handle: "owner" }, workspaceId: uid(3) };
const connectError = (code: string) =>
  Object.assign(new Error(code), { data: { code, message: "rejected by middleware" } });
const status = () => useWireStatus.getState().status;
const seqs = (qc: QueryClient, channelId = CH) => getTimeline(qc, channelId)?.items.map((m) => m.seq);
const seed = (qc: QueryClient, messages = [msg(1), msg(2)], channelId = CH) =>
  updateTimeline(qc, channelId, (t) => fromLatest(t, messages, false));

const channel = (over: Partial<Channel> = {}): Channel =>
  Channel.parse({
    id: CH,
    workspaceId: uid(3),
    name: "general",
    relayPolicy: {},
    visibility: "public",
    createdBy: USER,
    createdAt: "2027-01-15T08:00:00.000Z",
    ...over,
  });

const detachers: Array<() => void> = [];

/** 실제 QueryClient(createQueryClient)·구독 관리자 위에 핸들러를 붙인다. onUnauthorized 는 앱과 같은 하나 */
function setup() {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  fake.socket.active = true;
  fake.onAck("channel.unsubscribe", () => ok(null));
  const onUnauthorized = vi.fn();
  const queryClient = createQueryClient(onUnauthorized);
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient, fetchPage: vi.fn() });
  const detach = attachHandlers(fake.wire, { queryClient, subscriptions, onUnauthorized });
  detachers.push(detach);
  return { fake, queryClient, subscriptions, onUnauthorized, detach };
}

beforeEach(() => {
  useRunStore.getState().reset();
  useTypingStore.setState({ byChannel: {} });
  useWireStatus.setState({ status: "idle" });
  vi.clearAllMocks();
});
afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("타임라인 이벤트", () => {
  it("message.created: 그 채널 캐시가 있으면 upsert, 구독한 적 없는 채널(캐시 없음)은 무시한다", () => {
    const { fake, queryClient } = setup();
    seed(queryClient);

    fake.serverEmit("message.created", { message: msg(3) });
    fake.serverEmit("message.created", { message: msg(1, { channelId: CH2, id: uid(20_001) }) });

    expect(seqs(queryClient)).toEqual([1, 2, 3]);
    expect(getTimeline(queryClient, CH2)).toBeUndefined();
  });

  it("message.created 가 빈틈(lastSeq + 1 보다 큼)이면 넣지 않고 catchUp 한다", () => {
    const { fake, queryClient, subscriptions } = setup();
    const catchUp = vi.spyOn(subscriptions, "catchUp").mockResolvedValue();
    seed(queryClient);

    fake.serverEmit("message.created", { message: msg(5) });

    expect(catchUp).toHaveBeenCalledWith(CH);
    expect(seqs(queryClient)).toEqual([1, 2]);
  });

  it("빈 채널(적재됐고 lastSeq 0)에 seq > 1 이 오면 빈틈으로 보고 catchUp — seq 1 은 그냥 넣는다", () => {
    const { fake, queryClient, subscriptions } = setup();
    const catchUp = vi.spyOn(subscriptions, "catchUp").mockResolvedValue();
    seed(queryClient, []);

    fake.serverEmit("message.created", { message: msg(3) });
    expect(catchUp).toHaveBeenCalledTimes(1);
    expect(catchUp).toHaveBeenCalledWith(CH);
    expect(seqs(queryClient)).toEqual([]);

    catchUp.mockClear();
    fake.serverEmit("message.created", { message: msg(1) });
    expect(catchUp).not.toHaveBeenCalled();
    expect(seqs(queryClient)).toEqual([1]);
  });

  it("message.updated: 가진 메시지를 교체한다. 적재 범위 밖(더 옛것)이나 캐시 없는 채널은 넣지 않는다", () => {
    const { fake, queryClient } = setup();
    seed(queryClient, [msg(10), msg(11)]);

    fake.serverEmit("message.updated", { message: msg(11, { bodyMd: "고침" }) });
    fake.serverEmit("message.updated", { message: msg(3, { bodyMd: "옛것" }) });
    fake.serverEmit("message.updated", { message: msg(1, { channelId: CH2, id: uid(20_001) }) });

    expect(getTimeline(queryClient, CH)?.items.map((m) => [m.seq, m.bodyMd])).toEqual([
      [10, "m10"],
      [11, "고침"],
    ]);
    expect(getTimeline(queryClient, CH2)).toBeUndefined();
  });
});

describe("런 이벤트", () => {
  it("run.state 는 applyState, run.event 는 applyEvent", () => {
    const { fake } = setup();
    fake.serverEmit("run.state", { run: runState({ status: "queued" }) });
    fake.serverEmit("run.state", { run: runState({ status: "streaming" }) });
    fake.serverEmit("run.event", { event: textDelta(1, "안") });
    fake.serverEmit("run.event", { event: textDelta(2, "녕") });

    expect(useRunStore.getState().runs[RUN]).toMatchObject({
      state: { status: "streaming" },
      text: "안녕",
      lastEventSeq: 2,
    });
  });

  it("run.state resync: afterSeq = lastEventSeq 로 재생해 이벤트마다 이어 붙인다 — 앞 텍스트를 잃지 않는다", async () => {
    const { fake } = setup();
    fake.serverEmit("run.state", { run: runState() });
    fake.serverEmit("run.event", { event: textDelta(1, "안") });
    fake.serverEmit("run.event", { event: textDelta(2, "녕") });
    fake.onAck("run.events.replay", () =>
      ok({ run: runState(), events: [textDelta(3, "하"), textDelta(4, "세")] }),
    );

    fake.serverEmit("run.state", { run: runState(), resync: true });

    expect(fake.sentOf("run.events.replay")).toEqual([{ runId: RUN, afterSeq: 2 }]);
    await vi.waitFor(() => expect(useRunStore.getState().runs[RUN]?.text).toBe("안녕하세"));
    expect(useRunStore.getState().runs[RUN]?.lastEventSeq).toBe(4);
  });

  it("입장 재생 ack 전에 온 실시간 델타는 모았다가 재생 뒤에 붙인다 — 겹친 seq 는 한 번만", async () => {
    const { fake, subscriptions } = setup();
    let answer: (r: Result<unknown>) => void = () => {};
    fake.onAck("channel.subscribe", () =>
      ok<ChannelSubscribeResult>({
        messages: [],
        hasMore: false,
        activeRuns: [runState()],
        pendingApprovals: [],
      }),
    );
    fake.onAck("run.events.replay", () => new Promise((resolve) => (answer = resolve)));

    const entering = subscriptions.enter(CH);
    await vi.waitFor(() => expect(fake.sentOf("run.events.replay")).toHaveLength(1));
    // 서버는 재생을 계산한 뒤에도 델타를 흘린다 — seq 3 은 재생에도 실시간에도, seq 4 는 실시간에만
    fake.serverEmit("run.event", { event: textDelta(3, "c") });
    fake.serverEmit("run.event", { event: textDelta(4, "d") });
    answer(ok({ run: runState(), events: [textDelta(1, "a"), textDelta(2, "b"), textDelta(3, "c")] }));
    await entering;

    expect(useRunStore.getState().runs[RUN]).toMatchObject({ text: "abcd", lastEventSeq: 4 });
  });

  it("입장 재생이 실패하면 모아 둔 실시간 델타를 그대로 흘린다", async () => {
    const { fake, subscriptions } = setup();
    let answer: (r: Result<unknown>) => void = () => {};
    fake.onAck("channel.subscribe", () =>
      ok<ChannelSubscribeResult>({
        messages: [],
        hasMore: false,
        activeRuns: [runState()],
        pendingApprovals: [],
      }),
    );
    fake.onAck("run.events.replay", () => new Promise((resolve) => (answer = resolve)));

    const entering = subscriptions.enter(CH);
    await vi.waitFor(() => expect(fake.sentOf("run.events.replay")).toHaveLength(1));
    fake.serverEmit("run.event", { event: textDelta(3, "c") });
    expect(useRunStore.getState().runs[RUN]?.text).toBe("");
    answer({ ok: false, error: { code: "NOT_FOUND", message: "run not found" } });
    await entering;

    expect(useRunStore.getState().runs[RUN]).toMatchObject({ text: "c", lastEventSeq: 3 });
  });
});

describe("캐시 패치", () => {
  it("channel.updated: 채널 목록의 같은 id 를 교체하고 [channel, id] 를 채운다", () => {
    const { fake, queryClient } = setup();
    const other = channel({ id: CH2, name: "random" });
    queryClient.setQueryData(qk.channels, [channel(), other]);

    fake.serverEmit("channel.updated", { channel: channel({ name: "renamed" }) });

    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.name)).toEqual([
      "renamed",
      "random",
    ]);
    expect(queryClient.getQueryData<Channel>(qk.channel(CH))?.name).toBe("renamed");
  });

  it("channel.updated: 목록을 아직 안 받았으면 목록은 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    fake.serverEmit("channel.updated", { channel: channel({ name: "renamed" }) });
    expect(queryClient.getQueryData(qk.channels)).toBeUndefined();
    expect(queryClient.getQueryData<Channel>(qk.channel(CH))?.name).toBe("renamed");
  });

  it("channel.member.changed: [members, channelId] 를 통째로 바꾼다", () => {
    const { fake, queryClient } = setup();
    const member = ChannelMember.parse({
      id: uid(40),
      channelId: CH,
      memberType: "agent",
      memberId: AGENT,
      joinedAt: "2027-01-15T08:00:00.000Z",
    });
    queryClient.setQueryData(qk.members(CH), []);

    fake.serverEmit("channel.member.changed", { channelId: CH, members: [member] });

    expect(queryClient.getQueryData(qk.members(CH))).toEqual([member]);
  });

  it("adapter.status: [adapter] 에 병합한다 — capabilities 는 유지, 아직 없으면 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    fake.serverEmit("adapter.status", { provider: "openclaw", gateway: "down", bridge: "down" });
    expect(queryClient.getQueryData(qk.adapter)).toBeUndefined();

    const capabilities = { sessionReset: true, agentsList: true, configSet: false };
    queryClient.setQueryData<AdapterStatusResponse>(qk.adapter, {
      provider: "openclaw",
      gateway: "connected",
      bridge: "connected",
      capabilities,
    });
    fake.serverEmit("adapter.status", { provider: "openclaw", gateway: "reconnecting", bridge: "down" });

    expect(queryClient.getQueryData(qk.adapter)).toEqual({
      provider: "openclaw",
      gateway: "reconnecting",
      bridge: "down",
      capabilities,
    });
  });
});

describe("작성 중·알림", () => {
  it("typing 은 작성 중 저장소에 기록한다", () => {
    const { fake } = setup();
    fake.serverEmit("typing", { channelId: CH, actorType: "agent", actorId: AGENT });
    expect(typingActors(useTypingStore.getState(), CH, Date.now())).toEqual([
      { actorType: "agent", actorId: AGENT },
    ]);
  });

  it("system.notice 는 수준별 토스트 — info 4초·warn 6초·error 유지", () => {
    const { fake } = setup();
    fake.serverEmit("system.notice", { level: "info", message: "알림" });
    fake.serverEmit("system.notice", { level: "warn", message: "주의" });
    fake.serverEmit("system.notice", { level: "error", message: "오류" });

    expect(toast.info).toHaveBeenCalledWith("알림", { duration: 4_000 });
    expect(toast.warning).toHaveBeenCalledWith("주의", { duration: 6_000 });
    expect(toast.error).toHaveBeenCalledWith("오류", { duration: Infinity });
    expect(NOTICE_DURATION_MS).toEqual({ info: 4_000, warn: 6_000, error: Infinity });
  });
});

describe("연결 상태", () => {
  it("connect 는 connected 로 두고 붙을 때마다 보고 있는 채널을 다시 맞춘다(resubscribeAll)", () => {
    const { fake, subscriptions } = setup();
    const resubscribeAll = vi.spyOn(subscriptions, "resubscribeAll").mockResolvedValue();

    fake.serverEmit("connect");
    expect(status()).toBe("connected");
    fake.serverEmit("disconnect", "transport close");
    fake.serverEmit("connect");

    expect(resubscribeAll).toHaveBeenCalledTimes(2);
  });

  it("disconnect 는 reconnecting, 이쪽에서 끊은 것(io client disconnect)은 offline", () => {
    const { fake } = setup();
    fake.serverEmit("connect");
    fake.serverEmit("disconnect", "transport close");
    expect(status()).toBe("reconnecting");
    fake.serverEmit("connect");
    fake.serverEmit("disconnect", "io client disconnect");
    expect(status()).toBe("offline");
  });

  it("그 밖의 connect_error(전송 실패)는 reconnecting — socket.io 가 스스로 다시 붙는다", () => {
    const { fake, onUnauthorized } = setup();
    const connects = fake.calls.connect;
    fake.serverEmit("connect_error", new Error("websocket error"));
    expect(status()).toBe("reconnecting");
    expect(fake.calls.connect).toBe(connects);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("connect_error PROTOCOL_MISMATCH: protocol_mismatch 로 두고 소켓을 끊는다", () => {
    const { fake } = setup();
    fake.serverEmit("connect_error", connectError("PROTOCOL_MISMATCH"));
    expect(status()).toBe("protocol_mismatch");
    expect(fake.calls.disconnect).toBe(1);
    fake.serverEmit("disconnect", "io client disconnect");
    expect(status()).toBe("protocol_mismatch");
  });

  it("connect_error UNAUTHORIZED 인데 REST 세션은 살아 있으면(me 200) rejected — 로그인으로 보내지 않고 다시 붙지 않는다", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => json(200, ME));
    vi.stubGlobal("fetch", fetchMock);
    const { fake, onUnauthorized } = setup();
    fake.socket.active = false; // 미들웨어 거절은 socket.io 가 자동 재연결하지 않는다
    const connects = fake.calls.connect;

    fake.serverEmit("connect_error", connectError("UNAUTHORIZED"));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual(["/api/v1/auth/me"]);
    expect(status()).toBe("rejected");
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_MS * 10);
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(fake.calls.connect).toBe(connects);
    expect(fake.socket.active).toBe(false);
    expect(status()).toBe("rejected");
  });

  it("connect_error UNAUTHORIZED 이고 me 도 401 이면 onUnauthorized 를 한 번 부른다", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      json(401, { code: "UNAUTHORIZED", message: "로그인이 필요하다" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { fake, onUnauthorized } = setup();

    fake.serverEmit("connect_error", connectError("UNAUTHORIZED"));

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
    // me 가 한 번 더 도는 일(전역 401 처리)도 없다
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("connect_error UNAUTHORIZED 인데 me 확인이 네트워크 실패면 끊김처럼 reconnecting 으로 두고 잠시 뒤 다시 붙는다", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const { fake, onUnauthorized } = setup();
    fake.socket.active = false;
    const connects = fake.calls.connect;

    fake.serverEmit("connect_error", connectError("UNAUTHORIZED"));
    // me 쿼리는 네트워크 실패를 두 번 더 시도한다(1s·2s)
    await vi.advanceTimersByTimeAsync(3_000);
    expect(status()).toBe("reconnecting");
    expect(fake.calls.connect).toBe(connects);

    await vi.advanceTimersByTimeAsync(WIRE_RETRY_MS);
    expect(fake.calls.connect).toBe(connects + 1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("해제 함수는 붙인 리스너를 모두 떼고, 기다리던 재연결도 거둔다", async () => {
    vi.useFakeTimers();
    const fake = createFakeSocket();
    const before = fake.listenerCount();
    const onUnauthorized = vi.fn();
    const queryClient = createQueryClient(onUnauthorized);
    const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
    const detach = attachHandlers(fake.wire, { queryClient, subscriptions, onUnauthorized });
    expect(fake.listenerCount()).toBeGreaterThan(before);

    // 알 수 없는 코드의 미들웨어 거절 → 스스로 다시 붙기를 걸어 둔 채로 뗀다
    fake.serverEmit("connect_error", connectError("INTERNAL"));
    detach();
    expect(fake.listenerCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(WIRE_RETRY_MS * 2);
    expect(fake.calls.connect).toBe(0);
  });
});
