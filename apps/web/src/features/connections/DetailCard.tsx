import { EllipsisIcon } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import type { StateTone } from "./tree";

/**
 * 상세 몸통의 카드 하나(연결 재설계 스펙 목표 3) — 제목이 이름인 region, 머리 줄은 제목 · 개수 · 그 카드의 동작(고스트 버튼).
 * 「관리」처럼 되돌리기 어려운 동작을 모은 카드는 `tone="danger"`(붉은 테두리)
 */
export function DetailCard({
  title,
  count,
  action,
  tone,
  className,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  tone?: "danger";
  className?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-lg border bg-card p-4",
        tone === "danger" && "border-destructive/50",
        className,
      )}
    >
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id={headingId} className="text-sm font-semibold">
          {title}
        </h2>
        {count !== undefined && <span className="text-xs text-muted-foreground tabular-nums">{count}</span>}
        {action && <div className="ml-auto flex flex-wrap items-center gap-1">{action}</div>}
      </div>
      {children}
    </section>
  );
}

const CHIP: Record<StateTone, string> = {
  success: "bg-success/14",
  warning: "bg-warning/16",
  muted: "bg-muted-foreground/12",
};
const CHIP_DOT: Record<StateTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  muted: "bg-muted-foreground",
};

/** 상태 칩 — 점 + 글(색만으로 전하지 않는다). 바탕은 상태 토큰을 옅게 섞은 것, 강조색은 쓰지 않는다 */
export function StatusChip({
  tone,
  label,
  className,
}: {
  tone: StateTone;
  label: string;
  className?: string;
}) {
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-foreground",
        CHIP[tone],
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", CHIP_DOT[tone])} />
      {label}
    </span>
  );
}

export type OverflowMenuItem = {
  label: string;
  onSelect: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
};

/**
 * 「⋯」 메뉴 — 드물거나 위험한 동작(끄기·삭제·설치 안내 등). 버튼 이름은 「<대상> 더 보기」. 항목이 없으면 버튼도 그리지 않는다.
 * 고른 동작은 메뉴가 닫히고 초점이 「⋯」로 돌아온 뒤에 부른다(HeaderOverflow 와 같은 까닭 — 여는 대화상자가 사라질 메뉴 줄을 초점 복귀
 * 자리로 기억하지 않게). `triggerRef` 는 확인 줄을 취소했을 때 초점을 돌려줄 자리. `controls` 는 메뉴가 연 확인 줄의 id — 메뉴가
 * 닫혀 있는 동안 단추가 그 줄을 aria-controls 로 가리킨다(열려 있으면 Radix 가 메뉴를 가리킨다)
 */
export function OverflowMenu({
  label,
  items,
  triggerRef,
  controls,
}: {
  label: string;
  items: readonly OverflowMenuItem[];
  triggerRef?: RefObject<HTMLButtonElement | null>;
  controls?: string;
}) {
  const [open, setOpen] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const setTrigger = useCallback(
    (el: HTMLButtonElement | null) => {
      trigger.current = el;
      if (triggerRef) triggerRef.current = el;
    },
    [triggerRef],
  );
  if (items.length === 0) return null;
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          ref={setTrigger}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          // 키를 아예 빼야 Radix 의 메뉴 aria-controls 를 덮지 않는다(undefined 도 덮는다)
          {...(controls && !open ? { "aria-controls": controls } : {})}
        >
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-44"
        onCloseAutoFocus={(e) => {
          const run = pending.current;
          pending.current = null;
          if (!run) return;
          e.preventDefault();
          trigger.current?.focus();
          run();
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            variant={item.danger ? "destructive" : "default"}
            disabled={item.disabled}
            onSelect={() => {
              pending.current = item.onSelect;
            }}
          >
            {item.icon}
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
