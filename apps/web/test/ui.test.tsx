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
