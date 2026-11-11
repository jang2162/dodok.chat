import { SIDEBAR_LIMITS, type SidebarSection } from "@dodok/shared";
import { ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import { type FormEvent, useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Input } from "@/ui/input";
import { Label } from "@/ui/label";
import type { useSectionDnd } from "./dnd";
import { moveSection, removeSection, renameSection, setCollapsed } from "./layout";
import { useUpdateSidebar } from "./queries";

/**
 * 섹션 머리(사이드바 섹션 스펙 5장 「웹」) — 이름(누르면 접기·펴기), 접혔을 때 안 읽은 것이 있으면 점(B9), 「⋯」(이름 바꾸기·위로·
 * 아래로·지우기). 지우면 안의 것은 기본 절로 돌아간다(B7)
 */
export function SectionHeader({
  section,
  index,
  count,
  unread,
  listId,
  dnd,
}: {
  section: SidebarSection;
  index: number;
  count: number;
  /** 접힌 섹션 안에 안 읽은 것이 있는가 */
  unread: boolean;
  /** 접고 펴는 목록의 id(aria-controls) */
  listId: string;
  /** 끌어다 놓기 — 머리 전체가 마우스·터치 손잡이이자 항목을 놓는 자리, 키보드는 이름 단추에서 스페이스 */
  dnd: Pick<ReturnType<typeof useSectionDnd>, "headerRef" | "headerProps" | "handleRef" | "handleProps">;
}) {
  const update = useUpdateSidebar();
  const [renaming, setRenaming] = useState(false);
  const Chevron = section.collapsed ? ChevronRightIcon : ChevronDownIcon;
  const showDot = section.collapsed && unread;
  return (
    <div
      ref={dnd.headerRef}
      {...dnd.headerProps}
      className="group/section flex touch-manipulation items-center gap-1 rounded-md pt-2 pr-1 pl-1 data-over:bg-sidebar-accent data-over:ring-1 data-over:ring-sidebar-ring"
    >
      <button
        ref={dnd.handleRef}
        {...dnd.handleProps}
        type="button"
        aria-expanded={!section.collapsed}
        aria-controls={listId}
        onClick={() => update((l) => setCollapsed(l, section.id, !section.collapsed))}
        // 스페이스는 끌기 들기·놓기다 — 단추의 스페이스 누르기(keyup 의 클릭)로 접히지 않게. 접기는 엔터·클릭
        onKeyUp={(e) => {
          if (e.code === "Space") e.preventDefault();
        }}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-0.5 text-left text-xs font-medium text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <Chevron className="size-3.5 shrink-0" aria-hidden />
        <span className={cn("truncate", showDot && "font-semibold text-sidebar-foreground")}>
          {section.name}
        </span>
        {showDot && (
          <>
            <span
              data-section-unread
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-sidebar-foreground"
            />
            <span className="sr-only"> (안 읽음)</span>
          </>
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`${section.name} 섹션 메뉴`}
            className="text-muted-foreground opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRenaming(true)}>이름 바꾸기</DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === 0}
            onSelect={() => update((l) => moveSection(l, section.id, index - 1))}
          >
            위로
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={index === count - 1}
            onSelect={() => update((l) => moveSection(l, section.id, index + 1))}
          >
            아래로
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => update((l) => removeSection(l, section.id))}
          >
            지우기
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SectionNameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="섹션 이름 바꾸기"
        submitLabel="저장"
        initial={section.name}
        onSubmit={(name) => update((l) => renameSection(l, section.id, name))}
      />
    </div>
  );
}

/** 섹션 이름 대화상자 — 만들기·이름 바꾸기가 함께 쓴다. 이름은 앞뒤 공백을 깎아 1~40자(B8) */
export function SectionNameDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  initial = "",
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  initial?: string;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const nameId = useId();
  // 열 때마다 처음 값에서 시작한다
  useEffect(() => {
    if (open) setName(initial);
  }, [open, initial]);
  const trimmed = name.trim();
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!trimmed) return;
    onSubmit(trimmed);
    onOpenChange(false);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={nameId}>이름</Label>
            <Input
              id={nameId}
              value={name}
              maxLength={SIDEBAR_LIMITS.nameMax}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="submit" disabled={!trimmed}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
