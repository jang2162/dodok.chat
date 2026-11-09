import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { EMPTY_FILE, TOO_BIG } from "@/features/attachments/upload";
import { useWireStatus } from "@/realtime/wire";
import { stubEditorDom } from "../../../test/domStubs";
import { createFakeSocket, type FakeSocket } from "../../../test/fakeSocket";
import { FakeXhr, pdfFile, pngFile, stubObjectUrls, uploaded } from "../../../test/fakeXhr";
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
import { DROP_FOLDER } from "./Composer";
import { focusAfterRemove } from "./PendingAttachments";

const wire = vi.hoisted(() => ({ socket: undefined as unknown }));
vi.mock("@/realtime/WireProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/WireProvider")>()),
  useWire: () => ({ socket: wire.socket, subscriptions: undefined }),
}));

let fake: FakeSocket;
let restoreDom: () => void;
let urls: ReturnType<typeof stubObjectUrls>;
let toastInfo: MockInstance<typeof toast.info>;

beforeEach(() => {
  restoreDom = stubEditorDom();
  FakeXhr.reset();
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  urls = stubObjectUrls();
  fake = createFakeSocket();
  wire.socket = fake.wire;
  useWireStatus.getState().setStatus("connected");
  toastInfo = vi.spyOn(toast, "info");
});
afterEach(async () => {
  await flushEditorFrames();
  restoreDom();
  urls.restore();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  wire.socket = undefined;
  useWireStatus.getState().setStatus("idle");
});

const sendButton = () => screen.getByRole("button", { name: "보내기" });
const fileInput = () => document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
const chips = () => screen.queryByRole("list", { name: "첨부할 파일" });
const xhrAt = (i: number) => FakeXhr.all[i] as FakeXhr;
const finish = (i: number, a = uploaded(i + 1)) => act(async () => xhrAt(i).respond(200, a));

async function pick(...files: File[]) {
  await userEvent.click(screen.getByRole("button", { name: "파일 첨부" }));
  await userEvent.upload(fileInput(), files);
}

it("첨부 버튼으로 PNG → 칩·진행 → 끝나면 보내기가 켜지고, 보내면 attachments 에 id·칩을 비운다", async () => {
  fake.onAck("message.send", confirmed);
  const { editor } = renderComposer();
  const input = fileInput();
  // 형식을 막지 않는다 — 고르기 창이 모든 파일을 보여 준다
  expect(input).not.toHaveAttribute("accept");
  expect(input).toHaveAttribute("multiple");

  const clickInput = vi.spyOn(input, "click");
  await pick(pngFile("사진.png"));
  expect(clickInput).toHaveBeenCalled();
  expect(input.value).toBe("");

  const list = chips() as HTMLElement;
  const chip = within(list).getByRole("listitem");
  expect(within(chip).getByText("사진.png")).toBeInTheDocument();
  expect(chip.querySelector("img")).toHaveAttribute("src", "blob:1");
  act(() => xhrAt(0).progress(1, 2));
  const bar = within(chip).getByRole("progressbar", { name: "사진.png 올리는 중" });
  expect(bar).toHaveAttribute("aria-valuenow", "50");
  expect(sendButton()).toBeDisabled();

  const a = uploaded(1, "사진.png");
  await finish(0, a);
  expect(within(chip).queryByRole("progressbar")).toBeNull();
  setDoc(editor, doc(p(mention(`a:${AGENT}`, "dev"), t(" 봐 줘"))));
  expect(sendButton()).toBeEnabled();
  await userEvent.click(sendButton());

  expect(fake.sentOf("message.send")).toEqual([
    {
      channelId: CH,
      conversationId: CH,
      clientMsgId: expect.any(String),
      bodyMd: `<@a:${AGENT}> 봐 줘`,
      attachments: [a.id],
    },
  ]);
  expect(chips()).toBeNull();
  expect(editor.isEmpty).toBe(true);
  // 보낸 칩의 미리보기 URL 은 놓는다(보내는 중 항목은 서버 경로로 그린다)
  expect(urls.revoke).toHaveBeenCalledWith("blob:1");
});

