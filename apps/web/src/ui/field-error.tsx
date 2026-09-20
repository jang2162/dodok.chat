import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 칸 아래 오류 문구 — 비어 있는 채로 늘 두는 polite 라이브 영역이라 오류가 생기거나 바뀌면 스크린 리더가 읽는다
 * (새로 끼운 라이브 영역은 놓칠 수 있다). 칸은 오류가 있을 때만 이 id 를 aria-describedby 로 가리킨다.
 * 비었을 때는 부모 flex 의 간격을 되돌려 자리를 차지하지 않는다(`gap` 이 다르면 className 으로 덮는다)
 */
export function FieldError({ className, ...props }: Omit<React.ComponentProps<"p">, "aria-live">) {
  return (
    <p
      data-slot="field-error"
      aria-live="polite"
      className={cn("text-xs text-destructive empty:-mt-1.5", className)}
      {...props}
    />
  );
}
