import { LoaderCircleIcon } from "lucide-react";
import { useMe } from "@/api/queries";
import { AttachmentGrid } from "@/features/attachments/AttachmentGrid";
import { Button } from "@/ui/button";
import { AuthorAvatar, AuthorLine } from "./MessageItem";
import { MessageBody } from "./MessageBody";
import { usePendingActions } from "./pendingActions";
import type { PendingMessage } from "./timeline";
import { useAuthors } from "./useAuthors";

/** 레이트리밋으로 실패한 항목의 문구(운영 보강 스펙 4장) */
export const RATE_LIMITED_TEXT = "너무 빠르게 보내고 있습니다 — 잠시 뒤 다시";

/**
 * 보내는 중·실패한 내 메시지(스펙 4.4·5.3): 본문을 흐리게, `sending` 은 스피너, `failed` 는 「다시 보내기」·「삭제」.
 * 두 버튼은 ChannelPage 가 넣는 PendingActions 컨텍스트로 잇는다 — 없으면 그리지 않는다.
 * 첨부는 서버 경로로 그린다(올린 사람은 묶이기 전에도 읽는다). 크게 보기는 확정 메시지에서만 — 여기서는 누를 것이 없다
 */
export function PendingItem({ pending }: { pending: PendingMessage }) {
  const meId = useMe().data?.user.id;
  const me = useAuthors().author({ authorType: "user", authorId: meId });
  const actions = usePendingActions();
  const failed = pending.state === "failed";
  return (
    <article className="flex gap-3 px-4 py-0.5" data-pending={pending.state}>
      <div className="w-9 shrink-0 pt-1">
        <AuthorAvatar author={me} />
      </div>
      <div className="min-w-0 flex-1 pt-1">
        <AuthorLine author={me}>
          {failed ? (
            <span className="text-destructive">
              {pending.reason === "rate_limited" ? RATE_LIMITED_TEXT : "전송 실패"}
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
            <Button size="xs" variant="outline" onClick={() => actions.retry(pending.clientMsgId)}>
              다시 보내기
            </Button>
            <Button size="xs" variant="ghost" onClick={() => actions.discard(pending.clientMsgId)}>
              삭제
            </Button>
          </div>
        )}
      </div>
    </article>
  );
}
