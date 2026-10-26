import type { DmReadOnlyReason } from "@dodok/shared";
import { useEffect, useRef } from "react";
import { DM_READ_ONLY_TEXT } from "./queries";

/** DM 첫 안내(세션이 하나도 없을 때의 빈 화면 — 에이전트 DM 계획 Global Constraints, 글자 그대로) */
export const DM_FIRST_NOTICE =
  "이 DM 은 나만 봅니다. 다만 에이전트는 자기 기억(메모리·작업 디렉터리의 파일)을 거쳐 여기서 들은 것을 다른 채널의 답에 쓸 수 있습니다 — dodok 은 이것을 막지 못합니다.";

/**
 * 읽기 전용 DM 의 작성기 자리(에이전트 DM 스펙 3.3) — 사유 한 줄. 되돌리면(되살리기·켜기·허용) DM 목록이 다시 와 부르는 쪽이 작성기를
 * 다시 보인다(`agents.changed` → DM 목록 다시 받기).
 * `focusOnMount` 는 이 화면에서 쓸 수 있던 DM 이 읽기 전용이 됐다는 뜻이다 — 쓰던 작성기가 숨어(`hidden`) 초점이 갈 곳이 없으면 이 줄로
 * 옮긴다. 다른 곳에 초점이 있으면 뺏지 않는다(닫힌 세션 안내 `ClosedNotice` 와 같은 규칙 — 채널 세션 브라우저 검증 D2)
 */
export function DmReadOnlyNotice({
  reason,
  focusOnMount = false,
}: {
  reason: DmReadOnlyReason;
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  const focusFirst = useRef(focusOnMount).current;
  useEffect(() => {
    const active = document.activeElement;
    // 쓰던 작성기는 이 줄과 같은 커밋에 숨는다 — 그 안의 초점은 브라우저가 이 effect 뒤에야 body 로 옮기므로 떨어진 것으로 본다
    const dropped = active === null || active === document.body || active.closest("[hidden]") !== null;
    if (focusFirst && dropped) ref.current?.focus();
  }, [focusFirst]);
  return (
    <div
      data-testid="dm-read-only"
      className="flex flex-wrap items-center justify-center gap-3 border-t bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <p ref={ref} tabIndex={-1} className="outline-none">
        {DM_READ_ONLY_TEXT[reason]}
      </p>
    </div>
  );
}
