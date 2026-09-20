import type { Run, RunEvent } from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { selectPendingApproval, useApprovalStore } from "@/features/approvals/approvalStore";
import { emptyTimeline } from "@/features/messages/timeline";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import {
  AGENT,
  APPROVAL,
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
import { stubScrollLayout } from "../../../test/scrollLayout";
import { channelOf, json, ME, renderRoute, shellGet } from "../../../test/shellApi";
import { agentOf } from "../../../test/settingsServer";

// 활동 패널은 실시간 run.event 를 소켓에서 곧바로 받는다 — 테스트는 가짜 소켓을 끼운다
const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

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
  events?: RunEvent[] | Record<string, RunEvent[]>;
  override?: (method: string, url: string) => Response | undefined;
};

/** 활동 패널이 부르는 REST 를 흉내 낸다. 그 밖은 앱 셸 기본 응답 */
function stubServer({ runs = [], events = [], override }: ServerOpts = {}) {
  const calls: string[] = [];
  const state = { runs };
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    const forced = override?.(method, url);
    if (forced) return forced;
    if (url === "/api/v1/auth/me") return json(200, ME);
    if (url === "/api/v1/agents") return json(200, { agents: [DEV] });
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
  useApprovalStore.getState().reset();
});

const panel = () => screen.findByTestId("page-channel-panel");
/** 지금 고른 런의 id — 목록 줄의 `aria-current` 가 정본이다 */
const pickedRun = (aside: HTMLElement) =>
  aside.querySelector<HTMLElement>('[data-run-id][aria-current="true"]')?.dataset.runId;
const runIds = (aside: HTMLElement) =>
  [...aside.querySelectorAll<HTMLElement>("[data-run-id]")].map((el) => el.dataset.runId);
const timelineBox = (aside: HTMLElement) => aside.querySelector('[data-slot="run-timeline"]');

it("활동 탭은 런 목록을 보이고 고르면 타임라인을 그린다", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);

  const aside = await panel();
  // 탭 둘 — 지금 탭은 aria-current
  expect(within(aside).getByRole("link", { name: "설정" })).not.toHaveAttribute("aria-current");
  expect(within(aside).getByRole("link", { name: "활동" })).toHaveAttribute("aria-current", "page");

  await userEvent.click(await within(aside).findByRole("button", { name: /@dev/ }));
  expect(await within(aside).findByText("Read")).toBeInTheDocument();
  // 인자는 접힘이 기본
  expect(screen.queryByText('{"path":"README.md"}')).not.toBeInTheDocument();
  await userEvent.click(within(aside).getByRole("button", { name: "Read 인자 보기" }));
  expect(screen.getByText('{"path":"README.md"}')).toBeInTheDocument();
  // 결과도 따로 접혀 있다
  await userEvent.click(within(aside).getByRole("button", { name: "Read 결과 보기" }));
  expect(screen.getByText("ok")).toBeInTheDocument();
});

it("텍스트 델타는 타임라인에 들어가지 않는다", async () => {
  stubServer({ runs: [runOf(RUN)], events: [textDelta(1, "긴 답변"), ...TOOL_EVENTS] });
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  expect(await within(aside).findByText("잘렸습니다")).toBeInTheDocument();
});

it("진행 중 런은 새 이벤트가 오면 끝에 붙는다", async () => {
  stubServer({ runs: [runOf(RUN, { status: "tool", endedAt: undefined })], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
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

it("다른 런의 실시간 이벤트는 섞이지 않는다", async () => {
  stubServer({ runs: [runOf(RUN)], events: { [RUN]: TOOL_EVENTS } });
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  expect(await within(aside).findByText("활동 기록을 불러오지 못했습니다.")).toBeInTheDocument();
});

it("설정 탭으로 가도 같은 틀(패널·시트)이 유지된다", async () => {
  const media = stubMedia(false);
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  const { router } = renderRoute(`/c/${CH}/activity`);

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
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/settings`));
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
  const { router } = renderRoute(`/c/${CH}/activity`);
  const aside = await panel();

  const settingsTab = within(aside).getByRole("link", { name: "설정" });
  await userEvent.click(settingsTab);
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/settings`));
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
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/activity`));
  await waitFor(() =>
    expect(screen.getByTestId("page-channel-panel")).toHaveAttribute("data-panel-tab", "activity"),
  );
  expect(document.body).toContainElement(activityTab);
  expect(document.activeElement).toBe(activityTab);
});

it("「활동 닫기」는 채널 화면으로 돌아간다", async () => {
  stubServer({ runs: [] });
  const { router } = renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await userEvent.click(within(aside).getByRole("link", { name: "활동 닫기" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}`));
  expect(screen.queryByTestId("page-channel-panel")).not.toBeInTheDocument();
});

