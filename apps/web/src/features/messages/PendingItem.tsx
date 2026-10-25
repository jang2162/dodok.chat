import { LoaderCircleIcon } from "lucide-react";
import { CHANNEL_ARCHIVED_TEXT, CONVERSATION_CLOSED_TEXT, SEND_FORBIDDEN_TEXT } from "@/api/formErrors";
import { useMe } from "@/api/queries";
import { AttachmentGrid } from "@/features/attachments/AttachmentGrid";
import { useConversationClosed } from "@/features/conversations/closed";
import { Button } from "@/ui/button";
import { AuthorAvatar, AuthorLine } from "./MessageItem";
import { MessageBody } from "./MessageBody";
import { usePendingActions } from "./pendingActions";
import { RATE_LIMITED_TEXT } from "./rateLimited";
import { FINAL_FAIL_REASONS, type PendingMessage } from "./timeline";
import { useAuthors } from "./useAuthors";

/**
 * 보내는 중·실패한 내 메시지(스펙 4.4·5.3): 본문을 흐리게, `sending` 은 스피너, `failed` 는 「다시 보내기」·「삭제」
 * (보관한 채널·닫힌 세션에 보낸 것·권한 거절은 「삭제」만 — 다시 보내도 같은 거절이다, 채널 세션 계획 Review Focus 2. 다른 사유로 실패한
 * 뒤 세션이 닫혔어도 「삭제」만).
 * 두 버튼은 ChannelPage 가 넣는 PendingActions 컨텍스트로 잇는다 — 없으면 그리지 않는다.
 * 첨부는 서버 경로로 그린다(올린 사람은 묶이기 전에도 읽는다). 크게 보기는 확정 메시지에서만 — 여기서는 누를 것이 없다
 */
export function PendingItem({ pending }: { pending: PendingMessage }) {
  const meId = useMe().data?.user.id;
  const me = useAuthors().author({ authorType: "user", authorId: meId });
  const actions = usePendingActions();
  const closed = useConversationClosed();
  const failed = pending.state === "failed";
  const final = closed || (pending.reason !== undefined && FINAL_FAIL_REASONS.has(pending.reason));
  return (
    <article className="flex gap-3 px-4 py-0.5" data-pending={pending.state}>
      <div className="w-9 shrink-0 pt-1">
        <AuthorAvatar author={me} />
      </div>
      <div className="min-w-0 flex-1 pt-1">
        <AuthorLine author={me}>
          {failed ? (
            <span className="text-destructive">
              {pending.reason === "rate_limited"
                ? RATE_LIMITED_TEXT
                : pending.reason === "channel_archived"
                  ? CHANNEL_ARCHIVED_TEXT
                  : pending.reason === "conversation_closed"
                    ? CONVERSATION_CLOSED_TEXT
                    : pending.reason === "forbidden"
                      ? SEND_FORBIDDEN_TEXT
                      : "전송 실패"}
            </span>
          ) : (
            <LoaderCircleIcon
              role="status"
              aria-label="보내는 중"
              aria-hidden={false}
              className="inline size-3 animate-spin motion-reduce:animate-none"
            />
          )}
        </AuthorLine>
        <div className="opacity-60">
          {pending.bodyMd !== "" && <MessageBody bodyMd={pending.bodyMd} />}
          {pending.attachments && pending.attachments.length > 0 && (
            <div className="mt-1">
              <AttachmentGrid images={pending.attachments} />
            </div>
          )}
        </div>
        {failed && actions && (
          <div className="mt-1 flex gap-2">
            {!final && (
              <Button size="xs" variant="outline" onClick={() => actions.retry(pending.clientMsgId)}>
                다시 보내기
              </Button>
            )}
            <Button size="xs" variant="ghost" onClick={() => actions.discard(pending.clientMsgId)}>
              삭제
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
