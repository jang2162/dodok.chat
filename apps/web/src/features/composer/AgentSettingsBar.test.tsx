import type {
  Agent,
  ChannelMember,
  ConversationAgentSettings,
  Message,
  Result,
  RunnerModelOption,
  RunnerPermissionMode,
} from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { invitedAgentKeys } from "@/features/conversations/invitedAgents";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, msg, uid, USER } from "../../../test/fixtures";
import { doc, flushEditorFrames, mention, p, setDoc, t } from "../../../test/composerHarness";
import { stubMedia } from "../../../test/media";
import { runnerId } from "../../../test/runnersServer";
import { Composer } from "./Composer";
import { openAgentSettings } from "./insertMention";
import { ABOVE_CEILING, EFFORT_DEFAULT_LABEL, EFFORT_UNSUPPORTED, RAISE_LOCKED } from "./AgentSettingChips";
import { PANEL_COLUMNS, panelTitle, SHEET_COLUMNS, settingsLabel } from "./AgentPills";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const W = uid(900);
const TS = "2026-11-11T00:00:00.000Z";
const CONV = uid(500);
const ROOT = uid(501);

function runnerAgent(n: number, handle: string, defaults: Partial<Agent["sessionDefaults"]> = {}): Agent {
  return {
    id: uid(600 + n),
    workspaceId: W,
    provider: "runner",
    providerAgentId: `r-000000000${n}`,
    handle,
    name: handle,
    enabled: true,
    createdAt: TS,
    archivedAt: null,
    dmAccess: "admins",
    program: "claude",
    createdBy: null,
    runTimeoutMinutes: null,
    runner: { tokenId: runnerId(1), label: "맥북", revoked: false },
    sessionDefaults: { model: null, effort: null, permissionMode: null, ...defaults },
  };
}
const OPENCLAW: Agent = {
  id: uid(700),
  workspaceId: W,
  provider: "openclaw",
  providerAgentId: "dev",
  handle: "dev",
  name: "dev",
  enabled: true,
  createdAt: TS,
  archivedAt: null,
  dmAccess: "admins",
  program: null,
  createdBy: null,
  runTimeoutMinutes: null,
};
const CODER = runnerAgent(1, "coder", { model: "sonnet" });
/**
 * 러너가 알린 모델 목록 — default 줄은 「기본」에 합친다(efforts 를 다섯이 아닌 둘로 — 「기본」이 이 줄을 보는지 가른다, C9),
 * Sonnet 은 effort 셋, Haiku 는 effort 를 안 받는다(빈 목록)
 */
const MODELS: RunnerModelOption[] = [
  { value: "default", displayName: "Default (recommended)", efforts: ["low", "high"] },
  { value: "opus", displayName: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
  { value: "haiku", displayName: "Haiku 5.5", efforts: [] },
];
const REVIEWER = runnerAgent(2, "reviewer");
const TESTER = runnerAgent(3, "tester");
const DOCS = runnerAgent(4, "docs");

const memberOf = (memberId: string): ChannelMember => ({
  id: `m-${memberId}`,
  channelId: CH,
  memberType: "agent",
  memberId,
  autoRespond: false,
  aliases: [],
  joinedAt: TS,
});
const row = (agent: Agent, over: Partial<ConversationAgentSettings> = {}): ConversationAgentSettings => ({
  agentId: agent.id,
  model: null,
  effort: null,
  permissionMode: null,
  contextPercent: null,
  ceiling: null,
  context: null,
  models: [],
  ...over,
});

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let fake: FakeSocket;
let restoreDom: () => void;

/**
 * 가짜 REST — 세션 설정·채널의 권한 상한. 상한(`ceiling`, 기본 acceptEdits)은 서버가 대화 줄과 `agent-ceilings` 에 싣는다 — 줄에
 * 따로 준 값이 우선. `GET /runners` 는 주지 않는다(member 는 남의 러너를 못 받는다 — 화면은 그것에 기대지 않는다). PATCH 는 보낸
 * 칸을 얹은 줄을 돌려준다
 */
function serve(opts: {
  settings?: Record<string, ConversationAgentSettings[]>;
  ceiling?: RunnerPermissionMode;
  patchFails?: { status: number; code: string };
  /** 채널의 agent-ceilings 가 싣는 모델 목록(새 세션 창) */
  models?: RunnerModelOption[];
}) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });
      const ceiling = opts.ceiling ?? "acceptEdits";
      const settings = url.match(/\/conversations\/([^/?]+)\/agent-settings(\?threadRootId=(.+))?$/);
      if (method === "GET" && settings) {
        const key = settings[3] ? `${settings[1]}:${settings[3]}` : (settings[1] ?? "");
        const rows = (opts.settings?.[key] ?? []).map((r) => ({ ...r, ceiling: r.ceiling ?? ceiling }));
        return json(200, { settings: rows });
      }
      if (method === "GET" && url.endsWith(`/channels/${CH}/agent-ceilings`))
        return json(200, {
          ceilings: [CODER, REVIEWER].map((a) => ({ agentId: a.id, ceiling, models: opts.models ?? [] })),
        });
      const patch = url.match(/\/conversations\/([^/]+)\/agent-settings\/([^/]+)$/);
      if (method === "PATCH" && patch) {
        if (opts.patchFails)
          return json(opts.patchFails.status, { code: opts.patchFails.code, message: "거절" });
        const before = opts.settings?.[patch[1] ?? ""]?.find((r) => r.agentId === patch[2]);
        return json(200, { ...before, agentId: patch[2], ...body });
      }
      return json(404, { code: "NOT_FOUND", message: "없음" });
    }),
  );
}

