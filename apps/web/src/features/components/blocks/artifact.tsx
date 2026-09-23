import { cn } from "@/lib/utils";

/**
 * 카드 URL 이 풀리지 않을 때의 문구 — media·file·링크 버튼이 같이 쓴다(첨부 스펙 6.3).
 * `artifact://<이름 또는 id>` 가 그 메시지의 첨부에 없으면 「첨부를 찾을 수 없습니다」, `artifact://` 도 `https://` 도 아니면
 * 「열 수 없는 링크입니다」. 같은 카드의 같은 값이 자리마다 다른 말을 하지 않게 한 곳에 둔다
 */
export const ATTACHMENT_MISSING = "첨부를 찾을 수 없습니다";
export const LINK_BLOCKED = "열 수 없는 링크입니다";

/** 풀리지 않는 URL 자리 한 칸. 누를 것이 없다 — 링크도 이미지도 만들지 않는다 */
export function Unresolved({ text, className }: { text: string; className?: string }) {
  return (
    <span data-slot="unresolved" className={cn("text-sm text-muted-foreground", className)}>
      {text}
    </span>
  );
}
