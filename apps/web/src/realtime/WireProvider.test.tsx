import type { ChannelSubscribeResult, Result } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { meQuery, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { resetClientState } from "@/app/session";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { notifyApproval, resetApprovalNotices } from "@/features/approvals/notify";
import { ReadSenderContext } from "@/features/reads/readSender";
import { useUnread } from "@/features/reads/useUnread";
import { useRunStore } from "@/features/runs/runStore";
import { stubNotification } from "../../test/domStubs";
import { fakeSubscription, pushStub, stubPush } from "../../test/pushStubs";
import { createdSockets } from "../../test/fakeSocket";
import { approval, CH, CH2, runState, USER, uid } from "../../test/fixtures";
import { useWireStatus } from "./wire";
import { type AppNotifyTarget, useChannelSubscription, useWire, WireProvider } from "./WireProvider";

// 기기 푸시 구독은 서비스 워커가 있어야 한다 — 여기서는 WireProvider 가 언제 부르는지만 잰다(push.test.ts 가 흐름을 잰다)
vi.mock("@/pwa/push", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/pwa/push")>()),
  syncPushSubscription: vi.fn(async () => {}),
  dropLocalPush: vi.fn(async () => {}),
}));
const push = await import("@/pwa/push");

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: USER, handle: "owner" }, workspaceId: uid(3) };
const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const meQueryFresh = { ...meQuery, staleTime: 0 };
/** 승인 알림이 보는 화면 사정 — 이 파일은 알림을 재지 않으므로 아무것도 하지 않는다 */
const notify = {
  currentChannelId: () => undefined,
  currentConversationId: () => undefined,
  openActivity: () => {},
};

let queryClient: QueryClient;
const onUnauthorized = vi.fn();
/**
 * queryClient 의 401 처리(값을 가진 me 의 401 도 부른다 — 오프라인 사본 뒤 세션 만료)는 따로 잰다. 앱에서는 둘이 같은
 * createApp 의 함수이고 겹쳐 불려도 멱등이다(/login 이면 생략) — 여기서는 WireProvider 가 받은 것만 센다
 */
const queryUnauthorized = vi.fn();
/** `Notification` 전역 스텁 — 단언이 터져도 같은 파일 뒤 테스트로 새지 않게 afterEach 가 벗긴다 */
let notifications: ReturnType<typeof stubNotification> | undefined;

beforeEach(() => {
  queryClient = createQueryClient(queryUnauthorized);
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
  resetApprovalNotices();
  useWireStatus.setState({ status: "idle" });
  onUnauthorized.mockClear();
  queryUnauthorized.mockClear();
  vi.mocked(push.syncPushSubscription).mockClear();
  vi.mocked(push.dropLocalPush).mockClear();
});
afterEach(() => {
  notifications?.restore();
  notifications = undefined;
  vi.unstubAllGlobals();
});

function stubMe(status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () =>
      status === 200 ? json(200, ME) : json(status, { code: "UNAUTHORIZED", message: "x" }),
    ),
  );
}

function Probe() {
  const { socket, subscriptions } = useWire();
  return <div data-testid="probe">{socket && subscriptions ? "ready" : "none"}</div>;
}

function Tree({ children, target = notify }: { children?: ReactNode; target?: AppNotifyTarget }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WireProvider onUnauthorized={onUnauthorized} notify={target}>
        <Probe />
        {children}
      </WireProvider>
    </QueryClientProvider>
  );
}

it("로그인이 확인되기 전에는 소켓을 만들지 않는다(me 401)", async () => {
  stubMe(401);
  render(<Tree />);
  await waitFor(() => expect(queryClient.getQueryState(qk.me)?.status).toBe("error"));
  expect(createdSockets).toHaveLength(0);
  expect(screen.getByTestId("probe")).toHaveTextContent("none");
});

