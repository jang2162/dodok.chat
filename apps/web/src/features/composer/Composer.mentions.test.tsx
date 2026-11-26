import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DmViewContext } from "@/features/dms/context";
import { ConversationClosedContext } from "@/features/conversations/closed";
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
import type { Editor, JSONContent } from "@tiptap/core";
import userEvent from "@testing-library/user-event";
import { insertMention } from "./insertMention";
import { doc, mention, p, setDoc, t } from "../../../test/composerHarness";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

/** 후보 줄의 글 — 아바타 이니셜은 뺀다 */
const rowText = (o: Element) =>
  Array.from(o.childNodes)
    .filter((n) => !(n instanceof Element && n.matches('[data-slot="avatar"]')))
    .map((n) => n.textContent)
    .join("");

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
    expect(options.map(rowText)).toEqual(["개발봇@devAI", "Finance@finAI꺼짐", "주인@owner"]);
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
    expect(options.map(rowText)).toEqual(["Main@main-office사무실AI", "Main@main-home집AI"]);
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
    expect(within(list).getAllByRole("option").map(rowText)).toEqual(["개발봇@devAI"]);

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
    const texts = within(list).getAllByRole("option").map(rowText);
    await flushEditorFrames();
    cleanup();
    return texts;
  };
  expect(await optionsIn(CH)).toEqual([
    "개발봇@devAI",
    "Finance@finAI꺼짐",
    "손님@guestAI초대됨",
    "주인@owner",
  ]);
  expect(await optionsIn(OTHER)).toEqual(["개발봇@devAI", "Finance@finAI꺼짐", "주인@owner"]);
});

/** 문서 안 멘션 노드(순서대로) */
const mentionsIn = (json: JSONContent): string[] => {
  const out: string[] = [];
  const walk = (n: JSONContent) => {
    if (n.type === "mention") out.push(String(n.attrs?.["label"]));
    for (const c of n.content ?? []) walk(c);
  };
  walk(json);
  return out;
};