function renderAt(
  conversationId: string,
  opts: { agents?: Agent[]; role?: string; threadRootId?: string } = {},
) {
  const agents = opts.agents ?? [CODER, REVIEWER, OPENCLAW];
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.me, {
    user: { id: USER, handle: "mia", displayName: "미아" },
    workspaceId: W,
    role: opts.role ?? "member",
  });
  qc.setQueryData(qk.people, [{ id: USER, handle: "mia", displayName: "미아", role: opts.role ?? "member" }]);
  qc.setQueryData(qk.agents, agents);
  qc.setQueryData(
    qk.members(CH),
    agents.map((a) => memberOf(a.id)),
  );
  // 그 세션에 초대한 에이전트 없음 — 초대를 보는 시험은 따로 넣는다(세션 에이전트 초대 스펙 5.4)
  qc.setQueryData(invitedAgentKeys.of(conversationId), []);
  const ui = (conv: string) => (
    <QueryClientProvider client={qc}>
      <Composer
        channelId={CH}
        conversationId={conv}
        {...(opts.threadRootId === undefined ? {} : { threadRootId: opts.threadRootId })}
      />
    </QueryClientProvider>
  );
  const view = render(ui(conversationId));
  return { qc, rerender: (conv: string) => view.rerender(ui(conv)) };
}

const bar = () => screen.getByTestId("agent-settings-bar");
const lineOf = (handle: string) => screen.getByTestId(`agent-settings-${handle}`);
type ChipKind = "모델" | "노력치" | "권한";
const chip = (handle: string, kind: ChipKind) =>
  within(lineOf(handle)).getByRole("button", { name: new RegExp(`^@${handle} ${kind}:`) });
/** 칩 메뉴는 트리거에 초점을 준 뒤 Enter 로 연다 — jsdom 의 window blur 가 Radix 메뉴를 닫는다(invitedAgents.test 와 같은 까닭) */
async function openChip(handle: string, kind: ChipKind) {
  const user = userEvent.setup();
  const trigger = await waitFor(() => chip(handle, kind));
  act(() => trigger.focus());
  await user.keyboard("{Enter}");
  // 메뉴 이름은 트리거(aria-labelledby)에서 온다 — 「@coder 모델: Sonnet 5.5」
  const menu = await screen.findByRole("menu", { name: new RegExp(`^@${handle} ${kind}:`) });
  return { user, menu };
}
const optionsOf = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole("menuitemradio")
    .map((o) => ({
      name: o.textContent,
      disabled: o.getAttribute("aria-disabled") === "true" || o.hasAttribute("data-disabled"),
      checked: o.getAttribute("aria-checked") === "true",
    }));
const names = (menu: HTMLElement) => optionsOf(menu).map((o) => o.name);
async function pick(handle: string, kind: ChipKind, name: string) {
  const { user, menu } = await openChip(handle, kind);
  await user.click(within(menu).getByRole("menuitemradio", { name }));
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}
const patches = () => calls.filter((c) => c.method === "PATCH");
/** 도구 줄의 주의 알약(70% 이상·초안의 멘션) — 「⚙ 에이전트 N」 단추는 빼고 */
const pills = () =>
  within(bar())
    .queryAllByRole("button", { name: /설정 — / })
    .map((b) => b.getAttribute("data-testid"));
/** 알약(이름을 안 주면 맨 앞의 「⚙ 에이전트 N」)을 눌러 설정 패널을 연다 */
async function openPanel(name?: RegExp) {
  const button = await waitFor(() =>
    name ? within(bar()).getByRole("button", { name }) : within(bar()).getAllByRole("button")[0]!,
  );
  await userEvent.click(button);
  return screen.findByRole("dialog");
}

beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
});
afterEach(async () => {
  await flushEditorFrames();
  restoreDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

describe("에이전트 칩 — 세션에 초대한 러너 에이전트 [세션 에이전트 초대 스펙 5.4]", () => {
  it("그 세션에 초대한 러너 에이전트도 한 줄 — 핸들 옆 「초대됨」, 다른 세션에는 줄이 없다", async () => {
    const GUEST = runnerAgent(3, "guest");
    const OTHER = uid(502);
    serve({ settings: { [CONV]: [row(CODER), row(GUEST, { model: "opus" })], [OTHER]: [row(CODER)] } });
    const { qc, rerender } = renderAt(CONV, { agents: [CODER, OPENCLAW] });
    await act(async () => {
      qc.setQueryData(qk.agents, [CODER, OPENCLAW, GUEST]);
      qc.setQueryData(invitedAgentKeys.of(CONV), [{ agentId: GUEST.id, invitedBy: USER, invitedAt: TS }]);
      qc.setQueryData(invitedAgentKeys.of(OTHER), []);
    });
    await openPanel(new RegExp(`^${settingsLabel(2)}$`));
    await waitFor(() => expect(chip("guest", "모델")).toHaveTextContent("opus"));
    expect(within(lineOf("guest")).getByText("초대됨")).toBeInTheDocument();
    expect(within(lineOf("coder")).queryByText("초대됨")).toBeNull();
    rerender(OTHER);
    await waitFor(() => expect(lineOf("coder")).toBeInTheDocument());
    expect(within(bar()).queryByText("@guest")).toBeNull();
  });
});

describe("에이전트 칩 — 칩·게이지 [세션 설정 스펙 S3 · 작성기 칩 스펙 5.4]", () => {
  it("러너 에이전트마다 한 줄 — 칩 셋·「기본」·게이지 %·「—」, OpenClaw agents get no chips", async () => {
    serve({
      settings: {
        [CONV]: [
          row(CODER, { model: "opus", effort: "high", permissionMode: "default", contextPercent: 42 }),
          row(REVIEWER),
        ],
      },
    });
    renderAt(CONV);
    await openPanel();
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("opus"));
    expect(chip("coder", "노력치")).toHaveTextContent("높음");
    expect(chip("coder", "권한")).toHaveTextContent("default");
    expect(within(lineOf("coder")).getByRole("button", { name: "컨텍스트 42%" })).toBeInTheDocument();
    expect(chip("reviewer", "모델")).toHaveTextContent("모델 기본");
    expect(chip("reviewer", "노력치")).toHaveTextContent("노력 기본");
    expect(chip("reviewer", "권한")).toHaveTextContent("권한 기본");
    expect(within(lineOf("reviewer")).getByRole("button", { name: "컨텍스트 —" })).toBeInTheDocument();
    expect(screen.queryByText("@dev")).toBeNull();
    expect(screen.queryByTestId("agent-settings-dev")).toBeNull();
    expect(screen.queryByTestId("agent-pill-dev")).toBeNull();
  });

  it("러너 에이전트가 없으면 그리지도 묻지도 않는다", () => {
    serve({});
    renderAt(CONV, { agents: [OPENCLAW] });
    expect(screen.queryByTestId("agent-settings-bar")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("도구 줄 — 1명 [작성기 도구 줄 스펙 T1·T2]", () => {
  it("1명이면 칩 셋을 도구 줄에 펼치고 게이지는 「컨텍스트 —」", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER, OPENCLAW] });
    const line = await waitFor(() =>
      within(screen.getByTestId("composer-toolbar")).getByTestId("agent-settings-coder"),
    );
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("모델 기본"));
    expect(within(line).getByRole("button", { name: "컨텍스트 —" }).textContent).toBe("컨텍스트 —");
  });
});

describe("알약·설정 패널 — 2명 이상 [작성기 도구 줄 스펙 T3·T4·T6]", () => {
  const editorOf = () =>
    (screen.getByRole("textbox", { name: "메시지 입력" }) as unknown as { editor: Editor }).editor;
  const linesIn = (dialog: HTMLElement) =>
    Array.from(dialog.querySelectorAll("[data-testid^='agent-settings-']")).map((el) =>
      el.getAttribute("data-testid"),
    );

  it("2명 — 맨 앞 「⚙ 에이전트 2」, 알약은 70% 이상만 · 알약을 누르면 그 줄로, 단추면 첫 줄로 초점 [UI 시안 01]", async () => {
    serve({
      settings: {
        [CONV]: [
          row(CODER, { model: "opus", contextPercent: 31 }),
          row(REVIEWER, { models: MODELS, contextPercent: 75 }),
        ],
      },
    });
    renderAt(CONV);
    const settings = await screen.findByRole("button", { name: settingsLabel(2) });
    expect(settings).toHaveTextContent("에이전트 2");
    expect(settings).toHaveAttribute("aria-haspopup", "dialog");
    expect(within(bar()).getAllByRole("button")[0]).toBe(settings);
    const reviewer = await screen.findByRole("button", { name: "@reviewer 설정 — 모델 기본, 컨텍스트 75%" });
    expect(reviewer).toHaveTextContent("@reviewer기본75%");
    // 31% 는 주의 구간 밖 — 알약이 없다
    expect(pills()).toEqual(["agent-pill-reviewer"]);
    // 칩은 패널을 열기 전에는 없다
    expect(screen.queryByTestId("agent-settings-coder")).toBeNull();
    const dialog = await openPanel(/^@reviewer 설정/);
    expect(dialog).toHaveAccessibleName(panelTitle(2));
    expect(dialog).toHaveTextContent("바꾸면 이 세션에 바로 저장됩니다");
    // 줄 순서는 T4 — 70% 이상(reviewer)이 앞
    expect(linesIn(dialog)).toEqual(["agent-settings-reviewer", "agent-settings-coder"]);
    expect(reviewer).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(chip("reviewer", "모델")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await userEvent.click(settings);
    await screen.findByRole("dialog", { name: panelTitle(2) });
    expect(settings).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(chip("reviewer", "모델")).toHaveFocus());
  });

  it("8명이어도 「+N」 없이 「⚙ 에이전트 8」 — 패널에 전원, 5명 이상이면 검색 칸(핸들·이름) [UI 시안 01]", async () => {
    const eight = [CODER, REVIEWER, TESTER, DOCS, ...[5, 6, 7, 8].map((n) => runnerAgent(n, `bot${n}`))];
    serve({
      settings: {
        [CONV]: eight.map((a) => row(a, a === TESTER ? { contextPercent: 72 } : {})),
      },
    });
    renderAt(CONV, { agents: eight });
    const settings = await screen.findByRole("button", { name: settingsLabel(8) });
    await waitFor(() => expect(pills()).toEqual(["agent-pill-tester"]));
    expect(screen.queryByTestId("agent-pill-more")).toBeNull();
    expect(within(bar()).queryByText(/^\+\d/)).toBeNull();
    await userEvent.click(settings);
    const dialog = await screen.findByRole("dialog", { name: panelTitle(8) });
    expect(linesIn(dialog)).toEqual([
      "agent-settings-tester",
      "agent-settings-coder",
      "agent-settings-reviewer",
      "agent-settings-docs",
      "agent-settings-bot5",
      "agent-settings-bot6",
      "agent-settings-bot7",
      "agent-settings-bot8",
    ]);
    await waitFor(() => expect(chip("tester", "모델")).toHaveFocus());
    const search = within(dialog).getByRole("searchbox", { name: "에이전트 찾기" });
    await userEvent.type(search, "BOT");
    expect(linesIn(dialog)).toEqual([
      "agent-settings-bot5",
      "agent-settings-bot6",
      "agent-settings-bot7",
      "agent-settings-bot8",
    ]);
    await userEvent.clear(search);
    await userEvent.type(search, "없는");
    expect(linesIn(dialog)).toEqual([]);
    expect(dialog).toHaveTextContent("맞는 에이전트가 없습니다");
  });

  it("4명이면 검색 칸이 없다", async () => {
    const four = [CODER, REVIEWER, TESTER, DOCS];
    serve({ settings: { [CONV]: four.map((a) => row(a)) } });
    renderAt(CONV, { agents: four });
    const dialog = await openPanel();
    expect(within(dialog).queryByRole("searchbox")).toBeNull();
  });

  it("mention highlights without reordering", async () => {
    const four = [CODER, REVIEWER, TESTER, DOCS];
    serve({ settings: { [CONV]: four.map((a) => row(a)) } });
    renderAt(CONV, { agents: four });
    await screen.findByRole("button", { name: settingsLabel(4) });
    // 주의할 것이 없으면 알약도 없다
    expect(pills()).toEqual([]);
    setDoc(editorOf(), doc(p(mention(`a:${REVIEWER.id}`, "reviewer"), t(" 봐 줘"))));
    await waitFor(() =>
      expect(screen.getByTestId("agent-pill-reviewer")).toHaveAccessibleName(
        "@reviewer 설정 — 모델 기본, 컨텍스트 — — 이 글에서 부름",
      ),
    );
    expect(pills()).toEqual(["agent-pill-reviewer"]);
    // 멘션한 순서(docs → coder)가 아니라 받은 순서(coder → docs)
    setDoc(editorOf(), doc(p(mention(`a:${DOCS.id}`, "docs"), mention(`a:${CODER.id}`, "coder"))));
    await waitFor(() => expect(pills()).toEqual(["agent-pill-coder", "agent-pill-docs"]));
    expect(screen.getByTestId("agent-pill-docs")).toHaveAccessibleName(/이 글에서 부름$/);
    // 멘션을 지우면 알약도 사라진다
    setDoc(editorOf(), doc(p(t("멘션 없음"))));
    await waitFor(() => expect(pills()).toEqual([]));
    expect(screen.getByRole("button", { name: settingsLabel(4) })).toBeInTheDocument();
  });

  it("panel stays open while picking a chip", async () => {
    serve({ settings: { [CONV]: [row(CODER), row(REVIEWER)] } });
    renderAt(CONV);
    await openPanel();
    await pick("reviewer", "모델", "opus");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(patches().map((c) => [c.url, c.body])).toEqual([
      [`/api/v1/conversations/${CONV}/agent-settings/${REVIEWER.id}`, { model: "opus" }],
    ]);
    await waitFor(() => expect(chip("reviewer", "모델")).toHaveTextContent("모델 opus"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("new-session pending via panel", async () => {
    serve({});
    fake.onAck("message.send", (payload) => {
      const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
      return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd, conversationId: CONV }) } };
    });
    renderAt(NEW_CONVERSATION, { agents: [CODER, REVIEWER] });
    const dialog = await openPanel();
    expect(dialog).toHaveTextContent("첫 메시지와 함께 저장됩니다");
    await pick("reviewer", "노력치", "낮음");
    await waitFor(() => expect(chip("reviewer", "노력치")).toHaveTextContent("노력 낮음"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const box = screen.getByRole("textbox", { name: "메시지 입력" });
    setDoc(editorOf(), doc(p(t("시작"))));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fake.sentOf("message.send")).toHaveLength(1));
    expect(fake.sentOf("message.send")[0]).toMatchObject({
      newConversation: {},
      agentSettings: [{ agentId: REVIEWER.id, effort: "low" }],
    });
    expect(patches()).toEqual([]);
  });

  it("바깥(참여자 목록의 ⚙)이 openAgentSettings 로 부르면 패널이 그 에이전트 줄에 초점을 두고 열린다 [UI 시안 03]", async () => {
    const four = [CODER, REVIEWER, TESTER, DOCS];
    serve({ settings: { [CONV]: four.map((a) => row(a)) } });
    renderAt(CONV, { agents: four });
    await screen.findByRole("button", { name: settingsLabel(4) });
    // 다른 세션의 작성기는 듣지 않는다
    expect(openAgentSettings({ channelId: CH, conversationId: uid(509) }, DOCS.id)).toBe(false);
    let handled = false;
    act(() => {
      handled = openAgentSettings({ channelId: CH, conversationId: CONV }, DOCS.id);
    });
    expect(handled).toBe(true);
    await screen.findByRole("dialog", { name: panelTitle(4) });
    await waitFor(() => expect(chip("docs", "모델")).toHaveFocus());
  });

  it("1명이면 openAgentSettings 가 펼친 칩의 첫 칩으로 초점만 옮긴다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER, OPENCLAW] });
    await waitFor(() => expect(chip("coder", "모델")).toBeInTheDocument());
    act(() => {
      openAgentSettings({ channelId: CH, conversationId: CONV }, CODER.id);
    });
    expect(chip("coder", "모델")).toHaveFocus();
  });

  it("panel closes when agents drop to one", async () => {
    serve({ settings: { [CONV]: [row(CODER), row(REVIEWER)] } });
    const { qc } = renderAt(CONV);
    await openPanel();
    act(() => qc.setQueryData(qk.members(CH), [memberOf(CODER.id), memberOf(OPENCLAW.id)]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      within(screen.getByTestId("composer-toolbar")).getByTestId("agent-settings-coder"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("agent-pill-coder")).toBeNull();
  });

  it("escape returns focus", async () => {
    serve({ settings: { [CONV]: [row(CODER), row(REVIEWER)] } });
    renderAt(CONV);
    await openPanel();
    await waitFor(() => expect(chip("coder", "모델")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("agent-pill-summary")).toHaveFocus();
    expect(screen.getByTestId("agent-pill-summary")).toHaveAttribute("aria-expanded", "false");
  });
});

describe("모은 알약 — 좁은 화면·스레드 작성기 [작성기 도구 줄 스펙 T5]", () => {
  const three = [CODER, REVIEWER, TESTER];
  const rows = () => [row(CODER, { contextPercent: 10 }), row(REVIEWER, { contextPercent: 72 }), row(TESTER)];
  const summary = () => screen.getByTestId("agent-pill-summary");

  it("좁은 화면 3명 — 모은 알약 하나, 가장 높은 %, 누르면 아래 시트에 줄 셋", async () => {
    stubMedia(true);
    serve({ settings: { [CONV]: rows() } });
    renderAt(CONV, { agents: three });
    await waitFor(() => expect(summary()).toHaveTextContent("72%"));
    expect(summary()).toHaveTextContent("에이전트 3");
    expect(summary()).toHaveAccessibleName(settingsLabel(3));
    expect(summary()).toHaveAttribute("aria-haspopup", "dialog");
    expect(screen.queryByTestId("agent-pill-coder")).toBeNull();
    await userEvent.click(summary());
    const dialog = await screen.findByRole("dialog", { name: panelTitle(3) });
    expect(dialog).toHaveAttribute("data-slot", "sheet-content");
    expect(summary()).toHaveAttribute("aria-expanded", "true");
    // 줄 순서도 T4 — 70% 이상(reviewer)이 앞
    expect(
      Array.from(dialog.querySelectorAll("[data-testid^='agent-settings-']")).map((el) =>
        el.getAttribute("data-testid"),
      ),
    ).toEqual(["agent-settings-reviewer", "agent-settings-coder", "agent-settings-tester"]);
    await waitFor(() => expect(chip("reviewer", "모델")).toHaveFocus());
  });

  it("좁은 화면 — 70% 이상이어도 알약 없이 단추 하나 [UI 시안 01]", async () => {
    stubMedia(true);
    serve({ settings: { [CONV]: rows() } });
    renderAt(CONV, { agents: three });
    await waitFor(() => expect(summary()).toHaveTextContent("72%"));
    expect(within(bar()).getAllByRole("button")).toEqual([summary()]);
    expect(screen.queryByTestId("agent-pill-reviewer")).toBeNull();
  });

  it("넓은 화면의 스레드 작성기도 모은 알약 — 시트가 아니라 패널", async () => {
    serve({ settings: { [CONV]: rows(), [`${CONV}:${ROOT}`]: rows() } });
    renderAt(CONV, { agents: three, threadRootId: ROOT });
    await waitFor(() => expect(summary()).toHaveTextContent("72%"));
    await userEvent.click(summary());
    const dialog = await screen.findByRole("dialog", { name: panelTitle(3) });
    expect(dialog).toHaveAttribute("data-slot", "popover-content");
  });

  it("좁은 화면 1명은 펼친 칩 그대로", async () => {
    stubMedia(true);
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER, OPENCLAW] });
    await waitFor(() =>
      expect(
        within(screen.getByTestId("composer-toolbar")).getByTestId("agent-settings-coder"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("agent-pill-summary")).toBeNull();
  });

  it("모은 알약도 멘션하면 이름에 「이 글에서 부름」", async () => {
    stubMedia(true);
    serve({ settings: { [CONV]: rows() } });
    renderAt(CONV, { agents: three });
    await waitFor(() => expect(summary()).toHaveAccessibleName(settingsLabel(3)));
    const editor = (screen.getByRole("textbox", { name: "메시지 입력" }) as unknown as { editor: Editor })
      .editor;
    setDoc(editor, doc(p(mention(`a:${TESTER.id}`, "tester"))));
    await waitFor(() => expect(summary()).toHaveAccessibleName(`${settingsLabel(3)} — 이 글에서 부름`));
  });

  it("escape returns focus — 시트", async () => {
    stubMedia(true);
    serve({ settings: { [CONV]: rows() } });
    renderAt(CONV, { agents: three });
    await userEvent.click(await waitFor(() => summary()));
    await screen.findByRole("dialog", { name: panelTitle(3) });
    await waitFor(() => expect(chip("reviewer", "모델")).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(summary()).toHaveFocus();
  });
});

describe("모델 칩 [작성기 칩 스펙 C3·C4·C9]", () => {
  it("picking a model chip saves immediately (PATCH model)", async () => {
    serve({ settings: { [CONV]: [row(CODER, { models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("모델 기본"));
    await pick("coder", "모델", "Opus 5.5");
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("Opus 5.5"));
    expect(patches()).toEqual([
      {
        method: "PATCH",
        url: `/api/v1/conversations/${CONV}/agent-settings/${CODER.id}`,
        body: { model: "opus" },
      },
    ]);
  });

  it("default row merges into 기본 — 표시 이름 목록", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "sonnet", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("Sonnet 5.5"));
    const { menu } = await openChip("coder", "모델");
    expect(names(menu)).toEqual(["기본", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    expect(optionsOf(menu).find((o) => o.checked)?.name).toBe("Sonnet 5.5");
    expect(within(menu).queryByText("Default (recommended)")).toBeNull();
  });

  it("models [] falls back to sonnet/opus/haiku + 직접 입력", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER] });
    const { user, menu } = await openChip("coder", "모델");
    expect(names(menu)).toEqual(["기본", "sonnet", "opus", "haiku"]);
    await user.click(within(menu).getByRole("menuitem", { name: "직접 입력" }));
    const input = await screen.findByRole("textbox", { name: "모델 이름" });
    await user.type(input, "claude-sonnet-5-5");
    await user.click(within(lineOf("coder")).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "모델 이름" })).toBeNull());
    expect(patches().map((c) => c.body)).toEqual([{ model: "claude-sonnet-5-5" }]);
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("claude-sonnet-5-5"));
  });

  it("saved model not in list stays shown at top — 말없이 바뀌지 않는다", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "claude-custom-1", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("claude-custom-1"));
    const { menu } = await openChip("coder", "모델");
    expect(optionsOf(menu)[0]).toEqual({ name: "claude-custom-1", disabled: false, checked: true });
    expect(names(menu).slice(1)).toEqual(["기본", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
    expect(patches()).toEqual([]);
  });

  it("러너가 끊겨 목록이 비면(models []) 저장된 값은 그대로, 고정 목록으로 고를 수 있다", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "opus" })] } });
    renderAt(CONV, { agents: [CODER] });
    await pick("coder", "모델", "haiku");
    expect(patches().map((c) => c.body)).toEqual([{ model: "haiku" }]);
  });
});

