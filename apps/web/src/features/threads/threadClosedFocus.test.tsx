import type { Conversation } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline, threadFromPage, type Timeline } from "@/features/messages/timeline";
import { attachHandlers } from "@/realtime/handlers";
import { createSubscriptions } from "@/realtime/subscriptions";
import { useWireStatus } from "@/realtime/wire";
import { flushEditorFrames } from "../../../test/composerHarness";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { CH, msg, uid } from "../../../test/fixtures";
import { ME, channelOf, conversationOf, json, renderRoute, shellGet } from "../../../test/shellApi";
import { stubScrollLayout } from "../../../test/scrollLayout";

/**
 * 스레드 패널에서 쓰던 중 세션이 닫힐 때의 초점(plan.md 이월 「스레드 패널에서 쓰던 중 세션이 닫히면 초점이 본문 쪽 안내로 간다」).
 * 세션이 닫히면 세션 작성기 자리와 스레드 작성기 자리에 안내가 하나씩 선다 — 초점은 쓰던 쪽의 안내로 간다
 */
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const A = uid(5_101);
const at = (min: number) => new Date(Date.UTC(2027, 0, 15, 8, min)).toISOString();
const conv = (over: Partial<Conversation> = {}): Conversation =>
  conversationOf(CH, { id: A, title: "세션", createdAt: at(0), ...over });
const ROOT = msg(1, { conversationId: A, bodyMd: "루트 질문" });

let restore: Array<() => void>;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout()];
  wire.socket = createFakeSocket().wire;
  useWireStatus.getState().setStatus("connected");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, ME);
      if (url === `/api/v1/channels/${CH}`) return json(200, { channel: channelOf(CH) });
      if (url.startsWith(`/api/v1/channels/${CH}/conversations`))
        return json(200, { conversations: [conv()] });
      if (url === `/api/v1/conversations/${A}`) return json(200, { conversation: conv() });
      return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
    }),
  );
});
afterEach(async () => {
  await flushEditorFrames();
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

/** 실시간 이벤트는 실제 처리기(attachHandlers)가 같은 QueryClient 에 반영한다 */
function liveHandlers(qc: QueryClient) {
  const socket = createFakeSocket();
  const detach = attachHandlers(socket.wire, {
    queryClient: qc,
    subscriptions: createSubscriptions({ socket: socket.wire, queryClient: qc }),
    onUnauthorized: () => {},
    notify: {
      currentChannelId: () => undefined,
      currentConversationId: () => undefined,
      openActivity: () => {},
    },
  });
  return { emit: (event: string, payload: unknown) => act(() => socket.serverEmit(event, payload)), detach };
}

/** 넓은 화면 — 세션 작성기와 스레드 패널 작성기가 함께 보인다 */
async function openThread() {
  const qc = createQueryClient(() => {});
  qc.setQueryData<Timeline>(qk.timeline(CH, A), { ...emptyTimeline(), items: [ROOT], lastSeq: 1 });
  qc.setQueryData<Timeline>(qk.thread(CH, A, ROOT.id), threadFromPage(undefined, ROOT, [ROOT], false));
  const { router } = renderRoute(`/c/${CH}/s/${A}/t/${ROOT.id}`, qc);
  const panel = await screen.findByTestId("thread-panel");
  const reply = await within(panel).findByRole("textbox", { name: "스레드 답글 입력" });
  const main = await screen.findByRole("textbox", { name: "메시지 입력" });
  return { qc, router, panel, reply, main };
}

const closeByOther = () => ({ conversation: conv({ closedAt: at(3), closedBy: "other" }) });

it("스레드 작성기에서 쓰던 중 세션이 닫히면 초점은 스레드 패널의 안내로 간다 — 본문 쪽 안내가 아니다", async () => {
  const { qc, panel, reply } = await openThread();
  const live = liveHandlers(qc);
  act(() => reply.focus());
  expect(reply).toHaveFocus();

  live.emit("conversation.updated", closeByOther());

  const notice = await within(panel).findByTestId("conversation-closed");
  await waitFor(() => expect(within(notice).getByText("닫힌 세션입니다")).toHaveFocus());
  live.detach();
});

it("세션 작성기에서 쓰던 중이면 스레드 패널이 열려 있어도 초점은 본문 쪽 안내로 간다", async () => {
  const { qc, panel, main } = await openThread();
  const live = liveHandlers(qc);
  act(() => main.focus());
  expect(main).toHaveFocus();

  live.emit("conversation.updated", closeByOther());

  await within(panel).findByTestId("conversation-closed");
  const notices = await screen.findAllByTestId("conversation-closed");
  const mainNotice = notices.find((n) => !panel.contains(n));
  if (!mainNotice) throw new Error("본문 쪽 안내가 없다");
  await waitFor(() => expect(within(mainNotice).getByText("닫힌 세션입니다")).toHaveFocus());
  live.detach();
});

it("스레드 작성기에서 쓰던 중 패널이 그냥 빠지면(주소 이동 — 뒤로 가기) 그 뒤 세션이 닫힐 때 초점은 본문 쪽 안내로 간다", async () => {
  const { qc, router, reply } = await openThread();
  const live = liveHandlers(qc);
  act(() => reply.focus());
  expect(reply).toHaveFocus();
  // 닫기 단추가 아니라 주소로 빠진다 — 초점을 돌려줄 자리 없이 body 로 떨어진다
  await act(() => router.navigate({ to: `/c/${CH}/s/${A}` }));
  await waitFor(() => expect(screen.queryByTestId("thread-panel")).toBeNull());
  expect(document.activeElement).toBe(document.body);

  live.emit("conversation.updated", closeByOther());

  const notice = await screen.findByTestId("conversation-closed");
  await waitFor(() => expect(within(notice).getByText("닫힌 세션입니다")).toHaveFocus());
  live.detach();
});
