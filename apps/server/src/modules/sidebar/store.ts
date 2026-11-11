import { EMPTY_SIDEBAR_LAYOUT, type SidebarLayout } from "@dodok/shared";
import { eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "../../db/client";
import { channels, userSidebarLayouts } from "../../db/schema.sqlite";

// 사이드바 개인 섹션의 저장(사이드바 섹션 스펙 5장) — 사람마다 배치 한 벌, 통째로 읽고 쓴다

/** 그 사람의 배치 — 행이 없으면 빈 배치. 저장된 그대로다: 지금 읽을 수 없는 채널 id 도 들어 있다(화면이 그리지 않는다) */
export function getSidebarLayout(db: DbOrTx, userId: string): SidebarLayout {
  const row = db
    .select({ layout: userSidebarLayouts.layoutJson })
    .from(userSidebarLayouts)
    .where(eq(userSidebarLayouts.userId, userId))
    .get();
  return row?.layout ?? EMPTY_SIDEBAR_LAYOUT;
}

/**
 * 배치를 통째로 바꾸고 저장한 배치를 돌려준다. DB 에 없는(지워진) 채널 id 만 걷는다 — 보관·잠시 접근을 잃은 채널은 되살아나면 원래
 * 섹션 자리로 돌아오도록 남긴다(B7). 그래서 읽을 수 있는지는 여기서 보지 않는다: 남는 id 는 채널 id 뿐이고 화면이 지금 목록에 없는
 * id 를 그리지 않는다
 */
export function saveSidebarLayout(
  db: DbOrTx,
  userId: string,
  layout: SidebarLayout,
  now: Date = new Date(),
): SidebarLayout {
  const ids = layout.sections.flatMap((s) => s.items);
  const existing =
    ids.length === 0
      ? new Set<string>()
      : new Set(
          db
            .select({ id: channels.id })
            .from(channels)
            .where(inArray(channels.id, ids))
            .all()
            .map((r) => r.id),
        );
  const saved: SidebarLayout = {
    sections: layout.sections.map((s) => ({ ...s, items: s.items.filter((id) => existing.has(id)) })),
  };
  db.insert(userSidebarLayouts)
    .values({ userId, layoutJson: saved, updatedAt: now })
    .onConflictDoUpdate({
      target: userSidebarLayouts.userId,
      set: { layoutJson: saved, updatedAt: now },
    })
    .run();
  return saved;
}
