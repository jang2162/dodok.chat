import type { Conversation } from "@dodok/shared";
import { useEffect, useRef } from "react";
import { CONVERSATION_CLOSED_TEXT } from "@/api/formErrors";
import { Button } from "@/ui/button";
import { usePatchConversation } from "./mutations";
import { useConversationPermissions } from "./permissions";

/**
 * 닫힌 세션의 작성기 자리(채널 세션 스펙 「웹」 장) — 「닫힌 세션입니다」, 바꿀 권한이 있으면 「다시 열기」. 다시 열면 세션 캐시가 열린
 * 세션으로 바뀌어 부르는 쪽이 작성기를 다시 보인다(`onReopened` — 단추가 사라지므로 초점을 작성기로 옮기라는 신호).
 * `focusOnMount` 는 보던 세션이 이 화면에서 닫혔다는 뜻이다 — 누른 단추(머리의 「세션 닫기」)가 사라져 초점이 body 로 떨어졌으면 이
 * 안내로 옮긴다. 쓰던 작성기 안에 있었어도 옮긴다(작성기가 숨어 초점이 갈 곳이 없다). 다른 곳에 초점이 있으면(다른 탭·다른 사람이 닫았다) 뺏지 않는다(설정 패널의 `ArchivedSettings` 와 같은 규칙)
 * 스레드 패널은 단추 없이 문구만 둔다(`reopen` 없음) — 같은 화면에 「다시 열기」가 둘이 되지 않게
 */
export function ClosedNotice({
  channelId,
  conversation,
  reopen = false,
  focusOnMount = false,
  onReopened,
}: {
  channelId: string;
  conversation: Conversation;
  reopen?: boolean;
  focusOnMount?: boolean;
  onReopened?: () => void;
}) {
  const { canManage } = useConversationPermissions(channelId);
  const patch = usePatchConversation(conversation.id);
  const ref = useRef<HTMLParagraphElement>(null);
  const focusFirst = useRef(focusOnMount).current;
  useEffect(() => {
    const active = document.activeElement;
    // 쓰던 작성기는 이 안내와 같은 커밋에 숨는다(`hidden`) — 그 안의 초점은 브라우저가 이 effect 뒤에야 body 로 옮기므로 떨어진 것으로 본다
    const dropped = active === null || active === document.body || active.closest("[hidden]") !== null;
    if (focusFirst && dropped) ref.current?.focus();
  }, [focusFirst]);
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
          onClick={() => patch.mutate({ closed: false }, { onSuccess: () => onReopened?.() })}
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