it("미해결 승인이 없으면 카드도 없고, 오면 런 목록보다 위에 뜬다", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
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

// 설계 5.3 — 자리 둘(메시지 흐름·활동 탭)이 **하나의 스토어**를 본다. 다른 화면이라 중복이 아니다
it("승인 카드는 메시지 흐름과 활동 탭 양쪽에 하나씩 뜬다", async () => {
  const restoreLayout = stubScrollLayout({ width: 800, height: 600, rowHeight: 64 });
  try {
    stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
    const queryClient = createQueryClient(() => {});
    queryClient.setQueryData(qk.timeline(CH), { ...emptyTimeline(), items: [msg(1)], lastSeq: 1 });
    act(() => useApprovalStore.getState().apply(approval()));
    renderRoute(`/c/${CH}/activity`, queryClient);

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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  // 기본 선택은 가장 최근 런 — 아직 진행 중이라 기다리는 문구
  expect(await within(aside).findByText("아직 도구를 쓰지 않았습니다.")).toBeInTheDocument();
  const buttons = await within(aside).findAllByRole("button", { name: /@dev/ });
  await userEvent.click(buttons[1] as HTMLElement);
  expect(await within(aside).findByText("도구 기록이 없습니다.")).toBeInTheDocument();
});

// 이월 5 — 런을 바꾸면 타임라인을 새로 세운다(`key={runId}`). 툴 id 가 겹치면 행 key 도 같아 펼침이 따라온다
it("런을 바꾸면 앞 런에서 펼쳐 둔 인자가 따라오지 않는다", async () => {
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  const runButtons = async () => await within(aside).findAllByRole("button", { name: /@dev/ });

  // 옛 런으로 한 번 다녀와 두 이벤트 응답을 캐시에 올린다 — 되돌아올 때 「불러오는 중」으로 안 갈리게
  await userEvent.click((await runButtons())[1] as HTMLElement);
  await within(aside).findByText("Grep");
  await userEvent.click(within(aside).getByRole("button", { name: "Grep 인자 보기" }));
  expect(within(aside).getByText('{"앞":1}')).toBeInTheDocument();

  await userEvent.click((await runButtons())[0] as HTMLElement);
  await within(aside).findByText("Read");
  expect(within(aside).getByRole("button", { name: "Read 인자 보기" })).toBeInTheDocument();
  expect(within(aside).queryByText('{"뒤":2}')).not.toBeInTheDocument();
  expect(within(aside).queryByText('{"앞":1}')).not.toBeInTheDocument();
});

it("고른 런이 바뀌면 그 런의 이벤트만 그린다", async () => {
  stubServer({
    runs: [runOf(RUN2, { createdAt: "2027-01-15T08:10:00.000Z" }), runOf(RUN)],
    events: {
      [RUN]: TOOL_EVENTS,
      [RUN2]: [
        runEvent({ type: "TOOL_CALL_START", runId: RUN2, seq: 1, toolCallId: "x", toolCallName: "Bash" }),
      ],
    },
  });
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  // 기본 선택은 가장 최근 런(uuid v7 이 큰 쪽)
  expect(await within(aside).findByText("Bash")).toBeInTheDocument();
  const buttons = within(aside).getAllByRole("button", { name: /@dev/ });
  expect(buttons).toHaveLength(2);
  await userEvent.click(buttons[1] as HTMLElement);
  expect(await within(aside).findByText("Read")).toBeInTheDocument();
  expect(within(aside).queryByText("Bash")).not.toBeInTheDocument();
});

it("실시간 텍스트 델타는 타임라인 행이 되지 않는다", async () => {
  stubServer({ runs: [runOf(RUN, { status: "streaming", endedAt: undefined })], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  await userEvent.click(within(aside).getByRole("button", { name: "Read 인자 보기" }));
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("런 목록을 불러오지 못했습니다.");
  expect(toastError).not.toHaveBeenCalled();
});

it("런 목록은 한 번에 50개까지 받는다", async () => {
  const { calls } = stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
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
  const { router } = renderRoute(`/c/${CH}/activity`, queryClient);
  const aside = await panel();
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "tool" })));
  await within(aside).findByText("Read");
  expect(pickedRun(aside)).toBe(RUN2);

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

  expect(pickedRun(aside)).toBe(RUN2);
  expect(within(aside).getByText("Read")).toBeInTheDocument();
  expect(within(aside).queryByText("옛도구")).not.toBeInTheDocument();
  // 타임라인이 새로 서지 않았다 — 스크롤 위치가 끝으로 튀지 않는 까닭이다
  expect(timelineBox(aside)).toBe(before);
  await waitFor(() => expect(pickedRun(aside)).toBe(RUN2));
});

