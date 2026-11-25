import type { Message } from "@dodok/shared";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { useJumpStore } from "@/features/messages/jumpTarget";
import { emptyTimeline, type Timeline } from "@/features/messages/timeline";
import { setChannelSeq } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, msg } from "../../../test/fixtures";
import { DEV } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { channelOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import type { LinkedMessageView } from "./messageLink";

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

const linkTo = (m: Message) => `${window.location.origin}/c/${m.channelId}/s/${m.conversationId}?m=${m.id}`;
const cards = () => screen.queryAllByRole("button", { name: /^링크한 메시지 — / });

/** 맨 아래(101)에 링크 글을 둔 채널 */
function withLinkPost(bodyMd: string) {
  const qc = subscribedClient();
  qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({
    ...t!,
    items: [...t!.items, msg(101, { bodyMd })],
    lastSeq: 101,
  }));
  setChannelSeq(qc, CH, 101);
  return qc;
}

describe("보낸 글의 인용 카드", () => {
  it("작성자·「# 채널 · 세션 제목 · 시각」·본문 첫 2줄(멘션 @핸들, 마크다운 걷음), 누르면 그 메시지로 가 강조", async () => {
    const target: Message = {
      // 셸의 사람 목록은 id "u" 의 「주인」 하나 — 픽스처의 uuid 검사를 지난 뒤 바꾼다
      ...msg(80, { bodyMd: `**스키마** 변경안 <@a:${AGENT}>\n\n---\n둘째 줄\n셋째 줄` }),
      authorId: ME.user.id,
    };
    routes.set(`/api/v1/messages/${target.id}`, () => json(200, viewOf(target)));
    const { router } = renderRoute(`/c/${CH}/s/${CH}`, withLinkPost(`이거 봐 [글](${linkTo(target)}).`));
    const [card] = await waitFor(() => {
      const found = cards();
      expect(found).toHaveLength(1);
      return found;
    });
    expect(card).toHaveTextContent("# general · 이전 대화 ·");
    expect(card).toHaveAccessibleName(`링크한 메시지 — 주인: 스키마 변경안 @dev\n둘째 줄`);
    await userEvent.click(card!);
    await waitFor(() =>
      expect(screen.getByText("본문 80").closest("[data-index]")).toHaveAttribute("data-highlighted", "true"),
    );
    expect(router.state.location.search).not.toHaveProperty("m");
  });

  it("보는 사람이 못 읽는 메시지(404)면 카드 없이 링크 글만", async () => {
    const hidden = msg(70);
    const qc = withLinkPost(`비밀 ${linkTo(hidden)}`);
    renderRoute(`/c/${CH}/s/${CH}`, qc);
    await screen.findByText(/비밀/);
    await waitFor(() => expect(qc.getQueryState(["message", hidden.id])?.status).toBe("success"));
    expect(cards()).toHaveLength(0);
  });

  it("링크가 넷이면 카드 셋", async () => {
    const targets = [81, 82, 83, 84].map((n) => msg(n));
    for (const m of targets) routes.set(`/api/v1/messages/${m.id}`, () => json(200, viewOf(m)));
    renderRoute(`/c/${CH}/s/${CH}`, withLinkPost(targets.map(linkTo).join(" ")));
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(fetchMock.mock.calls.map((c) => String(c[0]))).not.toContain(`/api/v1/messages/${targets[3]!.id}`);
  });
});