describe("노력치 칩 [작성기 칩 스펙 5.4]", () => {
  it("effort chip lists only the model's efforts — 「기본」이면 default 줄의 것, 목록 없으면 다섯", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "sonnet", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    let { menu } = await openChip("coder", "노력치");
    expect(names(menu)).toEqual([EFFORT_DEFAULT_LABEL, "낮음", "보통", "높음"]);
    await userEvent.keyboard("{Escape}");
    cleanup();
    // 「기본」 — default 줄의 둘만(대체값 다섯이 아니다 — C9)
    serve({ settings: { [CONV]: [row(CODER, { models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    ({ menu } = await openChip("coder", "노력치"));
    expect(names(menu)).toEqual([EFFORT_DEFAULT_LABEL, "낮음", "높음"]);
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER, { model: "sonnet" })] } });
    renderAt(CONV, { agents: [CODER] });
    ({ menu } = await openChip("coder", "노력치"));
    expect(names(menu)).toEqual([EFFORT_DEFAULT_LABEL, "낮음", "보통", "높음", "매우 높음", "최대"]);
  });

  it("노력치를 안 받는 모델(빈 efforts)은 「기본」만 — 저장된 값은 범위 밖 경고", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "haiku", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    let { menu } = await openChip("coder", "노력치");
    expect(names(menu)).toEqual([EFFORT_DEFAULT_LABEL]);
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER, { model: "haiku", effort: "high", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "노력치")).toHaveAttribute("aria-invalid", "true"));
    ({ menu } = await openChip("coder", "노력치"));
    expect(optionsOf(menu)).toEqual([
      { name: EFFORT_DEFAULT_LABEL, disabled: false, checked: false },
      { name: `높음 — ${EFFORT_UNSUPPORTED}`, disabled: true, checked: true },
    ]);
    expect(patches()).toEqual([]);
  });

  it("고르면 바로 저장 — PATCH effort", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "sonnet", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await pick("coder", "노력치", "높음");
    expect(patches().map((c) => c.body)).toEqual([{ effort: "high" }]);
    await waitFor(() => expect(chip("coder", "노력치")).toHaveTextContent("높음"));
  });

  it("out-of-list effort shows warning and is not changed", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "sonnet", effort: "max", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "노력치")).toHaveAttribute("aria-invalid", "true"));
    expect(chip("coder", "노력치")).toHaveTextContent("최대");
    expect(chip("coder", "노력치")).toHaveAccessibleName(`@coder 노력치: 최대 — ${EFFORT_UNSUPPORTED}`);
    const { menu } = await openChip("coder", "노력치");
    expect(optionsOf(menu).at(-1)).toEqual({
      name: `최대 — ${EFFORT_UNSUPPORTED}`,
      disabled: true,
      checked: true,
    });
    expect(patches()).toEqual([]);
  });
});

