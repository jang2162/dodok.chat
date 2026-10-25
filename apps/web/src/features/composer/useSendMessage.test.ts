import type { Message, Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterContextProvider } from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createAppRouter } from "@/app/router";
import { fromLatest, NEW_CONVERSATION, threadFromPage } from "@/features/messages/timeline";
import { getThread, getTimeline, updateTimeline } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { useSendMessage } from "./useSendMessage";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { uploaded } from "../../../test/fakeXhr";
import { CH, msg, uid, USER } from "../../../test/fixtures";

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
  return renderHook(() => useSendMessage(CH, CH), { wrapper }).result;
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
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([
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
  const t = getTimeline(qc, CH, CH);
  expect(t?.pending).toEqual([]);
  expect(t?.items.map((m) => [m.seq, m.clientMsgId])).toEqual([[7, payload?.clientMsgId]]);
});

it("ack ok:false 면 failed", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "VALIDATION", message: "bad" } }));
  const send = renderSend();
  await act(() => send.current.send("안녕"));
  expect(getTimeline(qc, CH, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);
  expect(getTimeline(qc, CH, CH)?.items).toEqual([]);
});

it("ack 오류가 RATE_LIMITED 면 failed 에 사유 rate_limited — 그 밖 실패에는 사유가 없다", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" } }));
  const send = renderSend();
  await act(() => send.current.send("빨리"));
  expect(getTimeline(qc, CH, CH)?.pending.map((p) => [p.state, p.reason])).toEqual([
    ["failed", "rate_limited"],
  ]);

  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  await act(() => send.current.send("다른"));
  expect(getTimeline(qc, CH, CH)?.pending[1]).not.toHaveProperty("reason");
});

it("레이트리밋으로 실패한 것의 다시 보내기는 같은 clientMsgId 로 — 보내는 중에는 사유를 내린다", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "RATE_LIMITED", message: "slow down" } }));
  const send = renderSend();
  await act(() => send.current.send("빨리"));
  const first = getTimeline(qc, CH, CH)?.pending[0];

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
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([
    expect.not.objectContaining({ reason: expect.anything() }),
  ]);
  expect(getTimeline(qc, CH, CH)?.pending[0]?.state).toBe("sending");
  release();
  await act(() => done);
  const sent = fake.sentOf("message.send") as SendPayload[];
  expect(sent.map((p) => p.clientMsgId)).toEqual([first?.clientMsgId, first?.clientMsgId]);
  expect(getTimeline(qc, CH, CH)?.items.map((m) => m.seq)).toEqual([4]);
});

it("시간 초과(ack 없음)도 failed", async () => {
  // 대본이 없으면 가짜 소켓의 emitWithAck 가 던진다 = 시간 초과
  const send = renderSend();
  await act(() => send.current.send("안녕"));
  expect(getTimeline(qc, CH, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);
});

it("retry 는 같은 clientMsgId·같은 본문으로 다시 message.send — 보내는 중으로 돌아갔다가 확정", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const send = renderSend();
  await act(() => send.current.send("다시"));
  const first = getTimeline(qc, CH, CH)?.pending[0];
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
  expect(getTimeline(qc, CH, CH)?.pending.map((p) => p.state)).toEqual(["sending"]);
  release();
  await act(() => done);

  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, clientMsgId: first?.clientMsgId, bodyMd: "다시", conversationId: CH },
    { channelId: CH, clientMsgId: first?.clientMsgId, bodyMd: "다시", conversationId: CH },
  ]);
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([]);
  expect(getTimeline(qc, CH, CH)?.items.map((m) => m.seq)).toEqual([3]);
});

it("retry: 모르는 clientMsgId 는 아무것도 하지 않는다", async () => {
  const send = renderSend();
  await act(() => send.current.retry("nope"));
  expect(fake.sent).toEqual([]);
});

it("discard 는 캐시에서만 지운다(서버로 아무것도 보내지 않음)", async () => {
  const send = renderSend();
  await act(() => send.current.send("버릴 것"));
  const id = getTimeline(qc, CH, CH)?.pending[0]?.clientMsgId ?? "";
  const before = fake.sent.length;
  act(() => send.current.discard(id));
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([]);
  expect(fake.sent).toHaveLength(before);
});

