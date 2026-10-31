import type { Conversation } from "@dodok/shared";
import { useEffect, useRef } from "react";
import { CONVERSATION_CLOSED_TEXT } from "@/api/formErrors";
import { Button } from "@/ui/button";
import { usePatchConversation } from "./mutations";
import { type ClosedZone, useClosedFocus } from "./closed";
import { useConversationPermissions } from "./permissions";

/**
 * 닫힌 세션의 작성기 자리(채널 세션 스펙 「웹」 장) — 「닫힌 세션입니다」, 바꿀 권한이 있으면 「다시 열기」. 다시 열면 세션 캐시가 열린
 * 세션으로 바뀌어 부르는 쪽이 작성기를 다시 보인다(`onReopened` — 단추가 사라지므로 초점을 작성기로 옮기라는 신호).
 * `focusOnMount` 는 보던 세션이 이 화면에서 닫혔다는 뜻이다 — 누른 단추(머리의 「세션 닫기」)가 사라져 초점이 body 로 떨어졌으면 이
 * 안내로 옮긴다. 쓰던 작성기 안에 있었어도 옮긴다(작성기가 숨어 초점이 갈 곳이 없다). 다른 곳에 초점이 있으면(다른 탭·다른 사람이 닫았다) 뺏지 않는다(설정 패널의 `ArchivedSettings` 와 같은 규칙)
 * 스레드 패널은 단추 없이 문구만 둔다(`reopen` 없음) — 같은 화면에 「다시 열기」가 둘이 되지 않게.
 * 세션 화면에는 안내가 둘(세션 작성기·스레드 패널) 설 수 있다 — `zone` 이 마지막으로 초점을 가졌던 자리(`ClosedFocusContext`)와 같은
 * 안내만 가져간다(스레드 작성기에서 쓰던 중이면 스레드 쪽, 아니면 본문 쪽)
 */
export function ClosedNotice({
  channelId,
  conversation,
  reopen = false,
  focusOnMount = false,
  zone,
  onReopened,
}: {
  channelId: string;
  conversation: Conversation;
  reopen?: boolean;
  focusOnMount?: boolean;
  zone?: ClosedZone;
  onReopened?: () => void;
}) {
  const focusZone = useClosedFocus()?.zone;
  const { canManage } = useConversationPermissions(channelId);
  const patch = usePatchConversation(conversation.id);
  const ref = useRef<HTMLParagraphElement>(null);
  const focusFirst = useRef(focusOnMount).current;
  useEffect(() => {
    const active = document.activeElement;
    // 쓰던 작성기는 이 안내와 같은 커밋에 숨는다(`hidden`) — 그 안의 초점은 브라우저가 이 effect 뒤에야 body 로 옮기므로 떨어진 것으로 본다
    const dropped = active === null || active === document.body || active.closest("[hidden]") !== null;
    // 스레드 패널이 닫기 단추가 아니라 주소 이동(뒤로 가기)으로 그냥 빠지면 자리는 `thread` 로 남는다 — 패널이 없으면 본문 것으로 본다
    const last =
      focusZone?.current === "thread" && !document.querySelector('[data-testid="thread-panel"]')
        ? "main"
        : focusZone?.current;
    const mine = focusZone === undefined || zone === undefined || last === zone;
    if (focusFirst && dropped && mine) ref.current?.focus();
  }, [focusFirst, focusZone, zone]);
  return (
    <div
      data-testid="conversation-closed"
      className="flex flex-wrap items-center justify-center gap-3 border-t bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <p ref={ref} tabIndex={-1} className="outline-none">
        {CONVERSATION_CLOSED_TEXT}
      </p>
      {reopen && canManage(conversation) && (
        <Button
          variant="outline"
          size="sm"
          disabled={patch.isPending}
          // mutate 의 콜백이 아니라 promise 로 — 훅의 onSuccess 가 세션 캐시를 열림으로 바꾸면 이 안내가 먼저 언마운트돼 mutate 콜백은
          // 불리지 않는다(초점이 body 로 떨어졌다). 실패는 전역 오류 처리가 알린다
          onClick={() =>
            void patch.mutateAsync({ closed: false }).then(
              () => onReopened?.(),
              () => undefined,
            )
          }
        >
          다시 열기
        </Button>
      )}
    </div>
  );
}

/**
 * 「세션 관리자만」 정책의 채널에서 새 세션을 만들 수 없는 사람이 새 세션 창(`/s/new`)에 왔다 — 작성기 대신 안내(태스크 5 리뷰가 넘긴 ②).
 * 보내도 서버가 403 이다
 */
export function CannotCreateNotice() {
  return (
    <div
      data-testid="conversation-cannot-create"
      className="flex flex-wrap items-center justify-center gap-3 border-t bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
    >
      <p>이 채널은 세션 관리자만 새 세션을 만들 수 있습니다.</p>
    </div>
  );
}
