import type { SidebarLayout, SidebarSection } from "@dodok/shared";

// 사이드바 개인 섹션의 배치 바꾸기(사이드바 섹션 스펙 B2·B6·B7) — 순수 함수. 받은 배치를 고치지 않고 새 배치를 돌려준다.
// 없는 섹션 id·항목 id 를 받으면 그대로 돌려준다(낡은 메뉴·끌기에서 와도 배치를 깨지 않게)

const clamp = (n: number, max: number) => Math.max(0, Math.min(n, max));

/** 어느 섹션에든 든 채널 id — 기본 두 절이 이것을 빼고 그린다 */
export function sectionedIds(layout: SidebarLayout): Set<string> {
  return new Set(layout.sections.flatMap((s) => s.items));
}

/** 그 항목이 든 섹션 id — 없으면 undefined */
export function sectionOf(layout: SidebarLayout, itemId: string): string | undefined {
  return layout.sections.find((s) => s.items.includes(itemId))?.id;
}

/**
 * 항목을 섹션의 index 자리로 옮긴다(다른 섹션에서 왔으면 거기서 뺀다 — 한 항목은 한 섹션에만, B2). index 는 옮긴 뒤 목록의 자리이고
 * 넘치면 맨 아래. `to` 가 null 이면 섹션에서 뺀다(기본 절로)
 */
export function moveItem(
  layout: SidebarLayout,
  itemId: string,
  to: { sectionId: string; index: number } | null,
): SidebarLayout {
  if (to && !layout.sections.some((s) => s.id === to.sectionId)) return layout;
  // 섹션에 없는 것을 빼면 바뀌는 것이 없다 — 저장하지 않게 같은 배치를 돌려준다
  if (!to && !layout.sections.some((s) => s.items.includes(itemId))) return layout;
  const sections = layout.sections.map((s) =>
    s.items.includes(itemId) ? { ...s, items: s.items.filter((id) => id !== itemId) } : s,
  );
  if (!to) return { sections };
  return {
    sections: sections.map((s) => {
      if (s.id !== to.sectionId) return s;
      const items = [...s.items];
      items.splice(clamp(to.index, items.length), 0, itemId);
      return { ...s, items };
    }),
  };
}

/** 새 섹션은 맨 아래, 빈 채 펼친 채 */
export function addSection(layout: SidebarLayout, name: string, id: string): SidebarLayout {
  const section: SidebarSection = { id, name: name.trim(), collapsed: false, items: [] };
  return { sections: [...layout.sections, section] };
}

const patch = (layout: SidebarLayout, id: string, change: Partial<SidebarSection>): SidebarLayout => ({
  sections: layout.sections.map((s) => (s.id === id ? { ...s, ...change } : s)),
});

export const renameSection = (layout: SidebarLayout, id: string, name: string): SidebarLayout =>
  patch(layout, id, { name: name.trim() });

export const setCollapsed = (layout: SidebarLayout, id: string, collapsed: boolean): SidebarLayout =>
  patch(layout, id, { collapsed });

/** 섹션을 지운다 — 안의 항목은 섹션에서 빠질 뿐이라 기본 절의 지금 순서 자리로 돌아간다(B7) */
export function removeSection(layout: SidebarLayout, id: string): SidebarLayout {
  return { sections: layout.sections.filter((s) => s.id !== id) };
}

/** 섹션을 index 자리로(옮긴 뒤 목록의 자리, 넘치면 맨 아래) */
export function moveSection(layout: SidebarLayout, id: string, index: number): SidebarLayout {
  const from = layout.sections.findIndex((s) => s.id === id);
  if (from < 0) return layout;
  const sections = [...layout.sections];
  const [section] = sections.splice(from, 1);
  sections.splice(clamp(index, sections.length), 0, section as SidebarSection);
  return { sections };
}
