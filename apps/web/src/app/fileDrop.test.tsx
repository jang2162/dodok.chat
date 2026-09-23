import { fireEvent, render } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import { usePreventFileDrop } from "./fileDrop";

afterEach(() => vi.restoreAllMocks());

function Page() {
  usePreventFileDrop();
  return (
    <div>
      <div data-testid="list">목록</div>
      <input aria-label="글 칸" />
    </div>
  );
}

const files = () => ({
  dataTransfer: { types: ["Files"], files: [new File(["x"], "a.png")], dropEffect: "copy" },
});
const text = () => ({
  dataTransfer: { types: ["text/plain"], files: [], getData: () => "글", dropEffect: "copy" },
});

it("앱 어디에 파일을 끌어 놓아도 브라우저가 파일을 열지 않는다 — 놓으면 「이미지는 입력 칸에 놓아 주세요」 토스트 하나", () => {
  const info = vi.spyOn(toast, "info");
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  // fireEvent 는 preventDefault 되면 false 를 돌려준다
  expect(fireEvent.dragOver(list, files())).toBe(false);
  expect(fireEvent.drop(list, files())).toBe(false);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("이미지는 입력 칸에 놓아 주세요", { id: "drop-on-composer" });
});

it("drop 을 주지 않는 브라우저에서도 끌고 있는 동안 안내한다 — 커서는 「놓을 수 없음」", () => {
  const info = vi.spyOn(toast, "info");
  const { getByTestId } = render(<Page />);
  const dragging = files();
  expect(fireEvent.dragOver(getByTestId("list"), dragging)).toBe(false);
  expect(info).toHaveBeenCalledTimes(1);
  expect(info).toHaveBeenCalledWith("이미지는 입력 칸에 놓아 주세요", { id: "drop-on-composer" });
  expect(dragging.dataTransfer.dropEffect).toBe("none");
});

it("한 번 끌 때 토스트는 하나 — 창을 벗어났다 다시 끌어 오면 다시 알린다", () => {
  const info = vi.spyOn(toast, "info");
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  fireEvent.dragOver(list, files());
  fireEvent.dragOver(list, files());
  expect(info).toHaveBeenCalledTimes(1);

  fireEvent.dragLeave(list, { ...files(), relatedTarget: null });
  fireEvent.dragOver(list, files());
  expect(info).toHaveBeenCalledTimes(2);
});

it("글 끌어 놓기(입력 칸에 글 놓기)는 브라우저 기본 동작 그대로", () => {
  const info = vi.spyOn(toast, "info");
  const { getByLabelText } = render(<Page />);
  const box = getByLabelText("글 칸");
  expect(fireEvent.dragOver(box, text())).toBe(true);
  expect(fireEvent.drop(box, text())).toBe(true);
  expect(info).not.toHaveBeenCalled();
});

it("이미 처리한 자리(작성기처럼 스스로 막고 알린 곳)는 건드리지 않는다 — 토스트가 겹치지 않는다", () => {
  const info = vi.spyOn(toast, "info");
  const { getByTestId } = render(<Page />);
  const list = getByTestId("list");
  list.addEventListener("drop", (e) => e.preventDefault());
  fireEvent.drop(list, files());
  expect(info).not.toHaveBeenCalled();
});

it("내려가면 듣기를 멈춘다", () => {
  // 컴포넌트 밖(문서에 붙은 채 남는) 자리에 놓는다 — 창까지 올라가는 이벤트다
  const outside = document.body.appendChild(document.createElement("div"));
  const { unmount } = render(<Page />);
  expect(fireEvent.drop(outside, files())).toBe(false);
  unmount();
  expect(fireEvent.drop(outside, files())).toBe(true);
  outside.remove();
});
