import type { Message } from "@dodok/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { useJumpStore } from "@/features/messages/jumpTarget";
import { emptyTimeline, type Timeline } from "@/features/messages/timeline";
import { setChannelSeq } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { CH, msg, uid } from "../../../test/fixtures";
import { DEV } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { channelOf, conversationOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { LINK_COPIED, LINK_UNREADABLE, type LinkedMessageView } from "./messageLink";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
vi.mock("sonner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("sonner")>()),
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), info: vi.fn() }),
}));

const RECT = { width: 800, height: 600 };
const ROOT = msg(1, { bodyMd: "루트 질문" });
const range = (from: number, to: number): Message[] =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i, { bodyMd: `본문 ${from + i}` }));
const viewOf = (m: Message): LinkedMessageView => ({
  message: m,
  channelKind: "channel",
  channelName: "general",
  conversationTitle: "이전 대화",
});

let restore: Array<() => void>;
let routes: Map<string, () => Response>;
let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
beforeEach(() => {
  restore = [stubEditorDom(), stubScrollLayout(RECT)];
  wire.socket = createFakeSocket().wire;
  useWireStatus.getState().setStatus("connected");
  routes = new Map();
  fetchMock = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/agents") return json(200, { agents: [DEV] });
    if (url === "/api/v1/channels") return json(200, { channels: [channelOf(CH, { name: "general" })] });
    const r = routes.get(url);
    if (r) return r();
    if (url.startsWith("/api/v1/messages/"))
      return json(404, { code: "NOT_FOUND", message: "message not found" });
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: url });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const fn of restore) fn();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useJumpStore.setState({ targets: {} });
});

/** 채널 CH 에 들어가 구독 응답까지 받은 상태(루트 60~100, lastSeq 100) */
function subscribedClient() {
  const qc = createQueryClient(() => {});
  qc.setQueryData<Timeline>(qk.timeline(CH, CH), {
    ...emptyTimeline(),
    items: range(60, 100),
    hasOlder: true,
    lastSeq: 100,
  });
  setChannelSeq(qc, CH, 100);
  return qc;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  const spy = vi.fn(writeText);
  Object.defineProperty(navigator, "clipboard", { value: { writeText: spy }, configurable: true });
  return spy;
}

const rowOf = (text: string) => screen.getByText(text).closest("article") as HTMLElement;

describe("링크 복사", () => {
  it("동작 줄의 「링크 복사」 — 오리진 + 세션 주소 ?m= 를 클립보드에, 토스트 「링크를 복사했습니다」", async () => {
    const write = stubClipboard(async () => {});
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await screen.findByText("본문 100");
    await userEvent.click(within(rowOf("본문 100")).getByRole("button", { name: "링크 복사" }));
    const target = msg(100);
    expect(write).toHaveBeenCalledWith(`${window.location.origin}/c/${CH}/s/${CH}?m=${target.id}`);
    expect(toast.success).toHaveBeenCalledWith(LINK_COPIED, expect.anything());
  });

  it("클립보드가 거절하면 주소가 선택된 읽기 전용 칸을 띄운다", async () => {
    stubClipboard(async () => {
      throw new Error("denied");
    });
    renderRoute(`/c/${CH}/s/${CH}`, subscribedClient());
    await screen.findByText("본문 100");
    await userEvent.click(within(rowOf("본문 100")).getByRole("button", { name: "링크 복사" }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    const opts = vi.mocked(toast).mock.calls[0]?.[1] as { description: ReactElement };
    render(opts.description);
    const field = screen.getByRole("textbox", { name: "메시지 링크" });
    const url = `${window.location.origin}/c/${CH}/s/${CH}?m=${msg(100).id}`;
    expect(field).toHaveValue(url);
    expect(field).toHaveAttribute("readonly");
    const input = field as HTMLInputElement;
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, url.length]);
  });

  it("시스템 메시지에는 「링크 복사」가 없다", async () => {
    const qc = subscribedClient();
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({
      ...t!,
      items: [...t!.items, msg(101, { kind: "system", authorType: "system", bodyMd: "시스템 안내" })],
      lastSeq: 101,
    }));
    renderRoute(`/c/${CH}/s/${CH}`, qc);
    const row = (await screen.findByText("시스템 안내")).closest("[data-index]") as HTMLElement;
    expect(within(row).queryByRole("button", { name: "링크 복사" })).toBeNull();
  });
});

