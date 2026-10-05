import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/ui/dialog";
import { Toaster } from "@/ui/sonner";

it("Toaster(system 테마 — matchMedia 를 부른다)와 asChild 버튼이 jsdom 에서 뜬다", () => {
  render(
    <>
      <Toaster />
      <Button asChild>
        <a href="/agents">에이전트</a>
      </Button>
    </>,
  );
  expect(screen.getByRole("link", { name: "에이전트" })).toHaveAttribute("data-slot", "button");
});

it("Radix 대화상자가 jsdom 에서 열린다", () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogTitle>채널 만들기</DialogTitle>
        <DialogDescription>이름을 넣는다</DialogDescription>
      </DialogContent>
    </Dialog>,
  );
  expect(screen.getByRole("dialog", { name: "채널 만들기" })).toHaveAccessibleDescription("이름을 넣는다");
});

function renderDialog(title: string, className?: string) {
  const view = render(
    <Dialog open>
      <DialogContent className={className}>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>높이 상한</DialogDescription>
      </DialogContent>
    </Dialog>,
  );
  return { dialog: screen.getByRole("dialog", { name: title }), unmount: view.unmount };
}

it("대화상자는 화면 높이 안에 들고 넘치면 안에서 스크롤된다 — 부르는 쪽이 max-h 를 바꿔도 스크롤은 남는다", () => {
  const base = renderDialog("기본");
  expect(base.dialog).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
  base.unmount();
  const custom = renderDialog("덮어쓴 상한", "max-h-[85svh]").dialog;
  expect(custom).toHaveClass("max-h-[85svh]", "overflow-y-auto");
  expect(custom).not.toHaveClass("max-h-[calc(100dvh-2rem)]");
});
