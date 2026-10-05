import {
  Channel,
  ChannelMember,
  type ChannelSubscribeResult,
  type Result,
  type OpsStatus,
  type SetupStatus,
} from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdapterStatusResponse, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { fromLatest, jumpAround, threadFromPage } from "@/features/messages/timeline";
import { threadQuery } from "@/features/threads/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { notifyApproval, resetApprovalNotices } from "@/features/approvals/notify";
import { useRunStore } from "@/features/runs/runStore";
import { stubNotification } from "../../test/domStubs";
import { createFakeSocket } from "../../test/fakeSocket";
import { eventOf, opsStatusOf } from "../../test/opsServer";
import { agentOf } from "../../test/settingsServer";
import { ADAPTER_OK, TEST_GATEWAY } from "../../test/shellApi";
import {
  AGENT,
  APPROVAL,
  APPROVAL2,
  approval,
  CH,
  CH2,
  msg,
  RUN,
  runState,
  textDelta,
  uid,
  USER,
} from "../../test/fixtures";
import { attachHandlers, NOTICE_DURATION_MS } from "./handlers";
import { createSubscriptions } from "./subscriptions";
import { getThread, getTimeline, updateTimeline } from "./timelineCache";
import { typingActors, useTypingStore } from "./typing";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const ok = <T>(data: T): Result<T> => ({ ok: true, data });
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
    archivedAt: null,
    ...over,
  });

const detachers: Array<() => void> = [];

/** 알림이 보는 화면 사정 — 테스트가 「지금 보고 있는 채널」을 정하고 「눌러서 연 채널」을 받아 본다 */
const screenNow: { channelId: string | undefined; opened: string[] } = {
  channelId: undefined,
  opened: [],
};
const notify = {
  currentChannelId: () => screenNow.channelId,
  openActivity: (channelId: string) => screenNow.opened.push(channelId),
};

/** 실제 QueryClient(createQueryClient)·구독 관리자 위에 핸들러를 붙인다. onUnauthorized 는 앱과 같은 하나 */
function setup() {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  fake.socket.active = true;
  fake.onAck("channel.unsubscribe", () => ok(null));
  const onUnauthorized = vi.fn();
  const queryClient = createQueryClient(onUnauthorized);
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient, fetchPage: vi.fn() });
  const detach = attachHandlers(fake.wire, { queryClient, subscriptions, onUnauthorized, notify });
  detachers.push(detach);
  return { fake, queryClient, subscriptions, onUnauthorized, detach };
}

beforeEach(() => {
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
  resetApprovalNotices();
  screenNow.channelId = undefined;
  screenNow.opened = [];
  useTypingStore.setState({ byChannel: {} });
  vi.clearAllMocks();
});
afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
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

describe("결과로 가기(around)로 갈아 끼운 뒤의 wire 이벤트", () => {
  const ROOT = msg(1);
  const reply = (seq: number) => msg(seq, { threadRootId: ROOT.id });
  /** 구독한 채널(루트 40·44, 끝 46)을 루트 5·9·12 의 around 페이지로 — 더 새것이 있어 떨어진 창이다 */
  function jumped(hasMoreAfter = true) {
    const t = setup();
    seed(t.queryClient, [msg(40), msg(44)]);
    updateTimeline(t.queryClient, CH, (x) => ({ ...x, lastSeq: 46 }));
    updateTimeline(t.queryClient, CH, (x) =>
      jumpAround(x, { messages: [msg(5), msg(9), msg(12)], hasMore: true, hasMoreAfter }),
    );
    return { ...t, catchUp: vi.spyOn(t.subscriptions, "catchUp").mockResolvedValue() };
  }

  it("다음 seq 는 빈틈이 아니다 — 창보다 새 루트는 목록에 넣지 않고 lastSeq 만, 답글도 seq 만", () => {
    const { fake, queryClient, catchUp } = jumped();
    fake.serverEmit("message.created", { message: msg(47) });
    fake.serverEmit("message.created", { message: reply(48) });
    fake.serverEmit("message.created", { message: msg(49) });

    expect(catchUp).not.toHaveBeenCalled();
    expect(seqs(queryClient)).toEqual([5, 9, 12]);
    expect(getTimeline(queryClient, CH)?.lastSeq).toBe(49);
  });

  it("창 안 루트의 수정(message.updated)은 그대로 반영한다", () => {
    const { fake, queryClient } = jumped();
    fake.serverEmit("message.updated", { message: msg(9, { bodyMd: "고침" }) });
    expect(getTimeline(queryClient, CH)?.items[1]?.bodyMd).toBe("고침");
  });

  it("진짜 빈틈(채널의 끝 + 1 보다 큼)은 여전히 catchUp — 기준은 창의 끝이 아니라 채널의 끝", () => {
    const { fake, queryClient, catchUp } = jumped();
    fake.serverEmit("message.created", { message: msg(50) });
    expect(catchUp).toHaveBeenCalledWith(CH);
    expect(seqs(queryClient)).toEqual([5, 9, 12]);
  });

  it("재동기화(lastSeq 구독)가 창보다 새 루트를 돌려줘도 창에 붙이지 않는다 — 이어 받기는 창의 끝에서", async () => {
    const { fake, queryClient, catchUp } = jumped();
    catchUp.mockRestore();
    fake.onAck("channel.subscribe", () =>
      ok<ChannelSubscribeResult>({
        messages: [msg(47), reply(48)],
        hasMore: false,
        activeRuns: [],
        pendingApprovals: [],
      }),
    );
    fake.serverEmit("message.created", { message: msg(50) });
    await vi.waitFor(() => expect(getTimeline(queryClient, CH)?.lastSeq).toBe(48));
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH, lastSeq: 46 }]);
    expect(seqs(queryClient)).toEqual([5, 9, 12]);
    expect(getTimeline(queryClient, CH)?.hasNewer).toBe(true);
  });

  it("페이지가 끝까지 닿았으면(hasMoreAfter 없음) 새 루트는 끝에 붙는다", () => {
    const { fake, queryClient, catchUp } = jumped(false);
    fake.serverEmit("message.created", { message: msg(47) });
    expect(catchUp).not.toHaveBeenCalled();
    expect(seqs(queryClient)).toEqual([5, 9, 12, 40, 44, 47]);
  });
});

