import type { RunnerContextBreakdown } from "@dodok/shared";
import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextGauge, DEFERRED_HEADING, formatTokens, OVER_WINDOW } from "./ContextGauge";

const CONTEXT: RunnerContextBreakdown = {
  model: "claude-opus-5-5",
  totalTokens: 248_500,
  maxTokens: 800_000,
  percentage: 31.1,
  categories: [
    { name: "Messages", tokens: 215_200, kind: "used" },
    { name: "System tools", tokens: 17_600, kind: "used" },
    { name: "Memory files", tokens: 0, kind: "used" },
    { name: "Free space", tokens: 518_400, kind: "free" },
    { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
    { name: "MCP tools (deferred)", tokens: 21_900, kind: "deferred" },
    { name: "System tools (deferred)", tokens: 0, kind: "deferred" },
  ],
};

/** 키보드 초점으로 연다 — 호버 없이도 열려야 한다(작성기 칩 스펙 5.4) */
async function focusGauge(name: string) {
  const trigger = screen.getByRole("button", { name });
  act(() => trigger.focus());
  return screen.findByRole("tooltip");
}

describe("formatTokens", () => {
  it("248.5k·800k·1.2M·1M·999", () => {
    expect(formatTokens(248_500)).toBe("248.5k");
    expect(formatTokens(800_000)).toBe("800k");
    expect(formatTokens(1_200_000)).toBe("1.2M");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(999)).toBe("999");
  });
});

describe("ContextGauge [작성기 칩 스펙 5.4·C8]", () => {
  it("shows — without runs", async () => {
    render(<ContextGauge percent={null} context={null} />);
    const trigger = screen.getByRole("button", { name: "컨텍스트 —" });
    expect(trigger).toHaveTextContent("—");
    const tip = await focusGauge("컨텍스트 —");
    expect(tip).toHaveTextContent("컨텍스트 —");
  });

  it("focus opens breakdown with 248.5k / 800k", async () => {
    render(<ContextGauge percent={31} context={CONTEXT} />);
    expect(screen.getByRole("button", { name: "컨텍스트 31%" })).toHaveTextContent("31%");
    const tip = await focusGauge("컨텍스트 31%");
    expect(tip).toHaveTextContent("248.5k / 800k");
    // 창 안 줄은 창 비율(소수 한 자리)
    expect(tip).toHaveTextContent("Messages26.9%");
    expect(tip).toHaveTextContent("Free space64.8%");
    expect(tip).toHaveTextContent("Autocompact buffer4.1%");
    expect(tip).not.toHaveTextContent(OVER_WINDOW);
  });

  it("옛 러너 런(항목 없는 세부)은 `사용/창` 한 줄만", async () => {
    render(
      <ContextGauge
        percent={42}
        context={{ model: "", totalTokens: 42_000, maxTokens: 100_000, percentage: 42, categories: [] }}
      />,
    );
    const tip = await focusGauge("컨텍스트 42%");
    expect(tip).toHaveTextContent("42k / 100k");
    expect(within(tip).queryAllByRole("list")).toEqual([]);
    expect(tip).not.toHaveTextContent("컨텍스트 42%");
    expect(tip).not.toHaveTextContent(OVER_WINDOW);
  });

  it("같은 이름의 줄이 둘이어도 둘 다 그린다", async () => {
    render(
      <ContextGauge
        percent={10}
        context={{
          model: "m",
          totalTokens: 20_000,
          maxTokens: 200_000,
          percentage: 10,
          categories: [
            { name: "Messages", tokens: 10_000, kind: "used" },
            { name: "Messages", tokens: 10_000, kind: "used" },
          ],
        }}
      />,
    );
    const tip = await focusGauge("컨텍스트 10%");
    expect(
      within(tip)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Messages5.0%", "Messages5.0%"]);
  });

  it("hides zero rows", async () => {
    render(<ContextGauge percent={31} context={CONTEXT} />);
    const tip = await focusGauge("컨텍스트 31%");
    expect(tip).not.toHaveTextContent("Memory files");
    expect(tip).not.toHaveTextContent("System tools (deferred)");
  });

  it("deferred rows under 불러올 때만 — 토큰 수로, 창 비율 줄에는 없다", async () => {
    render(<ContextGauge percent={31} context={CONTEXT} />);
    const tip = await focusGauge("컨텍스트 31%");
    const deferred = within(tip).getByRole("list", { name: DEFERRED_HEADING });
    expect(deferred).toHaveTextContent("MCP tools (deferred)21.9k");
    expect(
      within(tip)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "Messages26.9%",
      "System tools2.2%",
      "Free space64.8%",
      "Autocompact buffer4.1%",
      "MCP tools (deferred)21.9k",
    ]);
  });

  it("over 100 shows 창 초과 — 게이지는 100%", async () => {
    render(<ContextGauge percent={100} context={{ ...CONTEXT, totalTokens: 1_040_000, percentage: 130 }} />);
    const tip = await focusGauge("컨텍스트 100%");
    expect(tip).toHaveTextContent(OVER_WINDOW);
    expect(tip).toHaveTextContent("1M / 800k");
  });

  it("세부가 없는 런(옛 러너)은 퍼센트 한 줄", async () => {
    render(<ContextGauge percent={42} context={null} />);
    const tip = await focusGauge("컨텍스트 42%");
    expect(tip).toHaveTextContent("컨텍스트 42%");
    expect(within(tip).queryAllByRole("listitem")).toEqual([]);
  });
});
