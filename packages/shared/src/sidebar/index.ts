import { z } from "zod";
import { Id } from "../common";

// 사이드바 개인 섹션(사이드바 섹션 스펙 B1~B9) — 사람마다 배치 한 벌, 본인만 읽고 쓴다.
// 배열 순서가 화면 순서다. items 는 채널 id(DM·그룹 DM 도 채널이다)

export const SIDEBAR_LIMITS = { sections: 50, nameMax: 40, items: 1000 } as const;

export const SidebarSection = z.object({
  /** 클라이언트가 만든 UUID */
  id: Id,
  name: z.string().trim().min(1).max(SIDEBAR_LIMITS.nameMax),
  collapsed: z.boolean(),
  items: z.array(Id).max(SIDEBAR_LIMITS.items),
});
export type SidebarSection = z.infer<typeof SidebarSection>;

/** 섹션 id 는 겹치지 않고, 한 채널은 섹션 하나에만(B2) — 섹션 사이에서도 항목 id 가 겹치면 거절 */
export const SidebarLayout = z
  .object({ sections: z.array(SidebarSection).max(SIDEBAR_LIMITS.sections) })
  .superRefine((layout, ctx) => {
    const sectionIds = new Set<string>();
    const itemIds = new Set<string>();
    layout.sections.forEach((section, i) => {
      if (sectionIds.has(section.id))
        ctx.addIssue({ code: "custom", path: ["sections", i, "id"], message: "duplicate section id" });
      sectionIds.add(section.id);
      section.items.forEach((item, j) => {
        if (itemIds.has(item))
          ctx.addIssue({
            code: "custom",
            path: ["sections", i, "items", j],
            message: "item is in more than one place",
          });
        itemIds.add(item);
      });
    });
  });
export type SidebarLayout = z.infer<typeof SidebarLayout>;

export const EMPTY_SIDEBAR_LAYOUT: SidebarLayout = { sections: [] };