describe("?m= 주소로 들어오기", () => {
  it("받아 둔 페이지의 메시지 — 그 메시지를 강조하고 주소에서 m 을 지운다", async () => {
    const target = msg(80);
    routes.set(`/api/v1/messages/${target.id}`, () => json(200, viewOf(target)));
    const { router } = renderRoute(`/c/${CH}/s/${CH}?m=${target.id}`, subscribedClient());
    await waitFor(() =>
      expect(screen.getByText("본문 80").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`);
    expect(router.state.location.search).not.toHaveProperty("m");
  });

  it("아직 안 받은 오래된 페이지의 메시지 — around 로 받아 그 자리에 간다", async () => {
    const target = msg(10);
    routes.set(`/api/v1/messages/${target.id}`, () => json(200, viewOf(target)));
    routes.set(`/api/v1/conversations/${CH}/messages?limit=50&around=10`, () =>
      json(200, { messages: range(1, 20), hasMore: false, hasMoreAfter: true }),
    );
    renderRoute(`/c/${CH}/s/${CH}?m=${target.id}`, subscribedClient());
    await waitFor(() =>
      expect(screen.getByText("본문 10").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain(
      `/api/v1/conversations/${CH}/messages?limit=50&around=10`,
    );
  });

  it("스레드 주소 + ?m= — 스레드 패널 안의 그 답글로 간다", async () => {
    const reply = msg(133, { threadRootId: ROOT.id, bodyMd: "찾던 답글" });
    const qc = subscribedClient();
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({ ...t!, items: [ROOT, ...t!.items] }));
    routes.set(`/api/v1/messages/${reply.id}`, () => json(200, viewOf(reply)));
    const replies = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) =>
        msg(from + i, { threadRootId: ROOT.id, bodyMd: `답글 ${from + i}` }),
      );
    routes.set(`/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?limit=50`, () =>
      json(200, { root: ROOT, messages: replies(200, 249), hasMore: true }),
    );
    routes.set(`/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?limit=50&around=133`, () =>
      json(200, {
        root: ROOT,
        messages: [...replies(110, 132), reply, ...replies(134, 150)],
        hasMore: true,
        hasMoreAfter: true,
      }),
    );
    const { router } = renderRoute(`/c/${CH}/s/${CH}/t/${ROOT.id}?m=${reply.id}`, qc);
    const panel = await screen.findByTestId("thread-panel");
    await waitFor(() =>
      expect(within(panel).getByText("찾던 답글").closest("[data-index]")).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/t/${ROOT.id}`);
    expect(router.state.location.search).not.toHaveProperty("m");
  });

  it("주소의 대화와 응답이 다르면 응답의 대화로", async () => {
    const SIDE = uid(9_001);
    const target = msg(12, { conversationId: SIDE, bodyMd: "곁 세션 글" });
    routes.set(`/api/v1/messages/${target.id}`, () => json(200, viewOf(target)));
    routes.set(`/api/v1/conversations/${SIDE}`, () =>
      json(200, { conversation: conversationOf(CH, { id: SIDE, title: "곁" }) }),
    );
    const { router } = renderRoute(`/c/${CH}/s/${CH}?m=${target.id}`, subscribedClient());
    await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${SIDE}`));
    expect(useJumpStore.getState().targets[`${SIDE}:`]).toMatchObject({ messageId: target.id, seq: 12 });
  });

  it("못 읽는 메시지(404) — 「볼 수 없는 메시지입니다」 뒤 그 대화만 연다", async () => {
    const { router } = renderRoute(`/c/${CH}/s/${CH}?m=${uid(77_777)}`, subscribedClient());
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(LINK_UNREADABLE, expect.anything()));
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty("m"));
    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`);
    expect(await screen.findByText("본문 100")).toBeInTheDocument();
    expect(useJumpStore.getState().targets).toEqual({});
  });
});