it("me 가 확인되면 소켓 하나를 만들어 연결하고, 다시 렌더해도 새로 만들지 않는다", async () => {
  stubMe();
  const { rerender } = render(<Tree />);
  await waitFor(() => expect(screen.getByTestId("probe")).toHaveTextContent("ready"));
  expect(createdSockets).toHaveLength(1);
  expect(createdSockets[0]?.calls.connect).toBe(1);
  expect(useWireStatus.getState().status).toBe("connecting");

  rerender(<Tree />);
  expect(createdSockets).toHaveLength(1);
  expect(createdSockets[0]?.calls.disconnect).toBe(0);

  createdSockets[0]?.serverEmit("connect");
  expect(useWireStatus.getState().status).toBe("connected");
});

it("세션 정리(로그아웃·401)는 소켓을 끊고 런·승인 스토어를 비우며 상태를 idle 로", async () => {
  stubMe();
  const errors = vi.spyOn(console, "error");
  notifications = stubNotification("granted");
  render(<Tree />);
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  useRunStore.getState().applyState(runState());
  useApprovalStore.getState().apply(approval());
  const ring = () => notifyApproval(approval(), { visible: false, onClick: () => {} });
  expect(ring()).toBe(true); // 한 번 알렸다 — 두 번째는 같은 id 라 막힌다
  expect(ring()).toBe(false);

  resetClientState(queryClient);

  expect(createdSockets[0]?.calls.disconnect).toBeGreaterThanOrEqual(1);
  expect(useRunStore.getState().runs).toEqual({});
  expect(useApprovalStore.getState().byChannel).toEqual({});
  // 이미 알린 승인 기록도 비운다 — 다른 사람으로 다시 로그인하면 같은 승인을 다시 알려야 한다
  expect(ring()).toBe(true);
  expect(useWireStatus.getState().status).toBe("idle");
  // 비운 캐시에 me 를 다시 받아 새 소켓까지 — 그 사이 렌더 중 갱신 경고(캐시 알림을 렌더 안에서 받음)가 없다
  await waitFor(() => expect(createdSockets).toHaveLength(2));
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
});

it("세션 정리는 읽지 않음 현황도 비운다 — 다음 사람에게 앞 사람의 굵게·배지가 남지 않게", async () => {
  stubMe();
  render(<Tree />);
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  useUnread.getState().beginSnapshot();
  useUnread.getState().applySnapshot({
    channels: [CH, CH2],
    conversations: [
      { conversationId: CH, channelId: CH, lastReadSeq: 0, latestSeq: 3, unread: true, mentions: 1 },
    ],
  });

  resetClientState(queryClient);

  expect(useUnread.getState()).toMatchObject({ ready: false, byConversation: {} });
});

function ReadProbe({ seq }: { seq: number }) {
  const sender = useContext(ReadSenderContext);
  useEffect(() => sender?.request(CH, seq), [sender, seq]);
  return null;
}

it("읽음 전송기를 소켓마다 하나 만들어 내린다 — 요청은 그 소켓의 conversation.read(ack)로 나간다", async () => {
  stubMe();
  render(
    <Tree>
      <ReadProbe seq={5} />
    </Tree>,
  );
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  const fake = createdSockets[0];
  fake?.onAck("conversation.read", () => ok({ lastReadSeq: 5 }));
  await waitFor(() => expect(fake?.sentOf("conversation.read")).toEqual([{ conversationId: CH, seq: 5 }]));
});

it("떠나면 읽음 전송기를 비운다 — 디바운스 중이던 요청은 나가지 않는다", async () => {
  stubMe();
  const { unmount } = render(
    <Tree>
      <ReadProbe seq={5} />
    </Tree>,
  );
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  const fake = createdSockets[0];

  unmount();
  await new Promise((r) => setTimeout(r, 1200));

  expect(fake?.sentOf("conversation.read")).toEqual([]);
});

it("세션 정리 뒤 다시 로그인하면(me 가 다시 채워지면) 새 소켓을 만든다", async () => {
  stubMe(401);
  render(<Tree />);
  await waitFor(() => expect(queryClient.getQueryState(qk.me)?.status).toBe("error"));
  stubMe();
  await queryClient.refetchQueries({ queryKey: qk.me });
  await waitFor(() => expect(createdSockets).toHaveLength(1));

  // 로그아웃: 캐시를 비운다 — me 관찰자는 이것을 알림으로 받지 않는다
  stubMe(401);
  resetClientState(queryClient);
  await waitFor(() => expect(createdSockets[0]?.listenerCount()).toBe(0));
  expect(createdSockets).toHaveLength(1);

  // 다시 로그인(로그인 화면이 me 를 무효화해 다시 받는다)
  stubMe();
  await queryClient.fetchQuery({ ...meQueryFresh });
  await waitFor(() => expect(createdSockets).toHaveLength(2));
  expect(createdSockets[1]?.calls.connect).toBe(1);
});