describe("권한 칩 [S2]", () => {
  it("acceptEdits locked for member (RAISE_LOCKED) — default 이하·「기본」은 고른다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER] });
    const { menu } = await openChip("coder", "권한");
    expect(optionsOf(menu).map((o) => [o.name, o.disabled])).toEqual([
      ["기본 · default", false],
      ["plan", false],
      ["dontAsk", false],
      ["default", false],
      ["acceptEdits", true],
      ["auto — 승인 카드 없이 실행됩니다", true],
      ["bypassPermissions — 승인 카드 없이 실행됩니다", true],
    ]);
    expect(menu).toHaveTextContent(RAISE_LOCKED);
  });

  it("상한이 열린 러너(bypassPermissions) — member 는 auto·bypassPermissions 도 RAISE_LOCKED, admin 은 고른다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "bypassPermissions" });
    renderAt(CONV, { agents: [CODER] });
    let { menu } = await openChip("coder", "권한");
    expect(optionsOf(menu).slice(-2)).toMatchObject([{ disabled: true }, { disabled: true }]);
    expect(menu).toHaveTextContent(RAISE_LOCKED);
    expect(menu).not.toHaveTextContent("러너 상한");
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "bypassPermissions" });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    ({ menu } = await openChip("coder", "권한"));
    expect(optionsOf(menu).every((o) => !o.disabled)).toBe(true);
    const auto = within(menu)
      .getAllByRole("menuitemradio")
      .find((o) => o.textContent === "auto — 승인 카드 없이 실행됩니다");
    if (!auto) throw new Error("auto 선택지가 없다");
    await userEvent.click(auto);
    await waitFor(() => expect(patches().map((c) => c.body)).toEqual([{ permissionMode: "auto" }]));
  });

  it.each(["auto", "bypassPermissions"] as const)(
    "고른 값이 %s 면 칩에 경고색과 접근 이름의 「승인 카드 없이 실행됩니다」",
    async (permissionMode) => {
      serve({
        settings: { [CONV]: [row(CODER, { permissionMode }), row(REVIEWER)] },
        ceiling: "bypassPermissions",
      });
      renderAt(CONV, { agents: [CODER, REVIEWER] });
      await openPanel();
      const picked = await waitFor(() => chip("coder", "권한"));
      expect(picked).toHaveAccessibleName(`@coder 권한: ${permissionMode} — 승인 카드 없이 실행됩니다`);
      expect(picked.className).toContain("text-destructive");
      expect(chip("reviewer", "권한")).toHaveAccessibleName("@reviewer 권한: 기본 · default");
      expect(chip("reviewer", "권한").className).not.toContain("text-destructive");
    },
  );

  it("admin 은 acceptEdits 를 고른다 — 러너 상한(default) 위는 admin 도 막히고 그 사유", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    let { menu } = await openChip("coder", "권한");
    expect(optionsOf(menu).find((o) => o.name === "acceptEdits")).toMatchObject({ disabled: false });
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "default" });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    ({ menu } = await openChip("coder", "권한"));
    await waitFor(() =>
      expect(optionsOf(menu).find((o) => o.name === "acceptEdits")).toMatchObject({ disabled: true }),
    );
    expect(menu).toHaveTextContent(ABOVE_CEILING("default"));
  });

  it("member 도 남의 러너 상한(plan) 위는 막힌다 — 상한은 서버가 줄에 싣는다 [리뷰 건 1]", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "plan" });
    renderAt(CONV, { agents: [CODER] });
    const { menu } = await openChip("coder", "권한");
    await waitFor(() =>
      expect(optionsOf(menu).map((o) => o.disabled)).toEqual([false, false, true, true, true, true, true]),
    );
    expect(calls.some((c) => c.url.endsWith("/runners"))).toBe(false);
  });

  it("서버가 403 이면 칩 옆에 사유", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, patchFails: { status: 403, code: "FORBIDDEN" } });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    await pick("coder", "권한", "plan");
    await waitFor(() => expect(within(lineOf("coder")).getByRole("alert")).toHaveTextContent(RAISE_LOCKED));
    expect(chip("coder", "권한")).toHaveTextContent("권한 기본");
  });

  it("save failure shows 저장하지 못했습니다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, patchFails: { status: 500, code: "INTERNAL" } });
    renderAt(CONV, { agents: [CODER] });
    await pick("coder", "노력치", "낮음");
    await waitFor(() =>
      expect(within(lineOf("coder")).getByRole("alert")).toHaveTextContent("저장하지 못했습니다"),
    );
  });
});

