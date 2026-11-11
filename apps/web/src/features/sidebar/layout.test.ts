import type { SidebarLayout } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  addSection,
  moveItem,
  moveSection,
  removeSection,
  renameSection,
  sectionedIds,
  sectionOf,
  setCollapsed,
} from "./layout";

const S1 = "01a09fc9-d204-7551-89d6-38544d07a101";
const S2 = "01a09fc9-d204-7551-89d6-38544d07a102";
const S3 = "01a09fc9-d204-7551-89d6-38544d07a103";
const base: SidebarLayout = {
  sections: [
    { id: S1, name: "업무", collapsed: false, items: ["a", "b", "c"] },
    { id: S2, name: "개인", collapsed: true, items: ["d"] },
  ],
};
const items = (l: SidebarLayout) => l.sections.map((s) => s.items);

describe("sidebar layout — 순수 함수", () => {
  it("sectionedIds·sectionOf", () => {
    expect([...sectionedIds(base)].sort()).toEqual(["a", "b", "c", "d"]);
    expect(sectionOf(base, "d")).toBe(S2);
    expect(sectionOf(base, "z")).toBeUndefined();
  });

  it("moveItem — 다른 섹션으로(빠지고 그 자리에), 같은 섹션 안 순서, 넘치는 index 는 맨 아래, null 은 빼기", () => {
    expect(items(moveItem(base, "b", { sectionId: S2, index: 0 }))).toEqual([
      ["a", "c"],
      ["b", "d"],
    ]);
    expect(items(moveItem(base, "a", { sectionId: S1, index: 2 }))).toEqual([["b", "c", "a"], ["d"]]);
    expect(items(moveItem(base, "z", { sectionId: S2, index: 99 }))).toEqual([
      ["a", "b", "c"],
      ["d", "z"],
    ]);
    expect(items(moveItem(base, "c", null))).toEqual([["a", "b"], ["d"]]);
    // 없는 섹션으로는 옮기지 않는다 — 항목을 잃지 않게
    expect(moveItem(base, "a", { sectionId: S3, index: 0 })).toBe(base);
    // 받은 배치는 그대로
    expect(items(base)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("moveItem 결과는 늘 계약을 지킨다(한 항목은 한 섹션에만)", () => {
    const moved = moveItem(moveItem(base, "a", { sectionId: S2, index: 1 }), "a", {
      sectionId: S1,
      index: 0,
    });
    const all = moved.sections.flatMap((x) => x.items);
    expect(new Set(all).size).toBe(all.length);
    expect(items(moved)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("addSection 은 맨 아래·빈 채·펼친 채, 이름 앞뒤 공백을 깎는다", () => {
    const added = addSection(base, "  새 섹션 ", S3);
    expect(added.sections.at(-1)).toEqual({ id: S3, name: "새 섹션", collapsed: false, items: [] });
  });

  it("renameSection·setCollapsed", () => {
    expect(renameSection(base, S1, " 회사 ").sections[0]?.name).toBe("회사");
    expect(setCollapsed(base, S1, true).sections[0]?.collapsed).toBe(true);
    expect(setCollapsed(base, S2, false).sections[1]?.collapsed).toBe(false);
  });

  it("removeSection 은 섹션만 지운다 — 안의 항목은 어느 섹션에도 없게 된다(기본 절로)", () => {
    const removed = removeSection(base, S1);
    expect(removed.sections.map((s) => s.id)).toEqual([S2]);
    expect(sectionedIds(removed).has("a")).toBe(false);
  });

  it("moveSection — 위로·아래로·넘치는 index", () => {
    const three = addSection(base, "셋", S3);
    expect(moveSection(three, S3, 0).sections.map((s) => s.id)).toEqual([S3, S1, S2]);
    expect(moveSection(three, S1, 1).sections.map((s) => s.id)).toEqual([S2, S1, S3]);
    expect(moveSection(three, S1, 99).sections.map((s) => s.id)).toEqual([S2, S3, S1]);
    expect(moveSection(three, "nope", 0)).toBe(three);
  });
});
