import { expect, it } from "vitest";
import { isArchived } from "./archived";

it("archivedAt 이 시각이면 보관, null·없음은 살아 있다 — 보관 열이 생기기 전의 오프라인 사본에는 키가 없다", () => {
  expect(isArchived({ archivedAt: "2026-10-05T00:00:00.000Z" })).toBe(true);
  expect(isArchived({ archivedAt: null })).toBe(false);
  expect(isArchived({} as { archivedAt: null })).toBe(false);
});