describe("새 세션 창 [S11]", () => {
  const sent = (payload: unknown): Result<{ message: Message }> => {
    const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
    return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd, conversationId: CONV }) } };
  };

  it("new-session window keeps chip choice in pending — PATCH 없이 화면에만, 첫 message.send 에 agentSettings 로 실린다", async () => {
    serve({});
    fake.onAck("message.send", sent);
    renderAt(NEW_CONVERSATION, { agents: [CODER, REVIEWER] });
    await openPanel();
    expect(chip("coder", "모델")).toHaveTextContent("sonnet");
    await pick("coder", "권한", "plan");
    await waitFor(() => expect(chip("coder", "권한")).toHaveTextContent("plan"));
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    const box = screen.getByRole("textbox", { name: "메시지 입력" });
    const editor = (box as unknown as { editor: Editor }).editor;
    setDoc(editor, doc(p(t("시작"))));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fake.sentOf("message.send")).toHaveLength(1));
    expect(fake.sentOf("message.send")[0]).toMatchObject({
      newConversation: {},
      agentSettings: [{ agentId: CODER.id, permissionMode: "plan" }],
    });
  });

  it("새 세션 창의 모델 칩은 채널 agent-ceilings 의 목록을 쓴다", async () => {
    serve({ models: MODELS });
    renderAt(NEW_CONVERSATION, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("Sonnet 5.5"));
    const { menu } = await openChip("coder", "모델");
    expect(names(menu)).toEqual(["기본", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  });

  it("member 의 새 세션 창도 상한(plan) 위를 고를 수 없다 — 채널의 agent-ceilings 로 받는다 [리뷰 건 1]", async () => {
    serve({ ceiling: "plan" });
    renderAt(NEW_CONVERSATION, { agents: [CODER] });
    const { menu } = await openChip("coder", "권한");
    await waitFor(() =>
      expect(
        optionsOf(menu)
          .filter((o) => o.disabled)
          .map((o) => o.name),
      ).toEqual([
        "dontAsk",
        "default",
        "acceptEdits",
        "auto — 승인 카드 없이 실행됩니다",
        "bypassPermissions — 승인 카드 없이 실행됩니다",
      ]),
    );
    expect(menu).toHaveTextContent(ABOVE_CEILING("plan"));
    expect(calls.map((c) => c.url)).toContain(`/api/v1/channels/${CH}/agent-ceilings`);
  });

  it("보내지 않고 떠났다 돌아오면 시작값 — 바꾼 값은 버린다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    const { rerender } = renderAt(NEW_CONVERSATION, { agents: [CODER] });
    await pick("coder", "노력치", "낮음");
    await waitFor(() => expect(chip("coder", "노력치")).toHaveTextContent("낮음"));
    act(() => rerender(CONV));
    act(() => rerender(NEW_CONVERSATION));
    expect(chip("coder", "노력치")).toHaveTextContent("노력 기본");
    expect(chip("coder", "모델")).toHaveTextContent("sonnet");
  });
});

