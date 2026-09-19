import type { Agent, ChannelMember, Message, Result } from "@dodok/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor, JSONContent } from "@tiptap/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { qk } from "@/api/queries";
import { useRunStore } from "@/features/runs/runStore";
import { useWireStatus } from "@/realtime/wire";
import { Composer } from "./Composer";
import { MentionList, mentionSuggestion } from "./MentionList";
import { type MentionCandidate, mentionCandidates } from "./mentions";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, CH2, RUN, RUN2, USER, msg, runState, uid } from "../../../test/fixtures";
import { json } from "../../../test/shellApi";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

const W = uid(900);
const TS = "2026-09-19T00:00:00.000Z";
const DEV: Agent = {
  id: AGENT,
  workspaceId: W,
  provider: "openclaw",
  providerAgentId: "dev",
  handle: "dev",
  name: "개발봇",
  enabled: true,
  createdAt: TS,
};
const FIN: Agent = {
  ...DEV,
  id: uid(12),
  providerAgentId: "fin",
  handle: "fin",
  name: "Finance",
  enabled: false,
};
const memberOf = (memberId: string, aliases: string[] = []): ChannelMember => ({
  id: `m-${memberId}`,
  channelId: CH,
  memberType: "agent",
  memberId,
  autoRespond: false,
  aliases,
  joinedAt: TS,
});
const ME = { user: { id: USER, handle: "owner", displayName: "주인" }, workspaceId: W };

const p = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const t = (text: string): JSONContent => ({ type: "text", text });
const mention = (id: string, label: string): JSONContent => ({ type: "mention", attrs: { id, label } });
const doc = (...content: JSONContent[]): JSONContent => ({ type: "doc", content });

let fake: FakeSocket;
let restoreDom: () => void;
let toastInfo: MockInstance<typeof toast.info>;
let toastError: MockInstance<typeof toast.error>;

beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  useRunStore.getState().reset();
  toastInfo = vi.spyOn(toast, "info");
  toastError = vi.spyOn(toast, "error");
});
afterEach(() => {
  restoreDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

/** 캐시를 채운 채 띄운다(조회 없음). 편집기는 ProseMirror 요소에 붙은 Tiptap 인스턴스 */
function renderComposer(channelId = CH) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(qk.me, ME);
  qc.setQueryData(qk.agents, [DEV, FIN]);
  qc.setQueryData(qk.members(CH), [memberOf(DEV.id, ["coder"]), memberOf(FIN.id)]);
  qc.setQueryData(qk.members(CH2), []);
  const view = render(
    <QueryClientProvider client={qc}>
      <Composer channelId={channelId} />
    </QueryClientProvider>,
  );
  const box = screen.getByRole("textbox", { name: "메시지 입력" });
  const editor = (box as unknown as { editor: Editor }).editor;
  const rerender = (ch: string) =>
    view.rerender(
      <QueryClientProvider client={qc}>
        <Composer channelId={ch} />
      </QueryClientProvider>,
    );
  return { box, editor, rerender, qc };
}

/** 문서를 넣고 커서를 둔다(기본 끝). 코드 블록·목록 뒤에는 trailingNode 의 빈 문단이 붙으므로 그 안은 위치로 짚는다 */
const setDoc = (editor: Editor, content: JSONContent, at: "end" | number = "end") =>
  act(() => {
    editor.commands.setContent(content);
    editor.commands.focus(at);
  });
const confirmed = (payload: unknown): Result<{ message: Message }> => {
  const { clientMsgId, bodyMd } = payload as { clientMsgId: string; bodyMd: string };
  return { ok: true, data: { message: msg(1, { clientMsgId, bodyMd }) } };
};

it("(a) Enter → message.send 의 bodyMd 는 토큰 본문, 보낸 뒤 비운다", async () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" 안녕"))));
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, clientMsgId: expect.any(String), bodyMd: `<@a:${AGENT}> 안녕` },
  ]);
  await waitFor(() => expect(editor.isEmpty).toBe(true));
});

