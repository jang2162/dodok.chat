import type { ChannelSubscribeResult, Result } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { meQuery, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { resetClientState } from "@/app/session";
import { useRunStore } from "@/features/runs/runStore";
import { createdSockets } from "../../test/fakeSocket";
import { CH, CH2, runState, USER, uid } from "../../test/fixtures";
import { useWireStatus } from "./wire";
import { useChannelSubscription, useWire, WireProvider } from "./WireProvider";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const ME = { user: { id: USER, handle: "owner" }, workspaceId: uid(3) };
const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const meQueryFresh = { ...meQuery, staleTime: 0 };

let queryClient: QueryClient;
const onUnauthorized = vi.fn();

beforeEach(() => {
  queryClient = createQueryClient(onUnauthorized);
  useRunStore.getState().reset();
  useWireStatus.setState({ status: "idle" });
  onUnauthorized.mockClear();
});
afterEach(() => vi.unstubAllGlobals());

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

function Tree({ children }: { children?: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <WireProvider onUnauthorized={onUnauthorized}>
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

it("세션 정리(로그아웃·401)는 소켓을 끊고 런 스토어를 비우며 상태를 idle 로", async () => {
  stubMe();
  const errors = vi.spyOn(console, "error");
  render(<Tree />);
  await waitFor(() => expect(createdSockets).toHaveLength(1));
  useRunStore.getState().applyState(runState());

  resetClientState(queryClient);

  expect(createdSockets[0]?.calls.disconnect).toBeGreaterThanOrEqual(1);
  expect(useRunStore.getState().runs).toEqual({});
  expect(useWireStatus.getState().status).toBe("idle");
  // 비운 캐시에 me 를 다시 받아 새 소켓까지 — 그 사이 렌더 중 갱신 경고(캐시 알림을 렌더 안에서 받음)가 없다
  await waitFor(() => expect(createdSockets).toHaveLength(2));
  expect(errors).not.toHaveBeenCalled();
  errors.mockRestore();
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
    ok<ChannelSubscribeResult>({ messages: [], hasMore: false, activeRuns: [], pendingApprovals: [] }),
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
