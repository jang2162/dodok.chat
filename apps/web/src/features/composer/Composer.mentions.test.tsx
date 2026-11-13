import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DmViewContext } from "@/features/dms/context";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { dmChannelOf } from "../../../test/dms";
import { AGENT, CH, USER, uid } from "../../../test/fixtures";
import { channelOf } from "../../../test/shellApi";
import { qk } from "@/api/queries";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { Composer } from "./Composer";
import { invitedAgentKeys } from "@/features/conversations/invitedAgents";
import { confirmed, flushEditorFrames, renderComposer } from "../../../test/composerHarness";
import { MentionList, mentionSuggestion } from "./MentionList";
import { type MentionCandidate, mentionCandidates } from "./mentions";
import { DEV, FIN, ME, memberOf } from "../../../test/composerHarness";
import type { Editor } from "@tiptap/core";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

let fake: FakeSocket;
let restoreDom: () => void;

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

describe("멘션", () => {
  const candidates = (): MentionCandidate[] =>
    mentionCandidates([memberOf(DEV.id, ["coder"]), memberOf(FIN.id)], [DEV, FIN], ME as never);

  it("suggestion items: 핸들·별칭·이름 앞부분으로 거른다", async () => {
    const { items } = mentionSuggestion(candidates, { open: false });
    const labels = async (query: string) =>
      (await items?.({ query, editor: {} as Editor, signal: new AbortController().signal }))?.map(
        (c) => c.label,
      );
    expect(await labels("")).toEqual(["dev", "fin", "owner"]);
    expect(await labels("co")).toEqual(["dev"]);
    expect(await labels("F")).toEqual(["fin"]);
    expect(await labels("주")).toEqual(["owner"]);
  });

  it("후보 목록: 「AI」 배지, 꺼진 에이전트는 흐리게 + 「꺼짐」, ↑↓·Enter 로 고른다", () => {
    const command = vi.fn();
    const ref: { current: { onKeyDown(e: KeyboardEvent): boolean } | null } = { current: null };
    render(<MentionList items={candidates()} command={command} ref={ref} />);
    const options = within(screen.getByRole("listbox", { name: "멘션 후보" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["@dev개발봇AI", "@finFinanceAI꺼짐", "@owner주인"]);
    expect(options[1]).not.toHaveAttribute("aria-disabled"); // 꺼져 있어도 고를 수 있다
    expect(options[1]).toHaveClass("opacity-50");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    const key = (k: string) =>
      act(() => void ref.current?.onKeyDown(new KeyboardEvent("keydown", { key: k })));
    key("ArrowUp"); // 맨 위에서 위로 → 맨 아래
    expect(screen.getAllByRole("option")[2]).toHaveAttribute("aria-selected", "true");
    key("ArrowDown");
    key("ArrowDown");
    key("Enter");
    expect(command).toHaveBeenCalledWith({ id: `a:${FIN.id}`, label: "fin" });
    expect(ref.current?.onKeyDown(new KeyboardEvent("keydown", { key: "a" }))).toBe(false);
  });

  it("OpenClaw 에이전트 줄에는 Gateway 이름을 작게 — 두 Gateway 의 main 이 갈린다", () => {
    const items: MentionCandidate[] = [
      {
        id: "a:1",
        label: "main-office",
        name: "Main",
        kind: "agent",
        aliases: [],
        enabled: true,
        gateway: "사무실",
      },
      {
        id: "a:2",
        label: "main-home",
        name: "Main",
        kind: "agent",
        aliases: [],
        enabled: true,
        gateway: "집",
      },
    ];
    render(<MentionList items={items} command={vi.fn()} />);
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["@main-officeMain사무실AI", "@main-homeMain집AI"]);
    expect(within(options[1] as HTMLElement).getByText("집")).toHaveClass("text-xs");
  });

  it("@ 로 연 후보 목록에서 Enter 는 전송이 아니라 선택 — 닫힌 뒤 Enter 가 전송", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderComposer();
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("@co");
    });
    // focus() 가 미룬 프레임을 돌려 편집기가 선택 영역을 실제로 잡게 한다 —
    // 그 전에 후보를 확정하면 Tiptap 멘션이 부르는 collapseToEnd() 가 던진다(composerHarness 주석)
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["@dev개발봇AI"]);

    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
    expect(editor.getJSON().content?.[0]?.content?.[0]).toMatchObject({
      type: "mention",
      attrs: { id: `a:${AGENT}`, label: "dev" },
    });

    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toEqual([
      { channelId: CH, conversationId: CH, clientMsgId: expect.any(String), bodyMd: `<@a:${AGENT}>` },
    ]);
  });
});

