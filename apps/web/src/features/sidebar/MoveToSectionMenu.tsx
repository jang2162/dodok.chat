import { SIDEBAR_LIMITS } from "@dodok/shared";
import { MoreHorizontalIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { useItemDnd } from "./dnd";
import { addSection, moveItem, sectionOf } from "./layout";
import { useSidebarLayout, useUpdateSidebar } from "./queries";
import { SectionNameDialog } from "./SectionHeader";

/** 새 섹션 id — 클라이언트가 만든다(사이드바 섹션 스펙 5장 「계약」) */
export const newSectionId = () => crypto.randomUUID();

/**
 * 사이드바 한 줄(채널·DM)의 「⋯」 — 「섹션으로 옮기기」: 다른 섹션들 / 새 섹션… / 섹션에서 빼기(B5). 옮기면 그 섹션의 맨 아래(B6).
 * 배치를 아직 못 받았으면 그리지 않는다(빈 배치로 서버의 배치를 덮지 않게)
 */
export function MoveToSectionMenu({ itemId, label }: { itemId: string; label: string }) {
  const layout = useSidebarLayout().data;
  const update = useUpdateSidebar();
  const [creating, setCreating] = useState(false);
  if (!layout) return null;
  const current = sectionOf(layout, itemId);
  const targets = layout.sections.filter((s) => s.id !== current);
  const full = layout.sections.length >= SIDEBAR_LIMITS.sections;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${label} 메뉴`}
            className="shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>섹션으로 옮기기</DropdownMenuLabel>
          {targets.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onSelect={() => update((l) => moveItem(l, itemId, { sectionId: s.id, index: Infinity }))}
            >
              <span className="truncate">{s.name}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuItem disabled={full} onSelect={() => setCreating(true)}>
            새 섹션…
          </DropdownMenuItem>
          {current !== undefined && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => update((l) => moveItem(l, itemId, null))}>
                섹션에서 빼기
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <SectionNameDialog
        open={creating}
        onOpenChange={setCreating}
        title="새 섹션"
        submitLabel="만들기"
        onSubmit={(name) => {
          const id = newSectionId();
          update((l) => moveItem(addSection(l, name, id), itemId, { sectionId: id, index: 0 }));
        }}
      />
    </>
  );
}

/**
 * 사이드바 한 줄 틀 — 링크 옆에 「⋯」, 줄 전체가 끌린다(키보드는 링크에서 스페이스). 기본 두 절(`container` null)과 섹션이 함께 쓴다
 */
export function SidebarRow({
  itemId,
  label,
  container,
  children,
}: {
  itemId: string;
  label: string;
  container: string | null;
  children: ReactNode;
}) {
  const dnd = useItemDnd(itemId, label, container);
  return (
    <div
      ref={dnd.rowRef}
      {...dnd.rowProps}
      className="group/row relative flex touch-manipulation items-center gap-0.5 rounded-md data-dragging:opacity-40 data-over:ring-1 data-over:ring-sidebar-ring"
    >
      <div className="min-w-0 flex-1">{children}</div>
      <MoveToSectionMenu itemId={itemId} label={label} />
    </div>
  );
}
