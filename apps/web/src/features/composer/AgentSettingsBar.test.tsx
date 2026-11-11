import type { Agent, ChannelMember, ConversationAgentSettings, Message, Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { CH, msg, uid, USER } from "../../../test/fixtures";
import { doc, flushEditorFrames, p, setDoc, t } from "../../../test/composerHarness";
import { programOf, runnerId, runnerOf } from "../../../test/runnersServer";
import { Composer } from "./Composer";
import { ABOVE_CEILING, RAISE_LOCKED } from "./AgentSettingsPopover";

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
  ...over,
});

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let fake: FakeSocket;
let restoreDom: () => void;

/** 가짜 REST — 세션 설정·러너·연결. PATCH 는 보낸 칸을 얹은 줄을 돌려준다 */
function serve(opts: {
  settings?: Record<string, ConversationAgentSettings[]>;
  ceiling?: "plan" | "dontAsk" | "default" | "acceptEdits";
  patchFails?: { status: number; code: string };
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
      const settings = url.match(/\/conversations\/([^/?]+)\/agent-settings(\?threadRootId=(.+))?$/);
      if (method === "GET" && settings) {
        const key = settings[3] ? `${settings[1]}:${settings[3]}` : (settings[1] ?? "");
        return json(200, { settings: opts.settings?.[key] ?? [] });
      }
      const patch = url.match(/\/conversations\/([^/]+)\/agent-settings\/([^/]+)$/);
      if (method === "PATCH" && patch) {
        if (opts.patchFails)
          return json(opts.patchFails.status, { code: opts.patchFails.code, message: "거절" });
        const before = opts.settings?.[patch[1] ?? ""]?.find((r) => r.agentId === patch[2]);
        return json(200, { ...before, agentId: patch[2], ...body });
      }
      if (url.endsWith("/runners"))
        return json(200, {
          runners: [
            runnerOf(1, {
              programs: [
                programOf({
                  ceiling: { maxPermissionMode: opts.ceiling ?? "acceptEdits", allowedToolsCeiling: null },
                }),
              ],
            }),
          ],
        });
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
const lineOf = (handle: string) => within(bar()).getByText(`@${handle}`).parentElement as HTMLElement;
async function openPopover(handle: string) {
  await userEvent.click(screen.getByRole("button", { name: `@${handle} 설정 변경` }));
  return screen.findByRole("dialog", { name: `@${handle} 설정` });
}
const modeOptions = (dialog: HTMLElement) =>
  within(within(dialog).getByRole("combobox", { name: "권한 모드" }))
    .getAllByRole("option")
    .map((o) => ({ value: (o as HTMLOptionElement).value, disabled: (o as HTMLOptionElement).disabled }));

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

describe("상태 줄 — 값 [세션 설정 스펙 S3·5.4]", () => {
  it("러너 에이전트마다 한 줄 — 값·「기본」·컨텍스트 %·「—」, OpenClaw 에이전트는 줄이 없다", async () => {
    serve({
      settings: {
        [CONV]: [
          row(CODER, { model: "opus", effort: "high", permissionMode: "default", contextPercent: 42 }),
          row(REVIEWER),
        ],
      },
    });
    renderAt(CONV);
    await waitFor(() =>
      expect(lineOf("coder")).toHaveTextContent("opus · effort high · default · 컨텍스트 42%"),
    );
    expect(lineOf("reviewer")).toHaveTextContent("모델 기본 · effort 기본 · 권한 기본 · 컨텍스트 —");
    expect(within(bar()).queryByText("@dev")).toBeNull();
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

describe("「변경」 팝오버 — 권한 [S2]", () => {
  it("member 에게 acceptEdits 는 막히고 사유 한 줄 — default 이하·「기본」은 고른다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER] });
    const dialog = await openPopover("coder");
    await waitFor(() =>
      expect(modeOptions(dialog)).toEqual([
        { value: "", disabled: false },
        { value: "plan", disabled: false },
        { value: "dontAsk", disabled: false },
        { value: "default", disabled: false },
        { value: "acceptEdits", disabled: true },
      ]),
    );
    expect(within(dialog).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
      RAISE_LOCKED,
    );
  });

  it("admin 은 acceptEdits 를 고른다 — 러너 상한(default) 위는 admin 도 막히고 그 사유", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    let dialog = await openPopover("coder");
    await waitFor(() =>
      expect(modeOptions(dialog).at(-1)).toEqual({ value: "acceptEdits", disabled: false }),
    );
    await userEvent.keyboard("{Escape}");
    cleanup();
    serve({ settings: { [CONV]: [row(CODER)] }, ceiling: "default" });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    dialog = await openPopover("coder");
    await waitFor(() => expect(modeOptions(dialog).at(-1)).toEqual({ value: "acceptEdits", disabled: true }));
    expect(within(dialog).getByRole("combobox", { name: "권한 모드" })).toHaveAccessibleDescription(
      ABOVE_CEILING("default"),
    );
  });

  it("저장하면 PATCH 하나 — 바뀐 칸만, 줄이 곧바로 바뀐다", async () => {
    serve({ settings: { [CONV]: [row(CODER, { contextPercent: 5 })] } });
    renderAt(CONV, { agents: [CODER] });
    await waitFor(() => expect(lineOf("coder")).toHaveTextContent("컨텍스트 5%"));
    const dialog = await openPopover("coder");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "모델" }), "opus");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "effort" }), "max");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "PATCH")).toEqual([
      {
        method: "PATCH",
        url: `/api/v1/conversations/${CONV}/agent-settings/${CODER.id}`,
        body: { model: "opus", effort: "max" },
      },
    ]);
    expect(lineOf("coder")).toHaveTextContent("opus · effort max · 권한 기본 · 컨텍스트 5%");
  });

  it("서버가 403 이면 그 자리에 사유 — 팝오버는 닫히지 않는다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] }, patchFails: { status: 403, code: "FORBIDDEN" } });
    renderAt(CONV, { agents: [CODER], role: "admin" });
    const dialog = await openPopover("coder");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "권한 모드" }), "plan");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(dialog).toHaveTextContent(RAISE_LOCKED));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("새 세션 창 [S11]", () => {
  const sent = (payload: unknown): Result<{ message: Message }> => {
    const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
    return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd, conversationId: CONV }) } };
  };

  it("바꾼 값은 PATCH 없이 화면에만 — 첫 message.send 에 agentSettings 로 실린다", async () => {
    serve({});
    fake.onAck("message.send", sent);
    renderAt(NEW_CONVERSATION, { agents: [CODER, REVIEWER] });
    expect(lineOf("coder")).toHaveTextContent("sonnet · effort 기본 · 권한 기본 · 컨텍스트 —");
    const dialog = await openPopover("coder");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "권한 모드" }), "plan");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(lineOf("coder")).toHaveTextContent("sonnet · effort 기본 · plan"));
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

  it("보내지 않고 떠났다 돌아오면 시작값 — 바꾼 값은 버린다", async () => {
    serve({ settings: { [CONV]: [row(CODER)] } });
    const { rerender } = renderAt(NEW_CONVERSATION, { agents: [CODER] });
    const dialog = await openPopover("coder");
    await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "effort" }), "low");
    await userEvent.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(lineOf("coder")).toHaveTextContent("effort low"));
    act(() => rerender(CONV));
    act(() => rerender(NEW_CONVERSATION));
    expect(lineOf("coder")).toHaveTextContent("sonnet · effort 기본 · 권한 기본");
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
    await waitFor(() =>
      expect(lineOf("coder")).toHaveTextContent("opus · effort 기본 · 권한 기본 · 컨텍스트 —"),
    );
    expect(calls.map((c) => c.url)).toContain(
      `/api/v1/conversations/${CONV}/agent-settings?threadRootId=${ROOT}`,
    );
  });
});