it("wire UNAUTHORIZED 이고 세션도 끝났으면(me 401) 받은 onUnauthorized 를 부른다", async () => {
  stubMe();
  render(<Tree />);
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  stubMe(401);

  createdSockets[0]?.serverEmit(
    "connect_error",
    Object.assign(new Error("UNAUTHORIZED"), { data: { code: "UNAUTHORIZED", message: "invalid session" } }),
  );

  await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1));
});

it("떠나면(unmount) 소켓을 끊고 리스너를 뗀다", async () => {
  stubMe();
  const { unmount } = render(<Tree />);
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  const fake = createdSockets[0];

  unmount();

  expect(fake?.calls.disconnect).toBeGreaterThanOrEqual(1);
  expect(fake?.listenerCount()).toBe(0);
  expect(useWireStatus.getState().status).toBe("idle");
});

function Channel({ id }: { id: string }) {
  useChannelSubscription(id);
  return null;
}

it("useChannelSubscription: 마운트하면 들어가고, 채널이 바뀌거나 내려가면 떠난다", async () => {
  stubMe();
  const { rerender } = render(
    <Tree>
      <Channel id={CH} />
    </Tree>,
  );
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  const fake = createdSockets[0];
  if (!fake) throw new Error("no socket");
  fake.onAck("channel.subscribe", () =>
    ok<ChannelSubscribeResult>({
      messages: [],
      hasMore: false,
      latestSeq: 0,
      activeRuns: [],
      pendingApprovals: [],
    }),
  );
  fake.onAck("channel.unsubscribe", () => ok(null));
  // 연결 전에 들어간 채널은 붙을 때 구독한다
  expect(fake.sentOf("channel.subscribe")).toEqual([]);
  fake.socket.connected = true;
  fake.serverEmit("connect");
  await waitFor(() => expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }]));

  rerender(
    <Tree>
      <Channel id={CH2} />
    </Tree>,
  );
  await waitFor(() =>
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }, { channelId: CH2 }]),
  );
  expect(fake.sentOf("channel.unsubscribe")).toEqual([{ channelId: CH }]);

  rerender(<Tree />);
  expect(fake.sentOf("channel.unsubscribe")).toEqual([{ channelId: CH }, { channelId: CH2 }]);
});

