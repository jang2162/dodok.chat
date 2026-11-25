import type { Agent, BackgroundTask, ChannelSubscribeResult, Result, Run, RunEvent } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { ApprovalCard } from "@/features/approvals/ApprovalCard";
import { selectPendingApproval, useApprovalStore } from "@/features/approvals/approvalStore";
import { emptyTimeline } from "@/features/messages/timeline";
import { useRunStore } from "@/features/runs/runStore";
import { TICK_MS } from "@/hooks/useNowTick";
import { createSubscriptions } from "@/realtime/subscriptions";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import {
  AGENT,
  APPROVAL,
  APPROVAL2,
  approval,
  CH,
  CH2,
  iso,
  msg,
  RUN,
  RUN2,
  runEvent,
  runState,
  textDelta,
  uid,
} from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { renderWithClient } from "../../../test/messages";
import { stubScrollLayout } from "../../../test/scrollLayout";
import { channelOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { agentOf } from "../../../test/settingsServer";
import { RunCards } from "./RunCard";
import { APPROVAL_PENDING_HINT } from "./RunTimeline";
import type { ActivityRun } from "./timeline";
import { useBackgroundTaskStore } from "./useBackgroundTasks";

// 활동 패널은 실시간 run.event 를 소켓에서 곧바로 받는다 — 테스트는 가짜 소켓을 끼운다
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

// 런 카드가 다시 그려진 수 — `RunCard` 는 그릴 때마다 `useAgents` 를 한 번 부른다(리뷰 M1 시험)
const agentsCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("@/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/queries")>();
  return {
    ...actual,
    useAgents: (...args: Parameters<typeof actual.useAgents>) => {
      agentsCalls.n += 1;
      return actual.useAgents(...args);
    },
  };
});

const DEV = agentOf(AGENT, "dev");
const TOOL_EVENTS: RunEvent[] = [
  runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Read" }),
  runEvent({ type: "TOOL_CALL_ARGS", seq: 2, toolCallId: "t1", delta: '{"path":' }),
  runEvent({ type: "TOOL_CALL_ARGS", seq: 3, toolCallId: "t1", delta: '"README.md"}' }),
  runEvent({ type: "TOOL_CALL_RESULT", seq: 4, toolCallId: "t1", content: "ok", ok: true, durationMs: 12 }),
  runEvent({ type: "TOOL_CALL_END", seq: 5, toolCallId: "t1" }),
];

const runOf = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  channelId: CH,
  conversationId: CH,
  agentId: AGENT,
  triggerKind: "mention",
  rootMessageId: uid(9),
  relayDepth: 0,
  sessionKey: "agent:dev:dodok:channel:c",
  status: "done",
  hasCanonical: true,
  createdAt: "2027-01-15T08:00:00.000Z",
  startedAt: "2027-01-15T08:00:01.000Z",
  endedAt: "2027-01-15T08:00:13.000Z",
  ...over,
});

type ServerOpts = {
  runs?: Run[];
  agents?: Agent[];
  events?: RunEvent[] | Record<string, RunEvent[]>;
  override?: (method: string, url: string) => Response | undefined;
};

/** 활동 패널이 부르는 REST 를 흉내 낸다. 그 밖은 앱 셸 기본 응답 */
function stubServer({ runs = [], agents = [DEV], events = [], override }: ServerOpts = {}) {
  const calls: string[] = [];
  const state = { runs };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const forced = override?.(method, url);
    if (forced) return forced;
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/agents") return json(200, { agents });
    if (/^\/api\/v1\/channels\/[^/]+\/runs(\?|$)/.test(url)) return json(200, { runs: state.runs });
    const m = /^\/api\/v1\/runs\/([^/]+)\/events(\?|$)/.exec(url);
    if (m?.[1]) return json(200, { events: Array.isArray(events) ? events : (events[m[1]] ?? []) });
    return shellGet(input, init) ?? json(404, { code: "NOT_FOUND", message: "x" });
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, state };
}

let fake: FakeSocket;
beforeEach(() => {
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
  useBackgroundTaskStore.getState().reset();
});
afterEach(async () => {
  // 앱 셸의 작성기(tiptap)는 언마운트된 뒤 다음 틱(`setTimeout` 1ms)에 `Editor.destroy` 를 부른다 — 파일의 마지막 테스트면 그 틱이
  // 오기 전에 테스트 환경이 내려가 「window is not defined」로 터졌다(plan.md 이월 「테스트 빈틈 몇」). 여기서 먼저 내리고 그 틱을 넘긴다
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 5));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
});

const panel = () => screen.findByTestId("page-channel-panel");
/** 펼친 런 카드의 id 들(위에서부터) — 카드의 `data-expanded` 가 정본이다 */
const openRuns = (aside: HTMLElement) =>
  [...aside.querySelectorAll<HTMLElement>('[data-run-id][data-expanded="true"]')].map(
    (el) => el.dataset.runId,
  );
/** 런 카드 하나 */
const card = (aside: HTMLElement, runId: string) => {
  const el = aside.querySelector<HTMLElement>(`[data-run-id="${runId}"]`);
  if (!el) throw new Error(`${runId} 카드가 없다`);
  return el;
};
const runIds = (aside: HTMLElement) =>
  [...aside.querySelectorAll<HTMLElement>("[data-run-id]")].map((el) => el.dataset.runId);
const timelineBox = (aside: HTMLElement) => aside.querySelector('[data-slot="run-timeline"]');

it("활동 탭은 런 카드를 보이고 가장 최근 런은 펼친 채다 — 접고 펼 수 있고, 도구 줄을 누르면 인자·결과", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);

  const aside = await panel();
  // 탭 둘 — 지금 탭은 aria-current
  expect(within(aside).getByRole("link", { name: "설정" })).not.toHaveAttribute("aria-current");
  expect(within(aside).getByRole("link", { name: "활동" })).toHaveAttribute("aria-current", "page");

  // 카드는 접근 이름 「@핸들 런, 상태」의 영역이고, 머리 단추가 펼침을 쥔다
  expect(await within(aside).findByRole("region", { name: "@dev 런, 완료" })).toBe(card(aside, RUN));
  const head = within(aside).getByRole("button", { name: /@dev/ });
  expect(head).toHaveAttribute("aria-expanded", "true");
  expect(await within(aside).findByText("Read")).toBeInTheDocument();
  await userEvent.click(head);
  expect(head).toHaveAttribute("aria-expanded", "false");
  expect(within(aside).queryByText("Read")).not.toBeInTheDocument();
  await userEvent.click(head);
  expect(await within(aside).findByText("Read")).toBeInTheDocument();

  // 인자·결과는 접힘이 기본 — 줄에는 인자 한 줄 요약만(고정폭)
  expect(screen.queryByText('{"path":"README.md"}')).not.toBeInTheDocument();
  expect(within(aside).getByText("path=README.md")).toHaveClass("font-mono");
  const tool = within(aside).getByRole("button", { name: "Read 자세히" });
  expect(tool).toHaveAttribute("aria-expanded", "false");
  // 줄 전체가 단추다 — 이름·요약·소요가 그 안에 있다
  expect(tool).toHaveTextContent("Read");
  expect(tool).toHaveTextContent("path=README.md");
  expect(tool).toHaveTextContent("12ms");
  await userEvent.click(tool);
  expect(tool).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByText('{"path":"README.md"}').tagName).toBe("PRE");
  expect(screen.getByText("ok").tagName).toBe("PRE");
  await userEvent.click(tool);
  expect(screen.queryByText('{"path":"README.md"}')).not.toBeInTheDocument();
  expect(screen.queryByText("ok")).not.toBeInTheDocument();
});

