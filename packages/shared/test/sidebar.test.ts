import { describe, expect, it } from "vitest";
import * as root from "../src/index";
import { EMPTY_SIDEBAR_LAYOUT, SidebarLayout, SidebarSection } from "../src/sidebar";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const section = (n: number, items: string[] = []) => ({
  id: ID(n),
  name: `섹션 ${n}`,
  collapsed: false,
  items,
});

describe("SidebarLayout", () => {
  it("정상 배치를 받는다 — 이름은 앞뒤 공백을 깎는다", () => {
    const parsed = SidebarLayout.parse({
      sections: [{ ...section(1, [ID(10), ID(11)]), name: "  업무  " }, section(2, [ID(12)])],
    });
    expect(parsed.sections[0]?.name).toBe("업무");
    expect(parsed.sections[1]?.items).toEqual([ID(12)]);
    expect(SidebarLayout.parse(EMPTY_SIDEBAR_LAYOUT)).toEqual({ sections: [] });
  });

  it("섹션은 50개까지 — 51번째는 거절", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => section(i + 1));
    expect(SidebarLayout.safeParse({ sections: fifty }).success).toBe(true);
    expect(SidebarLayout.safeParse({ sections: [...fifty, section(60)] }).success).toBe(false);
  });

  it("이름은 trim 뒤 1~40자 — 공백만·41자는 거절", () => {
    expect(SidebarSection.safeParse({ ...section(1), name: "   " }).success).toBe(false);
    expect(SidebarSection.safeParse({ ...section(1), name: "가".repeat(40) }).success).toBe(true);
    expect(SidebarSection.safeParse({ ...section(1), name: "가".repeat(41) }).success).toBe(false);
  });

  it("한 채널은 한 섹션에만 — 두 섹션에 같은 id, 한 섹션 안 중복 모두 거절", () => {
    expect(SidebarLayout.safeParse({ sections: [section(1, [ID(10)]), section(2, [ID(10)])] }).success).toBe(
      false,
    );
    expect(SidebarLayout.safeParse({ sections: [section(1, [ID(10), ID(10)])] }).success).toBe(false);
  });

  it("같은 섹션 id 둘은 거절", () => {
    expect(SidebarLayout.safeParse({ sections: [section(1), section(1)] }).success).toBe(false);
  });

  it("패키지 루트에서 내보낸다", () => {
    expect(root.SidebarLayout).toBe(SidebarLayout);
    expect(root.EMPTY_SIDEBAR_LAYOUT).toBe(EMPTY_SIDEBAR_LAYOUT);
  });
});