it("[Review Focus 3] 글 없이 이미지만 — 보내기가 켜지고 bodyMd 는 빈 문자열, Enter 로도 간다", async () => {
  fake.onAck("message.send", confirmed);
  const { box } = renderComposer();
  await pick(pngFile());
  await finish(0);
  expect(sendButton()).toBeEnabled();
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([
    {
      channelId: CH,
      conversationId: CH,
      clientMsgId: expect.any(String),
      bodyMd: "",
      attachments: [uploaded(1).id],
    },
  ]);
});

it("올리는 중에는 보내기가 꺼지고 「파일을 올리는 중입니다」, Enter 도 보내지 않는다", async () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(t("같이 보낼 글"))));
  await pick(pngFile());
  expect(sendButton()).toBeDisabled();
  expect(sendButton()).toHaveAccessibleDescription("파일을 올리는 중입니다");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([]);
  expect(editor.getText()).toBe("같이 보낼 글");

  await finish(0);
  expect(screen.queryByText("파일을 올리는 중입니다")).toBeNull();
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toHaveLength(1);
});

it("오류 칩이 있으면 꺼지고 「올리지 못한 파일을 빼 주세요」, 빼면 켜진다", async () => {
  fake.onAck("message.send", confirmed);
  const { box, editor } = renderComposer();
  setDoc(editor, doc(p(t("글"))));
  await pick(pngFile("큰.png", 5 * 1024 * 1024 + 1));
  expect(FakeXhr.all).toHaveLength(0);
  const chip = within(chips() as HTMLElement).getByRole("listitem");
  expect(within(chip).getByText(TOO_BIG)).toHaveClass("text-destructive");
  expect(sendButton()).toBeDisabled();
  expect(sendButton()).toHaveAccessibleDescription("올리지 못한 파일을 빼 주세요");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(fake.sentOf("message.send")).toEqual([]);

  await userEvent.click(screen.getByRole("button", { name: "큰.png 빼기" }));
  expect(chips()).toBeNull();
  expect(sendButton()).toBeEnabled();
  expect(sendButton()).not.toHaveAccessibleDescription();
});

it("서버 거절도 칩에 이유 — 올리는 중 칩을 빼면 요청을 끊는다", async () => {
  renderComposer();
  await pick(pngFile("a.png"), pngFile("b.png"));
  await act(async () => xhrAt(0).respond(400, { code: "VALIDATION", message: "빈 파일이다" }));
  expect(screen.getByText("빈 파일이다")).toHaveClass("text-destructive");
  await userEvent.click(screen.getByRole("button", { name: "b.png 빼기" }));
  expect(xhrAt(1).aborted).toBe(true);
});

it("끊겼을 때는 끊김 사유가 먼저 — 올리는 중이어도 「연결되면 보낼 수 있습니다」 하나", async () => {
  useWireStatus.getState().setStatus("reconnecting");
  renderComposer();
  await pick(pngFile());
  expect(sendButton()).toBeDisabled();
  expect(sendButton()).toHaveAccessibleDescription("연결되면 보낼 수 있습니다");
  expect(screen.queryByText("파일을 올리는 중입니다")).toBeNull();
});

