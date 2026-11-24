import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InlineActivity, REASONING_TRUNCATED_NOTE } from "./InlineActivity";
import type { ActivityRow } from "./timeline";

const reasoning = (over: Partial<Extract<ActivityRow, { kind: "reasoning" }>> = {}): ActivityRow => ({
  kind: "reasoning",
  key: "reasoning:1",
  text: "테스트 실패 원인부터 보자\n**굵게** 아님",
  state: "done",
  ...over,
});
const tool = (n: number, over: Partial<Extract<ActivityRow, { kind: "tool" }>> = {}): ActivityRow => ({
  kind: "tool",
  key: `tool:t${n}`,
  toolCallId: `t${n}`,
  name: n === 1 ? "Read" : "Bash",
  args: "{}",
  result: "ok",
  ok: true,
  state: "done",
  ...over,
});

const summaryButton = () => screen.getByRole("button", { name: /^활동/ });

describe("InlineActivity", () => {
  it("요약 줄은 「활동 · 추론 · 도구 4 · 12초」, 접힘이 기본(aria-expanded=false)이고 줄은 숨는다", () => {
    render(
      <InlineActivity
        rows={[reasoning(), tool(1), tool(2), tool(3), tool(4)]}
        summary={{ reasoning: true, tools: 4, durationMs: 12_000 }}
      />,
    );
    expect(summaryButton()).toHaveTextContent("활동 · 추론 · 도구 4 · 12초");
    expect(summaryButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("list", { name: "응답 활동" })).not.toBeInTheDocument();
  });

  it("펼치면 추론 전체(마크다운 해석 없이)와 도구 줄", async () => {
    render(<InlineActivity rows={[reasoning(), tool(1)]} summary={{ reasoning: true, tools: 1 }} />);
    await userEvent.click(summaryButton());
    expect(summaryButton()).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("list", { name: "응답 활동" });
    // 줄바꿈까지 그대로 — **굵게** 가 strong 이 되지 않는다
    expect(list.querySelector("[data-slot=reasoning-row] p")?.textContent).toBe(
      "테스트 실패 원인부터 보자\n**굵게** 아님",
    );
    expect(list.querySelector("strong")).toBeNull();
    expect(screen.getByRole("button", { name: "Read 인자 보기" })).toBeInTheDocument();
  });

  it("행이 없으면 아무것도 그리지 않는다(바로 답한 런)", () => {
    const { container } = render(<InlineActivity rows={[]} summary={{ reasoning: false, tools: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("잘린 추론은 「추론이 길어 일부만 남겼습니다」, 글 없는 추론은 「생각 중…」", () => {
    render(
      <InlineActivity
        defaultOpen
        rows={[reasoning({ truncated: true }), reasoning({ key: "reasoning:9", text: "", state: "running" })]}
        summary={{ reasoning: true, tools: 0 }}
      />,
    );
    expect(screen.getByText(REASONING_TRUNCATED_NOTE)).toBeInTheDocument();
    expect(screen.getByText("생각 중…")).toBeInTheDocument();
  });

  it("진행 중 도구 줄에는 진행 표시", () => {
    render(
      <InlineActivity
        defaultOpen
        live
        rows={[tool(2, { state: "running", result: undefined, ok: undefined })]}
        summary={{ reasoning: false, tools: 1 }}
      />,
    );
    expect(screen.getByRole("img", { name: "실행 중" })).toBeInTheDocument();
  });

  it("아직 모르는 활동(rows 없음)도 notice 가 있으면 요약 「활동」만 그리고, 펼치면 notice", async () => {
    render(<InlineActivity rows={undefined} summary={undefined} notice="불러오는 중…" />);
    expect(summaryButton()).toHaveTextContent(/^활동$/);
    await userEvent.click(summaryButton());
    expect(screen.getByText("불러오는 중…")).toBeInTheDocument();
  });
});
