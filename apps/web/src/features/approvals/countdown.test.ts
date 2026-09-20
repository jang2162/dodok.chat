import { describe, expect, it } from "vitest";
import { iso } from "../../../test/fixtures";
import { remainingLabel, remainingMs } from "./countdown";

const NOW = Date.parse("2027-01-15T08:00:00.000Z");
const at = (ms: number) => iso(NOW + ms);

describe("remainingLabel", () => {
  it.each([
    [600_000, "10분 0초"],
    [120_000, "2분 0초"],
    [118_000, "1분 58초"],
    [60_000, "1분 0초"],
    [59_999, "59초"],
    [12_000, "12초"],
    [999, "0초"],
    [0, "만료됨"],
    [-5_000, "만료됨"],
  ])("남은 시간 %i ms → %s", (ms, label) => {
    expect(remainingLabel(at(ms), NOW)).toBe(label);
  });

  it("읽을 수 없는 만료 시각은 만료로 보지 않는다 — 카운트다운만 감춘다", () => {
    expect(remainingLabel("", NOW)).toBe("");
    expect(remainingLabel("어제", NOW)).toBe("");
  });
});

describe("remainingMs", () => {
  it("남은 밀리초를 그대로 — 지났으면 음수", () => {
    expect(remainingMs(at(3_000), NOW)).toBe(3_000);
    expect(remainingMs(at(-3_000), NOW)).toBe(-3_000);
  });
});
