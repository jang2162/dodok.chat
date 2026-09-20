import type { Run, RunEvent } from "@dodok/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, RUN, RUN2, runEvent, runState, textDelta, uid } from "../../../test/fixtures";
import { stubMedia } from "../../../test/media";
import { json, ME, renderRoute, shellGet } from "../../../test/shellApi";
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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
  useRunStore.getState().reset();
});

const panel = () => screen.findByTestId("page-channel-settings");

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
  expect(sheet).toHaveAttribute("data-testid", "page-channel-settings");
  expect(await within(sheet).findByRole("link", { name: "설정" })).toBeInTheDocument();

  // 설정 탭으로 — 같은 틀, 제목만 바뀐다
  await userEvent.click(within(sheet).getByRole("link", { name: "설정" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}/settings`));
  expect(await screen.findByRole("dialog", { name: "채널 설정" })).toHaveAttribute(
    "data-testid",
    "page-channel-settings",
  );

  media.setNarrow(false);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(await screen.findByTestId("page-channel-settings")).toHaveAttribute("data-panel-tab", "settings");
});

it("「활동 닫기」는 채널 화면으로 돌아간다", async () => {
  stubServer({ runs: [] });
  const { router } = renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await userEvent.click(within(aside).getByRole("link", { name: "활동 닫기" }));
  await waitFor(() => expect(router.state.location.pathname).toBe(`/c/${CH}`));
  expect(screen.queryByTestId("page-channel-settings")).not.toBeInTheDocument();
});

it("승인 카드 자리는 태스크 8 을 위해 패널 위쪽에 비워 둔다", async () => {
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  const slot = await waitFor(() => {
    const el = aside.querySelector('[data-slot="approval-card"]');
    if (!el) throw new Error("승인 카드 자리가 없다");
    return el;
  });
  expect(slot).toBeEmptyDOMElement();
  // 목록보다 위에 있다
  expect(slot.compareDocumentPosition(within(aside).getByRole("list", { name: "런 목록" }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
});

it("승인·오류·단계 행도 타임라인에 그려진다", async () => {
  const approvalId = uid(301);
  stubServer({
    runs: [runOf(RUN, { status: "error" })],
    events: [
      runEvent({ type: "STEP_STARTED", seq: 1, stepName: "계획" }),
      runEvent({ type: "TOOL_CALL_START", seq: 2, toolCallId: "t1", toolCallName: "Write" }),
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
  expect(row).toHaveTextContent("Write"); // 툴 행과 이어졌다
  expect(within(aside).getByText("계획")).toBeInTheDocument();
  expect(within(aside).getByText("도구가 실패했습니다")).toBeInTheDocument();
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
  stubServer({ runs: [runOf(RUN)], events: TOOL_EVENTS });
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("Read");
  await userEvent.click(within(aside).getByRole("button", { name: "Read 인자 보기" }));
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

it("끝난 런이 런 스토어에서 빠져도 목록에 남는다", async () => {
  const { state } = stubServer({ runs: [] });
  renderRoute(`/c/${CH}/activity`);
  const aside = await panel();
  await within(aside).findByText("아직 실행 기록이 없습니다.");

  // 실시간으로 시작한 런이 끝나면 REST 목록을 다시 받아 둔다(스토어는 곧 그 런을 지운다)
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "streaming" })));
  await within(aside).findByRole("button", { name: /@dev/ });
  state.runs = [runOf(RUN2, { status: "done" })];
  act(() => useRunStore.getState().applyState(runState({ id: RUN2, status: "done" })));
  await waitFor(() => expect(within(aside).getByRole("button", { name: /@dev/ })).toHaveTextContent("완료"));

  act(() => useRunStore.getState().remove(RUN2));
  expect(await within(aside).findByRole("button", { name: /@dev/ })).toHaveTextContent("완료");
});