describe("스레드 작성기 [S9 · Review Focus 5]", () => {
  it("값은 대화의 것, 컨텍스트 % 는 그 스레드 세션의 것 — 스레드에 실행이 없으면 「—」", async () => {
    serve({
      settings: {
        [CONV]: [row(CODER, { model: "opus", contextPercent: 42 })],
        [`${CONV}:${ROOT}`]: [row(CODER, { model: "opus", contextPercent: null })],
      },
    });
    renderAt(CONV, { agents: [CODER], threadRootId: ROOT });
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("opus"));
    expect(within(lineOf("coder")).getByRole("button", { name: "컨텍스트 —" })).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toContain(
      `/api/v1/conversations/${CONV}/agent-settings?threadRootId=${ROOT}`,
    );
  });
});

describe("「기본」의 실제 값 [채널 UI·권한 모드 스펙 2장]", () => {
  /** 새 러너 — default 줄에 「기본」이 지금 도는 모델의 표시 이름 */
  const LABELED: RunnerModelOption[] = [{ ...MODELS[0]!, resolvedLabel: "Opus 5.5" }, ...MODELS.slice(1)];

  it("모델 「기본」은 default 줄의 resolvedLabel 로 「기본 · Opus 5.5」 — 칩·메뉴·알약이 같은 글", async () => {
    // 알약은 70% 이상일 때만 선다 — 둘 다 주의 구간으로
    serve({
      settings: {
        [CONV]: [
          row(CODER, { models: LABELED, contextPercent: 75 }),
          row(REVIEWER, { models: MODELS, contextPercent: 80 }),
        ],
      },
    });
    renderAt(CONV, { agents: [CODER, REVIEWER] });
    await waitFor(() =>
      expect(screen.getByTestId("agent-pill-coder")).toHaveAccessibleName(
        "@coder 설정 — 모델 기본 · Opus 5.5, 컨텍스트 75%",
      ),
    );
    // 옛 러너(resolvedLabel 없음)는 「기본」 그대로
    expect(screen.getByTestId("agent-pill-reviewer")).toHaveAccessibleName(
      "@reviewer 설정 — 모델 기본, 컨텍스트 80%",
    );
    await openPanel();
    expect(chip("coder", "모델")).toHaveAccessibleName("@coder 모델: 기본 · Opus 5.5");
    expect(chip("reviewer", "모델")).toHaveAccessibleName("@reviewer 모델: 기본");
    const { menu } = await openChip("coder", "모델");
    expect(names(menu)).toEqual(["기본 · Opus 5.5", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"]);
  });

  it("노력치 「기본」은 「기본 · 모델 기본」 — 칩과 메뉴", async () => {
    serve({ settings: { [CONV]: [row(CODER, { models: LABELED })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() =>
      expect(chip("coder", "노력치")).toHaveAccessibleName("@coder 노력치: 기본 · 모델 기본"),
    );
    expect(chip("coder", "노력치")).toHaveTextContent("노력 기본 · 모델 기본");
    const { menu } = await openChip("coder", "노력치");
    expect(names(menu)[0]).toBe("기본 · 모델 기본");
  });

  it.each([
    ["plan", "plan"],
    ["dontAsk", "dontAsk"],
    ["default", "default"],
    ["acceptEdits", "default"],
    ["bypassPermissions", "default"],
    // 러너가 끊겨 상한을 모르면 default — runner-adapter 와 같다
    [null, "default"],
  ] as const)("권한 「기본」 + 상한 %s → 「기본 · %s」 — 칩과 메뉴", async (ceiling, expected) => {
    serve({ settings: { [CONV]: [row(CODER, { ceiling })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() =>
      expect(chip("coder", "권한")).toHaveAccessibleName(`@coder 권한: 기본 · ${expected}`),
    );
    expect(chip("coder", "권한")).toHaveTextContent(`권한 기본 · ${expected}`);
    const { menu } = await openChip("coder", "권한");
    expect(names(menu)[0]).toBe(`기본 · ${expected}`);
  });
});

describe("설정 패널의 열 정렬 [채널 UI·권한 모드 스펙 2장]", () => {
  /** 패널의 줄이 한 grid 의 칸이다 — 줄은 상자 없는 contents, 칸은 줄마다 다섯(핸들·모델·노력·권한·컨텍스트) */
  function expectAligned(dialog: HTMLElement, handles: string[], columns = PANEL_COLUMNS) {
    const grid = within(dialog).getByTestId("agent-panel-grid");
    expect(grid.className).toMatch(/(^|\s)grid(\s|$)/);
    expect(grid.style.gridTemplateColumns).toBe(columns);
    const lines = handles.map((h) => within(dialog).getByTestId(`agent-settings-${h}`));
    for (const line of lines) {
      expect(line.parentElement).toBe(grid);
      expect(line.className).toMatch(/(^|\s)contents(\s|$)/);
      expect(line.children).toHaveLength(5);
    }
    return grid;
  }

  it("넓은 화면 팝오버 — 줄들이 한 grid 의 자식, 줄마다 칸 다섯", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "claude-custom-long-name" }), row(REVIEWER)] } });
    renderAt(CONV, { agents: [CODER, REVIEWER] });
    const dialog = await openPanel();
    expectAligned(dialog, ["coder", "reviewer"]);
  });

  it("오류는 그 줄 아래 한 줄을 다 쓴다 — 칸 다섯은 그대로", async () => {
    serve({
      settings: { [CONV]: [row(CODER), row(REVIEWER)] },
      patchFails: { status: 500, code: "INTERNAL" },
    });
    renderAt(CONV, { agents: [CODER, REVIEWER] });
    const dialog = await openPanel();
    await pick("coder", "권한", "plan");
    const alert = await within(lineOf("coder")).findByRole("alert");
    expect(alert.parentElement?.className).toContain("col-span-full");
    expect(lineOf("coder").children).toHaveLength(6);
    expect(Array.from(lineOf("coder").children).indexOf(alert.parentElement!)).toBe(5);
    expectAligned(dialog, ["reviewer"]);
  });

  it("좁은 화면 시트도 같은 grid — 열은 줄지 않고 표만 가로 스크롤, 줄 높이 44px 이상", async () => {
    stubMedia(true);
    serve({ settings: { [CONV]: [row(CODER), row(REVIEWER), row(TESTER)] } });
    renderAt(CONV, { agents: [CODER, REVIEWER, TESTER] });
    await userEvent.click(await screen.findByTestId("agent-pill-summary"));
    const dialog = await screen.findByRole("dialog", { name: panelTitle(3) });
    const grid = expectAligned(dialog, ["coder", "reviewer", "tester"], SHEET_COLUMNS);
    expect(grid.style.gridAutoRows).toBe("minmax(2.75rem, auto)");
    expect(grid.parentElement?.className).toContain("overflow-x-auto");
  });
});
