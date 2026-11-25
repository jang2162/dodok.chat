import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { KEY_STEP, type Range } from "./useLayoutWidths";

/** 끄는 동안 문서 어디서나 col-resize 커서, 텍스트 선택 없음 — 손이 손잡이 밖으로 나가도 */
function lockDocument(on: boolean) {
  const style = document.documentElement.style;
  style.cursor = on ? "col-resize" : "";
  style.userSelect = on ? "none" : "";
}

/**
 * 칸 경계의 끌기 손잡이(UI 시안 04) — 사이드바·오른쪽 패널이 같이 쓴다. 폭 9px(보이는 선은 가운데 1px, 호버·끌기·초점 때 진해진다).
 * `grow` 는 오른쪽으로 끌 때 늘어나는가 — 사이드바는 오른쪽(+1), 패널은 왼쪽(-1)이 늘어난다. ←/→ 는 손잡이가 움직이는 쪽이다.
 *
 * 끄는 동안은 `onDrag`(상태만), 놓을 때 `onCommit`(저장). 포인터를 잡아(pointer capture) 끄는 동안 iframe·텍스트가 포인터를
 * 가져가지 않게 하고, 문서 전체의 커서·텍스트 선택을 막는다(`lockDocument`). 더블클릭·Enter 는 기본값, Home/End 는 최소/최대
 */
export function ResizeHandle({
  label,
  value,
  range,
  grow,
  onDrag,
  onCommit,
  onSet,
  className,
  ref,
}: {
  label: string;
  /** 지금 그린 너비 */
  value: number;
  range: Range;
  grow: 1 | -1;
  /** `start` 는 끌기 시작 때 너비 */
  onDrag: (raw: number, start: number) => void;
  onCommit: () => void;
  /** 키보드·더블클릭 — 바로 저장한다 */
  onSet: (value: number) => void;
  className?: string;
  ref?: RefObject<HTMLDivElement | null>;
}) {
  const start = useRef<{ x: number; value: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  // 끄는 중에 사라지면(최솟값 아래로 끌어 사이드바가 접혔다) 놓기가 오지 않는다 — 잠금을 풀고 그때까지를 저장한다
  useEffect(
    () => () => {
      if (!start.current) return;
      start.current = null;
      lockDocument(false);
      onCommit();
    },
    [onCommit],
  );

  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current?.id !== e.pointerId) return;
    start.current = null;
    setDragging(false);
    lockDocument(false);
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onCommit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next =
      e.key === "ArrowRight"
        ? value + KEY_STEP * grow
        : e.key === "ArrowLeft"
          ? value - KEY_STEP * grow
          : e.key === "Home"
            ? range.min
            : e.key === "End"
              ? range.max
              : e.key === "Enter"
                ? range.initial
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    onSet(next);
  };

  return (
    // 폭을 바꾸는 손잡이는 초점을 받는 separator 다(WAI-ARIA Window Splitter)
    <div
      ref={ref}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      className={cn(
        "group absolute inset-y-0 z-10 w-[9px] cursor-col-resize touch-none outline-none select-none",
        className,
      )}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        start.current = { x: e.clientX, value, id: e.pointerId };
        e.currentTarget.setPointerCapture?.(e.pointerId);
        lockDocument(true);
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s?.id !== e.pointerId) return;
        onDrag(s.value + (e.clientX - s.x) * grow, s.value);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => onSet(range.initial)}
      onKeyDown={onKeyDown}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-1 w-px bg-transparent transition-colors",
          "group-hover:bg-ring group-focus-visible:bg-ring group-data-dragging:bg-ring",
        )}
      />
    </div>
  );
}
