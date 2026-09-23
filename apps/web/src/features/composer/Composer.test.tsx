import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { AGENT, CH, CH2 } from "../../../test/fixtures";
import {
  confirmed,
  doc,
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

describe("(g) 붙여넣기·끌어 놓기 — 이미지 아닌 파일(이미지는 Composer.attachments.test)", () => {
  const pdf = () => new File(["x"], "a.pdf", { type: "application/pdf" });

  it("이미지 아닌 파일만 온 붙여넣기 → 「이미지만 올릴 수 있습니다」 토스트, 본문 변화 없음", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("그대로"))));
    fireEvent.paste(box, { clipboardData: { files: [pdf()], types: ["Files"], getData: () => "" } });
    expect(toastInfo).toHaveBeenCalledWith("이미지만 올릴 수 있습니다", { id: "attach-only-images" });
    expect(editor.getJSON()).toEqual(doc(p(t("그대로"))));
    expect(screen.queryByRole("list", { name: "첨부할 이미지" })).toBeNull();
  });

  it("글과 이미지 아닌 파일이 함께 오면 글은 들어가고 파일은 알린다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("앞 "))));
    const getData = (type: string) => (type === "text/plain" ? "붙인 글" : "");
    fireEvent.paste(box, { clipboardData: { files: [pdf()], types: ["text/plain", "Files"], getData } });
    expect(toastInfo).toHaveBeenCalledWith("이미지만 올릴 수 있습니다", { id: "attach-only-images" });
    expect(editor.getText()).toBe("앞 붙인 글");
  });

  it("이미지 아닌 파일 끌어 놓기 → 토스트, 브라우저가 열지 않게 막는다", () => {
    const { box } = renderComposer();
    const dropped = fireEvent.drop(box, {
      dataTransfer: { files: [pdf()], types: ["Files"], getData: () => "" },
    });
    expect(dropped).toBe(false);
    expect(toastInfo).toHaveBeenCalledWith("이미지만 올릴 수 있습니다", { id: "attach-only-images" });
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