it("텍스트 델타는 타임라인에 들어가지 않는다", async () => {
  stubServer({ runs: [runOf(RUN)], events: [textDelta(1, "긴 답변"), ...TOOL_EVENTS] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  expect(await within(aside).findByText("Read")).toBeInTheDocument();
  expect(within(aside).queryByText("긴 답변")).not.toBeInTheDocument();
  expect(within(aside).getAllByRole("listitem")).toHaveLength(2); // 런 한 줄 + 툴 한 행
});

it("잘린 결과에는 잘림 표시가 붙는다", async () => {
  stubServer({
    runs: [runOf(RUN)],
    events: [
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Write" }),
      runEvent({
        type: "TOOL_CALL_RESULT",
        seq: 2,
        toolCallId: "t1",
        content: "앞부분 … …[+120 chars hidden]… …",
        ok: true,
      }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  expect(await within(aside).findByText("잘렸습니다")).toBeInTheDocument();
});

it("진행 중 런은 새 이벤트가 오면 끝에 붙는다", async () => {
  stubServer({ runs: [runOf(RUN, { status: "tool", endedAt: undefined })], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  expect(within(aside).queryByText("Bash")).not.toBeInTheDocument();

  act(() => {
    fake.serverEmit("run.event", {
      event: runEvent({ type: "TOOL_CALL_START", seq: 6, toolCallId: "t2", toolCallName: "Bash" }),
    });
  });
  const rows = await within(aside).findByRole("list", { name: "활동 기록" });
  await waitFor(() => expect(within(rows).getAllByRole("listitem")).toHaveLength(2));
  expect(within(rows).getAllByRole("listitem").at(-1)).toHaveTextContent("Bash");
});

/**
 * 진행 중 타임라인은 끝에 붙어 따라가고, 위로 올려 읽는 사람은 끌어내리지 않는다. jsdom 은 배치를 계산하지 않으므로
 * 이 타임라인 상자 하나에만 높이(행마다 40px, 보이는 높이 100px)와 스크롤 위치를 흉내 낸다
 */
it("진행 중 타임라인은 끝을 따라가고, 위로 올린 사람은 끌어내리지 않는다", async () => {
  stubServer({ runs: [runOf(RUN, { status: "tool", endedAt: undefined })], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  const box = timelineBox(card(aside, RUN)) as HTMLElement;
  let top = 0;
  const height = () => box.querySelectorAll("li").length * 40;
  const maxTop = () => Math.max(0, height() - 100);
  Object.defineProperties(box, {
    scrollHeight: { configurable: true, get: height },
    clientHeight: { configurable: true, get: () => 100 },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.min(Math.max(0, v), maxTop());
      },
    },
  });
  let seq = 6;
  const addTool = async (name: string) => {
    const before = box.querySelectorAll("li").length;
    act(() => {
      fake.serverEmit("run.event", {
        event: runEvent({ type: "TOOL_CALL_START", seq: seq++, toolCallId: `f${seq}`, toolCallName: name }),
      });
    });
    await waitFor(() => expect(box.querySelectorAll("li")).toHaveLength(before + 1));
  };

  // 끝에 붙어 있으면 새 행을 따라 내려간다
  await addTool("Bash");
  await addTool("Grep");
  await addTool("Glob");
  expect(maxTop()).toBeGreaterThan(0);
  expect(top).toBe(maxTop());

  // 위로 올려 읽는 중이면 새 행이 와도 그 자리에 둔다
  top = 0;
  fireEvent.scroll(box);
  await addTool("Edit");
  expect(top).toBe(0);

  // 다시 끝으로 내리면 또 따라간다
  top = maxTop();
  fireEvent.scroll(box);
  await addTool("Write");
  expect(top).toBe(maxTop());
});

it("다른 런의 실시간 이벤트는 섞이지 않는다", async () => {
  stubServer({ runs: [runOf(RUN)], events: { [RUN]: TOOL_EVENTS } });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  act(() => {
    fake.serverEmit("run.event", {
      event: runEvent({
        type: "TOOL_CALL_START",
        runId: RUN2,
        seq: 6,
        toolCallId: "t9",
        toolCallName: "남의도구",
      }),
    });
  });
  expect(within(aside).queryByText("남의도구")).not.toBeInTheDocument();
});

it("실시간 run.state 로 시작한 런도 목록에 든다 — 그때 REST 를 다시 부르지는 않는다", async () => {
  const { calls } = stubServer({ runs: [] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");
  const listCalls = () => calls.filter((c) => /\/runs\?/.test(c)).length;
  expect(listCalls()).toBe(1);

  for (const status of ["queued", "streaming", "tool"] as const) {
    act(() => {
      useRunStore.getState().applyState(runState({ id: RUN2, status }));
    });
  }
  expect(await within(aside).findByRole("button", { name: /@dev/ })).toHaveTextContent("도구 사용 중");
  expect(listCalls()).toBe(1);

  // 끝나면 한 번 받아 둔다 — 캐시가 그 런을 모르는 채 남지 않게(`ended`)
  await act(async () => {
    useRunStore.getState().applyState(runState({ id: RUN2, status: "done" }));
  });
  await waitFor(() => expect(listCalls()).toBe(2));

  /**
   * 그 뒤 버블 정리로 런 스토어에서 빠져도 **다시 부르지 않는다**: 종료를 본 런은 `ended` 가 맡으므로
   * 「빠진 런」 자리값(D12)에 겹쳐 넣지 않는다. 겹치면 `settledKey` 가 한 번 더 바뀌어 런마다 재조회가
   * 한 번 더 난다(리뷰 C.1 — 이 가드를 잠그는 테스트가 없었다)
   */
  await act(async () => {
    useRunStore.getState().remove(RUN2);
  });
  expect(within(aside).getByRole("button", { name: /@dev/ })).toHaveTextContent("완료");
  expect(listCalls()).toBe(2);
});

it("런 조회 실패는 패널 안에 알리고 「다시 시도」로 되살린다", async () => {
  let fail = true;
  stubServer({
    runs: [runOf(RUN)],
    override: (method, url) =>
      fail && method === "GET" && /\/runs(\?|$)/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  expect(await within(aside).findByText("런 목록을 불러오지 못했습니다.")).toBeInTheDocument();
  fail = false;
  await userEvent.click(within(aside).getByRole("button", { name: "다시 시도" }));
  expect(await within(aside).findByRole("button", { name: /@dev/ })).toBeInTheDocument();
});

it("타임라인 조회 실패도 패널 안에 알린다", async () => {
  stubServer({
    runs: [runOf(RUN)],
    override: (method, url) =>
      method === "GET" && /\/events(\?|$)/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  expect(await within(aside).findByText("활동 기록을 불러오지 못했습니다.")).toBeInTheDocument();
});

it("설정 탭으로 가도 같은 틀(패널·시트)이 유지된다", async () => {
  const media = stubMedia(false);
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`);

  const aside = await panel();
  expect(aside.tagName).toBe("ASIDE");
  expect(aside).toHaveAttribute("data-panel-tab", "activity");
  expect(within(aside).getByRole("heading", { name: "활동" })).toBeInTheDocument();

  // 좁은 화면이면 같은 내용이 전체 화면 시트로
  media.setNarrow(true);
  const sheet = await screen.findByRole("dialog", { name: "활동" });
  expect(sheet).toHaveAttribute("data-testid", "page-channel-panel");
  expect(await within(sheet).findByRole("link", { name: "설정" })).toBeInTheDocument();

  // 설정 탭으로 — 같은 틀, 제목만 바뀐다
  await userEvent.click(within(sheet).getByRole("link", { name: "설정" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/settings`));
  expect(await screen.findByRole("dialog", { name: "채널 설정" })).toHaveAttribute(
    "data-testid",
    "page-channel-panel",
  );

  media.setNarrow(false);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(await screen.findByTestId("page-channel-panel")).toHaveAttribute("data-panel-tab", "settings");
});

/**
 * 브라우저 검증 D3 — 탭을 옮기면 초점이 `<body>` 로 떨어지던 것. 탭 머리를 부모(ChannelPage)가 그려
 * 링크가 언마운트되지 않으므로, 누른 링크에 초점이 그대로 남는다(키보드 이동이 처음부터 다시 시작되지 않는다)
 */
it("탭을 옮겨도 초점이 <body> 로 떨어지지 않는다(D3)", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();

  const settingsTab = within(aside).getByRole("link", { name: "설정" });
  await userEvent.click(settingsTab);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/settings`));
  // 화면이 실제로 설정 탭을 그린 뒤에 본다 — 주소만 바뀐 사이를 재면 아무것도 잠그지 못한다
  await waitFor(() =>
    expect(screen.getByTestId("page-channel-panel")).toHaveAttribute("data-panel-tab", "settings"),
  );
  // 누른 링크가 화면에 살아 있고 초점도 거기 있다 — 링크가 언마운트되면 초점은 `<body>` 로 떨어진다
  expect(document.body).toContainElement(settingsTab);
  expect(document.activeElement).toBe(settingsTab);

  // 반대 방향도, 키보드로도
  const activityTab = within(aside).getByRole("link", { name: "활동" });
  activityTab.focus();
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/activity`));
  await waitFor(() =>
    expect(screen.getByTestId("page-channel-panel")).toHaveAttribute("data-panel-tab", "activity"),
  );
  expect(document.body).toContainElement(activityTab);
  expect(document.activeElement).toBe(activityTab);
});

it("「활동 닫기」는 채널 화면으로 돌아간다", async () => {
  stubServer({ runs: [] });
  const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await userEvent.click(within(aside).getByRole("link", { name: "활동 닫기" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
  expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument();
});

/**
 * 넓은 화면의 닫기 링크는 누르면 패널과 함께 언마운트돼 초점이 `<body>` 로 떨어졌다(p2-t14 걱정 6, D3·D13·D14 와 같은 부류).
 * 활동 탭에는 헤더에 여는 자리가 따로 없고 탭 머리는 패널과 함께 사라진다 — 좁은 화면 시트(D14)와 같은 자리,
 * 헤더의 「채널 설정」 링크로 돌려준다
 */
it("넓은 화면에서 「활동 닫기」를 누르면 초점이 헤더의 「채널 설정」 링크로 간다 — <body> 가 아니다", async () => {
  stubMedia(false);
  stubServer({ runs: [] });
  const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  within(aside).getByRole("link", { name: "활동 닫기" }).focus();

  await userEvent.keyboard("{Enter}");

  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
  await waitFor(() => expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument());
  const opener = within(screen.getByTestId("channel-header")).getByRole("link", { name: "채널 설정" });
  expect(document.activeElement).not.toBe(document.body);
  expect(opener).toHaveFocus();
});

/**
 * 수정자 클릭은 라우터가 옮기지 않는다(새 탭·새 창은 브라우저 몫) — 패널이 그대로 남는데 초점만 헤더로 가면
 * 사람이 보던 자리를 잃는다(plan.md 이월 「넓은 화면 「닫기」의 수정자 클릭」)
 */
it.each(["Meta", "Control", "Shift", "Alt"])(
  "넓은 화면에서 「활동 닫기」를 %s 와 함께 누르면 패널도 초점도 그대로다",
  async (key) => {
    stubMedia(false);
    stubServer({ runs: [] });
    const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`);
    const aside = await panel();
    const close = within(aside).getByRole("link", { name: "활동 닫기" });

    // 같은 인스턴스여야 누른 수정자가 클릭까지 이어진다
    const user = userEvent.setup();
    await user.keyboard(`{${key}>}`);
    await user.click(close);
    await user.keyboard(`{/${key}}`);

    expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}/activity`);
    expect(screen.getByTestId("page-channel-panel")).toBe(aside);
    expect(close).toHaveFocus();
  },
);

it("미해결 승인이 없으면 카드도 없고, 오면 런 목록보다 위에 뜬다", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  expect(aside.querySelector('[data-slot="approval-card"]')).toBeNull();

  act(() => useApprovalStore.getState().apply(approval()));
  const card = await waitFor(() => {
    const el = aside.querySelector('[data-slot="approval-card"]');
    if (!el) throw new Error("승인 카드가 없다");
    return el;
  });
  expect(card).toHaveAttribute("data-status", "pending");
  // 목록보다 위에 있다
  expect(card.compareDocumentPosition(within(aside).getByRole("list", { name: "런 목록" }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );

  // 확정되면 사라지지 않고 결과 한 줄로 남는다(설계 5.3) — 다만 「미해결 하나」 자리는 비워진다
  act(() =>
    useApprovalStore
      .getState()
      .apply(approval({ status: "allowed", decision: "allow-once", reason: "user" })),
  );
  await waitFor(() =>
    expect(aside.querySelector('[data-slot="approval-card"]')).toHaveAttribute("data-status", "allowed"),
  );
});

/**
 * 카드 자리 규칙을 실물로 잠근다(plan.md 이월 「`PanelSlot` 테스트 하네스가 실물에 안 묶여 있다」) — D13 의
 * 하네스(`ApprovalCard.test.tsx` 의 `PanelSlot`)는 이 규칙을 베낀 것이라, 규칙이 바뀌면 여기가 먼저 깨져야 한다
 */
it("승인 둘이면 A 가 확정된 뒤 카드가 B 로 갈아탄다", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  const second = (over: Partial<Parameters<typeof approval>[0]> = {}) =>
    approval({ id: APPROVAL2, toolCallId: "toolu_02", ...over });
  act(() => {
    useApprovalStore.getState().apply(approval());
    useApprovalStore.getState().apply(second());
  });
  const cardId = () => aside.querySelector('[data-slot="approval-card"]')?.getAttribute("data-approval-id");
  await waitFor(() => expect(cardId()).toBe(APPROVAL));

  act(() =>
    useApprovalStore
      .getState()
      .apply(approval({ status: "allowed", decision: "allow-once", reason: "user" })),
  );

  expect(cardId()).toBe(APPROVAL2);
  expect(aside.querySelector('[data-slot="approval-card"]')).toHaveAttribute("data-status", "pending");
});

// 설계 5.3 — 자리 둘(메시지 흐름·활동 탭)이 **하나의 스토어**를 본다. 다른 화면이라 중복이 아니다
it("승인 카드는 메시지 흐름과 활동 탭 양쪽에 하나씩 뜬다", async () => {
  const restoreLayout = stubScrollLayout({ width: 800, height: 600, rowHeight: 64 });
  try {
    stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData(qk.timeline(CH, CH), { ...emptyTimeline(), items: [msg(1)], lastSeq: 1 });
    act(() => useApprovalStore.getState().apply(approval()));
    renderRoute(`/c/${CH}/s/${CH}/activity`, queryClient);

    const aside = await panel();
    await waitFor(() => expect(screen.getAllByRole("group", { name: /승인 요청/ })).toHaveLength(2));
    expect(within(aside).getAllByRole("group", { name: /승인 요청/ })).toHaveLength(1);
    // 한 스토어라 버튼도 두 벌이다 — 범위를 좁혀 눌러야 한다
    expect(within(aside).getAllByRole("button", { name: "이번만 허용" })).toHaveLength(1);
  } finally {
    restoreLayout();
  }
});

// 다른 채널의 승인이 새어 들어오면 안 된다 — 선택자 둘 다 channelId 를 받는다
it("다른 채널의 승인은 이 채널 활동 탭에 뜨지 않는다", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  act(() => useApprovalStore.getState().apply(approval({ channelId: uid(77) })));
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  expect(aside.querySelector('[data-slot="approval-card"]')).toBeNull();
  expect(selectPendingApproval(CH)(useApprovalStore.getState())).toBeUndefined();
});

/**
 * 타임라인 이벤트의 `toolCallId` 는 실물 프레임 도착 순서에 따라 비어 있을 수 있다(p2-t6 어긋남 C) —
 * 승인 **레코드**가 정본이라 패널이 스토어를 넘겨 준다(Ruling 2)
 */
it("승인 레코드가 이벤트에 없는 toolCallId·제목을 메운다", async () => {
  act(() => useApprovalStore.getState().apply(approval({ toolCallId: "t1", title: "쓰기 허락" })));
  stubServer({
    runs: [runOf(RUN, { status: "tool", endedAt: undefined })],
    events: [
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Write" }),
      runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t2", toolCallName: "Read" }),
      runEvent({
        type: "APPROVAL_REQUESTED",
        seq: 3,
        approvalId: APPROVAL,
        kind: "plugin",
        title: "이벤트가 아는 제목",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        expiresAt: "2027-01-15T08:02:00.000Z",
      }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  const list = await within(aside).findByRole("list", { name: "활동 기록" });
  const toolRow = (name: string): HTMLElement => {
    const hit = within(list)
      .getAllByRole("listitem")
      .find(
        (li) => li.querySelector('[data-slot="approval-row"]') === null && li.textContent?.includes(name),
      );
    if (!hit) throw new Error(`${name} 툴 행이 없다`);
    return hit;
  };
  expect(toolRow("Write")).toHaveTextContent("승인");
  expect(toolRow("Read")).not.toHaveTextContent("승인");
  expect(within(list).getByText("쓰기 허락")).toBeInTheDocument();
  expect(within(list).queryByText("이벤트가 아는 제목")).not.toBeInTheDocument();
  // 아직 답하지 않은 승인은 위 카드를 가리킨다 — 경고색(--warning)은 글자에 쓰지 않는다(대비 4.5:1 미달). 색은 아이콘·테두리만
  const hint = within(list).getByText(APPROVAL_PENDING_HINT);
  expect(hint).not.toHaveClass("text-warning");
  expect(hint.closest('[data-slot="approval-row"]')?.querySelector("svg")).toHaveClass("text-warning");
});

it("승인·오류·단계 행도 타임라인에 그려진다", async () => {
  const approvalId = uid(301);
  stubServer({
    runs: [runOf(RUN, { status: "error" })],
    events: [
      runEvent({ type: "STEP_STARTED", seq: 1, stepName: "계획" }),
      // 툴 이름을 승인 제목과 겹치지 않게 둔다 — 겹치면 이음을 끊어도 아래 단언이 통과한다
      runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t1", toolCallName: "Bash" }),
      runEvent({
        type: "APPROVAL_REQUESTED",
        seq: 3,
        approvalId,
        kind: "plugin",
        title: "Write 실행",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        toolCallId: "t1",
        expiresAt: "2027-01-15T08:02:00.000Z",
      }),
      runEvent({ type: "APPROVAL_RESOLVED", seq: 4, approvalId, decision: "deny", reason: "timeout" }),
      runEvent({ type: "RUN_ERROR", seq: 5, message: "도구가 실패했습니다" }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  const row = await waitFor(() => {
    const el = aside.querySelector<HTMLElement>(`[data-approval-id="${approvalId}"]`);
    if (!el) throw new Error("승인 행이 없다");
    return el;
  });
  expect(row).toHaveTextContent("Write 실행");
  expect(row).toHaveTextContent("만료됨");
  expect(row).toHaveTextContent("Bash"); // 툴 행과 이어졌다 — 제목에 없는 이름이라 이음이 끊기면 빨강
  expect(within(aside).getByText("계획")).toBeInTheDocument();
  expect(within(aside).getByText("도구가 실패했습니다")).toBeInTheDocument();
});

it("승인을 요구한 툴 행에만 「승인」이 붙는다", async () => {
  stubServer({
    runs: [runOf(RUN, { status: "tool", endedAt: undefined })],
    events: [
      runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Write" }),
      runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t2", toolCallName: "Read" }),
      runEvent({
        type: "APPROVAL_REQUESTED",
        seq: 3,
        approvalId: uid(302),
        kind: "plugin",
        title: "쓰기 허락",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        toolCallId: "t1",
        expiresAt: "2027-01-15T08:02:00.000Z",
      }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  const list = await within(aside).findByRole("list", { name: "활동 기록" });
  /** 이름으로 툴 행 하나 — 승인 행에도 툴 이름이 있어 그쪽은 뺀다 */
  const toolRow = (name: string): HTMLElement => {
    const hit = within(list)
      .getAllByRole("listitem")
      .find(
        (li) => li.querySelector('[data-slot="approval-row"]') === null && li.textContent?.includes(name),
      );
    if (!hit) throw new Error(`${name} 툴 행이 없다`);
    return hit;
  };
  expect(toolRow("Write")).toHaveTextContent("승인");
  expect(toolRow("Read")).not.toHaveTextContent("승인");
});

it("서브에이전트 행은 상태를 글자로도 말한다", async () => {
  stubServer({
    runs: [runOf(RUN)],
    events: [
      runEvent({ type: "SUBAGENT_STARTED", seq: 1, subagentRunId: uid(401), label: "조사" }),
      runEvent({ type: "SUBAGENT_STARTED", seq: 2, subagentRunId: uid(402), label: "정리" }),
      runEvent({ type: "SUBAGENT_FINISHED", seq: 3, subagentRunId: uid(402) }),
      runEvent({ type: "SUBAGENT_STARTED", seq: 4, subagentRunId: uid(403), label: "빌드" }),
      runEvent({ type: "SUBAGENT_ERROR", seq: 5, subagentRunId: uid(403), message: "터졌다" }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  const subRow = async (label: string): Promise<HTMLElement> => {
    const el = (await within(aside).findByText(new RegExp(`^서브에이전트.*${label}$`))).closest("li");
    if (!el) throw new Error(`${label} 서브에이전트 행이 없다`);
    return el;
  };
  expect(await subRow("조사")).toHaveTextContent("진행 중");
  expect(await subRow("정리")).toHaveTextContent("완료");
  const failed = await subRow("빌드");
  expect(failed).toHaveTextContent("터졌다");
  expect(failed).toHaveTextContent("실패");
});

it("도구를 안 쓴 런의 빈 타임라인은 진행 중과 끝남을 다르게 말한다", async () => {
  stubServer({
    runs: [
      runOf(RUN2, { status: "tool", endedAt: undefined, createdAt: "2027-01-15T08:10:00.000Z" }),
      runOf(RUN),
    ],
    events: [],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  // 기본 선택은 가장 최근 런 — 아직 진행 중이라 기다리는 문구
  expect(await within(aside).findByText("아직 도구를 쓰지 않았습니다.")).toBeInTheDocument();
  const buttons = await within(aside).findAllByRole("button", { name: /@dev/ });
  await userEvent.click(buttons[1] as HTMLElement);
  expect(await within(aside).findByText("도구 기록이 없습니다.")).toBeInTheDocument();
});

// 이월 5 — 카드마다 타임라인을 따로 세운다(`key={runId}`). 툴 id 가 겹치면 행 key 도 같아, 한 타임라인이면 펼침이 따라온다
it("한 카드에서 펼쳐 둔 인자가 다른 카드로 번지지 않고, 접었다 펴면 새로 선다", async () => {
  stubServer({
    runs: [runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }), runOf(RUN)],
    events: {
      [RUN]: [
        runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Grep" }),
        runEvent({ type: "TOOL_CALL_ARGS", seq: 2, toolCallId: "t1", delta: '{"앞":1}' }),
      ],
      [RUN2]: [
        runEvent({ type: "TOOL_CALL_START", runId: RUN2, seq: 1, toolCallId: "t1", toolCallName: "Read" }),
        runEvent({ type: "TOOL_CALL_ARGS", runId: RUN2, seq: 2, toolCallId: "t1", delta: '{"뒤":2}' }),
      ],
    },
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  const older = () => within(card(aside, RUN)).getByRole("button", { name: /@dev/ });

  await userEvent.click(older());
  await within(card(aside, RUN)).findByText("Grep");
  await userEvent.click(within(aside).getByRole("button", { name: "Grep 자세히" }));
  expect(within(aside).getByText('{"앞":1}')).toBeInTheDocument();
  // 같은 toolCallId 의 다른 카드 행은 접힌 그대로다
  expect(within(aside).getByRole("button", { name: "Read 자세히" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(within(aside).queryByText('{"뒤":2}')).not.toBeInTheDocument();

  // 접었다 펴면 타임라인이 새로 선다 — 펼쳐 둔 인자도 접힌 채로
  await userEvent.click(older());
  await userEvent.click(older());
  await within(card(aside, RUN)).findByText("Grep");
  expect(within(aside).queryByText('{"앞":1}')).not.toBeInTheDocument();
});

it("펼친 카드마다 그 런의 이벤트만 그린다", async () => {
  stubServer({
    runs: [runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }), runOf(RUN)],
    events: {
      [RUN]: TOOL_EVENTS,
      [RUN2]: [
        runEvent({ type: "TOOL_CALL_START", runId: RUN2, seq: 1, toolCallId: "x", toolCallName: "Bash" }),
      ],
    },
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  // 기본으로 펼친 것은 가장 최근 런(uuid v7 이 큰 쪽)
  await within(aside).findByText("Bash");
  expect(within(card(aside, RUN2)).getByText("Bash")).toBeInTheDocument();
  expect(openRuns(aside)).toEqual([RUN2]);
  expect(within(aside).queryByText("Read")).not.toBeInTheDocument();
  const buttons = within(aside).getAllByRole("button", { name: /@dev/ });
  expect(buttons).toHaveLength(2);
  await userEvent.click(buttons[1] as HTMLElement);
  expect(await within(card(aside, RUN)).findByText("Read")).toBeInTheDocument();
  expect(within(card(aside, RUN)).queryByText("Bash")).not.toBeInTheDocument();
  expect(within(card(aside, RUN2)).queryByText("Read")).not.toBeInTheDocument();
  expect(openRuns(aside)).toEqual([RUN2, RUN]);
});

it("처음엔 가장 최근 런만 펼치고, 접힌 카드는 이벤트를 부르지 않는다 — 펼칠 때 한 번", async () => {
  const OLD = uid(100);
  const { calls } = stubServer({
    runs: [runOf(RUN2), runOf(RUN), runOf(OLD)],
    events: { [RUN2]: TOOL_EVENTS, [RUN]: OTHER_RUN, [OLD]: [] },
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  const eventCalls = (id: string) => calls.filter((c) => c === `GET /api/v1/runs/${id}/events`).length;
  expect(openRuns(aside)).toEqual([RUN2]);
  expect(eventCalls(RUN2)).toBe(1);
  expect(eventCalls(RUN)).toBe(0);
  expect(eventCalls(OLD)).toBe(0);

  await userEvent.click(within(card(aside, RUN)).getByRole("button", { name: /@dev/ }));
  await within(card(aside, RUN)).findByText("옛도구");
  expect(eventCalls(RUN)).toBe(1);
  expect(eventCalls(OLD)).toBe(0);
});

const chip = (aside: HTMLElement, name: string) =>
  within(within(aside).getByRole("group", { name: "런 거르기" })).getByRole("button", {
    name: new RegExp(`^${name} \\d+$`),
  });

it("거르기 칩은 「전체 N · 진행 중 N · 승인 대기 N · 실패 N」 — 고른 칩만 aria-pressed, 비면 거르기마다 문구", async () => {
  const FAILED = uid(120);
  const ABORTED = uid(121);
  stubServer({
    runs: [
      runOf(ABORTED, { status: "aborted" }),
      runOf(FAILED, { status: "error" }),
      runOf(RUN2, { status: "tool", endedAt: undefined }),
      runOf(RUN),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findAllByRole("region", { name: /^@dev 런/ });
  expect(chip(aside, "전체")).toHaveTextContent("전체 4");
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 1");
  expect(chip(aside, "승인 대기")).toHaveTextContent("승인 대기 0");
  expect(chip(aside, "실패")).toHaveTextContent("실패 1");
  expect(chip(aside, "전체")).toHaveAttribute("aria-pressed", "true");
  expect(chip(aside, "실패")).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(chip(aside, "실패"));
  expect(chip(aside, "실패")).toHaveAttribute("aria-pressed", "true");
  expect(chip(aside, "전체")).toHaveAttribute("aria-pressed", "false");
  expect(runIds(aside)).toEqual([FAILED]);
  // 수는 거르기와 상관없이 전체에서 센다
  expect(chip(aside, "전체")).toHaveTextContent("전체 4");

  await userEvent.click(chip(aside, "진행 중"));
  expect(runIds(aside)).toEqual([RUN2]);

  await userEvent.click(chip(aside, "승인 대기"));
  expect(runIds(aside)).toEqual([]);
  expect(within(aside).getByText("승인을 기다리는 런이 없습니다.")).toBeInTheDocument();

  // 멈춘 런(aborted)은 실패가 아니다 — 전체에만
  await userEvent.click(chip(aside, "전체"));
  expect(runIds(aside)).toEqual([FAILED, ABORTED, RUN2, RUN].sort().reverse());
});

it("실패로 거른 채 비면 「실패한 런이 없습니다.」, 승인 카드는 거르기와 무관하게 맨 위", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  await userEvent.click(chip(aside, "실패"));
  expect(within(aside).getByText("실패한 런이 없습니다.")).toBeInTheDocument();

  act(() => useApprovalStore.getState().apply(approval()));
  const box = await waitFor(() => {
    const el = aside.querySelector('[data-slot="approval-card"]');
    if (!el) throw new Error("승인 카드가 없다");
    return el;
  });
  expect(box.compareDocumentPosition(within(aside).getByRole("group", { name: "런 거르기" }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

it("아무 카드도 손대지 않았으면 새 런이 올 때 기본 펼침이 새 런으로 옮긴다 — 앞 카드는 접힌다", async () => {
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: "@dev 런, 완료" });
  expect(openRuns(aside)).toEqual([RUN]);

  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));
  await waitFor(() => expect(runIds(aside)).toEqual([RUN2, RUN]));
  expect(openRuns(aside)).toEqual([RUN2]);
});

it("한 번이라도 펼침을 바꿨으면 새 런은 접힌 채로 오고, 보던 카드는 펼친 채다", async () => {
  // 런 id 는 시간순(UUIDv7)이라 큰 쪽이 최근 런이다
  const LATEST = uid(140);
  const NEWER = uid(141);
  stubServer({ runs: [runOf(LATEST), runOf(RUN)], events: { [LATEST]: TOOL_EVENTS, [RUN]: OTHER_RUN } });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await waitFor(() => expect(runIds(aside)).toEqual([LATEST, RUN]));
  expect(openRuns(aside)).toEqual([LATEST]);
  // 옛 런을 손으로 편다 — 기본으로 펼쳐 있던 최근 런도 그대로 펼친 채
  await userEvent.click(within(card(aside, RUN)).getByRole("button", { name: /@dev/ }));
  expect(openRuns(aside)).toEqual([LATEST, RUN]);

  act(() => useRunStore.getState().applyState(runState({ id: NEWER, status: "streaming" })));
  await waitFor(() => expect(runIds(aside)).toEqual([NEWER, LATEST, RUN]));
  expect(openRuns(aside)).toEqual([LATEST, RUN]);
});

it("거르기를 고른 채 새 런이 오면 — 맞으면 나타나고 수가 늘고, 맞지 않으면 그 칩의 수만 는다", async () => {
  stubServer({ runs: [runOf(RUN, { status: "error" })] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: "@dev 런, 실패" });
  await userEvent.click(chip(aside, "실패"));

  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));
  await waitFor(() => expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 1"));
  expect(chip(aside, "전체")).toHaveTextContent("전체 2");
  expect(chip(aside, "실패")).toHaveTextContent("실패 1");
  expect(runIds(aside)).toEqual([RUN]);

  const THIRD = uid(130);
  act(() => useRunStore.getState().applyState(runState({ id: THIRD, status: "error" })));
  await waitFor(() => expect(chip(aside, "실패")).toHaveTextContent("실패 2"));
  expect(runIds(aside)).toEqual([THIRD, RUN]);
});

it("「승인 대기」로 거른 채 승인이 끝나면 그 런은 빠지고 펼친 다른 카드는 그대로, 비면 「승인을 기다리는 런이 없습니다.」", async () => {
  const B = uid(131);
  stubServer({ runs: [], events: { [RUN2]: TOOL_EVENTS, [B]: OTHER_RUN } });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");
  act(() => {
    useRunStore.getState().applyState(runState({ id: RUN2, status: "awaiting_approval" }));
    useRunStore.getState().applyState(runState({ id: B, status: "awaiting_approval" }));
  });
  await within(aside).findAllByRole("region", { name: "@dev 런, 승인 대기" });
  await userEvent.click(chip(aside, "승인 대기"));
  expect(runIds(aside)).toEqual([B, RUN2]);
  // 가장 최근 런(B)은 기본으로 펼쳐 있고, RUN2 도 손으로 편다
  await userEvent.click(within(card(aside, RUN2)).getByRole("button", { name: /@dev/ }));
  await within(card(aside, RUN2)).findByText("Read");
  await userEvent.click(within(aside).getByRole("button", { name: "Read 자세히" }));
  expect(openRuns(aside)).toEqual([B, RUN2]);

  // B 의 승인이 끝나 도구로 돌아갔다 — 목록에서 빠진다. RUN2 는 펼친 채, 펼친 도구 줄도 그대로
  const before = timelineBox(card(aside, RUN2));
  act(() => useRunStore.getState().applyState(runState({ id: B, status: "tool" })));
  await waitFor(() => expect(runIds(aside)).toEqual([RUN2]));
  expect(openRuns(aside)).toEqual([RUN2]);
  expect(timelineBox(card(aside, RUN2))).toBe(before);
  expect(within(aside).getByRole("button", { name: "Read 자세히" })).toHaveAttribute("aria-expanded", "true");
  expect(chip(aside, "승인 대기")).toHaveTextContent("승인 대기 1");

  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "done" })));
  expect(await within(aside).findByText("승인을 기다리는 런이 없습니다.")).toBeInTheDocument();
  expect(runIds(aside)).toEqual([]);
});

const CODER = agentOf(uid(12), "coder", { provider: "runner", program: "claude" });

it("러너 에이전트 런 카드에는 프로그램 배지, OpenClaw 에이전트는 없고, 모르는 에이전트는 「알 수 없는 에이전트」", async () => {
  const GONE = uid(106);
  stubServer({
    agents: [DEV, CODER],
    runs: [
      runOf(GONE, { agentId: uid(99), createdAt: "2027-01-15T08:20:00.000Z" }),
      runOf(RUN2, { agentId: CODER.id, createdAt: "2027-01-15T08:10:00.000Z" }),
      runOf(RUN),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  const coder = await within(aside).findByRole("region", { name: "@coder 런, 완료" });
  expect(within(coder).getByRole("img", { name: "Claude Code" })).toHaveTextContent("CC");
  const dev = within(aside).getByRole("region", { name: "@dev 런, 완료" });
  expect(within(dev).queryByRole("img", { name: "Claude Code" })).not.toBeInTheDocument();
  expect(dev.querySelector('[role="img"][title]')).toBeNull();
  const gone = within(aside).getByRole("region", { name: "알 수 없는 에이전트 런, 완료" });
  expect(gone).toBe(card(aside, GONE));
  expect(gone.querySelector('[role="img"][title]')).toBeNull();
});

it("상태 칩은 상태마다 색이 다르다 — 진행 중 primary · 승인 대기 warning · 완료 success · 실패 destructive · 중지 muted", async () => {
  const ids = [uid(111), uid(112), uid(113), uid(114), uid(115)];
  const statuses = ["tool", "awaiting_approval", "done", "error", "aborted"] as const;
  stubServer({
    runs: statuses.map((status, i) =>
      runOf(ids[i] as string, {
        status,
        endedAt: status === "tool" || status === "awaiting_approval" ? undefined : "2027-01-15T08:00:13.000Z",
      }),
    ),
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: "@dev 런, 도구 사용 중" });
  const chip = (i: number) => card(aside, ids[i] as string).querySelector('[data-slot="run-status"]');
  expect(chip(0)).toHaveTextContent("도구 사용 중");
  expect(chip(0)?.className).toMatch(/bg-primary\//);
  expect(chip(1)).toHaveTextContent("승인 대기");
  expect(chip(1)?.className).toMatch(/bg-warning\//);
  expect(chip(2)?.className).toMatch(/bg-success\//);
  expect(chip(3)?.className).toMatch(/bg-destructive\//);
  expect(chip(4)).toHaveTextContent("중지됨");
  expect(chip(4)?.className).toMatch(/bg-muted\b/);
});

it("진행 중 카드의 「런 중지」는 run.abort { runId } 를 한 번 보내고, 끝난 카드에는 없다", async () => {
  fake.onAck("run.abort", () => ({ ok: true, data: null }));
  stubServer({
    runs: [
      runOf(RUN2, { status: "tool", endedAt: undefined, createdAt: "2027-01-15T08:10:00.000Z" }),
      runOf(RUN),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: "@dev 런, 도구 사용 중" });
  expect(within(card(aside, RUN)).queryByRole("button", { name: /런 중지/ })).not.toBeInTheDocument();
  const stop = within(card(aside, RUN2)).getByRole("button", { name: "런 중지" });
  await userEvent.click(stop);
  expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN2 }]);
  // 런이 끝날 때까지 「중지 중」으로 잠근다 — 다시 눌러도 보내지 않는다
  const locked = within(card(aside, RUN2)).getByRole("button", { name: "런 중지 중" });
  expect(locked).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(locked);
  expect(fake.sentOf("run.abort")).toHaveLength(1);
});

it("끝나 접힌 카드는 받아 둔 이벤트가 있으면 「생각 N · 도구 N(이름들) · 답 N」 요약 한 줄, 없으면 요약 없음", async () => {
  const queryClient = createQueryClient(() => {});
  queryClient.setQueryData(qk.runEvents(RUN), [
    runEvent({ type: "REASONING_MESSAGE_START", seq: 1, messageId: "r1" }),
    runEvent({ type: "REASONING_MESSAGE_END", seq: 2, messageId: "r1" }),
    ...TOOL_EVENTS.map((e) => ({ ...e, seq: e.seq + 2 })),
    runEvent({ type: "TOOL_CALL_START", seq: 8, toolCallId: "t2", toolCallName: "Bash" }),
    runEvent({ type: "TOOL_CALL_START", seq: 9, toolCallId: "t3", toolCallName: "Read" }),
    runEvent({ type: "TEXT_MESSAGE_START", seq: 10, messageId: "m1", role: "assistant" }),
    textDelta(11, "답"),
  ]);
  const OLDEST = uid(100); // 목록 순서는 id(uuid v7) 순이다 — 가장 작은 id 가 가장 오래된 런
  stubServer({
    runs: [
      runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }),
      runOf(RUN, { createdAt: "2027-01-15T08:05:00.000Z" }),
      runOf(OLDEST),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`, queryClient);
  const aside = await panel();
  await within(aside).findAllByRole("region", { name: /^@dev 런/ });
  expect(openRuns(aside)).toEqual([RUN2]);
  await waitFor(() =>
    expect(card(aside, RUN).querySelector('[data-slot="run-summary"]')).toHaveTextContent(
      "생각 1 · 도구 3(Read, Bash) · 답 1",
    ),
  );
  expect(card(aside, OLDEST).querySelector('[data-slot="run-summary"]')).toBeNull();
});

it("실시간 텍스트 델타는 타임라인 행이 되지 않는다", async () => {
  stubServer({ runs: [runOf(RUN, { status: "streaming", endedAt: undefined })], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  const rows = await within(aside).findByRole("list", { name: "활동 기록" });
  expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
  act(() => {
    fake.serverEmit("run.event", { event: textDelta(6, "이어지는 답변") });
  });
  expect(within(rows).getAllByRole("listitem")).toHaveLength(1);
  expect(within(aside).queryByText("이어지는 답변")).not.toBeInTheDocument();
});

// 스펙 7.3 — 아이콘만 있는 버튼·링크·그림에도 이름이 있어야 한다
it("활동 탭의 버튼·링크·그림에 모두 이름이 있다", async () => {
  // 끝난 툴만 있으면 진행 중 아이콘(스피너)을 지나지 않는다 — 안 끝난 툴을 하나 섞는다
  stubServer({
    runs: [runOf(RUN, { status: "tool", endedAt: undefined })],
    events: [
      ...TOOL_EVENTS,
      runEvent({ type: "TOOL_CALL_START", seq: 6, toolCallId: "t2", toolCallName: "Bash" }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  await userEvent.click(within(aside).getByRole("button", { name: "Read 자세히" }));
  expect(within(aside).getByRole("img", { name: "실행 중" })).toBeInTheDocument();
  for (const role of ["button", "link", "img", "list"] as const) {
    expect(within(aside).queryAllByRole(role, { name: "" })).toEqual([]);
  }
});

it("조회 실패를 전역 토스트로 이중 표시하지 않는다(meta.silent)", async () => {
  const toastError = vi.spyOn(toast, "error");
  stubServer({
    runs: [runOf(RUN)],
    override: (method, url) =>
      method === "GET" && /\/(runs|events)(\?|$)/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("런 목록을 불러오지 못했습니다.");
  expect(toastError).not.toHaveBeenCalled();
});

it("런 목록은 한 번에 50개까지 받는다", async () => {
  const { calls } = stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  await within(await panel()).findByText("Read");
  expect(calls).toContain(`GET /api/v1/channels/${CH}/runs?limit=50`);
  expect(calls).toContain(`GET /api/v1/runs/${RUN}/events`);
});

/**
 * 브라우저 검증 D2·D9 — 런이 끝나는 순간(스토어에서 빠지고 REST 재조회는 아직)에도 고른 런은 그대로다.
 * 옛 런으로 넘어가면 `key={selected.id}` 가 타임라인을 새로 세워 펼침·스크롤이 날아간다
 */
const OTHER_RUN = [
  runEvent({ type: "TOOL_CALL_START", runId: RUN, seq: 1, toolCallId: "t9", toolCallName: "옛도구" }),
];

/** RUN(옛 런, REST 에만) + RUN2(실시간으로 시작해 끝나는 런). 고른 런은 최근 것인 RUN2 */
async function endingRun(opts: ServerOpts = {}, queryClient?: QueryClient) {
  const { state } = stubServer({
    runs: [runOf(RUN)],
    events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS },
    ...opts,
  });
  const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`, queryClient);
  const aside = await panel();
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "tool" })));
  await within(aside).findByText("Read");
  expect(openRuns(aside)).toEqual([RUN2]);

  const end = () => {
    act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "done" })));
    // 버블 정리가 끝난 런을 스토어에서 뺀다(스펙 4.5) — REST 목록은 아직 그 런을 모른다
    act(() => useRunStore.getState().remove(RUN2));
  };
  return { aside, state, end, router };
}

it("런이 끝나도 타임라인이 옛 런으로 넘어가지 않는다(D2)", async () => {
  const { aside, end } = await endingRun();
  const before = timelineBox(aside);

  end();

  expect(openRuns(aside)).toEqual([RUN2]);
  expect(within(aside).getByText("Read")).toBeInTheDocument();
  expect(within(aside).queryByText("옛도구")).not.toBeInTheDocument();
  // 타임라인이 새로 서지 않았다 — 스크롤 위치가 끝으로 튀지 않는 까닭이다
  expect(timelineBox(aside)).toBe(before);
  await waitFor(() => expect(openRuns(aside)).toEqual([RUN2]));
});

it("런이 끝나도 펼쳐 둔 인자가 접히지 않는다(D2)", async () => {
  const { aside, end } = await endingRun();
  await userEvent.click(within(aside).getByRole("button", { name: "Read 자세히" }));
  expect(screen.getByText('{"path":"README.md"}')).toBeInTheDocument();

  end();

  expect(screen.getByText('{"path":"README.md"}')).toBeInTheDocument();
});

it("목록 조회가 실패해도 방금 끝난 런은 목록에서 사라지지 않는다(D9)", async () => {
  const { aside, end } = await endingRun({
    override: (method, url) =>
      method === "GET" && /\/runs\?/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });

  end();

  await within(aside).findByText("런 목록을 불러오지 못했습니다.");
  expect(runIds(aside)).toEqual([RUN2]);
  expect(openRuns(aside)).toEqual([RUN2]);
  expect(within(aside).getByText("Read")).toBeInTheDocument();
});

it("아무것도 안 골랐으면 가장 최근 런을 잡는다", async () => {
  stubServer({ runs: [runOf(RUN), runOf(RUN2)], events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS } });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();

  await within(aside).findByText("Read");
  // id 가 uuid v7 이라 문자열 순이 생성 순 — 최신이 맨 위이고 그것이 잡힌다
  expect(runIds(aside)).toEqual([RUN2, RUN]);
  expect(openRuns(aside)).toEqual([RUN2]);
});

const OTHER_CH_RUN = uid(103);

it("채널을 옮기면 선택도 목록도 옮겨 간 채널 것으로 새로 잡는다", async () => {
  // 옮겨 갈 채널을 미리 캐시에 둔다 — 그래야 ChannelPage 가 패널을 내렸다 올리지 않고 같은 패널이 채널만 바꾼다
  const queryClient = createQueryClient(() => {});
  queryClient.setQueryData(qk.channel(CH2), channelOf(CH2));
  const { aside, end, router } = await endingRun(
    {
      override: (method, url) =>
        method === "GET" && url.startsWith(`/api/v1/channels/${CH2}/runs`)
          ? json(200, { runs: [runOf(OTHER_CH_RUN, { channelId: CH2 })] })
          : method === "GET" && url.startsWith(`/api/v1/runs/${OTHER_CH_RUN}/events`)
            ? json(200, {
                events: [
                  runEvent({
                    type: "TOOL_CALL_START",
                    runId: OTHER_CH_RUN,
                    seq: 1,
                    toolCallId: "t8",
                    toolCallName: "저쪽도구",
                  }),
                ],
              })
            : undefined,
    },
    queryClient,
  );
  // 이 채널에서 끝난 런을 기억한 채로 옮긴다 — 그 기억이 옮겨 간 채널 목록에 섞이면 안 된다
  end();
  expect(runIds(aside)).toContain(RUN2);
  // 펼침·거르기도 이 채널 것이다 — 옛 런을 손으로 펴고 「실패」로 거른 채 옮긴다
  await userEvent.click(within(card(aside, RUN)).getByRole("button", { name: /@dev/ }));
  await userEvent.click(chip(aside, "실패"));
  expect(within(aside).getByText("실패한 런이 없습니다.")).toBeInTheDocument();

  await act(() =>
    router.navigate({
      to: "/c/$channelId/s/$conversationId/activity",
      params: { channelId: CH2, conversationId: CH2 },
    }),
  );

  const moved = await panel();
  await within(moved).findByText("저쪽도구");
  // 같은 패널이 그대로 있고(내렸다 올린 것이 아니다) 안쪽만 새 채널로 바뀌었다
  expect(moved).toBe(aside);
  expect(runIds(moved)).toEqual([OTHER_CH_RUN]);
  expect(openRuns(moved)).toEqual([OTHER_CH_RUN]);
  expect(chip(moved, "전체")).toHaveAttribute("aria-pressed", "true");
});

/**
 * 브라우저 검증 D7 — 진행 중인 런의 소요가 렌더 시점에 멈춰 있었다(「승인 대기 · 0초」가 몇 초째 그대로).
 * 타이머 자체(켜고 끄기)는 `useNowTick` 테스트가 잠근다 — 여기서는 목록이 그 시계를 쓰는지를 본다
 */
it("진행 중인 런의 소요는 1초마다 갱신되고 끝나면 고정된다(D7)", async () => {
  const START = Date.parse("2027-01-15T08:00:01.000Z");
  vi.useFakeTimers({ shouldAdvanceTime: true, now: START });
  try {
    stubServer({ runs: [runOf(RUN, { status: "tool", startedAt: iso(START), endedAt: undefined })] });
    renderRoute(`/c/${CH}/s/${CH}/activity`);
    const aside = await panel();
    const row = () => within(aside).getByRole("button", { name: /@dev/ });
    await waitFor(() => expect(row()).toHaveTextContent("0초"));

    act(() => void vi.advanceTimersByTime(3_000));
    expect(row()).toHaveTextContent("3초");

    // 끝난 런의 소요는 끝난 시각으로 고정 — 시간이 더 흘러도 그대로다
    act(() =>
      useRunStore
        .getState()
        .applyState(
          runState({ id: RUN, status: "done", startedAt: iso(START), endedAt: iso(START + 4_000) }),
        ),
    );
    await waitFor(() => expect(row()).toHaveTextContent("4초"));
    act(() => void vi.advanceTimersByTime(30_000));
    expect(row()).toHaveTextContent("4초");
  } finally {
    vi.useRealTimers();
  }
});

/**
 * 브라우저 검증 D10 — 높이 420px 창에서 카드와 런 목록이 먼저 자리를 잡아 타임라인이 54px 로 눌렸다. 카드 목록이 된 뒤로는
 * 목록 전체가 한 스크롤 영역이라 펼친 타임라인이 눌리지 않는다 — 대신 긴 타임라인이 목록을 통째로 차지하지 않게 높이를 묶고
 * 제 안에서 스크롤한다(끝에 붙어 따라가는 자리). jsdom 은 배치를 재지 않으므로 그 자리를 만드는 규칙을 잠근다
 */
it("카드 목록이 스크롤을 맡고, 펼친 타임라인은 높이를 묶어 제 안에서 스크롤한다(D10)", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");

  const list = within(aside).getByRole("list", { name: "런 목록" });
  expect(list).toHaveClass("min-h-0", "flex-1", "overflow-y-auto");
  expect(timelineBox(aside)).toHaveClass("max-h-96", "overflow-y-auto");
  // 타임라인은 목록 안에 있다 — 목록과 자리를 다투지 않는다
  expect(list).toContainElement(timelineBox(aside) as HTMLElement);
});

/**
 * 화면 값은 `ended` 기억만으로도 같다 — 재조회가 잠그는 것은 **캐시가 서버 사실을 쥐는 것**이다:
 * 다음 마운트(탭·채널 복귀)에서 그 런이 첫 프레임부터 보이고, 그때 조회가 실패해도 목록에 남는다.
 * 그래서 「남는가」와 함께 **호출 수**를 잰다 — 화면만 보면 재조회를 지워도 초록이라(리뷰 R10)
 */
it("끝난 런이 런 스토어에서 빠져도 목록에 남는다 — 끝날 때 REST 목록을 다시 받아 둔다", async () => {
  const { state, calls } = stubServer({ runs: [] });
  const { queryClient } = renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");
  const listCalls = () => calls.filter((c) => /\/runs\?/.test(c)).length;
  expect(listCalls()).toBe(1);

  // 실시간으로 시작한 런이 끝나면 REST 목록을 다시 받아 둔다(스토어는 곧 그 런을 지운다)
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));
  await within(aside).findByRole("button", { name: /@dev/ });
  // 시작만으로는 다시 받지 않는다 — 끝날 때만
  expect(listCalls()).toBe(1);
  state.runs = [runOf(RUN2, { status: "done" })];
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "done" })));
  await waitFor(() => expect(within(aside).getByRole("button", { name: /@dev/ })).toHaveTextContent("완료"));
  await waitFor(() => expect(listCalls()).toBe(2));
  // 그 재조회가 캐시에 남아 다음 마운트가 이 런을 곧바로 본다
  expect(queryClient.getQueryData(qk.channelRuns(CH))).toMatchObject([{ id: RUN2, status: "done" }]);

  act(() => useRunStore.getState().remove(RUN2));
  expect(await within(aside).findByRole("button", { name: /@dev/ })).toHaveTextContent("완료");
});

/**
 * 태스크 7 리뷰 이월 6 — 목록 조회가 실패했다고 **실시간으로 이미 아는 런까지** 감추지 않는다.
 * 잠깐 끊긴 사이에 진행 중인 런이 화면에서 사라지면 「멈춘 것」처럼 보인다
 */
it("런 목록 조회가 실패해도 실시간으로 아는 런은 그린다", async () => {
  stubServer({
    runs: [],
    override: (method, url) =>
      method === "GET" && /\/runs(\?|$)/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("런 목록을 불러오지 못했습니다.");

  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));

  expect(await within(aside).findByRole("button", { name: /@dev/ })).toHaveTextContent("응답 중");
  // 실패 문구도 함께 남는다 — 목록이 낡았다는 사실을 감추지 않는다
  expect(within(aside).getByText("런 목록을 불러오지 못했습니다.")).toBeInTheDocument();
});

/**
 * 브라우저 검증 D12 — 끊긴 사이 끝난 런(D9 의 재접속 경로). 재접속 스냅샷의 `activeRuns` 에 없는 진행 중 런은
 * 런 스토어에서 빠지는데(`applySubscribed`), 이 탭은 그 런의 종료를 **본 적이 없어** `ended` 기억에도 없다.
 * 그대로 두면 줄이 목록에서 빠지고 선택이 옛 런으로 넘어가 타임라인이 다른 런의 것이 된다.
 * 실제 경로 그대로 잰다 — 구독 ack 을 대본으로 주고 `catchUp` 을 돌린다
 */
const subscribeAck = (over: Partial<ChannelSubscribeResult> = {}): Result<ChannelSubscribeResult> => ({
  ok: true,
  data: {
    messages: [],
    hasMore: false,
    latestSeq: 0,
    activeRuns: [],
    pendingApprovals: [],
    tasks: [],
    ...over,
  },
});

async function reconnect(queryClient: QueryClient, over: Partial<ChannelSubscribeResult> = {}) {
  fake.onAck("channel.subscribe", () => subscribeAck(over));
  const subs = createSubscriptions({ socket: fake.wire, queryClient });
  await act(async () => {
    await subs.catchUp(CH);
  });
}

/** RUN(옛 런, REST 에만) + RUN2(실시간으로만 아는 진행 중 런). 고른 런은 최근 것인 RUN2 */
async function awaitingRun(queryClient?: QueryClient) {
  const { state, calls } = stubServer({
    runs: [runOf(RUN)],
    events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS },
  });
  const rendered = renderRoute(`/c/${CH}/s/${CH}/activity`, queryClient);
  const aside = await panel();
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "awaiting_approval" })));
  await within(aside).findByText("Read");
  expect(openRuns(aside)).toEqual([RUN2]);
  return { aside, state, calls, queryClient: rendered.queryClient, router: rendered.router };
}

it("끊긴 사이 끝난 런은 재접속 뒤에도 목록에 남고 선택·타임라인이 그대로다(D12)", async () => {
  const { aside, state, queryClient } = await awaitingRun();
  const before = timelineBox(aside);
  // 서버에서는 이미 끝났다 — 재접속 스냅샷의 activeRuns 에 없다
  state.runs = [runOf(RUN2, { status: "done" }), runOf(RUN)];

  await reconnect(queryClient);

  // ① 줄이 남는다 ② 선택이 옛 런으로 안 넘어간다 ③ 타임라인이 새로 서지 않는다
  expect(runIds(aside)).toEqual([RUN2, RUN]);
  expect(openRuns(aside)).toEqual([RUN2]);
  expect(timelineBox(aside)).toBe(before);
  expect(within(aside).getByText("Read")).toBeInTheDocument();
  expect(within(aside).queryByText("옛도구")).not.toBeInTheDocument();
  // 자리값은 마지막으로 본 상태다 — 재조회가 서버 사실을 받아 오면 그쪽이 덮는다(「승인 대기」 → 「완료」)
  await waitFor(() =>
    expect(within(aside).getAllByRole("button", { name: /@dev/ })[0]).toHaveTextContent("완료"),
  );
});

it("끊긴 사이 끝난 런의 타임라인은 재접속 뒤 다시 받는다 — 새로 빠진 런만(plan.md 이월)", async () => {
  const { aside, state, queryClient } = await awaitingRun();
  // 옛 런 타임라인도 캐시에 있다 — 이것까지 무효화하면 옛 런을 다시 받는다
  queryClient.setQueryData(qk.runEvents(RUN), OTHER_RUN);
  state.runs = [runOf(RUN2, { status: "done" }), runOf(RUN)];
  // 끊긴 사이 그 런이 도구를 하나 더 썼다 — 실시간으로는 못 받았고 서버 기록에만 있다
  const later = [
    ...TOOL_EVENTS,
    runEvent({ type: "TOOL_CALL_START", seq: 6, toolCallId: "t2", toolCallName: "Write" }),
    runEvent({ type: "TOOL_CALL_END", seq: 7, toolCallId: "t2" }),
  ];
  stubServer({ runs: state.runs, events: { [RUN]: OTHER_RUN, [RUN2]: later } });

  await reconnect(queryClient);

  expect(await within(aside).findByText("Write")).toBeInTheDocument();
  expect(queryClient.getQueryState(qk.runEvents(RUN))?.isInvalidated).toBe(false);
});

it("재접속 목록 조회가 실패해도 끊긴 사이 끝난 런은 사라지지 않는다(D12)", async () => {
  const { aside, queryClient } = await awaitingRun();
  // 다시 붙자마자 조회가 또 실패하는 판 — 재접속은 바로 그런 때에 일어난다
  stubServer({
    runs: [],
    events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS },
    override: (method, url) =>
      method === "GET" && /\/runs\?/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });

  await reconnect(queryClient);

  await within(aside).findByText("런 목록을 불러오지 못했습니다.");
  expect(runIds(aside)).toContain(RUN2);
  expect(openRuns(aside)).toEqual([RUN2]);
  expect(within(aside).getByText("Read")).toBeInTheDocument();
});

it("재접속이 지운 다른 채널 런은 이 채널 목록에 나타나지 않는다(D12 ④)", async () => {
  const { aside, queryClient } = await awaitingRun();
  const OTHER = uid(104);
  act(() => useRunStore.getState().applyState(runState({ id: OTHER, channelId: CH2, status: "tool" })));
  expect(runIds(aside)).toEqual([RUN2, RUN]);

  await reconnect(queryClient);

  // 이 채널 것만 기억한다 — 남의 채널 런이 이 목록에 섞여 들어오지 않는다
  expect(runIds(aside)).toEqual([RUN2, RUN]);
  // 그리고 남의 채널 런은 재접속이 건드리지 않는다(그 채널이 맡는다)
  expect(useRunStore.getState().runs[OTHER]?.state.status).toBe("tool");
});

it("재접속이 미해결 승인을 닫아도 그 런 줄은 남는다 — D8 정본화와 D12 가 서로 안 상한다(D12 ⑤)", async () => {
  const { aside, state, queryClient } = await awaitingRun();
  act(() => useApprovalStore.getState().apply(approval({ runId: RUN2 })));
  await waitFor(() => expect(aside.querySelector('[data-slot="approval-card"]')).not.toBeNull());
  state.runs = [runOf(RUN2, { status: "done" }), runOf(RUN)];

  // 끊긴 사이 승인이 확정됐다 — ack 의 미해결 목록이 비어 있다
  await reconnect(queryClient);

  expect(aside.querySelector('[data-slot="approval-card"]')).toBeNull();
  expect(runIds(aside)).toEqual([RUN2, RUN]);
  expect(openRuns(aside)).toEqual([RUN2]);
});

it("채널을 옮기면 「빠진 런」 기억도 버린다(D12 ④)", async () => {
  const queryClient = createQueryClient(() => {});
  queryClient.setQueryData(qk.channel(CH2), channelOf(CH2));
  const { aside, state, router } = await awaitingRun(queryClient);

  await reconnect(queryClient);
  expect(runIds(aside)).toContain(RUN2);

  // 옮겨 간 채널에는 런이 없다 — 앞 채널에서 빠진 런의 기억이 따라오면 안 된다
  state.runs = [];
  await act(() =>
    router.navigate({
      to: "/c/$channelId/s/$conversationId/activity",
      params: { channelId: CH2, conversationId: CH2 },
    }),
  );

  const moved = await panel();
  expect(moved).toBe(aside);
  await within(moved).findByText("아직 실행 기록이 없습니다.");
  expect(runIds(moved)).toEqual([]);
});

/**
 * p2-t14 리뷰 §A.2 — 재조회가 실패하는 동안 자리값(D12)의 소요가 계속 흘렀다(「승인 대기 · 25 → 26초」). 앱은 그 런이
 * 더는 진행 중이 아님을 이미 안다. **자리값은 남기되**(판정 그대로) 소요는 안 순간에 멈추고, 그런 줄만 남으면 1초 틱도
 * 멈춘다(D7 의 잠금). 틱은 `setInterval` 을 엿봐 잰다 — 이 파일에서는 react-query 타이머가 섞여 타이머 수를 못 센다
 */
const RUN3 = uid(105);
const SINCE = Date.parse("2027-01-15T08:00:01.000Z");
/**
 * 줄에 보이는 소요(초). 가짜 시계가 실제 시간과 함께도 흐르므로(`shouldAdvanceTime`) 글자를 통째로 맞대지 않고 초를 읽어
 * 범위로 잰다 — 부하가 큰 병렬 실행에서 실제로 흐른 수백 ms 가 한 칸을 넘겨도 흔들리지 않게
 */
const seconds = (el: HTMLElement | null) => Number(/ · (\d+)초/.exec(el?.textContent ?? "")?.[1]);

/** RUN2 가 25초째 진행 중일 때 끊겼다가, 다시 붙자 목록 조회가 계속 실패한다. `known` 이면 REST 도 진행 중인 RUN2 를 받아 둔 채다 */
async function vanishedWhileFailing({ known = false } = {}) {
  const intervals = vi.spyOn(globalThis, "setInterval");
  const clears = vi.spyOn(globalThis, "clearInterval");
  const inFlight = runOf(RUN2, { status: "tool", startedAt: iso(SINCE), endedAt: undefined });
  stubServer({
    runs: known ? [inFlight, runOf(RUN)] : [runOf(RUN)],
    events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS },
  });
  const { queryClient } = renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  act(() =>
    useRunStore
      .getState()
      .applyState(runState({ id: RUN2, status: "awaiting_approval", startedAt: iso(SINCE) })),
  );
  /** 카드 머리(펼침 단추) — 줄 글자만 잰다. 새 런이 오면 가장 최근 런이 바뀌어 아래 타임라인이 접히기도 한다 */
  const row = (id: string) => aside.querySelector<HTMLElement>(`[data-run-id="${id}"] button[aria-expanded]`);
  await waitFor(() => expect(seconds(row(RUN2))).toBeGreaterThanOrEqual(0));
  act(() => void vi.advanceTimersByTime(25_000));
  expect(seconds(row(RUN2))).toBeGreaterThanOrEqual(25);
  const ticks = intervals.mock.results.filter((_, i) => intervals.mock.calls[i]?.[1] === TICK_MS);
  expect(ticks).toHaveLength(1);

  // 끊긴 사이 끝났고, 다시 붙자 목록 조회가 계속 실패한다(재시도까지 다 쓴다)
  stubServer({
    runs: [],
    events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS },
    override: (method, url) =>
      method === "GET" && /\/runs\?/.test(url)
        ? json(500, { code: "INTERNAL", message: "터졌다" })
        : undefined,
  });
  await reconnect(queryClient);
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  await within(aside).findByText("런 목록을 불러오지 못했습니다.");
  return { aside, row, tick: ticks[0]?.value as unknown, clears };
}

it("목록 조회가 실패해 자리값으로 남은 런의 소요는 더 흐르지 않고, 그런 런만 남으면 1초 틱이 멈춘다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: SINCE });
  try {
    const { row, tick, clears } = await vanishedWhileFailing();

    // 자리값은 남는다 — 상태 글자도 마지막으로 본 그대로다(「남는 쪽이 사라지는 쪽보다 낫다」)
    expect(row(RUN2)).toHaveTextContent("승인 대기");
    // 빠진 것을 안 순간(≈25초)에 멈췄다 — 재시도를 다 쓰는 5초 동안 흘렀다면 30초다
    const frozen = row(RUN2)?.textContent;
    expect(seconds(row(RUN2))).toBeLessThan(28);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(row(RUN2)?.textContent).toBe(frozen);
    // 흐르는 줄이 하나도 없다(RUN 은 끝났고 RUN2 는 멈췄다) — 1초 틱을 거둔다
    expect(clears).toHaveBeenCalledWith(tick);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

/** 자리값은 REST 밑에 깔린다 — REST 가 끊기기 전의 진행 중 모습을 쥐고 있으면 그 줄이 보인다. 그 줄도 흐르면 같은 거짓이다 */
it("끊기기 전에 받아 둔 REST 줄이 진행 중이어도 재조회가 실패하는 동안 소요는 멈춘다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: SINCE });
  try {
    const { row, tick, clears } = await vanishedWhileFailing({ known: true });

    // 보이는 것은 REST 의 낡은 줄이다(자리값이 아니다) — 그래도 더는 진행 중이 아님을 안다
    expect(row(RUN2)).toHaveTextContent("도구 사용 중");
    const frozen = row(RUN2)?.textContent;
    expect(seconds(row(RUN2))).toBeLessThan(28);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(row(RUN2)?.textContent).toBe(frozen);
    expect(clears).toHaveBeenCalledWith(tick);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

it("자리값 곁에서도 진짜 진행 중인 런은 흐르고, 다시 실시간으로 돌아온 자리값도 흐른다", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: SINCE });
  try {
    const { row } = await vanishedWhileFailing();
    const frozen = row(RUN2)?.textContent;

    act(() =>
      useRunStore
        .getState()
        .applyState(runState({ id: RUN3, status: "streaming", startedAt: iso(SINCE + 30_000) })),
    );
    await waitFor(() => expect(seconds(row(RUN3))).toBeGreaterThanOrEqual(0));
    act(() => void vi.advanceTimersByTime(4_000));
    expect(seconds(row(RUN3))).toBeGreaterThanOrEqual(4);
    expect(row(RUN2)?.textContent).toBe(frozen);

    // 빠졌던 런의 실시간 상태가 다시 오면 더는 자리값이 아니다 — 멈춘 표시를 떼고 다시 흐른다
    act(() =>
      useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming", startedAt: iso(SINCE) })),
    );
    await waitFor(() => expect(row(RUN2)).toHaveTextContent("응답 중"));
    const back = row(RUN2)?.textContent;
    act(() => void vi.advanceTimersByTime(3_000));
    expect(row(RUN2)?.textContent).not.toBe(back);
  } finally {
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

/** 활동 패널의 두 자리 그대로(`ActivityPanel`) — 미해결 승인이 오면 런 카드 위에 카드가 뜬다 */
function CardOverRunCards({ runs }: { runs: readonly ActivityRun[] }) {
  const pending = useApprovalStore(selectPendingApproval(CH));
  return (
    <>
      {pending && <ApprovalCard approvalId={pending.approval.id} channelId={CH} />}
      <RunCards runs={runs} isExpanded={() => false} onToggle={() => {}} approval={() => undefined} />
    </>
  );
}

/**
 * 브라우저 검증 D6 의 나머지 반 — 카드끼리만이 아니라 한 화면에서 흐르는 값 **모두**가 공용 시계 하나를 본다.
 * 런이 도는 중에 600ms 늦게 뜬 카드가 제 시계를 따로 돌리면, 목록의 소요는 넘어갔는데 카드의 남은 초는 그대로인 순간이
 * 생긴다. 패널을 통째로(라우트) 띄우려면 `shouldAdvanceTime` 이 있어야 해 틱을 ms 로 못 맞추므로, 패널의 두 자리만 띄운다
 */
it("승인 카드의 남은 초와 런 목록의 소요는 같은 틱에 함께 넘어간다(D6)", async () => {
  const NOW = Date.parse("2027-01-15T08:00:00.000Z");
  vi.useFakeTimers({ now: NOW });
  try {
    renderWithClient(
      <CardOverRunCards runs={[runState({ status: "tool", startedAt: iso(NOW - 20_000) })]} />,
    );
    const shown = () => [
      seconds(document.querySelector(`[data-run-id="${RUN}"]`)),
      document.querySelector('[data-slot="approval-outcome"]')?.textContent,
    ];

    // 목록이 먼저 돌고 600ms 뒤 승인이 온다 — 카드가 제 시각으로 따로 세면 「9초」
    await act(async () => void vi.advanceTimersByTime(600));
    act(() => useApprovalStore.getState().apply(approval({ expiresAt: iso(NOW + 10_500) })));
    expect(shown()).toEqual([20, "10초 남음"]);

    // 소요가 1초 늘 때 남은 초도 같은 틱에 1초 준다 — 따로 돌면 카드가 600ms 늦게 넘어간다
    for (const [step, expected] of [
      [400, [21, "9초 남음"]],
      [300, [21, "9초 남음"]],
      [700, [22, "8초 남음"]],
      [300, [22, "8초 남음"]],
    ] as const) {
      await act(async () => void vi.advanceTimersByTime(step));
      expect(shown()).toEqual(expected);
    }
  } finally {
    vi.useRealTimers();
  }
});

/**
 * 브라우저 검증 D14 — 좁은 화면 시트의 초점 두 자리. 열면 Radix 가 링크를 건너뛰고(`removeLinks`)
 * 첫 입력에 초점을 줘 탭 머리가 뒤에 남았고, Esc 로 닫으면 돌려줄 Trigger 가 없어 초점이 `<body>` 로 떨어졌다
 */
it("좁은 화면에서 시트를 열면 초점이 탭 머리에서 시작한다(D14)", async () => {
  stubMedia(true);
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);

  const sheet = await screen.findByRole("dialog", { name: "활동" });

  const activityTab = within(sheet).getByRole("link", { name: "활동" });
  await waitFor(() => expect(activityTab).toHaveFocus());
  // 링크 차례는 그대로다 — 초점만 옮긴다
  expect([...sheet.querySelectorAll("[data-tab-id]")].map((el) => el.textContent)).toEqual([
    "설정",
    "활동",
    "파일",
  ]);
});

it("넓은 화면 패널은 초점을 옮기지 않는다 — 링크 차례도 그대로다(D14)", async () => {
  stubMedia(false);
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");

  // 대화상자가 아니다 — 주소로 들어온 사용자의 초점을 빼앗지 않는다
  expect(document.activeElement).toBe(document.body);
  expect([...aside.querySelectorAll("[data-tab-id]")].map((el) => el.textContent)).toEqual([
    "설정",
    "활동",
    "파일",
  ]);
});

// 좁은 화면 머리의 「채널 설정」은 「더 보기」 메뉴 줄이라(스펙 2026-11-19 U6) 초점은 그 메뉴를 여는 단추가 받는다
it("좁은 화면에서 Esc 로 시트를 닫으면 초점이 「더 보기」로 돌아간다(D14)", async () => {
  stubMedia(true);
  stubServer({ runs: [] });
  const { router } = renderRoute(`/c/${CH}/s/${CH}/activity`);
  await screen.findByRole("dialog", { name: "활동" });

  await userEvent.keyboard("{Escape}");

  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/s/${CH}`));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  const header = await screen.findByTestId("channel-header");
  const opener = within(header).getByRole("button", { name: "더 보기" });
  await waitFor(() => expect(opener).toHaveFocus());
});

it("멈춘 자리값 줄의 소요는 흐리게 보이고 「멈춤」 까닭을 툴팁과 화면 읽기 글로 단다 — 흐르는 줄·끝난 줄은 그대로다", () => {
  const NOW = Date.parse("2027-01-15T08:00:30.000Z");
  // runState 는 스키마로 걸러 frozenAt 을 버린다 — 활동 줄의 덧칸은 따로 얹는다
  const frozen: ActivityRun = {
    ...runState({ id: RUN2, status: "awaiting_approval", startedAt: iso(NOW - 25_000) }),
    frozenAt: iso(NOW - 5_000),
  };
  renderWithClient(
    <RunCards
      runs={[frozen, runOf(RUN), runState({ id: uid(106), status: "tool", startedAt: iso(NOW - 3_000) })]}
      isExpanded={() => false}
      onToggle={() => {}}
      approval={() => undefined}
    />,
  );
  const row = (id: string) => document.querySelector<HTMLElement>(`[data-run-id="${id}"]`)!;
  const mark = row(RUN2).querySelector<HTMLElement>('[data-frozen="true"]');
  expect(mark).not.toBeNull();
  expect(mark).toHaveAttribute("title", "멈춤 — 끝난 시각을 모릅니다");
  expect(mark).toHaveClass("opacity-60");
  expect(within(row(RUN2)).getByText("(멈춤 — 끝난 시각을 모릅니다)", { exact: false })).toHaveClass(
    "sr-only",
  );
  expect(seconds(row(RUN2))).toBe(20);
  // 끝난 줄과 아직 흐르는 줄에는 표식이 없다
  expect(row(RUN).querySelector("[data-frozen]")).toBeNull();
  expect(row(uid(106)).querySelector("[data-frozen]")).toBeNull();
});

// ── 백그라운드 작업(백그라운드 작업 스펙 5.7·D6·D7) ──────────────────────────────

const bgTask = (taskId: string, originRunId: string, over: Partial<BackgroundTask> = {}): BackgroundTask => ({
  taskId,
  kind: "shell",
  description: `pnpm dev ${taskId}`,
  startedAt: new Date(Date.now() - 125_000).toISOString(),
  originRunId,
  ...over,
});
/** 그 대화(여기서는 채널의 「이전 대화」 = CH)의 작업 전체를 바꿔 끼운다 — 서버 tasks.updated 와 같은 값 */
const putTasks = (tasks: BackgroundTask[], runnerConnected = true) =>
  act(() => useBackgroundTaskStore.getState().apply(CH, { conversationId: CH, runnerConnected, tasks }));
const taskRows = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>("[data-task-id]")];

it("shows background rows on a collapsed card — 접힌 끝난 카드에도 작업 줄, 머리에 「백그라운드 N」 칩", async () => {
  stubServer({ runs: [runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }), runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findAllByRole("region", { name: /^@dev 런/ });
  expect(openRuns(aside)).toEqual([RUN2]);
  putTasks([
    bgTask("s1", RUN),
    bgTask("a1", RUN, {
      kind: "subagent",
      description: "파일 찾기",
      subagentType: "Explore",
      summary: "src 를 훑는 중",
      lastToolName: "Grep",
    }),
  ]);
  const collapsed = card(aside, RUN);
  expect(collapsed).toHaveAttribute("data-expanded", "false");
  const rows = taskRows(collapsed);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent("셸");
  expect(rows[0]).toHaveTextContent("pnpm dev s1");
  expect(rows[0]).toHaveTextContent("2분째");
  expect(rows[1]).toHaveTextContent("서브에이전트");
  expect(rows[1]).toHaveTextContent("파일 찾기");
  expect(rows[1]).toHaveTextContent("Explore · src 를 훑는 중 · Grep");
  const badge = collapsed.querySelector('[data-slot="background-chip"]');
  expect(badge).toHaveTextContent("백그라운드 2");
  expect(badge).toHaveAttribute("aria-label", "백그라운드 작업 2개");
  // 작업이 없는 카드에는 칩도 줄도 없다
  expect(card(aside, RUN2).querySelector('[data-slot="background-chip"]')).toBeNull();
  expect(taskRows(card(aside, RUN2))).toHaveLength(0);
  // 바꿔 끼운 값에서 빠진 작업은 줄도 빠진다
  putTasks([bgTask("s1", RUN)]);
  expect(taskRows(card(aside, RUN))).toHaveLength(1);
  expect(card(aside, RUN).querySelector('[data-slot="background-chip"]')).toHaveTextContent("백그라운드 1");
});

it("stop follows the run stop rule — 런을 보는 사람 누구에게나 「종료」, wire 가 붙어 있지 않으면 비활성", async () => {
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  putTasks([bgTask("s1", RUN)]);
  const stop = within(card(aside, RUN)).getByRole("button", { name: "셸 pnpm dev s1 종료" });
  expect(stop).toBeEnabled();
  act(() => useWireStatus.getState().setStatus("reconnecting"));
  expect(stop).toBeDisabled();
  await userEvent.click(stop);
  expect(fake.sentOf("task.stop")).toEqual([]);
  act(() => useWireStatus.getState().setStatus("connected"));
  expect(stop).toBeEnabled();
});

it("stop sends task.stop and disables the button — 원래 런 id 로 보내고, 응답 전까지 잠근다. 실패는 그 줄에, NOT_FOUND 면 줄을 지운다", async () => {
  let release: (r: Result<null>) => void = () => {};
  fake.onAck("task.stop", () => new Promise<Result<null>>((resolve) => (release = resolve)));
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  putTasks([bgTask("s1", RUN), bgTask("s2", RUN)]);

  await userEvent.click(within(card(aside, RUN)).getByRole("button", { name: "셸 pnpm dev s1 종료" }));
  expect(fake.sentOf("task.stop")).toEqual([{ runId: RUN, taskId: "s1" }]);
  const locked = within(card(aside, RUN)).getByRole("button", { name: "셸 pnpm dev s1 종료 중" });
  expect(locked).toHaveAttribute("aria-disabled", "true");
  await userEvent.click(locked);
  expect(fake.sentOf("task.stop")).toHaveLength(1);

  // 러너가 끊겼거나 끄지 못했다 — 그 줄에 짧게 알리고 다시 연다
  await act(async () => release({ ok: false, error: { code: "ADAPTER_UNAVAILABLE", message: "x" } }));
  const row = taskRows(card(aside, RUN))[0]!;
  expect(within(row).getByRole("alert")).toHaveTextContent("러너에 닿지 않아 작업을 종료하지 못했습니다");
  expect(within(row).getByRole("button", { name: "셸 pnpm dev s1 종료" })).not.toHaveAttribute(
    "aria-disabled",
  );

  // 서버가 그 런을 모른다 — 줄을 지운다. 칩·「진행 중」 수도 함께 맞는다(스토어에서 뺀다 — 리뷰 N1)
  expect(card(aside, RUN).querySelector('[data-slot="background-chip"]')).toHaveTextContent("백그라운드 2");
  await userEvent.click(within(row).getByRole("button", { name: "셸 pnpm dev s1 종료" }));
  await act(async () => release({ ok: false, error: { code: "NOT_FOUND", message: "x" } }));
  expect(taskRows(card(aside, RUN)).map((r) => r.dataset.taskId)).toEqual(["s2"]);
  expect(card(aside, RUN).querySelector('[data-slot="background-chip"]')).toHaveTextContent("백그라운드 1");
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 1");

  // 마지막 작업도 NOT_FOUND — 칩이 사라지고 「진행 중」 수가 0
  await userEvent.click(within(card(aside, RUN)).getByRole("button", { name: "셸 pnpm dev s2 종료" }));
  await act(async () => release({ ok: false, error: { code: "NOT_FOUND", message: "x" } }));
  expect(taskRows(card(aside, RUN))).toHaveLength(0);
  expect(card(aside, RUN).querySelector('[data-slot="background-chip"]')).toBeNull();
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 0");
});

it("stop buttons of same-named tasks have distinct names — 같은 종류·설명 작업 둘이면 「종료」 이름에 순번", async () => {
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  putTasks([
    bgTask("d1", RUN, { description: "pnpm dev" }),
    bgTask("d2", RUN, { description: "pnpm dev" }),
    bgTask("s1", RUN),
  ]);
  const names = within(card(aside, RUN))
    .getAllByRole("button", { name: /종료$/ })
    .map((b) => b.getAttribute("aria-label"));
  expect(names).toEqual(["셸 pnpm dev (1) 종료", "셸 pnpm dev (2) 종료", "셸 pnpm dev s1 종료"]);
  expect(new Set(names).size).toBe(3);
});

const EARLIER = uid(140);
const earlierGroup = (aside: HTMLElement) =>
  aside.querySelector<HTMLElement>('[data-slot="earlier-run-tasks"]');

it("shows tasks of runs outside the loaded list at the top — 카드 없는 원래 런의 작업은 맨 위 묶음에, 「종료」는 그 런 id 로", async () => {
  fake.onAck("task.stop", async () => ({ ok: true, data: null }));
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  expect(earlierGroup(aside)).toBeNull();
  putTasks([bgTask("o1", EARLIER), bgTask("o2", EARLIER, { kind: "subagent", description: "훑기" })]);

  const group = earlierGroup(aside)!;
  expect(group).not.toBeNull();
  expect(group).toHaveAccessibleName("이전 런의 백그라운드 작업 2개");
  expect(within(group).getByRole("heading")).toHaveTextContent("이전 런의 백그라운드 작업2");
  expect(taskRows(group).map((r) => r.dataset.taskId)).toEqual(["o1", "o2"]);
  // 런 카드 목록 위에 있다
  const list = within(aside).getByRole("list", { name: "런 목록" });
  expect(group.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  // 카드 안 줄과 같은 「종료」 — 원래 런 id 로 보낸다
  await userEvent.click(within(group).getByRole("button", { name: "셸 pnpm dev o1 종료" }));
  expect(fake.sentOf("task.stop")).toEqual([{ runId: EARLIER, taskId: "o1" }]);
  // 러너가 끊기면 카드 안 줄처럼 흐리고 「종료」가 없다
  putTasks([bgTask("o1", EARLIER)], false);
  expect(within(earlierGroup(aside)!).getByText("러너 연결 끊김")).toBeInTheDocument();
  expect(within(earlierGroup(aside)!).queryByRole("button", { name: /종료/ })).not.toBeInTheDocument();
  putTasks([bgTask("o1", EARLIER)]);

  // 원래 런이 목록에 들어오면 묶음에서 빠져 그 카드로 옮겨 간다
  act(() => useRunStore.getState().applyState(runState({ id: EARLIER, status: "streaming" })));
  await waitFor(() => expect(earlierGroup(aside)).toBeNull());
  expect(taskRows(card(aside, EARLIER)).map((r) => r.dataset.taskId)).toEqual(["o1"]);
});

it("in progress count includes runs outside the loaded list — 묶음의 원래 런도 「진행 중」에 세고, 고르면 묶음이 보인다", async () => {
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  putTasks([bgTask("o1", EARLIER), bgTask("o2", EARLIER), bgTask("o3", uid(141))]);
  // 원래 런 둘
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 2");
  await userEvent.click(chip(aside, "진행 중"));
  expect(taskRows(earlierGroup(aside)!)).toHaveLength(3);
  expect(runIds(aside)).toEqual([]);
  expect(within(aside).queryByText("진행 중인 런이 없습니다.")).not.toBeInTheDocument();
  // 「실패」를 고르면 묶음은 숨는다
  await userEvent.click(chip(aside, "실패"));
  expect(earlierGroup(aside)).toBeNull();
  await userEvent.click(chip(aside, "진행 중"));
  putTasks([]);
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 0");
  expect(earlierGroup(aside)).toBeNull();
  expect(within(aside).getByText("진행 중인 런이 없습니다.")).toBeInTheDocument();
});

it("shows earlier run tasks when the run list is empty — 런 목록이 비어도 묶음은 보인다", async () => {
  stubServer({ runs: [] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");
  putTasks([bgTask("o1", EARLIER)]);
  expect(taskRows(earlierGroup(aside)!)).toHaveLength(1);
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 1");
  expect(within(aside).queryByText("아직 실행 기록이 없습니다.")).not.toBeInTheDocument();
});

it("task elapsed ticks without re-rendering run cards — 작업이 있어도 끝난 런 카드 목록은 매초 다시 그리지 않는다(리뷰 M1)", async () => {
  const NOW = Date.parse("2027-01-15T09:00:00.000Z");
  vi.useFakeTimers({ now: NOW });
  try {
    stubServer({ runs: [] });
    act(() =>
      useBackgroundTaskStore.getState().apply(CH, {
        conversationId: CH,
        runnerConnected: true,
        tasks: [bgTask("s1", RUN, { startedAt: iso(NOW - 10_000) })],
      }),
    );
    const done = { ...runState({ status: "done" }), endedAt: iso(NOW - 5_000) } as ActivityRun;
    function Cards() {
      const tasks = useBackgroundTaskStore((s) => s.byChannel[CH]?.[CH]);
      return (
        <RunCards
          runs={[done]}
          isExpanded={() => false}
          onToggle={() => {}}
          approval={() => undefined}
          background={() => ({ tasks: tasks?.tasks ?? [], runnerConnected: true })}
        />
      );
    }
    renderWithClient(<Cards />);
    const row = () => document.querySelector<HTMLElement>('[data-task-id="s1"]');
    expect(row()).toHaveTextContent("10초째");
    const before = agentsCalls.n;
    for (let i = 0; i < 3; i += 1) await act(async () => void vi.advanceTimersByTime(TICK_MS));
    // 걸린 시간은 흐르고, 카드는 그대로
    expect(row()).toHaveTextContent("13초째");
    expect(agentsCalls.n - before).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("marks disconnected runner rows — 줄을 흐리고 「러너 연결 끊김」, 「종료」는 없다", async () => {
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  putTasks([bgTask("s1", RUN)], false);
  const list = card(aside, RUN).querySelector<HTMLElement>('[data-slot="background-tasks"]')!;
  expect(list).toHaveClass("opacity-60");
  expect(within(list).getByText("러너 연결 끊김")).toBeInTheDocument();
  expect(within(list).queryByRole("button", { name: /종료/ })).not.toBeInTheDocument();
  putTasks([bgTask("s1", RUN)], true);
  expect(list).not.toHaveClass("opacity-60");
  expect(within(list).queryByText("러너 연결 끊김")).not.toBeInTheDocument();
  expect(within(list).getByRole("button", { name: "셸 pnpm dev s1 종료" })).toBeInTheDocument();
});

it("in progress filter includes finished runs with tasks — 작업이 남은 끝난 런도 「진행 중」에 들고 수에도 든다", async () => {
  stubServer({ runs: [runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }), runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findAllByRole("region", { name: /^@dev 런/ });
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 0");
  putTasks([bgTask("s1", RUN)]);
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 1");
  await userEvent.click(chip(aside, "진행 중"));
  expect(runIds(aside)).toEqual([RUN]);
  // 작업이 끝나면 빠진다
  putTasks([]);
  expect(chip(aside, "진행 중")).toHaveTextContent("진행 중 0");
  expect(within(aside).getByText("진행 중인 런이 없습니다.")).toBeInTheDocument();
});

it("follow-up card names its origin run — 「추가 응답 · <원래 런 시작 시각> 런」, 원래 런을 모르면 「추가 응답」", async () => {
  const FOLLOWUP = uid(130);
  const ORPHAN = uid(131);
  const startedAt = "2027-01-15T08:00:01.000Z";
  stubServer({
    runs: [
      runOf(ORPHAN, { triggerKind: "background", backgroundOriginRunId: uid(999) }),
      runOf(FOLLOWUP, { triggerKind: "background", backgroundOriginRunId: RUN }),
      runOf(RUN, { startedAt }),
    ],
  });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findAllByRole("region", { name: /^@dev 런/ });
  const time = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(
    new Date(startedAt),
  );
  expect(card(aside, FOLLOWUP).querySelector('[data-slot="followup-origin"]')).toHaveTextContent(
    `추가 응답 · ${time} 런`,
  );
  expect(card(aside, ORPHAN).querySelector('[data-slot="followup-origin"]')?.textContent).toBe("추가 응답");
  expect(card(aside, RUN).querySelector('[data-slot="followup-origin"]')).toBeNull();
});

it("follow-up card names its origin run from live run.state — 실시간 상태가 backgroundOriginRunId 를 싣는다", async () => {
  stubServer({ runs: [runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByRole("region", { name: /^@dev 런/ });
  act(() =>
    useRunStore
      .getState()
      .applyState(runState({ id: RUN2, status: "streaming", backgroundOriginRunId: RUN })),
  );
  await waitFor(() =>
    expect(card(aside, RUN2).querySelector('[data-slot="followup-origin"]')).toHaveTextContent(
      /^추가 응답 · .+ 런$/,
    ),
  );
});

it("held settings note — CUSTOM dodok.held_settings 가 있는 런 카드에 D6 문구(접혀 있어도 받아 둔 이벤트면)", async () => {
  const queryClient = createQueryClient(() => {});
  queryClient.setQueryData(qk.runEvents(RUN), [
    runEvent({ type: "CUSTOM", seq: 1, name: "dodok.held_settings", value: { fields: ["allowedTools"] } }),
    ...TOOL_EVENTS.map((e) => ({ ...e, seq: e.seq + 1 })),
  ]);
  stubServer({ runs: [runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }), runOf(RUN)] });
  renderRoute(`/c/${CH}/s/${CH}/activity`, queryClient);
  const aside = await panel();
  await within(aside).findAllByRole("region", { name: /^@dev 런/ });
  await waitFor(() =>
    expect(card(aside, RUN).querySelector('[data-slot="held-settings"]')).toHaveTextContent(
      "백그라운드 작업 때문에 일부 설정은 이전 값으로 실행",
    ),
  );
  expect(card(aside, RUN2).querySelector('[data-slot="held-settings"]')).toBeNull();
  // 행이 되지는 않는다 — 요약은 그대로 도구 하나
  expect(card(aside, RUN).querySelector('[data-slot="run-summary"]')).toHaveTextContent("도구 1(Read)");
});

it("held settings note — 실시간으로 본 런도 D6 문구", async () => {
  stubServer({ runs: [] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");
  act(() => {
    useRunStore.getState().applyState(runState({ id: RUN2, status: "queued" }));
    useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" }));
    useRunStore
      .getState()
      .applyEvent(
        runEvent({ runId: RUN2, type: "CUSTOM", seq: 1, name: "dodok.held_settings", value: { fields: [] } }),
      );
  });
  await waitFor(() =>
    expect(card(aside, RUN2).querySelector('[data-slot="held-settings"]')).toHaveTextContent(
      "백그라운드 작업 때문에 일부 설정은 이전 값으로 실행",
    ),
  );
});

it("queued card explains held slots — 기다리는 런 카드에 D7 문구, 시작하면 사라진다", async () => {
  stubServer({ runs: [] });
  renderRoute(`/c/${CH}/s/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");
  act(() => {
    useRunStore.getState().applyState(runState({ id: RUN2, status: "queued" }));
    useRunStore.getState().applyEvent(runEvent({ runId: RUN2, type: "RUN_QUEUED", seq: 1, heldSlots: 2 }));
  });
  const held = await waitFor(() => {
    const el = card(aside, RUN2).querySelector('[data-slot="held-slots"]');
    expect(el).not.toBeNull();
    return el;
  });
  expect(held).toHaveTextContent(
    "백그라운드 작업 2개가 러너 자리를 쓰는 중 — 활동 탭에서 종료하면 이어집니다",
  );
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));
  expect(card(aside, RUN2).querySelector('[data-slot="held-slots"]')).toBeNull();
});