it("런이 끝나도 펼쳐 둔 인자가 접히지 않는다(D2)", async () => {
  const { aside, end } = await endingRun();
  await userEvent.click(within(aside).getByRole("button", { name: "Read 인자 보기" }));
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
  expect(pickedRun(aside)).toBe(RUN2);
  expect(within(aside).getByText("Read")).toBeInTheDocument();
});

it("아무것도 안 골랐으면 가장 최근 런을 잡는다", async () => {
  stubServer({ runs: [runOf(RUN), runOf(RUN2)], events: { [RUN]: OTHER_RUN, [RUN2]: TOOL_EVENTS } });
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();

  await within(aside).findByText("Read");
  // id 가 uuid v7 이라 문자열 순이 생성 순 — 최신이 맨 위이고 그것이 잡힌다
  expect(runIds(aside)).toEqual([RUN2, RUN]);
  expect(pickedRun(aside)).toBe(RUN2);
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

  await act(() => router.navigate({ to: "/c/$channelId/activity", params: { channelId: CH2 } }));

  const moved = await panel();
  await within(moved).findByText("저쪽도구");
  // 같은 패널이 그대로 있고(내렸다 올린 것이 아니다) 안쪽만 새 채널로 바뀌었다
  expect(moved).toBe(aside);
  expect(runIds(moved)).toEqual([OTHER_CH_RUN]);
  expect(pickedRun(moved)).toBe(OTHER_CH_RUN);
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
    renderRoute(`/c/${CH}/activity`);
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
 * 브라우저 검증 D10 — 높이 420px 창에서 카드와 런 목록이 먼저 자리를 잡아 타임라인이 54px 로 눌렸다.
 * jsdom 은 배치를 재지 않으므로 그 자리를 만드는 규칙을 잠근다(실제 높이는 브라우저에서 잰다)
 */
it("짧은 창에서는 런 목록이 먼저 줄고 타임라인은 최소 높이를 지킨다(D10)", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");

  const list = within(aside).getByRole("list", { name: "런 목록" });
  // 목록은 최대 40% 까지 쓰되, 자리가 모자라면 줄어든다 — 줄지 않으면(shrink-0) 타임라인이 대신 눌린다
  expect(list).toHaveClass("max-h-[40%]", "overflow-y-auto");
  expect(list.className.split(/\s+/)).not.toContain("shrink-0");
  expect(timelineBox(aside)).toHaveClass("min-h-32");
});

/**
 * 화면 값은 `ended` 기억만으로도 같다 — 재조회가 잠그는 것은 **캐시가 서버 사실을 쥐는 것**이다:
 * 다음 마운트(탭·채널 복귀)에서 그 런이 첫 프레임부터 보이고, 그때 조회가 실패해도 목록에 남는다.
 * 그래서 「남는가」와 함께 **호출 수**를 잰다 — 화면만 보면 재조회를 지워도 초록이라(리뷰 R10)
 */
it("끝난 런이 런 스토어에서 빠져도 목록에 남는다 — 끝날 때 REST 목록을 다시 받아 둔다", async () => {
  const { state, calls } = stubServer({ runs: [] });
  const { queryClient } = renderRoute(`/c/${CH}/activity`);
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
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("런 목록을 불러오지 못했습니다.");

  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));

  expect(await within(aside).findByRole("button", { name: /@dev/ })).toHaveTextContent("응답 중");
  // 실패 문구도 함께 남는다 — 목록이 낡았다는 사실을 감추지 않는다
  expect(within(aside).getByText("런 목록을 불러오지 못했습니다.")).toBeInTheDocument();
});