it("wire 가 connected 가 아니면 보내지 않고 곧바로 failed(socket.io 가 끊김 중 emit 을 버퍼에 두지 않게)", async () => {
  useWireStatus.getState().setStatus("reconnecting");
  fake.onAck("message.send", (p) => confirmed(p));
  const send = renderSend();
  await act(() => send.current.send("끊김"));
  expect(fake.sentOf("message.send")).toEqual([]);
  expect(getTimeline(qc, CH, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);

  // 다시 붙은 뒤 다시 보내기는 간다
  useWireStatus.getState().setStatus("connected");
  await act(() => send.current.retry(getTimeline(qc, CH, CH)?.pending[0]?.clientMsgId ?? ""));
  await waitFor(() => expect(getTimeline(qc, CH, CH)?.pending).toEqual([]));
  expect(fake.sentOf("message.send")).toHaveLength(1);
});

it("소켓이 없으면(로그인 전·정리 뒤) failed", async () => {
  wire.socket = undefined;
  const send = renderSend();
  await act(() => send.current.send("없음"));
  expect(getTimeline(qc, CH, CH)?.pending.map((p) => p.state)).toEqual(["failed"]);
});

it("반환한 함수들은 렌더 사이에 같은 것(Provider 값이 매번 바뀌지 않게)", () => {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const { result, rerender } = renderHook(() => useSendMessage(CH, CH), { wrapper });
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
    conversationId: CH,
    clientMsgId: expect.any(String),
    bodyMd: "",
    attachments: [a1.id, a2.id],
  });
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([
    expect.objectContaining({ bodyMd: "", attachments: [a1, a2], state: "failed" }),
  ]);
});

it("첨부 있는 전송의 retry 는 같은 clientMsgId·같은 첨부 id 로(서버가 clientMsgId 로 멱등)", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const a1 = uploaded(1);
  const send = renderSend();
  await act(() => send.current.send("사진", [a1]));
  const id = getTimeline(qc, CH, CH)?.pending[0]?.clientMsgId ?? "";

  fake.onAck("message.send", (p) => confirmed(p, 4));
  await act(() => send.current.retry(id));
  const sent = { channelId: CH, conversationId: CH, clientMsgId: id, bodyMd: "사진", attachments: [a1.id] };
  expect(fake.sentOf("message.send")).toEqual([sent, sent]);
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([]);
});

it("빈 첨부 배열이면 페이로드·보내는 중 항목에 attachments 를 싣지 않는다", async () => {
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  const send = renderSend();
  await act(() => send.current.send("글만", []));
  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, conversationId: CH, clientMsgId: expect.any(String), bodyMd: "글만" },
  ]);
  expect(getTimeline(qc, CH, CH)?.pending[0]).not.toHaveProperty("attachments");
});

