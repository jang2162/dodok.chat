import type { Message, Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { fromLatest, threadFromPage } from "@/features/messages/timeline";
import { getThread, getTimeline, updateTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { useSendMessage } from "./useSendMessage";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { uploaded } from "../../../test/fakeXhr";
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

it("ack 오류가 RATE_LIMITED 면 failed 에 사유 rate_limited — 그 밖 실패에는 사유가 없다", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" } }));
  const send = renderSend();
  await act(() => send.current.send("빨리"));
  expect(getTimeline(qc, CH)?.pending.map((p) => [p.state, p.reason])).toEqual([["failed", "rate_limited"]]);

  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  await act(() => send.current.send("다른"));
  expect(getTimeline(qc, CH)?.pending[1]).not.toHaveProperty("reason");
});

it("레이트리밋으로 실패한 것의 다시 보내기는 같은 clientMsgId 로 — 보내는 중에는 사유를 내린다", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" } }));
  const send = renderSend();
  await act(() => send.current.send("빨리"));
  const first = getTimeline(qc, CH)?.pending[0];

  let release!: () => void;
  const acked = new Promise<void>((r) => (release = r));
  fake.onAck("message.send", async (p) => {
    await acked;
    return confirmed(p, 4);
  });
  let done!: Promise<void>;
  act(() => {
    done = send.current.retry(first?.clientMsgId ?? "");
  });
  expect(getTimeline(qc, CH)?.pending).toEqual([expect.not.objectContaining({ reason: expect.anything() })]);
  expect(getTimeline(qc, CH)?.pending[0]?.state).toBe("sending");
  release();
  await act(() => done);
  const sent = fake.sentOf("message.send") as SendPayload[];
  expect(sent.map((p) => p.clientMsgId)).toEqual([first?.clientMsgId, first?.clientMsgId]);
  expect(getTimeline(qc, CH)?.items.map((m) => m.seq)).toEqual([4]);
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

it("첨부가 있으면 보내는 중 항목에 싣고 message.send 에 id 를 — 글 없이도 보낸다(bodyMd 빈 문자열)", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const a1 = uploaded(1);
  const a2 = uploaded(2);
  const send = renderSend();
  await act(() => send.current.send("", [a1, a2]));
  const [payload] = fake.sentOf("message.send") as SendPayload[];
  expect(payload).toEqual({
    channelId: CH,
    clientMsgId: expect.any(String),
    bodyMd: "",
    attachments: [a1.id, a2.id],
  });
  expect(getTimeline(qc, CH)?.pending).toEqual([
    expect.objectContaining({ bodyMd: "", attachments: [a1, a2], state: "failed" }),
  ]);
});

it("첨부 있는 전송의 retry 는 같은 clientMsgId·같은 첨부 id 로(서버가 clientMsgId 로 멱등)", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const a1 = uploaded(1);
  const send = renderSend();
  await act(() => send.current.send("사진", [a1]));
  const id = getTimeline(qc, CH)?.pending[0]?.clientMsgId ?? "";

  fake.onAck("message.send", (p) => confirmed(p, 4));
  await act(() => send.current.retry(id));
  const sent = { channelId: CH, clientMsgId: id, bodyMd: "사진", attachments: [a1.id] };
  expect(fake.sentOf("message.send")).toEqual([sent, sent]);
  expect(getTimeline(qc, CH)?.pending).toEqual([]);
});

it("빈 첨부 배열이면 페이로드·보내는 중 항목에 attachments 를 싣지 않는다", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const send = renderSend();
  await act(() => send.current.send("글만", []));
  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, clientMsgId: expect.any(String), bodyMd: "글만" },
  ]);
  expect(getTimeline(qc, CH)?.pending[0]).not.toHaveProperty("attachments");
});

it("스레드 작성기: threadRootId 를 싣고, 보내는 중·확정은 스레드 캐시에 — 채널 타임라인에는 seq 만", async () => {
  const root = msg(1);
  updateTimeline(qc, CH, (t) => fromLatest(t, [root], false));
  qc.setQueryData(qk.thread(CH, root.id), threadFromPage(undefined, root, [], false));
  let release!: () => void;
  const acked = new Promise<void>((r) => (release = r));
  fake.onAck("message.send", async (p) => {
    await acked;
    const { clientMsgId, bodyMd } = p as SendPayload;
    return { ok: true, data: { message: msg(4, { clientMsgId, bodyMd, threadRootId: root.id }) } };
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const send = renderHook(() => useSendMessage(CH, root.id), { wrapper }).result;

  let done!: Promise<void>;
  act(() => {
    done = send.current.send("스레드 답");
  });
  expect(fake.sentOf("message.send")[0]).toMatchObject({
    channelId: CH,
    threadRootId: root.id,
    bodyMd: "스레드 답",
  });
  expect(getThread(qc, CH, root.id)?.pending.map((p) => p.bodyMd)).toEqual(["스레드 답"]);
  expect(getTimeline(qc, CH)?.pending).toEqual([]);

  release();
  await act(() => done);
  expect(getThread(qc, CH, root.id)?.items.map((m) => m.seq)).toEqual([1, 4]);
  expect(getThread(qc, CH, root.id)?.pending).toEqual([]);
  // 채널 목록에는 답글이 없고, 다음 루트가 거짓 빈틈이 되지 않게 seq 만 올라간다
  expect(getTimeline(qc, CH)?.items.map((m) => m.seq)).toEqual([1]);
  expect(getTimeline(qc, CH)?.lastSeq).toBe(4);
});

it("채널 작성기는 threadRootId 를 싣지 않는다", async () => {
  fake.onAck("message.send", (p) => confirmed(p));
  const send = renderSend();
  await act(() => send.current.send("채널"));
  expect(fake.sentOf("message.send")[0]).not.toHaveProperty("threadRootId");
});