describe("@ 단추 — 클릭으로 멘션 [UI 시안 02]", () => {
  it("검색·체크박스로 둘을 골라 「2명 넣기」 — 커서 자리에 자동완성과 같은 멘션 칩 둘, 칩마다 공백", async () => {
    const user = userEvent.setup();
    const { editor } = renderComposer();
    setDoc(editor, doc(p(t("안녕 "))));
    // 편집기의 미뤄 둔 focus 프레임이 열린 팝오버의 초점을 뺏어 닫지 않게 먼저 돌린다
    await flushEditorFrames();
    await user.click(screen.getByRole("button", { name: "에이전트 부르기" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 부르기" });
    // 후보는 @ 자동완성과 같은 목록 — 에이전트(멤버 순) 다음 사람
    expect(
      within(within(dialog).getByRole("group", { name: "에이전트" }))
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["@dev", "@fin"]);
    expect(within(dialog).getByRole("group", { name: "사람" })).toHaveTextContent("@owner");
    // 검색은 핸들·이름·별칭
    await user.type(within(dialog).getByRole("searchbox", { name: "에이전트 찾기" }), "fin");
    expect(
      within(dialog)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["@fin"]);
    await user.click(within(dialog).getByRole("checkbox", { name: "@fin" }));
    await user.clear(within(dialog).getByRole("searchbox", { name: "에이전트 찾기" }));
    await user.click(within(dialog).getByRole("checkbox", { name: "@dev" }));
    await user.click(within(dialog).getByRole("button", { name: "2명 넣기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await flushEditorFrames();
    // 고른 순서가 아니라 목록 순서(dev → fin)
    expect(mentionsIn(editor.getJSON())).toEqual(["dev", "fin"]);
    expect(editor.getText()).toBe("안녕 @dev @fin ");
    expect(editor.getJSON().content?.[0]?.content?.slice(1)).toEqual([
      { type: "mention", attrs: { id: `a:${DEV.id}`, label: "dev", mentionSuggestionChar: "@" } },
      { type: "text", text: " " },
      { type: "mention", attrs: { id: `a:${FIN.id}`, label: "fin", mentionSuggestionChar: "@" } },
      { type: "text", text: " " },
    ]);
  });

  it("이미 초안에 든 에이전트는 체크된 채 잠긴다", async () => {
    const user = userEvent.setup();
    const { editor } = renderComposer();
    setDoc(editor, doc(p(mention(`a:${DEV.id}`, "dev"), t(" 봐 줘"))));
    await flushEditorFrames();
    await user.click(screen.getByRole("button", { name: "에이전트 부르기" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 부르기" });
    const dev = within(dialog).getByRole("checkbox", { name: "@dev — 이미 넣음" });
    expect(dev).toBeChecked();
    expect(dev).toBeDisabled();
    expect(within(dialog).getByRole("checkbox", { name: "@fin" })).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "넣을 후보를 고르세요" })).toBeDisabled();
  });

  it("1:1 에이전트 DM 에는 @ 단추가 없다", () => {
    renderComposer(CH, ME, (children) => (
      <DmViewContext.Provider value={{ kind: "dm", channel: dmChannelOf(CH, USER, AGENT), readOnly: null }}>
        {children}
      </DmViewContext.Provider>
    ));
    expect(screen.queryByRole("button", { name: "에이전트 부르기" })).toBeNull();
  });
});

describe("@ 단추 — 넣을 에이전트가 있을 때만 [UI 시안 02]", () => {
  const MIA = uid(6_011);
  const direct = channelOf(CH, { kind: "direct", name: "direct", visibility: "private" });
  async function renderDirect(members: ReturnType<typeof memberOf>[]) {
    const view = renderComposer(CH, ME, (children) => (
      <DmViewContext.Provider value={{ kind: "direct", channel: direct, readOnly: null }}>
        {children}
      </DmViewContext.Provider>
    ));
    await act(async () => {
      view.qc.setQueryData(qk.people, [
        { id: USER, handle: "owner", displayName: "주인", role: "owner" },
        { id: MIA, handle: "mia", displayName: "미아", role: "member" },
      ]);
      view.qc.setQueryData(qk.members(CH), members);
      await new Promise((r) => setTimeout(r, 0));
    });
    return view;
  }
  const people = [
    { ...memberOf(USER), memberType: "user" as const },
    { ...memberOf(MIA), memberType: "user" as const },
  ];

  it("사람 1:1 DM(에이전트 후보 0명)에는 @ 단추가 없다", async () => {
    await renderDirect(people);
    // 사람 후보(mia)는 있어도 그리지 않는다
    expect(screen.queryByRole("button", { name: "에이전트 부르기" })).toBeNull();
  });

  it("그룹 DM 에 에이전트가 있으면 단추가 있고, 에이전트 갈래가 위·사람은 「사람」 갈래로 아래", async () => {
    const user = userEvent.setup();
    await renderDirect([memberOf(DEV.id), ...people]);
    await flushEditorFrames();
    await user.click(await screen.findByRole("button", { name: "에이전트 부르기" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 부르기" });
    const groups = within(dialog).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["에이전트", "사람"]);
    expect(
      within(groups[0]!)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["@dev"]);
    expect(
      within(groups[1]!)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-label")),
    ).toEqual(["@owner", "@mia"]);
  });
});

describe("insertMention — 바깥에서 작성기에 멘션 [UI 시안 02·03]", () => {
  it("등록한 자리에만 넣는다 — 같은 대화의 스레드 작성기·다른 세션·닫힌 세션 작성기로는 새지 않는다", async () => {
    const ROOT = uid(78);
    const OTHER = uid(79);
    const CLOSED = uid(80);
    const { editor, qc } = renderComposer();
    qc.setQueryData(invitedAgentKeys.of(OTHER), []);
    qc.setQueryData(invitedAgentKeys.of(CLOSED), []);
    render(
      <QueryClientProvider client={qc}>
        <Composer channelId={CH} conversationId={CH} threadRootId={ROOT} />
        <Composer channelId={CH} conversationId={OTHER} />
        <ConversationClosedContext.Provider value>
          <Composer channelId={CH} conversationId={CLOSED} />
        </ConversationClosedContext.Provider>
      </QueryClientProvider>,
    );
    const boxes = screen.getAllByRole("textbox", { name: "메시지 입력" });
    const [, other, closed] = boxes.map((b) => (b as unknown as { editor: Editor }).editor);
    const thread = (
      screen.getByRole("textbox", { name: "스레드 답글 입력" }) as unknown as { editor: Editor }
    ).editor;
    let ok = false;
    act(() => {
      ok = insertMention({ channelId: CH, conversationId: CH, threadRootId: ROOT }, "dev");
    });
    expect(ok).toBe(true);
    await flushEditorFrames();
    expect(mentionsIn(thread.getJSON())).toEqual(["dev"]);
    expect(mentionsIn(editor.getJSON())).toEqual([]);
    expect(mentionsIn(other!.getJSON())).toEqual([]);
    // 닫힌 세션의 작성기(숨겨진 채 남는다)는 등록하지 않는다
    expect(insertMention({ channelId: CH, conversationId: CLOSED }, "dev")).toBe(false);
    expect(mentionsIn(closed!.getJSON())).toEqual([]);
    // 등록하지 않은 스레드 자리
    expect(insertMention({ channelId: CH, conversationId: CH, threadRootId: uid(81) }, "dev")).toBe(false);
    expect(mentionsIn(thread.getJSON())).toEqual(["dev"]);
    expect(mentionsIn(editor.getJSON())).toEqual([]);
  });

  it("그 자리 작성기에 멘션 칩 + 공백을 넣고, 후보가 아니거나 다른 자리면 거짓", async () => {
    const { editor } = renderComposer();
    let ok = false;
    act(() => {
      ok = insertMention({ channelId: CH, conversationId: CH }, "dev");
    });
    expect(ok).toBe(true);
    await flushEditorFrames();
    expect(mentionsIn(editor.getJSON())).toEqual(["dev"]);
    expect(editor.getText()).toBe("@dev ");
    expect(insertMention({ channelId: CH, conversationId: CH }, "nobody")).toBe(false);
    // 스레드 작성기 자리는 등록되지 않았다
    expect(insertMention({ channelId: CH, conversationId: CH, threadRootId: uid(77) }, "dev")).toBe(false);
    expect(mentionsIn(editor.getJSON())).toEqual(["dev"]);
  });

  it("작성기가 내려가면 등록도 풀린다", () => {
    renderComposer();
    cleanup();
    expect(insertMention({ channelId: CH, conversationId: CH }, "dev")).toBe(false);
  });
});

describe("@ 입력 목록 — 여럿 고르기", () => {
  async function openAt(text = "@") {
    const view = renderComposer();
    act(() => {
      view.editor.commands.focus();
      view.editor.commands.insertContent(text);
    });
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    return { ...view, list };
  }
  const option = (label: string) =>
    screen.getAllByRole("option").find((o) => rowText(o).includes(`@${label}`)) as HTMLElement;
  const closed = () => waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

  it("목록은 여럿 고르기 listbox — 줄마다 aria-checked, 처음엔 하나도 체크 안 됨", async () => {
    const { list } = await openAt();
    expect(list).toHaveAttribute("aria-multiselectable", "true");
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.getAttribute("aria-checked")),
    ).toEqual(["false", "false", "false"]);
    expect(screen.queryByRole("button", { name: /명 넣기$/ })).toBeNull();
  });

  it("Tab 은 강조된 줄의 체크를 켜고 끈다 — 목록은 열린 채, 넣지 않는다", async () => {
    const { box, editor } = await openAt();
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(option("dev")).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByRole("listbox", { name: "멘션 후보" })).toBeInTheDocument();
    expect(mentionsIn(editor.getJSON())).toEqual([]);
    expect(screen.getByRole("button", { name: "1명 넣기" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(option("dev")).toHaveAttribute("aria-checked", "false"));
    expect(screen.queryByRole("button", { name: /명 넣기$/ })).toBeNull();
  });

  it("Tab 둘(↓ 사이) → Enter — 체크한 둘이 `@쿼리` 자리에 목록 순서로, 칩마다 공백", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = await openAt();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Tab" }); // fin
    fireEvent.keyDown(box, { key: "ArrowUp" });
    fireEvent.keyDown(box, { key: "Tab" }); // dev
    await waitFor(() => expect(screen.getByRole("button", { name: "2명 넣기" })).toBeInTheDocument());
    fireEvent.keyDown(box, { key: "Enter" });
    await closed();
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.getText()).toBe("@dev @fin ");
    expect(editor.getJSON().content?.[0]?.content).toEqual([
      { type: "mention", attrs: { id: `a:${DEV.id}`, label: "dev", mentionSuggestionChar: "@" } },
      { type: "text", text: " " },
      { type: "mention", attrs: { id: `a:${FIN.id}`, label: "fin", mentionSuggestionChar: "@" } },
      { type: "text", text: " " },
    ]);
  });

  it("Enter 는 체크가 없으면 강조된 하나만", async () => {
    const { box, editor } = await openAt();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    await closed();
    expect(mentionsIn(editor.getJSON())).toEqual(["fin"]);
    expect(editor.getText()).toBe("@fin ");
  });

  it("클릭은 체크를 켜고 끄고, 「N명 넣기」가 넣는다", async () => {
    const user = userEvent.setup();
    const { editor } = await openAt();
    await user.click(option("owner"));
    await user.click(option("dev"));
    await user.click(option("owner"));
    await user.click(option("owner"));
    expect(option("dev")).toHaveAttribute("aria-checked", "true");
    expect(mentionsIn(editor.getJSON())).toEqual([]);
    await user.click(screen.getByRole("button", { name: "2명 넣기" }));
    await closed();
    expect(mentionsIn(editor.getJSON())).toEqual(["dev", "owner"]);
  });

  it("검색어를 더 쳐서 줄이 좁혀져도 체크는 남고, N 은 체크 전체", async () => {
    const { box, editor } = await openAt();
    fireEvent.keyDown(box, { key: "Tab" }); // dev
    await waitFor(() => expect(option("dev")).toHaveAttribute("aria-checked", "true"));
    act(() => void editor.commands.insertContent("f"));
    await waitFor(() => expect(screen.getAllByRole("option").map(rowText)).toEqual(["Finance@finAI꺼짐"]));
    expect(screen.getByRole("button", { name: "1명 넣기" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Tab" }); // fin
    await waitFor(() => expect(screen.getByRole("button", { name: "2명 넣기" })).toBeInTheDocument());
    // 맞는 줄이 없어도 체크가 있으면 목록(넣기 단추)은 남고 Enter 는 넣기
    act(() => void editor.commands.insertContent("zz"));
    await waitFor(() => expect(screen.queryAllByRole("option")).toEqual([]));
    expect(screen.getByRole("button", { name: "2명 넣기" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    await closed();
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.getText()).toBe("@dev @fin ");
  });

  it("체크만 있고 보이는 줄이 0개여도 Tab·↑↓ 는 목록이 먹는다 — 초점·커서가 새지 않고 체크는 그대로", async () => {
    const { box, editor } = await openAt();
    fireEvent.keyDown(box, { key: "Tab" }); // dev
    await waitFor(() => expect(option("dev")).toHaveAttribute("aria-checked", "true"));
    act(() => void editor.commands.insertContent("zz"));
    await waitFor(() => expect(screen.queryAllByRole("option")).toEqual([]));
    for (const key of ["Tab", "ArrowUp", "ArrowDown"]) {
      // false = preventDefault 됨
      expect(fireEvent.keyDown(box, { key }), key).toBe(false);
    }
    expect(screen.getByRole("button", { name: "1명 넣기" })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    await closed();
    expect(editor.getText()).toBe("@dev ");
  });

  it("이미 초안에 든 후보는 체크된 채 잠기고 「이미 넣음」 — Tab·클릭으로 바뀌지 않는다", async () => {
    const user = userEvent.setup();
    const view = renderComposer();
    setDoc(view.editor, doc(p(mention(`a:${DEV.id}`, "dev"), t(" "))));
    act(() => {
      view.editor.commands.focus("end");
      view.editor.commands.insertContent("@");
    });
    await flushEditorFrames();
    await screen.findByRole("listbox", { name: "멘션 후보" });
    expect(option("dev")).toHaveAttribute("aria-checked", "true");
    expect(option("dev")).toHaveTextContent("이미 넣음");
    fireEvent.keyDown(view.box, { key: "Tab" });
    await user.click(option("dev"));
    expect(option("dev")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: /명 넣기$/ })).toBeNull();
  });

  it("줄의 화면 읽기 이름은 @ 단추 피커와 같다 — `@핸들`, 이미 든 것은 「— 이미 넣음」", async () => {
    const user = userEvent.setup();
    const view = renderComposer();
    setDoc(view.editor, doc(p(mention(`a:${DEV.id}`, "dev"), t(" "))));
    act(() => {
      view.editor.commands.focus("end");
      view.editor.commands.insertContent("@");
    });
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    const names = ["@dev — 이미 넣음", "@fin", "@owner"];
    for (const name of names) expect(within(list).getByRole("option", { name })).toBeInTheDocument();
    fireEvent.keyDown(view.box, { key: "Escape" });
    await closed();

    await user.click(screen.getByRole("button", { name: "에이전트 부르기" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 부르기" });
    for (const name of names) expect(within(dialog).getByRole("checkbox", { name })).toBeInTheDocument();
  });

  it("Esc 로 닫으면 체크를 버린다 — 다시 @ 를 치면 빈 체크", async () => {
    const { box, editor } = await openAt();
    fireEvent.keyDown(box, { key: "Tab" });
    await waitFor(() => expect(option("dev")).toHaveAttribute("aria-checked", "true"));
    fireEvent.keyDown(box, { key: "Escape" });
    await closed();
    act(() => void editor.commands.insertContent(" @"));
    await flushEditorFrames();
    await screen.findByRole("listbox", { name: "멘션 후보" });
    expect(option("dev")).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: /명 넣기$/ })).toBeNull();
    expect(mentionsIn(editor.getJSON())).toEqual([]);
  });
});

describe("후보 줄 — @ 입력 목록과 @ 단추 피커가 같은 줄", () => {
  const LONG = {
    ...DEV,
    id: uid(9_201),
    handle: "keyring-notes-market",
    name: "keyring-notes-market 에이전트",
  };
  const expectOneLine = (row: HTMLElement) => {
    expect(row.querySelector('[data-slot="avatar"]')).not.toBeNull();
    const handle = within(row).getByText("@keyring-notes-market");
    const name = within(row).getByText("keyring-notes-market 에이전트");
    for (const el of [handle, name]) expect(el).toHaveClass("truncate", "whitespace-nowrap");
    // 이름이 먼저 줄고 핸들은 최소 폭을 지킨다
    expect(name).toHaveClass("min-w-0", "shrink-[4]");
    expect(handle).toHaveClass("min-w-12");
    expect(handle.parentElement).toHaveAttribute(
      "title",
      "keyring-notes-market 에이전트 · @keyring-notes-market",
    );
  };

  it("긴 Gateway 이름은 줄을 넘기지 않고 이름보다 먼저 줄며, title 에 전체가 있다", () => {
    const gateway = "사무실 3층 서버실의 오래된 미니 PC Gateway";
    const item: MentionCandidate = {
      id: "a:1",
      label: "main",
      name: "Main",
      kind: "agent",
      aliases: [],
      enabled: true,
      gateway,
    };
    render(<MentionList items={[item]} command={vi.fn()} />);
    const option = screen.getByRole("option");
    const cell = within(option).getByText(gateway);
    expect(cell).toHaveClass("min-w-0", "shrink-[999]", "truncate");
    expect(cell).not.toHaveClass("shrink-0");
    // 이름·핸들 묶음은 내용 폭에서 시작해야 Gateway 칸이 먼저 준다
    const names = within(option).getByText("Main").parentElement;
    expect(names).toHaveClass("min-w-0", "flex-auto");
    const title = `Main · @main · ${gateway}`;
    expect(names).toHaveAttribute("title", title);
    expect(cell).toHaveAttribute("title", title);
  });

  it("두 목록 모두 아바타·이름·핸들 한 줄(줄바꿈 없이 말줄임, title 로 전체)", async () => {
    const user = userEvent.setup();
    const view = renderComposer();
    await act(async () => {
      view.qc.setQueryData(qk.agents, [DEV, FIN, LONG]);
      view.qc.setQueryData(qk.members(CH), [memberOf(DEV.id), memberOf(FIN.id), memberOf(LONG.id)]);
      await new Promise((r) => setTimeout(r, 0));
    });
    act(() => {
      view.editor.commands.focus();
      view.editor.commands.insertContent("@key");
    });
    await flushEditorFrames();
    const list = await screen.findByRole("listbox", { name: "멘션 후보" });
    expectOneLine(within(list).getByRole("option"));
    fireEvent.keyDown(view.box, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "에이전트 부르기" }));
    const dialog = await screen.findByRole("dialog", { name: "에이전트 부르기" });
    expect(dialog).toHaveClass("w-80");
    expectOneLine(within(dialog).getByRole("checkbox", { name: "@keyring-notes-market" }).closest("label")!);
  });
});