describe("presence.update(스펙 5.3) — 보이는가·보는 채널", () => {
  /** 라우터 대신 — 지금 채널(·세션)을 바꾸고 이동을 알린다. 세션을 주지 않으면 세션 주소가 아닌 것(채널만) */
  function fakeLocation(initial?: string) {
    let channelId = initial;
    let conversationId: string | undefined;
    const watchers = new Set<() => void>();
    const target: AppNotifyTarget = {
      currentChannelId: () => channelId,
      currentConversationId: () => conversationId,
      openActivity: () => {},
      onLocationChange: (fn) => {
        watchers.add(fn);
        return () => void watchers.delete(fn);
      },
    };
    return {
      target,
      watchers,
      go(next?: string, session?: string) {
        channelId = next;
        conversationId = session;
        for (const fn of watchers) fn();
      },
    };
  }

  async function connected(target: AppNotifyTarget) {
    stubMe();
    render(<Tree target={target} />);
    await waitFor(() => expect(createdSockets).toHaveLength(1));
    const fake = createdSockets[0];
    if (!fake) throw new Error("소켓 없음");
    fake.socket.connected = true;
    fake.serverEmit("connect");
    return fake;
  }

  it("연결될 때마다 보낸다 — 같은 값이어도 다시 붙으면 다시(서버는 끊긴 소켓 상태를 지운다)", async () => {
    const loc = fakeLocation(CH);
    const fake = await connected(loc.target);
    expect(fake.sentOf("presence.update")).toEqual([{ visible: true, channelId: CH }]);

    fake.socket.connected = false;
    fake.serverEmit("disconnect", "transport close");
    fake.socket.connected = true;
    fake.serverEmit("connect");
    expect(fake.sentOf("presence.update")).toEqual([
      { visible: true, channelId: CH },
      { visible: true, channelId: CH },
    ]);
  });

  it("채널 이동·visibilitychange 때 다시, 같은 값이면 보내지 않는다", async () => {
    const loc = fakeLocation(CH);
    const fake = await connected(loc.target);

    act(() => loc.go(CH)); // 같은 채널 안 이동(활동 탭 등)
    expect(fake.sentOf("presence.update")).toHaveLength(1);

    act(() => loc.go(CH2));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: true, channelId: CH2 });

    act(() => loc.go(undefined)); // /agents
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: true });

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: false });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(fake.sentOf("presence.update")).toHaveLength(4);
    hidden.mockRestore();
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: true });
  });

  it("pagehide 에서는 안 보임을 늘 보낸다 — 지난번과 같아도(끊기기 직전 마지막 값), 다시 보이면 다시", async () => {
    const loc = fakeLocation(CH);
    const fake = await connected(loc.target);

    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: false, channelId: CH });

    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      act(() => void document.dispatchEvent(new Event("visibilitychange"))); // 같은 값 — 생략
      expect(fake.sentOf("presence.update")).toHaveLength(2);
      act(() => void window.dispatchEvent(new Event("pagehide"))); // 같은 값이어도 pagehide 는 보낸다
      expect(fake.sentOf("presence.update")).toEqual([
        { visible: true, channelId: CH },
        { visible: false, channelId: CH },
        { visible: false, channelId: CH },
      ]);
    } finally {
      hidden.mockRestore(); // 실패해도 다음 테스트로 새지 않게
    }

    // bfcache 복원처럼 소켓이 살아 돌아오면 보임을 다시 알린다
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: true, channelId: CH });
  });

  /** jsdom 의 Event 에는 persisted 가 없다 — PageTransitionEvent 의 그 필드만 얹는다 */
  const pageShow = (persisted: boolean) => Object.assign(new Event("pageshow"), { persisted });

  it("뒤로 가기 캐시에서 돌아오면(pageshow persisted) 지금 보임을 곧바로 보낸다 — pagehide 의 대칭", async () => {
    const loc = fakeLocation(CH);
    const fake = await connected(loc.target);
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: false, channelId: CH });

    // 첫 로드의 pageshow 는 연결이 맡는다 — 보내지 않는다
    act(() => void window.dispatchEvent(pageShow(false)));
    expect(fake.sentOf("presence.update")).toHaveLength(2);

    // 소켓이 살아 돌아왔다 — visibilitychange 나 재연결을 기다리지 않는다
    act(() => void window.dispatchEvent(pageShow(true)));
    expect(fake.sentOf("presence.update")).toEqual([
      { visible: true, channelId: CH },
      { visible: false, channelId: CH },
      { visible: true, channelId: CH },
    ]);
  });

  it("끊겨 있으면 pagehide 에도 보내지 않는다", async () => {
    const loc = fakeLocation(CH);
    const fake = await connected(loc.target);
    fake.socket.connected = false;
    fake.serverEmit("disconnect", "transport close");
    act(() => void window.dispatchEvent(new Event("pagehide")));
    expect(fake.sentOf("presence.update")).toEqual([{ visible: true, channelId: CH }]);
  });

  it("보는 세션도 싣는다 — 같은 채널 안 세션을 옮기면 다시, 새 세션 창(new)은 싣지 않는다(채널 세션 계획 판정 PS7)", async () => {
    const loc = fakeLocation(CH);
    const fake = await connected(loc.target);
    const B = "01a00000-0000-7000-8000-000000003001";
    act(() => loc.go(CH, CH));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({
      visible: true,
      channelId: CH,
      conversationId: CH,
    });
    act(() => loc.go(CH, B));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({
      visible: true,
      channelId: CH,
      conversationId: B,
    });
    act(() => loc.go(CH, "new"));
    expect(fake.sentOf("presence.update").at(-1)).toEqual({ visible: true, channelId: CH });
  });

  it("연결이 없으면 보내지 않고, 채널 id 가 uuid 가 아니면 싣지 않는다", async () => {
    const loc = fakeLocation("nope");
    stubMe();
    render(<Tree target={loc.target} />);
    await waitFor(() => expect(createdSockets).toHaveLength(1));
    const fake = createdSockets[0];
    if (!fake) throw new Error("소켓 없음");
    act(() => loc.go(CH));
    expect(fake.sentOf("presence.update")).toEqual([]);
    act(() => loc.go("nope"));
    fake.socket.connected = true;
    fake.serverEmit("connect");
    expect(fake.sentOf("presence.update")).toEqual([{ visible: true }]);
  });

  it("떠나면 이동·visibilitychange·pagehide·pageshow 구독을 푼다", async () => {
    const loc = fakeLocation(CH);
    stubMe();
    const { unmount } = render(<Tree target={loc.target} />);
    await waitFor(() => expect(createdSockets).toHaveLength(1));
    expect(loc.watchers.size).toBe(1);
    unmount();
    expect(loc.watchers.size).toBe(0);
    const fake = createdSockets[0];
    if (!fake) throw new Error("소켓 없음");
    fake.socket.connected = true;
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    act(() => void window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true })));
    expect(fake.sentOf("presence.update")).toEqual([]);
  });
});

