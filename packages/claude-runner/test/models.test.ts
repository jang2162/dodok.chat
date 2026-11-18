import { describe, expect, it } from "vitest";
import { toModelOptions } from "../src/drivers/claude";
import type { SdkModelInfo } from "../src/drivers/claude/sdk";
import { FAKE_MODELS } from "./helpers/fake-query";

const info = (over: Partial<SdkModelInfo>): SdkModelInfo => ({
  value: "opus",
  displayName: "Opus 5.5",
  description: "d",
  ...over,
});

describe("toModelOptions(작성기 칩 스펙 C3)", () => {
  it("toModelOptions maps supportedEffortLevels", () => {
    expect(
      toModelOptions([info({ supportedEffortLevels: ["low", "max"], resolvedModel: "claude-opus-5-5" })]),
    ).toEqual([{ value: "opus", displayName: "Opus 5.5", efforts: ["low", "max"] }]);
    // effort 를 안 받는 모델 — 빈 목록
    expect(toModelOptions([info({ supportsEffort: false })])).toEqual([
      { value: "opus", displayName: "Opus 5.5", efforts: [] },
    ]);
  });

  it("keeps default row", () => {
    expect(toModelOptions(FAKE_MODELS).map((m) => m.value)).toEqual(["default", "sonnet", "haiku"]);
  });

  it("caps at 32", () => {
    const many = Array.from({ length: 40 }, (_, i) => info({ value: `m${i}` }));
    expect(toModelOptions(many)).toHaveLength(32);
  });

  it("계약에 맞지 않는 줄만 뺀다 — 빈 value·모르는 effort, 긴 표시 이름은 자른다", () => {
    const got = toModelOptions([
      info({ value: "" }),
      info({ value: "x", supportedEffortLevels: ["ultra" as "max"] }),
      info({ value: "long", displayName: "가".repeat(120) }),
    ]);
    expect(got).toEqual([{ value: "long", displayName: "가".repeat(80), efforts: [] }]);
  });
});