it("보내기 버튼도 같은 전송, 비었으면 비활성·공백만이면 보내지 않는다", async () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  const button = screen.getByRole("button", { name: "보내기" });
  expect(button).toBeDisabled();
  setDoc(editor, doc(p(t("   "))));
  expect(button).toBeEnabled();
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([]);

  setDoc(editor, doc(p(t("버튼으로"))));
  await userEvent.click(button);
  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, clientMsgId: expect.any(String), bodyMd: "버튼으로" },
  ]);
});

it("(b) 한글 조합 중(isComposing·keyCode 229) Enter 는 보내지도 줄을 나누지도 않는다", () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(t("안녕하세"))));
  fireEvent.keyDown(box, { key: "Enter", isComposing: true });
  fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
  expect(fake.sentOf("message.send")).toEqual([]);
  expect(editor.getJSON()).toEqual(doc(p(t("안녕하세"))));
});

it("(c) Shift+Enter 는 보내지 않고 줄바꿈 — 코드 블록이면 코드 줄, 목록이면 새 항목", () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(t("첫"))));
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(editor.getJSON()).toEqual(doc(p(t("첫"), { type: "hardBreak" })));

  setDoc(editor, doc({ type: "codeBlock", attrs: { language: null }, content: [t("a")] }), 2);
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(editor.getJSON().content?.[0]?.content).toEqual([t("a\n")]);

  setDoc(editor, doc({ type: "bulletList", content: [{ type: "listItem", content: [p(t("가"))] }] }), 4);
  fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
  expect(editor.getJSON().content?.[0]?.content).toHaveLength(2);
  expect(fake.sentOf("message.send")).toEqual([]);
});

it("목록·코드 블록 안에서도 Enter 는 전송(코어 keymap·목록보다 먼저)", () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc({ type: "bulletList", content: [{ type: "listItem", content: [p(t("가"))] }] }));
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, clientMsgId: expect.any(String), bodyMd: "- 가" },
  ]);
});

it("(d) wire 가 connected 가 아니면 전송 버튼 비활성 + 「연결되면 보낼 수 있습니다」, 입력은 받고 Enter 는 보내지 않는다", () => {
  fake.onAck("message.send", confirmed);
  useWireStatus.getState().setStatus("reconnecting");
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(t("나중에"))));
  const button = screen.getByRole("button", { name: "보내기" });
  expect(button).toBeDisabled();
  expect(button).toHaveAccessibleDescription("연결되면 보낼 수 있습니다");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([]);
  expect(editor.getJSON()).toEqual(doc(p(t("나중에"))));

  act(() => useWireStatus.getState().setStatus("connected"));
  expect(screen.queryByText("연결되면 보낼 수 있습니다")).not.toBeInTheDocument();
  expect(button).toBeEnabled();
});

describe("(e) /stop", () => {
  const seedRuns = () =>
    act(() => {
      const s = useRunStore.getState();
      s.applyState(runState({ id: RUN, status: "streaming" }));
      s.applyState(runState({ id: RUN2, status: "queued" }));
      s.applyState(runState({ id: uid(103), status: "done" }));
      s.applyState(runState({ id: uid(104), channelId: CH2, status: "streaming" }));
    });

  it("이 채널의 끝나지 않은 런마다 run.abort, 메시지로 보내지 않고 비운다", async () => {
    fake.onAck("run.abort", () => ({ ok: true, data: null }));
    seedRuns();
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("run.abort")).toEqual([{ runId: RUN }, { runId: RUN2 }]);
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(true);
    await Promise.resolve();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("진행 중인 런이 없으면 「진행 중인 실행이 없습니다」", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("run.abort")).toEqual([]);
    expect(toastInfo).toHaveBeenCalledWith("진행 중인 실행이 없습니다");
  });

  it("ack 실패는 코드별 문구 토스트", async () => {
    fake.onAck("run.abort", () => ({ ok: false, error: { code: "NOT_FOUND", message: "run not found" } }));
    act(() => useRunStore.getState().applyState(runState({ id: RUN, status: "streaming" })));
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("이미 끝났거나 없는 실행입니다", expect.anything()),
    );
  });
});

