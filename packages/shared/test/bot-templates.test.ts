import { describe, expect, it } from "vitest";
import { BOT_TEMPLATE_IDS, BOT_TEMPLATES, RunnerBotDefinition } from "../src";

describe("봇 템플릿(러너 봇 스펙 B5)", () => {
  it("넷 — 리뷰·릴리스·지원·빈 봇 순서", () => {
    expect(BOT_TEMPLATES.map((t) => t.id)).toEqual(["review", "release", "support", "blank"]);
    expect(BOT_TEMPLATE_IDS).toEqual(["review", "release", "support", "blank"]);
  });

  it.each(BOT_TEMPLATES.map((t) => [t.id, t] as const))("%s 의 네 칸이 정의 상한 안", (_, t) => {
    expect(RunnerBotDefinition.safeParse(t.definition).success).toBe(true);
    expect(t.label.length).toBeGreaterThan(0);
  });

  it("빈 봇만 네 칸이 비었다", () => {
    for (const t of BOT_TEMPLATES) {
      const filled = Object.values(t.definition).every((v) => v.trim() !== "");
      expect(filled, t.id).toBe(t.id !== "blank");
    }
  });
});
