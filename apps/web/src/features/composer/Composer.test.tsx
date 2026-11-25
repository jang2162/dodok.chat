import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { FakeXhr, stubObjectUrls } from "../../../test/fakeXhr";
import { qk } from "@/api/queries";
import { invitedAgentKeys } from "@/features/conversations/invitedAgents";
import { AGENT, CH, CH2, uid, USER } from "../../../test/fixtures";
import { Composer } from "./Composer";
import {
  confirmed,
  DEV,
  doc,
  FIN,
  ME,
  memberOf,
  flushEditorFrames,
  mention,
  p,
  renderComposer,
  setDoc,
  t,
} from "../../../test/composerHarness";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

let fake: FakeSocket;
let restoreDom: () => void;
let toastInfo: MockInstance<typeof toast.info>;

beforeEach(() => {
  restoreDom = stubEditorDom();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  toastInfo = vi.spyOn(toast, "info");
});
afterEach(async () => {
  await flushEditorFrames();
  restoreDom();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

it("(a) Enter → message.send 의 bodyMd 는 토큰 본문, 보낸 뒤 비운다", async () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" 안녕"))));
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([
    { channelId: CH, conversationId: CH, clientMsgId: expect.any(String), bodyMd: `<@a:${AGENT}> 안녕` },
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
    { channelId: CH, conversationId: CH, clientMsgId: expect.any(String), bodyMd: "버튼으로" },
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
    { channelId: CH, conversationId: CH, clientMsgId: expect.any(String), bodyMd: "- 가" },
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

describe("(g) 붙여넣기·끌어 놓기 — 이미지 아닌 파일도 칩(칩 꼴은 Composer.attachments.test)", () => {
  const pdf = () => new File(["x"], "a.pdf", { type: "application/pdf" });
  const chips = () => screen.queryByRole("list", { name: "첨부할 파일" });
  // 칩은 곧바로 올린다 — 실제 XHR 이 나가지 않게
  let urls: ReturnType<typeof stubObjectUrls>;
  beforeEach(() => {
    FakeXhr.reset();
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    urls = stubObjectUrls();
  });
  afterEach(() => {
    urls.restore();
    vi.unstubAllGlobals();
  });

  it("이미지 아닌 파일만 온 붙여넣기 → 칩, 토스트 없음, 본문 변화 없음", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("그대로"))));
    fireEvent.paste(box, { clipboardData: { files: [pdf()], types: ["Files"], getData: () => "" } });
    expect(toastInfo).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(doc(p(t("그대로"))));
    expect(within(chips() as HTMLElement).getByText("a.pdf")).toBeInTheDocument();
  });

  it("글과 이미지 아닌 파일이 함께 오면 글도 들어가고 칩도 생긴다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("앞 "))));
    const getData = (type: string) => (type === "text/plain" ? "붙인 글" : "");
    fireEvent.paste(box, { clipboardData: { files: [pdf()], types: ["text/plain", "Files"], getData } });
    expect(toastInfo).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("앞 붙인 글");
    expect(within(chips() as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
  });

  it("이미지 아닌 파일 끌어 놓기 → 칩, 브라우저가 열지 않게 막는다", () => {
    const { box } = renderComposer();
    const dropped = fireEvent.drop(box, {
      dataTransfer: { files: [pdf()], types: ["Files"], getData: () => "" },
    });
    expect(dropped).toBe(false);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(within(chips() as HTMLElement).getByText("a.pdf")).toBeInTheDocument();
  });
});