describe("스레드 답글 이벤트(스레드·검색 스펙 4.1 — 채널 룸 하나로 받아 웹이 나눈다)", () => {
  const ROOT = msg(1);
  const reply = (seq: number, over: Parameters<typeof msg>[1] = {}) =>
    msg(seq, { threadRootId: ROOT.id, ...over });
  const summary = (count: number) => ({ count, lastAt: msg(9).createdAt, agentIds: [] });
  /** 연 스레드(REST 로 받은 첫 페이지) */
  const openThread = (qc: QueryClient, messages = [ROOT, reply(2)]) =>
    qc.setQueryData(qk.thread(CH, ROOT.id), threadFromPage(undefined, ROOT, messages, false));
  const threadSeqs = (qc: QueryClient) => getThread(qc, CH, ROOT.id)?.items.map((m) => m.seq);

  it("답글은 채널 타임라인에 넣지 않고 lastSeq 만 올린다 — 연 스레드 캐시에 넣는다", () => {
    const { fake, queryClient, subscriptions } = setup();
    const catchUp = vi.spyOn(subscriptions, "catchUp").mockResolvedValue();
    seed(
      queryClient,
      [ROOT, reply(2)].filter((m) => !m.threadRootId),
    );
    openThread(queryClient);
    // 채널 lastSeq 는 1(루트만 받았다) — 답글 2 는 이미 스레드에 있다
    fake.serverEmit("message.created", { message: reply(2) });
    fake.serverEmit("message.created", { message: reply(3) });

    expect(seqs(queryClient)).toEqual([1]);
    expect(getTimeline(queryClient, CH)?.lastSeq).toBe(3);
    expect(threadSeqs(queryClient)).toEqual([1, 2, 3]);
    expect(catchUp).not.toHaveBeenCalled();
  });

  it("답글 뒤의 루트는 빈틈이 아니다 — 루트만 든 타임라인에서 거짓 빈틈을 내지 않는다", () => {
    const { fake, queryClient, subscriptions } = setup();
    const catchUp = vi.spyOn(subscriptions, "catchUp").mockResolvedValue();
    seed(queryClient, [ROOT]);

    fake.serverEmit("message.created", { message: reply(2) });
    fake.serverEmit("message.created", { message: reply(3) });
    fake.serverEmit("message.created", { message: msg(4) });

    expect(catchUp).not.toHaveBeenCalled();
    expect(seqs(queryClient)).toEqual([1, 4]);
  });

  it("답글로도 빈틈은 잡는다 — 앞의 seq 를 놓쳤으면 catchUp", () => {
    const { fake, queryClient, subscriptions } = setup();
    const catchUp = vi.spyOn(subscriptions, "catchUp").mockResolvedValue();
    seed(queryClient, [ROOT]);
    openThread(queryClient, [ROOT]);

    fake.serverEmit("message.created", { message: reply(5) });

    expect(catchUp).toHaveBeenCalledWith(CH);
    expect(threadSeqs(queryClient)).toEqual([1]);
  });

  it("연 적 없는 스레드의 답글은 버린다 — 스레드 캐시를 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    seed(queryClient, [ROOT]);
    fake.serverEmit("message.created", { message: reply(2) });
    expect(getThread(queryClient, CH, ROOT.id)).toBeUndefined();
  });

  it("루트 message.updated(요약)는 채널 캐시의 루트를, 연 스레드의 루트도 바꾼다", () => {
    const { fake, queryClient } = setup();
    seed(queryClient, [ROOT]);
    openThread(queryClient);
    fake.serverEmit("message.updated", { message: msg(1, { threadSummary: summary(2) }) });

    expect(getTimeline(queryClient, CH)?.items[0]?.threadSummary).toEqual(summary(2));
    expect(getThread(queryClient, CH, ROOT.id)?.items[0]?.threadSummary).toEqual(summary(2));
  });

  it("적재 범위 밖의 루트 수정도 연 스레드의 루트는 바꾼다(채널 목록에는 넣지 않는다)", () => {
    const { fake, queryClient } = setup();
    seed(queryClient, [msg(10), msg(11)]);
    openThread(queryClient);
    fake.serverEmit("message.updated", { message: msg(1, { bodyMd: "고침" }) });

    expect(seqs(queryClient)).toEqual([10, 11]);
    expect(getThread(queryClient, CH, ROOT.id)?.items[0]?.bodyMd).toBe("고침");
  });

  it("답글 message.updated(카드 상호작용)는 스레드 캐시의 그 답글을 바꾼다 — 채널 목록은 그대로", () => {
    const { fake, queryClient } = setup();
    seed(queryClient, [ROOT]);
    updateTimeline(queryClient, CH, (t) => ({ ...t, lastSeq: 2 }));
    openThread(queryClient);
    fake.serverEmit("message.updated", { message: reply(2, { bodyMd: "고친 답글" }) });

    expect(seqs(queryClient)).toEqual([1]);
    expect(getThread(queryClient, CH, ROOT.id)?.items[1]?.bodyMd).toBe("고친 답글");
  });

  it("과거가 남은 스레드에서 가장 옛 답글보다 앞 답글의 수정은 넣지 않는다 — 범위 안 수정은 넣는다", () => {
    const { fake, queryClient } = setup();
    seed(queryClient, [ROOT]);
    updateTimeline(queryClient, CH, (t) => ({ ...t, lastSeq: 11 }));
    queryClient.setQueryData(
      qk.thread(CH, ROOT.id),
      threadFromPage(undefined, ROOT, [reply(10), reply(11)], true),
    );

    fake.serverEmit("message.updated", { message: reply(5, { bodyMd: "옛 답글 고침" }) });
    expect(threadSeqs(queryClient)).toEqual([1, 10, 11]);

    fake.serverEmit("message.updated", { message: reply(11, { bodyMd: "고친 답글" }) });
    expect(getThread(queryClient, CH, ROOT.id)?.items[2]?.bodyMd).toBe("고친 답글");
  });

  describe("스레드 REST 가 도는 사이 온 답글이 스레드에 남는다(p4t-t6 리뷰 I1)", () => {
    /** 스레드 REST 를 약속으로 막는다 — 응답은 그 요청 때의 스냅숏(루트·답글 2) */
    function gateThreadRest() {
      let open = () => {};
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const calls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          calls.push(String(input));
          await gate;
          return new Response(JSON.stringify({ root: ROOT, messages: [reply(2)], hasMore: false }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      );
      return { open, calls };
    }
    afterEach(() => vi.unstubAllGlobals());

    it("첫 열기 — 캐시가 없어도 받는 중이면 그 사이 답글을 결과에 얹는다", async () => {
      const { fake, queryClient, subscriptions } = setup();
      const catchUp = vi.spyOn(subscriptions, "catchUp").mockResolvedValue();
      seed(queryClient, [ROOT]);
      updateTimeline(queryClient, CH, (t) => ({ ...t, lastSeq: 2 }));
      const rest = gateThreadRest();

      const loading = queryClient.fetchQuery(threadQuery(queryClient, CH, ROOT.id));
      await vi.waitFor(() => expect(rest.calls).toHaveLength(1));
      fake.serverEmit("message.created", { message: reply(3) });
      rest.open();
      await loading;

      expect(threadSeqs(queryClient)).toEqual([1, 2, 3]);
      expect(catchUp).not.toHaveBeenCalled();
    });

    it("다시 받기(invalidate) — 옛 캐시에 들어간 답글을 새 페이지가 지우지 않는다", async () => {
      const { fake, queryClient } = setup();
      seed(queryClient, [ROOT]);
      updateTimeline(queryClient, CH, (t) => ({ ...t, lastSeq: 2 }));
      const first = gateThreadRest();
      first.open();
      await queryClient.fetchQuery(threadQuery(queryClient, CH, ROOT.id));
      expect(threadSeqs(queryClient)).toEqual([1, 2]);

      const rest = gateThreadRest();
      const again = queryClient.invalidateQueries({ queryKey: qk.threads(CH), refetchType: "all" });
      await vi.waitFor(() => expect(rest.calls).toHaveLength(1));
      fake.serverEmit("message.created", { message: reply(3) });
      expect(threadSeqs(queryClient)).toEqual([1, 2, 3]);
      rest.open();
      await again;

      expect(threadSeqs(queryClient)).toEqual([1, 2, 3]);
    });

    it("받는 중 온 수정도 순서대로 얹는다 — 스냅숏의 옛 본문이 이기지 않는다", async () => {
      const { fake, queryClient } = setup();
      seed(queryClient, [ROOT]);
      updateTimeline(queryClient, CH, (t) => ({ ...t, lastSeq: 2 }));
      const rest = gateThreadRest();

      const loading = queryClient.fetchQuery(threadQuery(queryClient, CH, ROOT.id));
      await vi.waitFor(() => expect(rest.calls).toHaveLength(1));
      fake.serverEmit("message.updated", { message: reply(2, { bodyMd: "고친 답글" }) });
      rest.open();
      await loading;

      expect(getThread(queryClient, CH, ROOT.id)?.items[1]?.bodyMd).toBe("고친 답글");
    });
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

describe("승인 이벤트", () => {
  it("approval.requested·approval.resolved 는 승인 스토어에 넣는다 — 확정이 요구를 덮는다", () => {
    const { fake } = setup();
    fake.serverEmit("approval.requested", { approval: approval() });
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.approval.status).toBe("pending");

    fake.serverEmit("approval.resolved", {
      approval: approval({ status: "allowed", decision: "allow-once", reason: "user" }),
    });
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.approval).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });
  });

  it("같은 승인이 프레임 둘로 와도 카드는 하나 — 뒤엣것이 빈 자리를 채운다(p2-t6 Ruling C)", () => {
    const { fake } = setup();
    fake.serverEmit("approval.requested", { approval: approval({ toolCallId: undefined, urlPath: "/a" }) });
    fake.serverEmit("approval.requested", {
      approval: approval({ toolCallId: "toolu_9", urlPath: undefined }),
    });

    expect(Object.keys(useApprovalStore.getState().byChannel[CH] ?? {})).toEqual([APPROVAL]);
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.approval).toMatchObject({
      toolCallId: "toolu_9",
      urlPath: "/a",
    });
  });
});

