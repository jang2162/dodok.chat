import { EllipsisIcon } from "lucide-react";
import { Fragment, type ReactNode, type RefObject, useCallback, useRef } from "react";
import { Button } from "@/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

export type OverflowItem = {
  key: string;
  /** 데스크톱 단추의 접근 이름 그대로 */
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** 되돌릴 수 없는 동작(「세션 닫기」) — 붉은 글 */
  destructive?: boolean;
  separatorBefore?: boolean;
};

/**
 * 좁은 화면 대화 머리의 「더 보기」(스펙 2026-11-19 U6) — 데스크톱 머리의 단추들을 같은 순서로 메뉴 줄에 둔다. 단추·줄은 44px.
 *
 * 고른 동작은 메뉴가 다 닫히고 초점이 「더 보기」로 돌아온 **뒤에** 부른다(`onCloseAutoFocus`). 대화상자를 여는 동작이면 그 대화상자가
 * 「더 보기」를 연 자리로 기억해 닫을 때 초점을 여기로 돌려준다 — 바로 부르면 대화상자가 사라질 메뉴 줄을 기억해 초점이 `<body>` 로
 * 떨어지거나, 닫히는 메뉴가 열린 대화상자에서 초점을 뺏는다. `triggerRefs` 는 이 단추를 함께 가리킬 ref(패널을 닫으면 초점이 돌아올
 * 자리 — 데스크톱에서는 「채널 설정」·「활동」 링크가 하던 일)
 */
export function HeaderOverflow({
  items,
  triggerRefs = [],
}: {
  items: readonly OverflowItem[];
  triggerRefs?: ReadonlyArray<RefObject<HTMLElement | null> | undefined>;
}) {
  const pending = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const refsKey = useRef(triggerRefs);
  refsKey.current = triggerRefs;
  const setTrigger = useCallback((el: HTMLButtonElement | null) => {
    trigger.current = el;
    for (const r of refsKey.current) if (r) r.current = el;
  }, []);
  if (items.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={setTrigger} variant="ghost" size="icon" className="size-11" aria-label="더 보기">
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-48"
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
          <Fragment key={item.key}>
            {item.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem
              className="min-h-11"
              variant={item.destructive ? "destructive" : "default"}
              disabled={item.disabled}
              onSelect={() => {
                pending.current = item.onSelect;
              }}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