it("입력이 바뀌면 typing(3초 스로틀), 비우는 것(보낸 뒤 포함)은 알리지 않는다", () => {
  fake.onAck("message.send", confirmed);
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { box, editor } = renderComposer();
  act(() => editor.commands.insertContent("가"));
  act(() => editor.commands.insertContent("나"));
  expect(fake.sentOf("typing")).toEqual([{ channelId: CH, conversationId: CH }]);

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

it("입력 상자 안 도구 줄 — 첨부·보내기 버튼과 입력이 한 상자에, 러너가 없으면 에이전트 칸 없음", () => {
  renderComposer();
  const toolbar = screen.getByTestId("composer-toolbar");
  expect(within(toolbar).getByRole("button", { name: "파일 첨부" })).toBeInTheDocument();
  expect(within(toolbar).getByRole("button", { name: "보내기" })).toBeInTheDocument();
  expect(screen.queryByTestId("agent-settings-bar")).toBeNull();
  // 입력과 도구 줄이 한 상자 안에
  const box = screen.getByRole("textbox", { name: "메시지 입력" });
  expect(toolbar.parentElement?.contains(box)).toBe(true);
});

describe("스레드 작성기의 「채널에도 보내기」(스레드 글 채널에도 보이기 설계)", () => {
  const ROOT = uid(500);
  function renderThreadComposer() {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    qc.setQueryData(qk.me, ME);
    qc.setQueryData(qk.people, [{ id: USER, handle: "owner", displayName: "주인", role: "owner" }]);
    qc.setQueryData(qk.agents, [DEV, FIN]);
    qc.setQueryData(qk.members(CH), [memberOf(DEV.id), memberOf(FIN.id)]);
    qc.setQueryData(invitedAgentKeys.of(CH), []);
    render(
      <QueryClientProvider client={qc}>
        <Composer channelId={CH} conversationId={CH} threadRootId={ROOT} />
      </QueryClientProvider>,
    );
    const box = screen.getByRole("textbox", { name: "스레드 답글 입력" });
    const editor = (box as unknown as { editor: Editor }).editor;
    return { box, editor };
  }
  const toggle = () => screen.getByRole("checkbox", { name: "채널에도 보내기" });
  const two = () => doc(p(mention(`a:${DEV.id}`, "dev"), t(" "), mention(`a:${FIN.id}`, "fin"), t(" 봐줘")));

  it("기본값: 서로 다른 에이전트 둘을 멘션하면 켜짐, 하나면 꺼짐", () => {
    const { editor } = renderThreadComposer();
    expect(toggle()).not.toBeChecked();
    setDoc(editor, two());
    expect(toggle()).toBeChecked();
    setDoc(editor, doc(p(mention(`a:${DEV.id}`, "dev"), t(" 봐줘"))));
    expect(toggle()).not.toBeChecked();
  });

  it("사람이 손대면 초안이 바뀌어도 그 값 — 보낼 때 그 값을 alsoInChannel 로 명시, 보낸 뒤 다시 자동", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderThreadComposer();
    setDoc(editor, two());
    await userEvent.click(toggle());
    expect(toggle()).not.toBeChecked();
    setDoc(editor, doc(p(mention(`a:${DEV.id}`, "dev"), t(" "), mention(`a:${FIN.id}`, "fin"), t(" 다시"))));
    expect(toggle()).not.toBeChecked();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")[0]).toMatchObject({ threadRootId: ROOT, alsoInChannel: false });
    await waitFor(() => expect(editor.isEmpty).toBe(true));

    setDoc(editor, two());
    expect(toggle()).toBeChecked();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")[1]).toMatchObject({ alsoInChannel: true });
    setDoc(editor, doc(p(t("혼잣말"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")[2]).toMatchObject({ alsoInChannel: false });
  });

  it("세션 작성기에는 체크가 없다", () => {
    renderComposer();
    expect(screen.queryByRole("checkbox", { name: "채널에도 보내기" })).toBeNull();
  });
});

describe("링크한 메시지 미리보기 카드(메시지 링크 스펙)", () => {
  const LINKED_ID = "01a00000-0000-7000-8000-000000077001";
  const linkText = () => `${window.location.origin}/c/${CH}/s/${CH}?m=${LINKED_ID}`;
  const seed = (qc: ReturnType<typeof renderComposer>["qc"]) =>
    qc.setQueryData(["message", LINKED_ID], {
      message: {
        id: LINKED_ID,
        channelId: CH,
        conversationId: CH,
        seq: 3,
        kind: "normal",
        authorType: "user",
        authorId: USER,
        bodyMd: "스키마 변경안 정리했습니다",
        mentions: { users: [], agents: [] },
        attachments: [],
        interactions: [],
        reactions: [],
        createdAt: "2026-11-25T05:11:00.000Z",
      },
      channelKind: "channel",
      channelName: "dodok-dev",
      conversationTitle: "스레드 UI 개선",
    });
  const cards = () => screen.queryAllByRole("button", { name: /^링크한 메시지 — / });

  it("링크를 붙여넣으면 작성기 위에 카드, ✕ 는 카드만 닫고 본문 링크는 남는다", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor, qc } = renderComposer();
    seed(qc);
    const text = linkText();
    fireEvent.paste(box, {
      clipboardData: {
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? text : ""),
      },
    });
    // jsdom 의 붙여넣기가 글을 넣지 않으면 같은 글을 넣는다 — 시험하는 것은 본문의 링크가 카드가 되는가다
    if (!editor.getText().includes(text)) setDoc(editor, doc(p(t(text))));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cards()[0]).toHaveAccessibleName(/주인: 스키마 변경안 정리했습니다/);
    expect(cards()[0]).toHaveTextContent("# dodok-dev · 스레드 UI 개선");
    await userEvent.click(screen.getByRole("button", { name: "인용 미리보기 닫기" }));
    expect(cards()).toHaveLength(0);
    expect(editor.getText()).toContain(text);
    // 사라진 ✕ 대신 입력이 초점을 받는다 — 이어서 Enter 로 보낸다
    await flushEditorFrames();
    expect(box).toHaveFocus();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toMatchObject([{ bodyMd: text }]);
  });

  it("못 읽는 링크(null)면 카드가 없다", async () => {
    const { editor, qc } = renderComposer();
    qc.setQueryData(["message", LINKED_ID], null);
    setDoc(editor, doc(p(t(`봐 ${linkText()}`))));
    await act(async () => {});
    expect(cards()).toHaveLength(0);
  });
});