it("스레드 작성기: 그 세션과 threadRootId 를 싣고, 보내는 중·확정은 스레드 캐시에 — 세션 타임라인은 건드리지 않는다", async () => {
  const root = msg(1);
  updateTimeline(qc, CH, CH, (t) => fromLatest(t, [root], false));
  qc.setQueryData(qk.thread(CH, CH, root.id), threadFromPage(undefined, root, [], false));
  let release!: () => void;
  const acked = new Promise<void>((r) => (release = r));
  fake.onAck("message.send", async (p) => {
    await acked;
    const { clientMsgId, bodyMd } = p as SendPayload;
    return { ok: true, data: { message: msg(4, { clientMsgId, bodyMd, threadRootId: root.id }) } };
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const send = renderHook(() => useSendMessage(CH, CH, root.id), { wrapper }).result;

  let done!: Promise<void>;
  act(() => {
    done = send.current.send("스레드 답");
  });
  expect(fake.sentOf("message.send")[0]).toMatchObject({
    channelId: CH,
    conversationId: CH,
    threadRootId: root.id,
    bodyMd: "스레드 답",
  });
  expect(getThread(qc, CH, CH, root.id)?.pending.map((p) => p.bodyMd)).toEqual(["스레드 답"]);
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([]);

  release();
  await act(() => done);
  expect(getThread(qc, CH, CH, root.id)?.items.map((m) => m.seq)).toEqual([1, 4]);
  expect(getThread(qc, CH, CH, root.id)?.pending).toEqual([]);
  // 세션 목록에는 답글이 없다 — 답글의 seq 기록은 ack 보다 먼저 오는 서버의 message.created 가 맡는다(realtime/handlers)
  expect(getTimeline(qc, CH, CH)?.items.map((m) => m.seq)).toEqual([1]);
});

it("채널 작성기는 threadRootId 를 싣지 않는다", async () => {
  fake.onAck("message.send", (p) => confirmed(p));
  const send = renderSend();
  await act(() => send.current.send("채널"));
  expect(fake.sentOf("message.send")[0]).not.toHaveProperty("threadRootId");
});

it("[Review Focus 2] ack CONVERSATION_CLOSED 면 failed 에 사유 conversation_closed — 다른 탭이 닫은 세션", async () => {
  fake.onAck("message.send", () => ({
    ok: false,
    error: { code: "CONVERSATION_CLOSED", message: "닫힌 세션이다" },
  }));
  const send = renderSend();
  await act(() => send.current.send("늦은 글"));
  expect(getTimeline(qc, CH, CH)?.pending).toEqual([
    expect.objectContaining({ state: "failed", reason: "conversation_closed" }),
  ]);
});

describe("새 세션 창(/s/new) — 첫 보내기가 세션을 만든다(채널 세션 계획 판정 PS4·PS9)", () => {
  const NEW_ID = uid(3_001);
  /** 서버처럼: newConversation 이면 새 세션의 첫 메시지와 그 세션을, conversationId 면 그 세션의 메시지를 */
  const created = (p: unknown, seq: number) => {
    const { clientMsgId, bodyMd, conversationId } = p as SendPayload & { conversationId?: string };
    const message = msg(seq, { clientMsgId, bodyMd, conversationId: NEW_ID, id: uid(40_000 + seq) });
    return {
      ok: true as const,
      data: {
        message,
        ...(conversationId === undefined ? { conversation: conversationOf(seq) } : {}),
      },
    };
  };
  const conversationOf = (lastSeq: number) => ({
    id: NEW_ID,
    channelId: CH,
    title: "새 세션",
    titleSource: "auto" as const,
    createdBy: { type: "user" as const, id: USER },
    createdAt: msg(lastSeq).createdAt,
    lastMessageAt: msg(lastSeq).createdAt,
    lastSeq,
  });

  function renderNew(path = `/c/${CH}/s/${NEW_CONVERSATION}/settings`) {
    qc.setQueryData(qk.me, { user: { id: USER, handle: "owner" }, workspaceId: "w", role: "owner" });
    const history = createMemoryHistory({ initialEntries: [path] });
    const router = createAppRouter(qc, history);
    // 화면을 그리지 않으니 RouterProvider 가 하던 일(주소가 바뀌면 불러오기)을 대신 건다 — 이동의 약속이 그래야 끝난다
    history.subscribe(() => void router.load());
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(RouterContextProvider, { router, children }),
      );
    const result = renderHook(() => useSendMessage(CH, NEW_CONVERSATION), { wrapper }).result;
    return { result, history, router };
  }

  it("newConversation 을 싣고, ack 의 세션 타임라인에 확정 메시지를 넣은 뒤 주소를 그 세션으로 바꿔 간다(replace, 탭 그대로) — 그 다음에야 창의 항목을 지운다", async () => {
    let release!: () => void;
    const acked = new Promise<void>((r) => (release = r));
    fake.onAck("message.send", async (p) => {
      await acked;
      return created(p, 7);
    });
    const { result, history } = renderNew();
    const before = history.length;
    // 주소가 바뀌는 순간 새 세션에는 이미 메시지가 있고, 창에는 아직 항목이 있다 — 깜빡이거나 두 번 보이지 않게
    const atSwitch: Array<{ moved: boolean; waiting: number }> = [];
    const stop = history.subscribe(() =>
      atSwitch.push({
        moved: getTimeline(qc, CH, NEW_ID)?.items.some((m) => m.seq === 7) ?? false,
        waiting: getTimeline(qc, CH, NEW_CONVERSATION)?.pending.length ?? 0,
      }),
    );

    let done!: Promise<void>;
    act(() => {
      done = result.current.send("첫 글");
    });
    const [payload] = fake.sentOf("message.send") as Array<Record<string, unknown>>;
    expect(payload).toMatchObject({ channelId: CH, newConversation: {}, bodyMd: "첫 글" });
    expect(payload).not.toHaveProperty("conversationId");
    expect(getTimeline(qc, CH, NEW_CONVERSATION)?.pending.map((p) => p.state)).toEqual(["sending"]);

    release();
    await act(() => done);
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${NEW_ID}/settings`));
    await waitFor(() => expect(getTimeline(qc, CH, NEW_CONVERSATION)?.pending).toEqual([]));
    stop();
    expect(history.length).toBe(before);
    expect(atSwitch[0]).toEqual({ moved: true, waiting: 1 });
    const t = getTimeline(qc, CH, NEW_ID);
    expect(t?.items.map((m) => m.seq)).toEqual([7]);
    expect(t?.pending).toEqual([]);
    // 세션이 그 메시지 하나뿐이면 다시 받을 것이 없다
    expect(qc.getQueryState(qk.timeline(CH, NEW_ID))?.isInvalidated).toBe(false);
  });

  it("ack 를 잃었으면(시간 초과) 다시 보내기도 newConversation·같은 clientMsgId — 서버가 처음 만든 세션으로 답하고 그리로 간다", async () => {
    const { result, history } = renderNew(`/c/${CH}/s/${NEW_CONVERSATION}`);
    await act(() => result.current.send("첫 글"));
    const failed = getTimeline(qc, CH, NEW_CONVERSATION)?.pending[0];
    expect(failed?.state).toBe("failed");

    // 그 사이 다른 글이 그 세션에 붙었다 — 열 때 다시 받게 낡은 것으로 둔다
    fake.onAck("message.send", (p) => ({
      ...created(p, 3),
      data: { ...created(p, 3).data, conversation: conversationOf(5) },
    }));
    await act(() => result.current.retry(failed?.clientMsgId ?? ""));

    const sent = fake.sentOf("message.send") as Array<Record<string, unknown>>;
    expect(sent.map((p) => [p.clientMsgId, p.newConversation])).toEqual([
      [failed?.clientMsgId, {}],
      [failed?.clientMsgId, {}],
    ]);
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${NEW_ID}`));
    expect(getTimeline(qc, CH, NEW_ID)?.items.map((m) => m.seq)).toEqual([3]);
    expect(qc.getQueryState(qk.timeline(CH, NEW_ID))?.isInvalidated).toBe(true);
  });

  it("첫 ack 를 기다리는 사이 보낸 둘째 글은 새 세션을 또 만들지 않고 그 세션으로 간다", async () => {
    let release!: () => void;
    const acked = new Promise<void>((r) => (release = r));
    let n = 0;
    fake.onAck("message.send", async (p) => {
      n += 1;
      if (n === 1) await acked;
      return created(p, 6 + n);
    });
    const { result, history } = renderNew(`/c/${CH}/s/${NEW_CONVERSATION}`);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.send("하나");
    });
    act(() => {
      second = result.current.send("둘");
    });
    release();
    await act(() => Promise.all([first, second]));

    const sent = fake.sentOf("message.send") as Array<Record<string, unknown>>;
    expect(sent.map((p) => (p.newConversation ? "new" : p.conversationId))).toEqual(["new", NEW_ID]);
    await waitFor(() => expect(history.location.pathname).toBe(`/c/${CH}/s/${NEW_ID}`));
    await waitFor(() => expect(getTimeline(qc, CH, NEW_CONVERSATION)?.pending).toEqual([]));
    expect(getTimeline(qc, CH, NEW_ID)?.items.map((m) => m.bodyMd)).toEqual(["하나", "둘"]);
  });

  it("ack 가 올 때 이미 다른 곳으로 갔으면 주소를 바꾸지 않는다 — 메시지는 그 세션에, 창의 항목은 지운다", async () => {
    let release!: () => void;
    const acked = new Promise<void>((r) => (release = r));
    fake.onAck("message.send", async (p) => {
      await acked;
      return created(p, 7);
    });
    const { result, history, router } = renderNew(`/c/${CH}/s/${NEW_CONVERSATION}`);
    let done!: Promise<void>;
    act(() => {
      done = result.current.send("첫 글");
    });
    await act(() => router.navigate({ href: "/settings/account" }));
    release();
    await act(() => done);

    expect(history.location.pathname).toBe("/settings/account");
    expect(getTimeline(qc, CH, NEW_ID)?.items.map((m) => m.seq)).toEqual([7]);
    expect(getTimeline(qc, CH, NEW_CONVERSATION)?.pending).toEqual([]);
  });
});