describe("승인 알림", () => {
  let stub: ReturnType<typeof stubNotification>;
  /** 알림이 뜰 수 있는 판 — 권한 있음, 에이전트·채널 이름은 캐시에 */
  function armed(permission: NotificationPermission = "granted", role: string | null = "owner") {
    stub = stubNotification(permission);
    const s = setup();
    s.queryClient.setQueryData(qk.me, {
      user: { id: "u", handle: "owner" },
      workspaceId: "w",
      ...(role === null ? {} : { role }),
    });
    s.queryClient.setQueryData(qk.agents, [agentOf(AGENT, "dev")]);
    s.queryClient.setQueryData(qk.channels, [channel({ name: "일반" })]);
    return s;
  }
  afterEach(() => {
    stub.restore();
    // 이 묶음은 window.focus·document.visibilityState 를 흉내 낸다 — 다음 테스트로 새지 않게 되돌린다
    vi.restoreAllMocks();
  });

  it("다른 채널을 보고 있으면 알림을 띄우고, 누르면 그 채널 활동 탭으로 간다", () => {
    const { fake } = armed();
    screenNow.channelId = CH2;

    fake.serverEmit("approval.requested", { approval: approval() });

    expect(stub.made).toHaveLength(1);
    expect(stub.made[0]?.title).toBe("승인 필요 — @dev 가 Write 를 실행하려 합니다");
    expect(stub.made[0]?.options?.body).toBe("일반 채널");
    // jsdom 에는 창을 앞으로 내는 동작이 없다 — 가짜로 둬야 「구현되지 않음」 잡음이 나지 않는다
    vi.spyOn(window, "focus").mockImplementation(() => {});
    stub.made[0]?.click();
    expect(screenNow.opened).toEqual([CH]);
  });

  /**
   * 브라우저 검증 D1 — 서버가 승인을 채널 룸에만 내보내 「다른 채널을 보고 있어도」(스펙 5.4)가 도달 불가였다.
   * 서버 쪽 팬아웃은 서버가 고친다. 웹은 프레임만 닿으면 되므로 여기서 잠근다:
   * 보고 있지 않은 채널의 요구도 **스토어에 들어가고**(사이드바·나중에 열 카드가 쓴다) **탭이 보여도 알린다**
   */
  it("보고 있지 않은 채널의 승인은 탭이 보여도 스토어에 들어가고 알린다(D1)", () => {
    const { fake } = armed();
    screenNow.channelId = CH2;
    expect(document.visibilityState).toBe("visible");

    fake.serverEmit("approval.requested", { approval: approval() });

    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.approval).toMatchObject({
      channelId: CH,
      status: "pending",
    });
    expect(stub.made).toHaveLength(1);
  });

  it("admin 도 알린다, member·역할 모름은 알리지 않는다 — 결정은 관리자 몫이다(팀 스펙 5장)", () => {
    for (const [role, n] of [
      ["admin", 1],
      ["member", 0],
      [null, 0],
    ] as const) {
      resetApprovalNotices();
      const { fake } = armed("granted", role);
      screenNow.channelId = CH2;
      fake.serverEmit("approval.requested", { approval: approval() });
      expect(stub.made, String(role)).toHaveLength(n);
      // 카드(스토어)에는 누구에게나 들어간다 — 결과는 모두에게 보인다
      expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]).toBeDefined();
      stub.restore();
    }
  });

  it("보고 있는 채널의 승인은 알리지 않는다 — 카드가 이미 화면에 있다", () => {
    const { fake } = armed();
    screenNow.channelId = CH;
    fake.serverEmit("approval.requested", { approval: approval() });
    expect(stub.made).toHaveLength(0);
    // 스토어에는 그대로 들어간다
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]).toBeDefined();
  });

  it("탭이 숨겨져 있으면 보고 있는 채널이어도 알린다", () => {
    const { fake } = armed();
    screenNow.channelId = CH;
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fake.serverEmit("approval.requested", { approval: approval() });
    expect(stub.made).toHaveLength(1);
  });

  it("이미 확정된 승인이 요구로 와도 알리지 않는다", () => {
    const { fake } = armed();
    screenNow.channelId = CH2;
    fake.serverEmit("approval.requested", {
      approval: approval({ status: "expired", reason: "timeout" }),
    });
    expect(stub.made).toHaveLength(0);
  });

  it("같은 승인이 프레임 둘로 와도 한 번만 울린다 — 다른 승인은 막히지 않는다", () => {
    const { fake } = armed();
    screenNow.channelId = CH2;

    // 어댑터가 전역·세션 프레임을 병합해 다시 발행한다(p2-t6 Ruling C) — 같은 승인이 두 번 온다
    fake.serverEmit("approval.requested", { approval: approval({ toolCallId: undefined }) });
    fake.serverEmit("approval.requested", { approval: approval({ toolCallId: "toolu_9" }) });
    expect(stub.made).toHaveLength(1);

    fake.serverEmit("approval.requested", { approval: approval({ id: APPROVAL2 }) });
    expect(stub.made).toHaveLength(2);
  });

  it("확정 프레임은 알린 기록을 지운다 — 집합이 끝없이 자라지 않게", () => {
    const { fake } = armed();
    screenNow.channelId = CH2;
    fake.serverEmit("approval.requested", { approval: approval() });
    expect(stub.made).toHaveLength(1);

    fake.serverEmit("approval.resolved", {
      approval: approval({ status: "allowed", decision: "allow-once", reason: "user" }),
    });

    // 서버는 확정된 승인에 requested 를 다시 내지 않으므로(approvals/service.ts 의 발행 이름은 병합된 행의
    // 상태를 따른다) 프레임 순서로는 잴 수 없다 — 기록이 비었는지는 알림 문을 직접 두드려 확인한다
    expect(notifyApproval(approval(), { visible: false, onClick: () => {} })).toBe(true);
  });

  it("권한을 안 줬으면 조용하다 — 카드가 정본이라 스토어는 그대로 채운다", () => {
    const { fake } = armed("default");
    screenNow.channelId = CH2;
    fake.serverEmit("approval.requested", { approval: approval() });
    expect(stub.made).toHaveLength(0);
    expect(useApprovalStore.getState().byChannel[CH]?.[APPROVAL]?.approval.status).toBe("pending");
  });

  it("에이전트·채널을 아직 못 받았으면 일반 문구로 띄운다 — 알림 때문에 REST 를 부르지 않는다", () => {
    stub = stubNotification("granted");
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.me, { user: { id: "u", handle: "owner" }, workspaceId: "w", role: "owner" });
    screenNow.channelId = CH2;
    fake.serverEmit("approval.requested", { approval: approval({ toolName: undefined }) });
    expect(stub.made[0]?.title).toBe("승인 필요 — 에이전트가 도구를 실행하려 합니다");
    expect(stub.made[0]?.options?.body).toBeUndefined();
  });
});

