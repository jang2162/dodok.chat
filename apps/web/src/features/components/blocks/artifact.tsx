import { cn } from "@/lib/utils";

/**
 * `artifact://` 자리표시 문구 — media·file·링크 버튼이 같이 쓴다. `artifact://` 해석(Gateway `artifacts.download`)은
 * Phase 2 ③ 의 일이라 지금은 비활성 자리만 둔다(스펙 결정 1). ③ 은 해석기만 끼우면 된다.
 * 같은 카드 안에서 같은 `artifact://` 값이 한 곳은 「곧 지원」, 다른 곳은 「열 수 없음」(망가졌다는 뜻)으로 갈리지 않게 한 곳에 둔다
 */
export const ARTIFACT_PENDING = "첨부는 곧 지원합니다";

/** 계약 `SafeUrl` 이 https 말고 받는 유일한 스킴. 접두사로만 가른다 — 대문자·앞 공백·가운데 품은 값은 아니다 */
export const isArtifactUrl = (url: string) => url.startsWith("artifact://");

/** `artifact://` 자리표시 한 칸. 누를 것이 없다 — 링크도 이미지도 만들지 않는다 */
export function ArtifactPending({ className }: { className?: string }) {
  return (
    <span data-slot="artifact-pending" className={cn("text-sm text-muted-foreground", className)}>
      {ARTIFACT_PENDING}
    </span>
  );
}