it("팝업이 열리면 편집기가 목록과 고른 줄을 가리킨다(aria-controls·aria-activedescendant), 닫히면 뗀다", async () => {
  const { box, editor } = renderComposer();
  expect(box).toHaveAttribute("aria-autocomplete", "list");
  expect(box).not.toHaveAttribute("aria-controls");
  expect(box).not.toHaveAttribute("aria-activedescendant");

  act(() => {
    editor.commands.focus();
    editor.commands.insertContent("@");
  });
  await flushEditorFrames();
  const list = await screen.findByRole("listbox", { name: "멘션 후보" });
  expect(list.id).toBeTruthy();
  await waitFor(() => expect(box).toHaveAttribute("aria-controls", list.id));

  const options = within(list).getAllByRole("option");
  expect(options.map((o) => o.id)).toEqual([`${list.id}-0`, `${list.id}-1`, `${list.id}-2`]);
  await waitFor(() => expect(box).toHaveAttribute("aria-activedescendant", options[0]?.id ?? ""));

  fireEvent.keyDown(box, { key: "ArrowDown" });
  await waitFor(() => expect(box).toHaveAttribute("aria-activedescendant", `${list.id}-1`));
  expect(within(list).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");

  fireEvent.keyDown(box, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  expect(box).not.toHaveAttribute("aria-controls");
  expect(box).not.toHaveAttribute("aria-activedescendant");
});

it("DM 작성기에서는 @ 를 쳐도 후보 목록이 없다 — 같은 채널·같은 후보라도 일반 채널이면 있다(에이전트 DM 계획 판정 PD6)", async () => {
  const typeAt = async (editor: Editor) => {
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("@");
    });
    await flushEditorFrames();
  };
  const channel = renderComposer();
  await typeAt(channel.editor);
  expect(await screen.findByRole("listbox", { name: "멘션 후보" })).toBeInTheDocument();
  await flushEditorFrames();
  cleanup();

  const dm = renderComposer(CH, ME, (children) => (
    <DmViewContext.Provider value={{ kind: "dm", channel: dmChannelOf(CH, USER, AGENT), readOnly: null }}>
      {children}
    </DmViewContext.Provider>
  ));
  await typeAt(dm.editor);
  // 후보가 있었다면 열렸을 만큼 기다린 뒤 본다 — 팝업은 suggestion 의 비동기 items 뒤에 그려진다
  await flushEditorFrames();
  expect(dm.editor.getText()).toBe("@");
  expect(screen.queryByRole("listbox")).toBeNull();
});

it("사람 DM·그룹 DM 작성기의 @ 후보는 참여자만 — 참여하지 않은 사람·에이전트는 없다(사람 간 DM 계획 판정 PH6)", async () => {
  const MIA = uid(6_001);
  const JUN = uid(6_002);
  const direct = channelOf(CH, { kind: "direct", name: "direct", visibility: "private" });
  const view = renderComposer(CH, ME, (children) => (
    <DmViewContext.Provider value={{ kind: "direct", channel: direct, readOnly: null }}>
      {children}
    </DmViewContext.Provider>
  ));
  await act(async () => {
    view.qc.setQueryData(qk.people, [
      { id: USER, handle: "owner", displayName: "주인", role: "owner" },
      { id: MIA, handle: "mia", displayName: "미아", role: "member" },
      { id: JUN, handle: "jun", displayName: "준", role: "member" },
    ]);
    // 참여자: 나·mia·dev — fin·jun 은 참여자가 아니다
    view.qc.setQueryData(qk.members(CH), [
      memberOf(DEV.id),
      { ...memberOf(USER), memberType: "user" },
      { ...memberOf(MIA), memberType: "user" },
    ]);
    // Query 는 관찰자에게 다음 틱에 알린다
    await new Promise((r) => setTimeout(r, 0));
  });
  act(() => {
    view.editor.commands.focus();
    view.editor.commands.insertContent("@");
  });
  await flushEditorFrames();
  const list = await screen.findByRole("listbox", { name: "멘션 후보" });
  const labels = within(list)
    .getAllByRole("option")
    .map((o) => o.textContent ?? "");
  expect(labels.some((l) => l.includes("@dev"))).toBe(true);
  expect(labels.some((l) => l.includes("@mia"))).toBe(true);
  expect(labels.some((l) => l.includes("@fin"))).toBe(false);
  expect(labels.some((l) => l.includes("@jun"))).toBe(false);
});

it("그 세션에 초대한 에이전트는 「초대됨」 후보 — 같은 채널의 다른 세션 작성기에는 없다 [세션 에이전트 초대 스펙 5.4·Review Focus 1]", async () => {
  const GUEST = { ...DEV, id: uid(9_101), handle: "guest", providerAgentId: "guest", name: "손님" };
  const OTHER = uid(9_102);
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.me, ME);
  qc.setQueryData(qk.people, [{ id: USER, handle: "owner", displayName: "주인", role: "owner" }]);
  qc.setQueryData(qk.agents, [DEV, FIN, GUEST]);
  qc.setQueryData(qk.members(CH), [memberOf(DEV.id), memberOf(FIN.id)]);
  qc.setQueryData(invitedAgentKeys.of(CH), [
    { agentId: GUEST.id, invitedBy: USER, invitedAt: "2026-11-13T00:00:00.000Z" },
  ]);
  qc.setQueryData(invitedAgentKeys.of(OTHER), []);
  const optionsIn = async (conversationId: string) => {
    render(
      <QueryClientProvider client={qc}>
        <Composer channelId={CH} conversationId={conversationId} />
      </QueryClientProvider>,
    );
    const box = screen.getByRole("textbox", { name: "메시지 입력" });
    const editor = (box as unknown as { editor: Editor }).editor;
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("@");
    });
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    const texts = within(list)
      .getAllByRole("option")
      .map((o) => o.textContent);
    await flushEditorFrames();
    cleanup();
    return texts;
  };
  expect(await optionsIn(CH)).toEqual([
    "@dev개발봇AI",
    "@finFinanceAI꺼짐",
    "@guest손님AI초대됨",
    "@owner주인",
  ]);
  expect(await optionsIn(OTHER)).toEqual(["@dev개발봇AI", "@finFinanceAI꺼짐", "@owner주인"]);
});
