import type { Message, Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { useSendMessage } from "./useSendMessage";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, msg } from "../../../test/fixtures";

// 소켓만 가짜로 — WireProvider 의 나머지는 원본
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

type SendPayload = { channelId: string; clientMsgId: string; bodyMd: string };
let fake: FakeSocket;
let qc: QueryClient;

beforeEach(() => {
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  qc = new QueryClient();
});
afterEach(() => {
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

function renderSend() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useSendMessage(CH), { wrapper }).result;
}

/** 서버처럼: 보낸 clientMsgId·본문으로 확정 메시지를 돌려준다 */
const confirmed = (p: unknown, seq = 1): Result<{ message: Message }> => {
  const { clientMsgId, bodyMd } = p as SendPayload;
  return { ok: true, data: { message: msg(seq, { clientMsgId, bodyMd }) } };
};

it("send → 곧바로 보내는 중 항목, ack { message } 로 확정되고 보내는 중 항목은 사라진다", async () => {
  let release!: () => void;
  const acked = new Promise<void>((r) => (release = r));
  fake.onAck("message.send", async (p) => {
    await acked;
    return confirmed(p, 7);
  });
  const send = renderSend();

  let done!: Promise<void>;
  act(() => {
    done = send.current.send("<@a:x> 안녕");
  });
  const [payload] = fake.sentOf("message.send") as SendPayload[];
  expect(payload).toMatchObject({ channelId: CH, bodyMd: "<@a:x> 안녕" });
  expect(payload?.clientMsgId).toMatch(/^[0-9a-f-]{36}$/);
  expect(fake.timeouts).toEqual([10_000]);
  expect(getTimeline(qc, CH)?.pending).toEqual([
    {
      clientMsgId: payload?.clientMsgId,
      channelId: CH,
      bodyMd: "<@a:x> 안녕",
      createdAt: expect.any(String),
      state: "sending",
    },
  ]);

  release();
  await act(() => done);
  const t = getTimeline(qc, CH);
  expect(t?.pending).toEqual([]);
  expect(t?.items.map((m) => [m.seq, m.clientMsgId])).toEqual([[7, payload?.clientMsgId]]);
});

it("ack ok:false 면 failed", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "VALIDATION", message: "bad" } }));
  const send = renderSend();
  await act(() => send.current.send("안녕"));
  expect(getTimeline(qc, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);
  expect(getTimeline(qc, CH)?.items).toEqual([]);
});

it("시간 초과(ack 없음)도 failed", async () => {
  // 대본이 없으면 가짜 소켓의 emitWithAck 가 던진다 = 시간 초과
  const send = renderSend();
  await act(() => send.current.send("안녕"));
  expect(getTimeline(qc, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);
});

it("retry 는 같은 clientMsgId·같은 본문으로 다시 message.send — 보내는 중으로 돌아갔다가 확정", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const send = renderSend();
  await act(() => send.current.send("다시"));
  const first = getTimeline(qc, CH)?.pending[0];
  expect(first?.state).toBe("failed");

  let release!: () => void;
  const acked = new Promise<void>((r) => (release = r));
  fake.onAck("message.send", async (p) => {
    await acked;
    return confirmed(p, 3);
  });
  let done!: Promise<void>;
  act(() => {
    done = send.current.retry(first?.clientMsgId ?? "");
  });
  expect(getTimeline(qc, CH)?.pending.map((p) => p.state)).toEqual(["sending"]);
  release();
  await act(() => done);

  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, clientMsgId: first?.clientMsgId, bodyMd: "다시" },
    { channelId: CH, clientMsgId: first?.clientMsgId, bodyMd: "다시" },
  ]);
  expect(getTimeline(qc, CH)?.pending).toEqual([]);
  expect(getTimeline(qc, CH)?.items.map((m) => m.seq)).toEqual([3]);
});

it("retry: 모르는 clientMsgId 는 아무것도 하지 않는다", async () => {
  const send = renderSend();
  await act(() => send.current.retry("nope"));
  expect(fake.sent).toEqual([]);
});

it("discard 는 캐시에서만 지운다(서버로 아무것도 보내지 않음)", async () => {
  const send = renderSend();
  await act(() => send.current.send("버릴 것"));
  const id = getTimeline(qc, CH)?.pending[0]?.clientMsgId ?? "";
  const before = fake.sent.length;
  act(() => send.current.discard(id));
  expect(getTimeline(qc, CH)?.pending).toEqual([]);
  expect(fake.sent).toHaveLength(before);
});

it("wire 가 connected 가 아니면 보내지 않고 곧바로 failed(socket.io 가 끊김 중 emit 을 버퍼에 두지 않게)", async () => {
  useWireStatus.getState().setStatus("reconnecting");
  fake.onAck("message.send", (p) => confirmed(p));
  const send = renderSend();
  await act(() => send.current.send("끊김"));
  expect(fake.sentOf("message.send")).toEqual([]);
  expect(getTimeline(qc, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);

  // 다시 붙은 뒤 다시 보내기는 간다
  useWireStatus.getState().setStatus("connected");
  await act(() => send.current.retry(getTimeline(qc, CH)?.pending[0]?.clientMsgId ?? ""));
  await waitFor(() => expect(getTimeline(qc, CH)?.pending).toEqual([]));
  expect(fake.sentOf("message.send")).toHaveLength(1);
});

it("소켓이 없으면(로그인 전·정리 뒤) failed", async () => {
  wire.socket = undefined;
  const send = renderSend();
  await act(() => send.current.send("없음"));
  expect(getTimeline(qc, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);
});

it("반환한 함수들은 렌더 사이에 같은 것(Provider 값이 매번 바뀌지 않게)", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result, rerender } = renderHook(() => useSendMessage(CH), { wrapper });
  const first = result.current;
  rerender();
  expect(result.current.send).toBe(first.send);
  expect(result.current.retry).toBe(first.retry);
  expect(result.current.discard).toBe(first.discard);
});
