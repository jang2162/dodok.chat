import type {
  Agent,
  ChannelMember,
  ConversationAgentSettings,
  Message,
  Result,
  RunnerModelOption,
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
import { doc, flushEditorFrames, p, setDoc, t } from "../../../test/composerHarness";
import { runnerId } from "../../../test/runnersServer";
import { Composer } from "./Composer";
import { ABOVE_CEILING, EFFORT_UNSUPPORTED, RAISE_LOCKED } from "./AgentSettingChips";

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
  ceiling?: "plan" | "dontAsk" | "default" | "acceptEdits";
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

describe("상태 줄 — 세션에 초대한 러너 에이전트 [세션 에이전트 초대 스펙 5.4]", () => {
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
    await waitFor(() => expect(lineOf("guest")).toHaveTextContent("opus"));
    expect(within(lineOf("guest")).getByText("초대됨")).toBeInTheDocument();
    expect(within(lineOf("coder")).queryByText("초대됨")).toBeNull();
    rerender(OTHER);
    await waitFor(() => expect(lineOf("coder")).toBeInTheDocument());
    expect(within(bar()).queryByText("@guest")).toBeNull();
  });
});

describe("상태 줄 — 칩·게이지 [세션 설정 스펙 S3 · 작성기 칩 스펙 5.4]", () => {
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
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("opus"));
    expect(chip("coder", "노력치")).toHaveTextContent("높음");
    expect(chip("coder", "권한")).toHaveTextContent("default");
    expect(within(lineOf("coder")).getByRole("button", { name: "컨텍스트 42%" })).toBeInTheDocument();
    expect(chip("reviewer", "모델")).toHaveTextContent("기본 모델");
    expect(chip("reviewer", "노력치")).toHaveTextContent("기본 노력");
    expect(chip("reviewer", "권한")).toHaveTextContent("기본 권한");
    expect(within(lineOf("reviewer")).getByRole("button", { name: "컨텍스트 —" })).toBeInTheDocument();
    expect(within(bar()).queryByText("@dev")).toBeNull();
    expect(screen.queryByTestId("agent-settings-dev")).toBeNull();
  });

  it("러너 에이전트가 없으면 그리지도 묻지도 않는다", () => {
    serve({});
    renderAt(CONV, { agents: [OPENCLAW] });
    expect(screen.queryByTestId("agent-settings-bar")).toBeNull();
    expect(calls).toEqual([]);
  });

  it("넷이면 「러너 에이전트 4」 한 줄로 접히고, 펼치면 넷 — 셋은 접지 않는다", async () => {
    const four = [1, 2, 3, 4].map((n) => runnerAgent(n, `r${n}`));
    serve({ settings: { [CONV]: four.map((a) => row(a)) } });
    renderAt(CONV, { agents: four });
    expect(bar()).toHaveTextContent("러너 에이전트 4");
    expect(within(bar()).queryByText("@r1")).toBeNull();
    await userEvent.click(within(bar()).getByRole("button", { name: "펼치기" }));
    for (const a of four) expect(within(bar()).getByText(`@${a.handle}`)).toBeInTheDocument();
  });

  it("셋이면 접지 않는다", () => {
    const three = [1, 2, 3].map((n) => runnerAgent(n, `r${n}`));
    serve({});
    renderAt(CONV, { agents: three });
    expect(bar()).not.toHaveTextContent("러너 에이전트 3");
    expect(within(bar()).queryByRole("button", { name: "펼치기" })).toBeNull();
  });
});

describe("모델 칩 [작성기 칩 스펙 C3·C4·C9]", () => {
  it("picking a model chip saves immediately (PATCH model)", async () => {
    serve({ settings: { [CONV]: [row(CODER, { models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "모델")).toHaveTextContent("기본 모델"));
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
    expect(names(menu)).toEqual(["기본", "낮음", "보통", "높음"]);
    await userEvent.keyboard("{Escape}");
    cleanup();
    // 「기본」 — default 줄의 둘만(대체값 다섯이 아니다 — C9)
    serve({ settings: { [CONV]: [row(CODER, { models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    ({ menu } = await openChip("coder", "노력치"));
    expect(names(menu)).toEqual(["기본", "낮음", "높음"]);
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER, { model: "sonnet" })] } });
    renderAt(CONV, { agents: [CODER] });
    ({ menu } = await openChip("coder", "노력치"));
    expect(names(menu)).toEqual(["기본", "낮음", "보통", "높음", "매우 높음", "최대"]);
  });

  it("노력치를 안 받는 모델(빈 efforts)은 「기본」만 — 저장된 값은 범위 밖 경고", async () => {
    serve({ settings: { [CONV]: [row(CODER, { model: "haiku", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    let { menu } = await openChip("coder", "노력치");
    expect(names(menu)).toEqual(["기본"]);
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER, { model: "haiku", effort: "high", models: MODELS })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(chip("coder", "노력치")).toHaveAttribute("aria-invalid", "true"));
    ({ menu } = await openChip("coder", "노력치"));
    expect(optionsOf(menu)).toEqual([
      { name: "기본", disabled: false, checked: false },
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
      ["기본", false],
      ["plan", false],
      ["dontAsk", false],
      ["default", false],
      ["acceptEdits", true],
    ]);
    expect(menu).toHaveTextContent(RAISE_LOCKED);
  });

  it("admin 은 acceptEdits 를 고른다 — 러너 상한(default) 위는 admin 도 막히고 그 사유", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    let { menu } = await openChip("coder", "권한");
    expect(optionsOf(menu).at(-1)).toMatchObject({ name: "acceptEdits", disabled: false });
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "default" });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    ({ menu } = await openChip("coder", "권한"));
    await waitFor(() =>
      expect(optionsOf(menu).at(-1)).toMatchObject({ name: "acceptEdits", disabled: true }),
    );
    expect(menu).toHaveTextContent(ABOVE_CEILING("default"));
  });

  it("member 도 남의 러너 상한(plan) 위는 막힌다 — 상한은 서버가 줄에 싣는다 [리뷰 건 1]", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "plan" });
    renderAt(CONV, { agents: [CODER] });
    const { menu } = await openChip("coder", "권한");
    await waitFor(() =>
      expect(optionsOf(menu).map((o) => o.disabled)).toEqual([false, false, true, true, true]),
    );
    expect(calls.some((c) => c.url.endsWith("/runners"))).toBe(false);
  });

  it("서버가 403 이면 칩 옆에 사유", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, patchFails: { status: 403, code: "FORBIDDEN" } });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    await pick("coder", "권한", "plan");
    await waitFor(() => expect(within(lineOf("coder")).getByRole("alert")).toHaveTextContent(RAISE_LOCKED));
    expect(chip("coder", "권한")).toHaveTextContent("기본 권한");
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
      ).toEqual(["dontAsk", "default", "acceptEdits"]),
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
    expect(chip("coder", "노력치")).toHaveTextContent("기본 노력");
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
