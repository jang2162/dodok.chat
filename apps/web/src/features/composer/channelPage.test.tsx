import type { Message, Result } from "@dodok/shared";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { getTimeline, setChannelSeq } from "@/realtime/timelineCache";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, msg } from "../../../test/fixtures";
import { DEV, memberOf } from "../../../test/composerHarness";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { emptyTimeline } from "@/features/messages/timeline";
import { ME, json, renderRoute, shellGet } from "../../../test/shellApi";

// 채널 화면이 작성기 자리를 채우고, 보내는 중 항목의 다시 보내기·삭제를 PendingActionsContext 로 내려 주는지 잰다.
// 목록(태스크 7)은 아직 없으므로 헤더 자리에 컨텍스트를 읽는 탐침을 둔다
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));
vi.mock("@/app/layout/ChannelHeader", async () => {
  const { usePendingActions } = await import("@/features/messages/pendingActions");
  const { useQueryClient } = await import("@tanstack/react-query");
  const timeline = await import("@/realtime/timelineCache");
  return {
    ChannelHeader: ({ channelId }: { channelId: string }) => {
      const actions = usePendingActions();
      const qc = useQueryClient();
      const first = () => timeline.getTimeline(qc, channelId, channelId)?.pending[0]?.clientMsgId ?? "";
      return (
        <div>
          <button type="button" onClick={() => actions?.retry(first())}>
            탐침 다시 보내기
          </button>
          <button type="button" onClick={() => actions?.discard(first())}>
            탐침 삭제
          </button>
        </div>
      );
    },
  };
});

let fake: FakeSocket;
let restoreDom: () => void;
beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) =>
      String(input) === "/api/v1/auth/me" ? json(200, ME) : (shellGet(input, init) ?? json(404, {})),
    ),
  );
});
afterEach(() => {
  restoreDom();
  vi.unstubAllGlobals();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const confirmed = (payload: unknown): Result<{ message: Message }> => {
  const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
  return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd }) } };
};

async function sendFailing(text: string) {
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: Editor }).editor;
  act(() => {
    editor.commands.setContent(text);
    editor.commands.focus("end");
  });
  fake.onAck("message.send", () => ({ ok: false, error: { code: "INTERNAL", message: "x" } }));
  fireEvent.keyDown(box, { key: "Enter" });
}

it("작성기 자리: 작성 중 표시 + 작성기", async () => {
  renderRoute(`/c/${CH}/s/${CH}`);
  const box = await screen.findByRole("textbox", { name: "메시지 입력" });
  const slot = box.closest('[data-slot="composer"]');
  expect(slot).not.toBeNull();
  expect(within(slot as HTMLElement).getByRole("button", { name: "보내기" })).toBeInTheDocument();
});

it("PendingActions: 다시 보내기는 같은 clientMsgId 로 다시 보내 확정, 삭제는 캐시에서만", async () => {
  const { queryClient } = renderRoute(`/c/${CH}/s/${CH}`);
  await sendFailing("실패할 글");
  await waitFor(() =>
    expect(getTimeline(queryClient, CH, CH)?.pending.map((p) => p.state)).toEqual(["failed"]),
  );
  const id = getTimeline(queryClient, CH, CH)?.pending[0]?.clientMsgId;

  fake.onAck("message.send", confirmed);
  await userEvent.click(screen.getByRole("button", { name: "탐침 다시 보내기" }));
  await waitFor(() => expect(getTimeline(queryClient, CH, CH)?.pending).toEqual([]));
  expect(getTimeline(queryClient, CH, CH)?.items.map((m) => m.clientMsgId)).toEqual([id]);
  expect(fake.sentOf("message.send").map((p) => (p as { clientMsgId: string }).clientMsgId)).toEqual([
    id,
    id,
  ]);

  await sendFailing("버릴 글");
  await waitFor(() => expect(getTimeline(queryClient, CH, CH)?.pending).toHaveLength(1));
  const sent = fake.sent.length;
  await userEvent.click(screen.getByRole("button", { name: "탐침 삭제" }));
  expect(getTimeline(queryClient, CH, CH)?.pending).toEqual([]);
  expect(fake.sent).toHaveLength(sent);
});

/** 에이전트 dev 가 쓴 글 하나가 든 채널 — dev 는 채널 멤버라 작성기의 @ 후보다. `thread` 면 그 글을 답글로 둔 스레드를 연다 */
const ROOT = msg(1, { bodyMd: "루트 질문" });
function renderWithAgentMessage({ thread = false } = {}) {
  // 가상 목록은 높이를 재야 줄을 그린다
  const restoreScroll = stubScrollLayout();
  onTestFinished(restoreScroll);
  const agentMsg = thread
    ? msg(2, { authorType: "agent", authorId: AGENT, bodyMd: "답글 정리", threadRootId: ROOT.id })
    : msg(1, { authorType: "agent", authorId: AGENT, bodyMd: "정리했습니다" });
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, ME);
      if (url === "/api/v1/agents") return json(200, { agents: [DEV] });
      if (url === `/api/v1/channels/${CH}/members`) return json(200, { members: [memberOf(DEV.id)] });
      if (url.startsWith(`/api/v1/conversations/${CH}/threads/`))
        return json(200, { root: ROOT, messages: [ROOT, agentMsg], hasMore: false });
      return shellGet(input, init) ?? json(404, {});
    }),
  );
  const qc = createQueryClient(() => {});
  qc.setQueryData(qk.timeline(CH, CH), {
    ...emptyTimeline(),
    items: [
      thread
        ? { ...ROOT, threadSummary: { count: 1, lastAt: agentMsg.createdAt, agentIds: [AGENT] } }
        : agentMsg,
    ],
    lastSeq: thread ? 2 : 1,
  });
  if (thread) setChannelSeq(qc, CH, 2);
  renderRoute(thread ? `/c/${CH}/s/${CH}/t/${ROOT.id}` : `/c/${CH}/s/${CH}`, qc);
}
const textOf = async (name: string) => {
  const box = await screen.findByRole("textbox", { name });
  return (box as unknown as { editor: Editor }).editor.getText();
};
const composerText = () => textOf("메시지 입력");
/** 플랫폼을 바꿔 잰다 — 바로 멘션 수정 키가 macOS 는 ⌘, 그 밖은 Ctrl */
const onPlatform = (platform: string) => {
  const spy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  onTestFinished(() => spy.mockRestore());
};

