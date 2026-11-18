import { describe, expect, it } from "vitest";
import {
  CONTEXT_USAGE_TIMEOUT_MS,
  fetchContextBreakdown,
  toContextBreakdown,
} from "../src/drivers/claude/context-usage";
import type { SdkContextUsage } from "../src/drivers/claude/sdk";
import { FAKE_CONTEXT_USAGE } from "./helpers/fake-query";

describe("toContextBreakdown(작성기 칩 스펙 5.1)", () => {
  it("toContextBreakdown drops memoryFiles/mcpTools/gridRows", () => {
    const got = toContextBreakdown(FAKE_CONTEXT_USAGE);
    expect(got).toEqual({
      model: "claude-opus-5-5",
      totalTokens: 235_900,
      maxTokens: 800_000,
      percentage: 29.4875,
      categories: [
        { name: "System prompt", tokens: 3_100, kind: "used" },
        { name: "System tools", tokens: 17_600, kind: "used" },
        { name: "Messages", tokens: 215_200, kind: "used" },
        { name: "Free space", tokens: 518_400, kind: "free" },
        { name: "Autocompact buffer", tokens: 33_000, kind: "buffer" },
        { name: "MCP tools", tokens: 21_900, kind: "deferred" },
      ],
    });
    expect(JSON.stringify(got)).not.toContain("CLAUDE.md");
    expect(JSON.stringify(got)).not.toContain("mcp__dodok__post");
  });

  it("keeps percentage over 100", () => {
    const raw = { ...FAKE_CONTEXT_USAGE, percentage: 130.5 } as SdkContextUsage;
    expect(toContextBreakdown(raw)?.percentage).toBe(130.5);
  });

  it("0 토큰 줄은 남기고, 32줄 넘으면 자르고, 긴 이름은 80자로", () => {
    const categories = Array.from({ length: 40 }, (_, i) => ({
      name: i === 0 ? "x".repeat(200) : `c${i}`,
      tokens: i === 1 ? 0 : 10,
      color: "c",
      kind: "used" as const,
    }));
    const got = toContextBreakdown({ ...FAKE_CONTEXT_USAGE, categories } as SdkContextUsage);
    expect(got?.categories).toHaveLength(32);
    expect(got?.categories[0]?.name).toHaveLength(80);
    expect(got?.categories[1]).toEqual({ name: "c1", tokens: 0, kind: "used" });
  });

  it("returns undefined on malformed", () => {
    const bad = (over: Record<string, unknown>) =>
      toContextBreakdown({ ...FAKE_CONTEXT_USAGE, ...over } as unknown as SdkContextUsage);
    expect(bad({ maxTokens: 0 })).toBeUndefined();
    expect(bad({ categories: "nope" })).toBeUndefined();
    expect(bad({ categories: [{ name: "m", tokens: 1, color: "c", kind: "weird" }] })).toBeUndefined();
    expect(bad({ percentage: "31%" })).toBeUndefined();
    expect(toContextBreakdown(null as unknown as SdkContextUsage)).toBeUndefined();
  });
});

describe("fetchContextBreakdown", () => {
  it("summary 로 묻고 줄인 모양을 돌려준다", async () => {
    const seen: unknown[] = [];
    const got = await fetchContextBreakdown({
      getContextUsage: async (opts) => {
        seen.push(opts);
        return FAKE_CONTEXT_USAGE;
      },
    });
    expect(seen).toEqual([{ detail: "summary" }]);
    expect(got?.maxTokens).toBe(800_000);
  });

  it("던지거나 시간이 넘으면 undefined — 던지지 않는다", async () => {
    expect(CONTEXT_USAGE_TIMEOUT_MS).toBe(2000);
    await expect(
      fetchContextBreakdown({ getContextUsage: () => Promise.reject(new Error("boom")) }),
    ).resolves.toBeUndefined();
    await expect(
      fetchContextBreakdown({ getContextUsage: () => new Promise(() => {}) }, 10),
    ).resolves.toBeUndefined();
  });
});