describe("붙여넣기·끌어 놓기", () => {
  const svg = () => new File(["<svg/>"], "x.svg", { type: "image/svg+xml" });

  it("PDF 붙여넣기 → 파일 칩(파일 아이콘·이름·크기, 미리보기 없음), 올리기 시작, 토스트 없음, 본문 변화 없음", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("그대로"))));
    fireEvent.paste(box, {
      clipboardData: { files: [pdfFile("report.pdf", 2048)], types: ["Files"], getData: () => "" },
    });
    const chip = within(chips() as HTMLElement).getByRole("listitem");
    expect(within(chip).getByText("report.pdf")).toBeInTheDocument();
    expect(within(chip).getByText("2 KB")).toBeInTheDocument();
    expect(chip.querySelector("img")).toBeNull();
    expect(chip.querySelector('[data-icon="file"]')).not.toBeNull();
    expect(urls.create).not.toHaveBeenCalled();
    expect(FakeXhr.all).toHaveLength(1);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(doc(p(t("그대로"))));
  });

  it("이미지만 붙여넣기 → 칩(올리기 시작), 본문 변화 없음, 토스트 없음", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("그대로"))));
    fireEvent.paste(box, {
      clipboardData: { files: [pngFile("image.png")], types: ["Files"], getData: () => "" },
    });
    expect(within(chips() as HTMLElement).getByText("image.png")).toBeInTheDocument();
    expect(FakeXhr.all).toHaveLength(1);
    expect(toastInfo).not.toHaveBeenCalled();
    expect(editor.getJSON()).toEqual(doc(p(t("그대로"))));
  });

  it("웹 페이지 이미지 복사(파일 + text/html, text/plain 없음) → 칩만, HTML 은 본문에 안 들어간다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("그대로"))));
    const getData = (type: string) =>
      type === "text/html" ? '<p>alt 글</p><img src="https://e.com/a.png">' : "";
    fireEvent.paste(box, {
      clipboardData: { files: [pngFile("a.png")], types: ["text/html", "Files"], getData },
    });
    expect(within(chips() as HTMLElement).getByText("a.png")).toBeInTheDocument();
    expect(editor.getJSON()).toEqual(doc(p(t("그대로"))));
  });

  it("글+이미지 붙여넣기 → 글도 들어가고 칩도 생긴다", () => {
    const { box, editor } = renderComposer();
    setDoc(editor, doc(p(t("앞 "))));
    const getData = (type: string) => (type === "text/plain" ? "붙인 글" : "");
    fireEvent.paste(box, { clipboardData: { files: [pngFile()], types: ["text/plain", "Files"], getData } });
    expect(editor.getText()).toBe("앞 붙인 글");
    expect(within(chips() as HTMLElement).getAllByRole("listitem")).toHaveLength(1);
  });

  it("이미지와 SVG 가 섞여도 둘 다 칩 — SVG 는 미리보기 없는 파일 칩(SVG 는 이미지가 아니다)", () => {
    const { box } = renderComposer();
    fireEvent.paste(box, {
      clipboardData: { files: [pngFile(), svg()], types: ["Files"], getData: () => "" },
    });
    const [png, file] = within(chips() as HTMLElement).getAllByRole("listitem");
    expect(png?.querySelector("img")).toHaveAttribute("src", "blob:1");
    expect(file?.querySelector("img")).toBeNull();
    expect(FakeXhr.all).toHaveLength(2);
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("작성기에 이미지를 끌어 놓으면 칩 — 브라우저가 파일을 열지 않게 막는다", () => {
    const { box } = renderComposer();
    const dragging = { dataTransfer: { files: [], types: ["Files"], dropEffect: "none" } };
    // 끄는 동안 「놓을 수 있음」 — 창 전역 차단(dropEffect none)이 작성기 위에서 drop 을 없애지 않게
    expect(fireEvent.dragOver(box, dragging)).toBe(false);
    expect(dragging.dataTransfer.dropEffect).toBe("copy");
    const dropped = fireEvent.drop(box, {
      dataTransfer: { files: [pngFile("끈.png")], types: ["Files"], getData: () => "" },
    });
    expect(dropped).toBe(false);
    expect(within(chips() as HTMLElement).getByText("끈.png")).toBeInTheDocument();
  });

  it("사진과 PDF 를 섞어 놓으면 칩 둘 — 보내면 메시지 attachments 둘(넣은 순서)", async () => {
    fake.onAck("message.send", confirmed);
    const { box } = renderComposer();
    const dropped = fireEvent.drop(box, {
      dataTransfer: {
        files: [pngFile("사진.png"), pdfFile("report.pdf")],
        types: ["Files"],
        getData: () => "",
      },
    });
    expect(dropped).toBe(false);
    expect(within(chips() as HTMLElement).getAllByRole("listitem")).toHaveLength(2);
    expect(toastInfo).not.toHaveBeenCalled();
    const photo = uploaded(1, "사진.png");
    const pdf = { ...uploaded(2, "report.pdf"), kind: "file" as const, mime: "application/pdf" };
    delete pdf.width;
    delete pdf.height;
    await finish(1, pdf);
    await finish(0, photo);
    await userEvent.click(sendButton());
    expect(fake.sentOf("message.send")).toEqual([
      {
        channelId: CH,
        conversationId: CH,
        clientMsgId: expect.any(String),
        bodyMd: "",
        attachments: [photo.id, pdf.id],
      },
    ]);
  });

  /** 끌어 놓은 항목 — 폴더는 `webkitGetAsEntry().isDirectory`(jsdom 은 폴더를 만들 수 없어 그 모양만 흉내 낸다) */
  const entry = (file: File, isDirectory = false) => ({
    kind: "file",
    getAsFile: () => file,
    webkitGetAsEntry: () => ({ isDirectory, isFile: !isDirectory, name: file.name }),
  });

  it("폴더는 거르고 안내 — 함께 놓은 파일만 칩이 된다(옛 「이미지만」 거름이 걸러 주던 폴더가 오류 칩이 되지 않게)", () => {
    const { box } = renderComposer();
    const folder = new File([], "사진첩");
    const png = pngFile("끈.png");
    const dropped = fireEvent.drop(box, {
      dataTransfer: {
        files: [folder, png],
        items: [entry(folder, true), entry(png)],
        types: ["Files"],
        getData: () => "",
      },
    });
    expect(dropped).toBe(false);
    const items = within(chips() as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("끈.png");
    expect(toastInfo).toHaveBeenCalledWith(DROP_FOLDER, expect.anything());
  });

  it("폴더만 놓으면 칩 없이 안내만 — 브라우저가 폴더를 열지 않게 막는다", () => {
    const { box } = renderComposer();
    const folder = new File([], "사진첩");
    const dropped = fireEvent.drop(box, {
      dataTransfer: { files: [folder], items: [entry(folder, true)], types: ["Files"], getData: () => "" },
    });
    expect(dropped).toBe(false);
    expect(chips()).toBeNull();
    expect(toastInfo).toHaveBeenCalledWith(DROP_FOLDER, expect.anything());
  });

  it("items 는 있는데 webkitGetAsEntry 가 없는 브라우저 — 폴더를 가릴 수 없으니 items 의 파일을 그대로 칩으로", () => {
    const { box } = renderComposer();
    const png = pngFile("끈.png");
    fireEvent.drop(box, {
      dataTransfer: {
        files: [],
        items: [{ kind: "file", getAsFile: () => png }],
        types: ["Files"],
        getData: () => "",
      },
    });
    const items = within(chips() as HTMLElement).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("끈.png");
    expect(toastInfo).not.toHaveBeenCalled();
  });

  it("칩 이름·title·aria-label 에 방향 제어 문자가 없다 — invoice<U+202E>fdp.exe 가 invoiceexe.pdf 로 보이지 않게", () => {
    const { box } = renderComposer();
    fireEvent.drop(box, {
      dataTransfer: { files: [pdfFile("invoice\u202Efdp.exe", 10)], types: ["Files"], getData: () => "" },
    });
    const chip = within(chips() as HTMLElement).getByRole("listitem");
    expect(within(chip).getByText("invoicefdp.exe")).toHaveAttribute("title", "invoicefdp.exe");
    expect(within(chip).getByRole("button", { name: "invoicefdp.exe 빼기" })).toBeInTheDocument();
    expect(within(chip).getByRole("progressbar")).toHaveAttribute("aria-label", "invoicefdp.exe 올리는 중");
    expect(chip.outerHTML).not.toMatch(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/);
  });

  it("빈 파일은 서버에 보내지 않고 칩에 웹 문구", () => {
    const { box } = renderComposer();
    fireEvent.drop(box, {
      dataTransfer: { files: [new File([], "notes.txt")], types: ["Files"], getData: () => "" },
    });
    const [chip] = within(chips() as HTMLElement).getAllByRole("listitem");
    expect(within(chip as HTMLElement).getByText(EMPTY_FILE)).toHaveClass("text-destructive");
    expect(FakeXhr.all).toHaveLength(0);
  });

  it("이미지 상한·파일 상한을 칩마다 따로 — 큰 사진은 「5 MB 를 넘습니다」, 같은 크기의 PDF 는 올린다", () => {
    const { box } = renderComposer();
    fireEvent.drop(box, {
      dataTransfer: {
        files: [pngFile("큰.png", 5 * 1024 * 1024 + 1), pdfFile("큰.pdf", 5 * 1024 * 1024 + 1)],
        types: ["Files"],
        getData: () => "",
      },
    });
    const [png, pdf] = within(chips() as HTMLElement).getAllByRole("listitem");
    expect(within(png as HTMLElement).getByText(TOO_BIG)).toHaveClass("text-destructive");
    expect(
      within(pdf as HTMLElement).getByRole("progressbar", { name: "큰.pdf 올리는 중" }),
    ).toBeInTheDocument();
    expect(FakeXhr.all).toHaveLength(1);
  });
});

describe("슬래시 명령과 첨부", () => {
  it("/stop 은 명령으로만 처리하고 칩은 남긴다", async () => {
    fake.onAck("message.send", confirmed);
    const { box, editor } = renderComposer();
    await pick(pngFile("남을.png"));
    await finish(0);
    setDoc(editor, doc(p(t("/stop"))));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(toastInfo).toHaveBeenCalledWith("진행 중인 실행이 없습니다");
    expect(fake.sentOf("message.send")).toEqual([]);
    expect(editor.isEmpty).toBe(true);
    expect(within(chips() as HTMLElement).getByText("남을.png")).toBeInTheDocument();
    // 칩은 그대로 보낼 수 있다
    expect(sendButton()).toBeEnabled();
  });
});

it("채널을 옮기면 칩을 비우고 올리던 것을 끊는다(첨부는 채널별로 들고 다니지 않는다)", async () => {
  const { box, rerender } = renderComposer();
  await pick(pngFile());
  box.focus();
  act(() => rerender(CH2));
  expect(xhrAt(0).aborted).toBe(true);
  expect(chips()).toBeNull();
  // 훅 안의 비우기다 — 칩 빼기처럼 초점을 옆 칩·「파일 첨부」로 옮기지 않는다
  expect(document.activeElement).toBe(box);
});

describe("칩을 빼면 초점을 옮긴다 — body 로 떨어지지 않게", () => {
  const removeButton = (name: string) => screen.getByRole("button", { name: `${name} 빼기` });

  it("focusAfterRemove: 다음 칩 → 이전 칩 → 없으면 null", () => {
    expect(focusAfterRemove(["a", "b", "c"], "b")).toBe("c");
    expect(focusAfterRemove(["a", "b", "c"], "c")).toBe("b");
    expect(focusAfterRemove(["a"], "a")).toBeNull();
    expect(focusAfterRemove(["a", "b"], "없음")).toBeNull();
  });

  it("세 칩에서 가운데를 빼면 셋째 칩의 빼기 버튼으로 — 키보드", async () => {
    renderComposer();
    await pick(pngFile("a.png"), pngFile("b.png"), pngFile("c.png"));
    removeButton("b.png").focus();
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("button", { name: "b.png 빼기" })).toBeNull();
    expect(document.activeElement).toBe(removeButton("c.png"));
  });

  it("마지막 칩을 빼면 이전 칩의 빼기 버튼으로 — 마우스", async () => {
    renderComposer();
    await pick(pngFile("a.png"), pngFile("b.png"), pngFile("c.png"));
    await userEvent.click(removeButton("c.png"));
    expect(document.activeElement).toBe(removeButton("b.png"));
  });

  it("하나 남은 칩을 빼면 「파일 첨부」 버튼으로", async () => {
    renderComposer();
    await pick(pngFile("a.png"));
    await userEvent.click(removeButton("a.png"));
    expect(chips()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "파일 첨부" }));
  });

  it("보낸 뒤 칩을 비울 때는 초점을 옮기지 않는다 — 편집기에 남는다", async () => {
    fake.onAck("message.send", confirmed);
    const { box } = renderComposer();
    await pick(pngFile("a.png"), pngFile("b.png"));
    await finish(0);
    await finish(1);
    box.focus();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(fake.sentOf("message.send")).toHaveLength(1);
    expect(chips()).toBeNull();
    expect(document.activeElement).toBe(box);
  });
});
