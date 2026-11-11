import type { Agent, Person } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { useTypingStore } from "@/realtime/typing";
import { useWireStatus } from "@/realtime/wire";
import { TypingIndicator } from "./TypingIndicator";
import { TYPING_THROTTLE_MS, useTyping } from "./useTyping";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, CH2, USER, uid } from "../../../test/fixtures";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const agentOf = (n: number, handle: string): Agent => ({
  id: uid(n),
  workspaceId: uid(900),
  provider: "openclaw",
  providerAgentId: handle,
  handle,
  name: handle,
  enabled: true,
  createdAt: "2026-09-19T00:00:00.000Z",
  archivedAt: null,
  dmAccess: "admins",
  program: null,
  createdBy: null,
});
const DEV = agentOf(21, "dev");
const personOf = (n: number, handle: string): Person => ({
  id: uid(n),
  handle,
  displayName: handle,
  role: "member",
  deactivatedAt: null,
  statusMessage: null,
});
const MIA = personOf(31, "mia");
const JO = personOf(32, "jo");

let fake: FakeSocket;
let qc: QueryClient;
beforeEach(() => {
  vi.useFakeTimers();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useTypingStore.setState({ byConversation: {} });
  // gcTime: Infinity — 표시기가 읽지 않는 qk.agents 의 GC 타이머가 「타이머 0」 검사에 섞이지 않게
  qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity, retry: false } },
  });
  qc.setQueryData(qk.me, { user: { id: USER, handle: "owner" }, workspaceId: uid(900) });
  qc.setQueryData(qk.agents, [DEV]); // 목록에 있는 에이전트도 typing 으로는 보이지 않는다
  qc.setQueryData(qk.people, [{ id: USER, handle: "owner", displayName: "owner", role: "owner" }, MIA, JO]);
});
afterEach(() => {
  vi.useRealTimers();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
);
/** 그 세션에서의 작성 중 — 기본은 CH 의 「이전 대화」(id = 채널 id) */
const note = (actorType: "user" | "agent", actorId: string, conversationId = CH) =>
  act(() => useTypingStore.getState().note({ conversationId, actorType, actorId }));

it("useTyping: 세션마다 3초에 한 번 typing { channelId, conversationId }, connected 일 때만 — 새 세션 창은 보내지 않는다", () => {
  const { result, rerender } = renderHook(({ ch, conv }) => useTyping(ch, conv), {
    wrapper,
    initialProps: { ch: CH, conv: CH },
  });
  result.current.notify();
  result.current.notify();
  expect(fake.sentOf("typing")).toEqual([{ channelId: CH, conversationId: CH }]);

  vi.advanceTimersByTime(TYPING_THROTTLE_MS - 1);
  result.current.notify();
  expect(fake.sentOf("typing")).toHaveLength(1);
  vi.advanceTimersByTime(1);
  result.current.notify();
  expect(fake.sentOf("typing")).toEqual([
    { channelId: CH, conversationId: CH },
    { channelId: CH, conversationId: CH },
  ]);

  // 같은 채널의 다른 세션으로 옮기면 그 세션으로 곧바로
  const other = "01a00000-0000-7000-8000-000000003001";
  rerender({ ch: CH, conv: other });
  result.current.notify();
  expect(fake.sentOf("typing").at(-1)).toEqual({ channelId: CH, conversationId: other });

  // 새 세션 창 — 아직 그 세션을 볼 사람이 없다
  vi.advanceTimersByTime(TYPING_THROTTLE_MS);
  rerender({ ch: CH2, conv: NEW_CONVERSATION });
  result.current.notify();
  expect(fake.sentOf("typing")).toHaveLength(3);
  rerender({ ch: CH2, conv: CH2 });

  // 끊긴 동안은 보내지 않는다(socket.io 버퍼에 쌓였다가 붙을 때 늦게 가지 않게)
  vi.advanceTimersByTime(TYPING_THROTTLE_MS);
  act(() => useWireStatus.getState().setStatus("reconnecting"));
  result.current.notify();
  expect(fake.sentOf("typing")).toHaveLength(3);
});

it("받은 작성 중: 다른 사람은 people 로 푼 핸들로, 여럿이면 쉼표 — 자기 자신(다른 탭)과 다른 세션은 숨긴다", () => {
  render(<TypingIndicator conversationId={CH} />, { wrapper });
  expect(screen.queryByText(/작성 중/)).not.toBeInTheDocument();

  note("user", USER); // 같은 사용자의 다른 탭
  note("user", MIA.id, CH2);
  expect(screen.queryByText(/작성 중/)).not.toBeInTheDocument();

  note("user", MIA.id);
  expect(screen.getByText("@mia 작성 중…")).toBeInTheDocument();
  note("user", JO.id);
  expect(screen.getByText("@mia, @jo 작성 중…")).toBeInTheDocument();
});

it("5초가 지나면 1초 안에 사라진다(다시 그리기 타이머)", () => {
  render(<TypingIndicator conversationId={CH} />, { wrapper });
  note("user", MIA.id);
  act(() => vi.advanceTimersByTime(3_000));
  note("user", JO.id);
  expect(screen.getByText("@mia, @jo 작성 중…")).toBeInTheDocument();

  act(() => vi.advanceTimersByTime(2_000)); // mia 만료
  expect(screen.getByText("@jo 작성 중…")).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(3_000)); // jo 만료
  expect(screen.queryByText(/작성 중/)).not.toBeInTheDocument();
  expect(vi.getTimerCount()).toBe(0); // 보일 것이 없으면 타이머도 멈춘다
});

it("사람만 보인다 — 에이전트 typing(목록에 있는 에이전트라도)과 people 에 없는 사람은 건너뛴다", () => {
  render(<TypingIndicator conversationId={CH} />, { wrapper });
  note("agent", DEV.id);
  note("agent", MIA.id); // people 에 있는 id 라도 에이전트면 숨는다
  note("user", uid(78));
  expect(screen.queryByText(/작성 중/)).not.toBeInTheDocument();
});
