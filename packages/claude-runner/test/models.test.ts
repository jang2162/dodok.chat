import { RUNNER_EFFORTS } from "@dodok/shared";
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
    // effort 를 안 받는 모델 — 빈 목록(단계를 함께 실어도 「안 받음」이 이긴다)
    expect(toModelOptions([info({ supportsEffort: false, supportedEffortLevels: ["low"] })])).toEqual([
      { value: "opus", displayName: "Opus 5.5", efforts: [] },
    ]);
  });

  it("effort 「모름」(둘 다 없음)은 다섯 단계 — 「안 받음」과 가른다", () => {
    expect(toModelOptions([info({})])).toEqual([
      { value: "opus", displayName: "Opus 5.5", efforts: [...RUNNER_EFFORTS] },
    ]);
    expect(toModelOptions([info({ supportsEffort: true })])[0]!.efforts).toEqual([...RUNNER_EFFORTS]);
  });

  it("rows without effort keys are [] when another row has them", () => {
    // 실제 CLI 의 꼴 — effort 를 받는 모델에만 두 키를 함께 싣고 안 받는 모델(Haiku)은 둘 다 뺀다
    expect(toModelOptions(FAKE_MODELS).find((m) => m.value === "haiku")!.efforts).toEqual([]);
    // 한 키만 실어도 이 CLI 는 effort 를 아는 판이다
    expect(
      toModelOptions([info({ value: "a", supportsEffort: true }), info({ value: "b" })]).map(
        (m) => m.efforts,
      ),
    ).toEqual([[...RUNNER_EFFORTS], []]);
    expect(
      toModelOptions([info({ value: "a" }), info({ value: "b", supportedEffortLevels: ["low"] })]).map(
        (m) => m.efforts,
      ),
    ).toEqual([[], ["low"]]);
  });

  it("all rows without effort keys get all five", () => {
    expect(
      toModelOptions([info({ value: "a" }), info({ value: "b", displayName: "B" })]).map((m) => m.efforts),
    ).toEqual([[...RUNNER_EFFORTS], [...RUNNER_EFFORTS]]);
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
      info({ value: "long", displayName: "가".repeat(120), supportsEffort: false }),
    ]);
    expect(got).toEqual([{ value: "long", displayName: "가".repeat(80), efforts: [] }]);
  });
});