it("에이전트 작성자 이름 → 메뉴 「멘션」·「프로필」, 「멘션」은 세션 작성기에 @dev 칩 [UI 시안 02]", async () => {
  renderWithAgentMessage();
  const user = userEvent.setup();
  const name = await screen.findByRole("button", { name: "개발봇" });
  // 후보 목록(멤버·에이전트)을 받은 뒤 부른다
  await waitFor(async () => expect(await composerText()).toBe(""));
  name.focus();
  await user.keyboard("{Enter}");
  const menu = await screen.findByRole("menu");
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((i) => i.textContent),
  ).toEqual(["멘션", "프로필"]);
  await user.click(within(menu).getByRole("menuitem", { name: "멘션" }));
  await waitFor(async () => expect(await composerText()).toBe("@dev "));
});

it("이름 메뉴를 Esc 로 닫으면 초점이 그 이름 단추로 돌아온다", async () => {
  renderWithAgentMessage();
  const user = userEvent.setup();
  const name = await screen.findByRole("button", { name: "개발봇" });
  name.focus();
  await user.keyboard("{Enter}");
  await screen.findByRole("menu");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await waitFor(() => expect(name).toHaveFocus());
});

it("스레드 패널 안의 이름 → 「멘션」은 스레드 작성기에 넣고 세션 작성기에는 넣지 않는다", async () => {
  renderWithAgentMessage({ thread: true });
  const user = userEvent.setup();
  const panel = await screen.findByTestId("thread-panel");
  const name = await within(panel).findByRole("button", { name: "개발봇" });
  await waitFor(async () => expect(await textOf("스레드 답글 입력")).toBe(""));
  name.focus();
  await user.keyboard("{Enter}");
  await user.click(within(await screen.findByRole("menu")).getByRole("menuitem", { name: "멘션" }));
  await waitFor(async () => expect(await textOf("스레드 답글 입력")).toBe("@dev "));
  expect(await composerText()).toBe("");
});

it("macOS: ⌘+클릭은 누르는 순간 메뉴를 열지 않고 바로 멘션, Ctrl+클릭(컨텍스트 메뉴)은 멘션하지 않는다", async () => {
  onPlatform("MacIntel");
  renderWithAgentMessage();
  const user = userEvent.setup();
  const name = await screen.findByRole("button", { name: "개발봇" });
  expect(name).toHaveAttribute("title", "⌘+클릭으로 바로 멘션");
  await waitFor(async () => expect(await composerText()).toBe(""));
  const press = (over: { metaKey?: boolean }) =>
    fireEvent.pointerDown(name, { button: 0, ctrlKey: false, pointerType: "mouse", ...over });
  // 대조 — 수정 키 없이 누르면 Radix 가 pointerdown 에서 메뉴를 연다(이 환경이 그 길을 탄다는 증거. 화면이 자리 잡기 전 첫 누름은 놓칠 수 있다)
  // waitFor 안에서 누르면 DOM 변화마다 콜백이 다시 돌아 열고 닫기를 끝없이 되풀이한다 — 몇 번만 따로 눌러 본다
  for (let i = 0; i < 10 && name.getAttribute("data-state") !== "open"; i++) {
    press({});
    await act(() => new Promise((r) => setTimeout(r, 30)));
  }
  expect(name).toHaveAttribute("data-state", "open");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(name).toHaveAttribute("data-state", "closed"));
  // ⌘ 로 누른 순간은 열리지 않는다 — 가드가 없으면 위 대조처럼 열린다
  press({ metaKey: true });
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(name).toHaveAttribute("data-state", "closed");
  await user.keyboard("{Meta>}");
  await user.click(name);
  await user.keyboard("{/Meta}");
  await waitFor(async () => expect(await composerText()).toBe("@dev "));
  expect(screen.queryByRole("menu")).toBeNull();
  await user.keyboard("{Control>}");
  await user.click(name);
  await user.keyboard("{/Control}");
  expect(await composerText()).toBe("@dev ");
});

it("macOS 밖: Ctrl+클릭은 메뉴 없이 바로 멘션, ⌘(Meta)+클릭은 바로 멘션이 아니다", async () => {
  onPlatform("Win32");
  renderWithAgentMessage();
  const user = userEvent.setup();
  const name = await screen.findByRole("button", { name: "개발봇" });
  expect(name).toHaveAttribute("title", "Ctrl+클릭으로 바로 멘션");
  await waitFor(async () => expect(await composerText()).toBe(""));
  await user.keyboard("{Control>}");
  await user.click(name);
  await user.keyboard("{/Control}");
  await waitFor(async () => expect(await composerText()).toBe("@dev "));
  expect(screen.queryByRole("menu")).toBeNull();
  await user.keyboard("{Meta>}");
  await user.click(name);
  await user.keyboard("{/Meta}");
  expect(await screen.findByRole("menu")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(await composerText()).toBe("@dev ");
});