describe("(f) /new", () => {
  it("/new + 에이전트 멘션 → 「새 대화」 대화상자, 확인하면 reset", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(200, { ok: true }));
    vi.stubGlobal("fetch", fetch);
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });

    const dialog = await screen.findByRole("dialog", { name: "새 대화" });
    expect(dialog).toHaveTextContent("@dev 와의 대화 기록을 새로 시작합니다. 진행 중인 실행은 중지됩니다");
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(true);

    await userEvent.click(within(dialog).getByRole("button", { name: "새 대화 시작" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`/api/v1/channels/${CH}/agents/${AGENT}/reset`, "POST"],
    ]);
  });

  it("wire 가 끊겨도 /new 는 된다(REST)", async () => {
    useWireStatus.getState().setStatus("reconnecting");
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new "), mention(`a:${AGENT}`, "dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(await screen.findByRole("dialog", { name: "새 대화" })).toBeInTheDocument();
  });

  it("/new 뒤에 에이전트가 없으면 토스트, 입력은 남긴다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("/new dev"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toastError).toHaveBeenCalledWith("/new 뒤에 @에이전트를 붙이세요", expect.anything());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editor.getJSON()).toEqual(doc(p(t("/new dev"))));
  });
});

describe("(g) 붙여넣기·끌어 놓기", () => {
  const png = () => new File(["x"], "a.png", { type: "image/png" });

  it("파일만 온 붙여넣기 → 토스트, 본문 변화 없음", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("그대로"))));
    fireEvent.paste(box, { clipboardData: { files: [png()], types: ["Files"], getData: () => "" } });
    expect(toastInfo).toHaveBeenCalledWith("이미지는 Phase 2 에서 지원합니다", expect.anything());
    expect(editor.getJSON()).toEqual(doc(p(t("그대로"))));
  });

  it("글과 파일이 함께 오면 글만 들어가고 토스트는 없다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("앞 "))));
    const getData = (type: string) => (type === "text/plain" ? "붙인 글" : "");
    fireEvent.paste(box, { clipboardData: { files: [png()], types: ["text/plain", "Files"], getData } });
    expect(toastInfo).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("앞 붙인 글");
  });

  it("파일 끌어 놓기 → 토스트", () => {
    const { box } = renderComposer();
    fireEvent.drop(box, { dataTransfer: { files: [png()], types: ["Files"], getData: () => "" } });
    expect(toastInfo).toHaveBeenCalledWith("이미지는 Phase 2 에서 지원합니다", expect.anything());
  });
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
    expect(options[1]).toHaveAttribute("aria-disabled", "true");
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

  it("@ 로 연 후보 목록에서 Enter 는 전송이 아니라 선택 — 닫힌 뒤 Enter 가 전송", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderComposer();
    act(() => {
      editor.commands.focus();
      editor.commands.insertContent("@co");
    });
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
      { channelId: CH, clientMsgId: expect.any(String), bodyMd: `<@a:${AGENT}>` },
    ]);
  });
});

it("입력이 바뀌면 typing(3초 스로틀), 비우는 것(보낸 뒤 포함)은 알리지 않는다", () => {
  fake.onAck("message.send", confirmed);
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { box, editor } = renderComposer();
  act(() => editor.commands.insertContent("가"));
  act(() => editor.commands.insertContent("나"));
  expect(fake.sentOf("typing")).toEqual([{ channelId: CH }]);

  now += 3_000; // 스로틀 창 밖
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toHaveLength(1);
  expect(editor.isEmpty).toBe(true);
  expect(fake.sentOf("typing")).toHaveLength(1);

  act(() => editor.commands.insertContent("다"));
  expect(fake.sentOf("typing")).toHaveLength(2);
});

it("초안은 채널마다 — 옮겨 가면 비고, 돌아오면 되살아난다", () => {
  const { editor, rerender } = renderComposer(CH);
  setDoc(editor, doc(p(t("CH 초안"))));
  act(() => rerender(CH2));
  expect(editor.isEmpty).toBe(true);
  setDoc(editor, doc(p(t("CH2 초안"))));
  act(() => rerender(CH));
  expect(editor.getText()).toBe("CH 초안");
  act(() => rerender(CH2));
  expect(editor.getText()).toBe("CH2 초안");
});