describe("기기 푸시 구독", () => {
  it("로그인이 확인되면 그 사람으로 한 번 동기화한다(스펙 5.1)", async () => {
    stubMe();
    render(<Tree />);
    await waitFor(() => expect(push.syncPushSubscription).toHaveBeenCalledTimes(1));
    expect(push.syncPushSubscription).toHaveBeenCalledWith(USER);
  });

  it("[Review Focus 1] 세션 정리(401)는 기기 구독을 해지한다 — 서버 해지는 세션이 없어 못 한다", async () => {
    stubMe();
    render(<Tree />);
    await waitFor(() => expect(createdSockets).toHaveLength(1));
    expect(push.dropLocalPush).not.toHaveBeenCalled();
    act(() => resetClientState(queryClient));
    expect(push.dropLocalPush).toHaveBeenCalledTimes(1);
  });

  it("세션 없이 앱을 열면(me 401, 사본 없음) 기기 구독을 해지하고 플래그를 지운다", async () => {
    const actual = await vi.importActual<typeof import("@/pwa/push")>("@/pwa/push");
    vi.mocked(push.dropLocalPush).mockImplementation(actual.dropLocalPush);
    const sub = fakeSubscription();
    const device = stubPush({ permission: "granted", subscription: sub });
    try {
      localStorage.setItem("dodok.push", "userA");
      stubMe(401);
      render(<Tree />);
      await waitFor(() => expect(sub.unsubscribed).toBe(true));
      expect(push.dropLocalPush).toHaveBeenCalledTimes(1);
      expect(pushStub.current).toBeNull();
      expect(localStorage.getItem("dodok.push")).toBeNull();
    } finally {
      device.restore();
      localStorage.clear();
      vi.mocked(push.dropLocalPush).mockImplementation(async () => {});
    }
  });

  it("me 가 네트워크 오류·5xx 면 해지하지 않는다 — 일시 오류·오프라인", async () => {
    for (const answer of [
      async () => {
        throw new TypeError("Failed to fetch");
      },
      async () => json(500, { code: "INTERNAL", message: "x" }),
      async () => json(503, { code: "UNAVAILABLE", message: "x" }),
    ]) {
      queryClient = createQueryClient(queryUnauthorized);
      // 재시도(5xx·네트워크 2회)는 그대로, 사이 대기만 없앤다
      queryClient.setQueryDefaults(qk.me, { retryDelay: 0 });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(answer));
      const { unmount } = render(<Tree />);
      await waitFor(() => expect(queryClient.getQueryState(qk.me)?.status).toBe("error"));
      expect(queryClient.getQueryState(qk.me)?.fetchFailureCount).toBe(3);
      expect(push.dropLocalPush).not.toHaveBeenCalled();
      unmount();
    }
  });
});