describe("캐시 패치", () => {
  it("channel.created: 사이드바가 보는 채널 목록 끝에 더한다 — 목록을 아직 안 받았으면 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    const created = channel({ id: CH2, name: "random" });

    // 목록을 받기 전(구독 전)에 온 것은 한 채널짜리 목록을 만들지 않는다 — 완전한 목록인 척하지 않게
    fake.serverEmit("channel.created", { channel: created });
    expect(queryClient.getQueryData(qk.channels)).toBeUndefined();

    queryClient.setQueryData(qk.channels, [channel()]);
    fake.serverEmit("channel.created", { channel: created });

    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.name)).toEqual([
      "general",
      "random",
    ]);
  });

  it("channel.created: 같은 id 가 두 번 와도 한 번만 — 늦게 온 것이 그새 바뀐 값을 되돌리지 않는다", () => {
    const { fake, queryClient } = setup();
    // 만든 사람 화면: useCreateChannel 이 넣은 뒤 이름이 바뀌었고, 그제야 created 가 닿는다
    queryClient.setQueryData(qk.channels, [channel({ name: "renamed" })]);

    fake.serverEmit("channel.created", { channel: channel({ name: "general" }) });
    fake.serverEmit("channel.created", { channel: channel({ name: "general" }) });

    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.name)).toEqual(["renamed"]);
  });

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

  it("channel.updated 보관: 사이드바 목록에서 빼고 [channel, id] 는 보관된 채널로, 보관 목록에 넣는다", () => {
    const { fake, queryClient } = setup();
    const other = channel({ id: CH2, name: "random" });
    queryClient.setQueryData(qk.channels, [channel(), other]);
    queryClient.setQueryData(qk.archivedChannels, []);
    const archived = channel({ archivedAt: "2027-01-16T00:00:00.000Z" });

    fake.serverEmit("channel.updated", { channel: archived });

    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.id)).toEqual([CH2]);
    expect(queryClient.getQueryData<Channel>(qk.channel(CH))?.archivedAt).toBe(archived.archivedAt);
    expect(queryClient.getQueryData<Channel[]>(qk.archivedChannels)?.map((c) => c.id)).toEqual([CH]);
  });

  it("channel.updated 보관 해제: 사이드바 목록의 만든 순서 자리로 돌아오고 보관 목록에서 빠진다", () => {
    const { fake, queryClient } = setup();
    // CH 가 먼저 만든 채널 — 서버 목록 순서(createdAt, id)대로 앞에 돌아와야 한다
    const later = channel({ id: CH2, name: "random", createdAt: "2027-01-16T08:00:00.000Z" });
    queryClient.setQueryData(qk.channels, [later]);
    queryClient.setQueryData(qk.archivedChannels, [channel({ archivedAt: "2027-01-16T00:00:00.000Z" })]);

    fake.serverEmit("channel.updated", { channel: channel() });

    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.id)).toEqual([CH, CH2]);
    expect(queryClient.getQueryData<Channel[]>(qk.archivedChannels)).toEqual([]);
    expect(queryClient.getQueryData<Channel>(qk.channel(CH))?.archivedAt).toBeNull();
  });

  it("channel.updated 보관: 보관 목록을 아직 안 받았으면 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    fake.serverEmit("channel.updated", { channel: channel({ archivedAt: "2027-01-16T00:00:00.000Z" }) });
    expect(queryClient.getQueryData(qk.archivedChannels)).toBeUndefined();
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

  it("agents.changed: 에이전트 목록과 채널 멤버를 다시 받게 낡은 것으로 둔다 — 찾기 목록은 건드리지 않는다", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.agents, []);
    queryClient.setQueryData(qk.members(CH), []);
    queryClient.setQueryData(qk.members(CH2), []);
    queryClient.setQueryData(qk.discoverOf("claude"), []);

    fake.serverEmit("agents.changed", {});

    expect(queryClient.getQueryState(qk.agents)?.isInvalidated).toBe(true);
    // 보관하면 서버는 channel.member.changed 를 내지 않는다 — 멤버 줄·멘션 후보가 보관한 에이전트를 내려놓게
    expect(queryClient.getQueryState(qk.members(CH))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.members(CH2))?.isInvalidated).toBe(true);
    // 고르는 중인 등록 대화상자의 목록을 다시 부르지 않는다(adapter.status 의 exact 와 같은 까닭)
    expect(queryClient.getQueryState(qk.discoverOf("claude"))?.isInvalidated).toBe(false);
  });

  it("people.changed: [people] 를 통째로 바꾼다", () => {
    const { fake, queryClient } = setup();
    const people = [{ id: uid(30), handle: "mina", displayName: "미나", role: "member" as const }];
    fake.serverEmit("people.changed", { people });
    expect(queryClient.getQueryData(qk.people)).toEqual(people);
  });

  it("people.changed: 멤버 표·대기 초대는 다시 받게 낡은 것으로 둔다(다른 관리자의 가입·역할·비활성화)", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.teamMembers, []);
    queryClient.setQueryData(qk.invites, []);
    fake.serverEmit("people.changed", { people: [] });
    expect(queryClient.getQueryState(qk.teamMembers)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.invites)?.isInvalidated).toBe(true);
  });

  it("people.changed 에서 내 역할이 me 와 다르면 me 를 다시 받는다 — 같으면 부르지 않는다", async () => {
    const { fake, queryClient } = setup();
    const me = { user: { id: uid(30), handle: "mina" }, workspaceId: "w", role: "admin" };
    queryClient.setQueryData(qk.me, me);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...me, role: "member" }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    try {
      fake.serverEmit("people.changed", {
        people: [{ id: uid(30), handle: "mina", displayName: "미나", role: "admin" }],
      });
      expect(fetch).not.toHaveBeenCalled();
      fake.serverEmit("people.changed", {
        people: [{ id: uid(30), handle: "mina", displayName: "미나", role: "member" }],
      });
      await vi.waitFor(() => expect(queryClient.getQueryData<{ role?: string }>(qk.me)?.role).toBe("member"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("setup.status: [setup, status] 를 통째로 바꾸고 남은 Gateway 의 토큰 목록만 다시 받게 낡은 것으로 둔다", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData([...qk.bridgeTokens, "gw-live"], []);
    queryClient.setQueryData([...qk.bridgeTokens, "gw-gone"], []);
    const status = { gateways: [{ id: "gw-live" }] } as unknown as SetupStatus;
    fake.serverEmit("setup.status", { status });
    expect(queryClient.getQueryData(qk.setupStatus)).toBe(status);
    expect(queryClient.getQueryState([...qk.bridgeTokens, "gw-live"])?.isInvalidated).toBe(true);
    // 지워진 Gateway 의 목록을 다시 부르면 404 — 그대로 둔다(쓰는 카드가 사라지면 gcTime 뒤 걷힌다)
    expect(queryClient.getQueryState([...qk.bridgeTokens, "gw-gone"])?.isInvalidated).toBe(false);
  });

  it("ops.event: [ops, status] 의 unacked 를 곧바로 덮고 상태·사건 목록은 다시 받게 낡은 것으로 둔다 — 상태가 아직 없으면 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    const event = eventOf(1);
    fake.serverEmit("ops.event", { event, unacked: { warn: 1, error: 0 } });
    expect(queryClient.getQueryData(qk.opsStatus)).toBeUndefined();

    queryClient.setQueryData(qk.opsStatus, opsStatusOf({ runsToday: 7 }));
    queryClient.setQueryData(qk.opsEvents(undefined), { pages: [], pageParams: [] });
    fake.serverEmit("ops.event", { event, unacked: { warn: 2, error: 1 } });
    const status = queryClient.getQueryData<OpsStatus>(qk.opsStatus);
    expect(status?.unacked).toEqual({ warn: 2, error: 1 });
    expect(status?.runsToday).toBe(7);
    expect(queryClient.getQueryState(qk.opsEvents(undefined))?.isInvalidated).toBe(true);
    // 배지 밖의 칸(디스크·버전·런 수)은 사건이 바꿨을 수 있다 — 상태도 다시 받게 낡은 것으로 둔다(브라우저 검증 D1)
    expect(queryClient.getQueryState(qk.opsStatus)?.isInvalidated).toBe(true);
  });

  it("adapter.status: [adapter] 에 병합한다 — capabilities 는 유지, 아직 없으면 만들지 않는다", () => {
    const { fake, queryClient } = setup();
    const down = { ...TEST_GATEWAY, gateway: "down", bridge: "down" } as const;
    fake.serverEmit("adapter.status", { provider: "openclaw", gateways: [down] });
    expect(queryClient.getQueryData(qk.adapter)).toBeUndefined();

    const capabilities = { sessionReset: true, agentsList: true, configSet: false };
    const cached: AdapterStatusResponse = { ...ADAPTER_OK, capabilities };
    queryClient.setQueryData(qk.adapter, cached);
    const reconnecting = { ...TEST_GATEWAY, gateway: "reconnecting", bridge: "down" } as const;
    fake.serverEmit("adapter.status", { provider: "openclaw", gateways: [reconnecting] });

    // Gateway 목록을 통째로 바꾼다 — 점·배너·운영 화면이 저마다 모은다
    expect(queryClient.getQueryData(qk.adapter)).toEqual({
      provider: "openclaw",
      gateways: [reconnecting],
      capabilities,
    });
  });

  it("adapter.status: Gateway 의 id·이름 집합이 바뀌면 에이전트 목록을 낡게 한다 — 상태만 바뀌면 그대로(리뷰 I1)", () => {
    const { fake, queryClient } = setup();
    const HOME = { ...TEST_GATEWAY, id: "gw-home", name: "집" } as const;
    queryClient.setQueryData(qk.adapter, { ...ADAPTER_OK, gateways: [TEST_GATEWAY, HOME] });
    queryClient.setQueryData(qk.agents, []);
    queryClient.setQueryData(qk.discoverOf("openclaw"), []);
    const agentsStale = () => queryClient.getQueryState(qk.agents)?.isInvalidated;

    // 상태만 바뀜 — 에이전트 줄이 보이는 이름은 그대로라 다시 받지 않는다
    fake.serverEmit("adapter.status", {
      provider: "openclaw",
      gateways: [TEST_GATEWAY, { ...HOME, gateway: "reconnecting", bridge: "down" }],
    });
    expect(agentsStale()).toBe(false);

    // 이름 바꿈
    fake.serverEmit("adapter.status", {
      provider: "openclaw",
      gateways: [TEST_GATEWAY, { ...HOME, name: "본가" }],
    });
    expect(agentsStale()).toBe(true);

    // 지움 — 다른 탭의 에이전트 줄이 「Gateway 가 삭제됨」을 보이게
    queryClient.setQueryData(qk.agents, []);
    fake.serverEmit("adapter.status", { provider: "openclaw", gateways: [TEST_GATEWAY] });
    expect(agentsStale()).toBe(true);
    // 찾기 목록은 [agents] 아래 키지만 건드리지 않는다 — 지운 Gateway 의 찾기를 다시 부르면 404 다
    expect(queryClient.getQueryState(qk.discoverOf("openclaw"))?.isInvalidated).toBe(false);
  });

  it("adapter.status: 어댑터 캐시가 아직 없으면 에이전트 목록을 건드리지 않는다", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.agents, []);
    fake.serverEmit("adapter.status", { provider: "openclaw", gateways: [TEST_GATEWAY] });
    expect(queryClient.getQueryState(qk.agents)?.isInvalidated).toBe(false);
  });

  it("adapter.status: OpenClaw 가 아닌 어댑터의 상태는 [adapter] 를 건드리지 않는다(판정 P7)", () => {
    const { fake, queryClient } = setup();
    const cached: AdapterStatusResponse = ADAPTER_OK;
    queryClient.setQueryData(qk.adapter, cached);
    fake.serverEmit("adapter.status", { provider: "claude", runners: { connected: 0, tokens: 1 } });
    expect(queryClient.getQueryData(qk.adapter)).toEqual(cached);
  });

  it("adapter.status(claude): 등록 화면의 러너 목록(discover)을 낡게 한다 — OpenClaw 것은 아니다", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.discoverOf("claude"), []);
    queryClient.setQueryData(qk.discoverOf("openclaw"), []);
    fake.serverEmit("adapter.status", { provider: "claude", runners: { connected: 1, tokens: 1 } });
    expect(queryClient.getQueryState(qk.discoverOf("claude"))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(qk.discoverOf("openclaw"))?.isInvalidated).toBe(false);
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
