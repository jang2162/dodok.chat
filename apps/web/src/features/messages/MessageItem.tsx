import type { Message } from "@dodok/shared";
import type { ReactNode } from "react";
import { MessageAttachments } from "@/features/attachments/MessageAttachments";
import { referencedAttachmentIds } from "@/features/attachments/resolve";
import { Components } from "@/features/components/Components";
import { ReplyInThread, ThreadChip } from "@/features/threads/ThreadChip";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { MessageBody } from "./MessageBody";
import { type Author, useAuthors } from "./useAuthors";

const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeStyle: "short" });

export function MessageTime({ iso, className }: { iso: string; className?: string }) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={FULL.format(d)} className={className}>
      {TIME.format(d)}
    </time>
  );
}

/** 아바타 36px(스펙 7.1). 에이전트는 테두리 2px 에이전트 색, 사람은 테두리 없음(스펙 7.2) */
export function AuthorAvatar({ author }: { author: Author }) {
  return (
    <Avatar
      className={author.isAgent ? "size-9 border-2" : "size-9"}
      style={author.colorVar ? { borderColor: author.colorVar } : undefined}
    >
      {author.avatarUrl && <AvatarImage src={author.avatarUrl} alt="" />}
      <AvatarFallback>{author.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
}

/** 머리 줄: 이름(나간 멤버면 흐리게) · 에이전트면 「AI」 배지 · 시각(또는 상태) */
export function AuthorLine({ author, children }: { author: Author; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[15px] leading-snug">
      <span className={cn("truncate font-semibold", author.left && "font-normal text-muted-foreground")}>
        {author.name}
      </span>
      {author.isAgent && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          AI
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

/**
 * 사람·에이전트 메시지(스펙 5.3): 머리(아바타·이름·「AI」·시각) + 본문 + 첨부 + components 카드.
 * 글 없는 첨부 메시지는 본문을 그리지 않는다(빈 단락이 줄을 차지하지 않게). 카드가 가리킨 첨부는 본문 아래에 다시 그리지 않는다(첨부 스펙 6.3).
 * 같은 작성자의 연속(`head: false`)은 머리를 생략하고 시각은 마우스를 올리거나 행 안에 초점이 있을 때만 보인다 —
 * 투명도로만 숨겨 스크린 리더는 늘 읽는다(visibility:hidden 은 접근성 트리에서도 빠진다, web-t7 리뷰 m6).
 * 채널 타임라인에서는 루트 아래에 답글 요약 칩과 「스레드에서 답하기」가 붙는다(스레드·검색 스펙 4.2) — 스레드 패널
 * 안(`inThread`)에서는 둘 다 없다: 이미 그 스레드이고, 스레드 안의 스레드는 없다
 */
export function MessageItem({
  message,
  head,
  inThread = false,
}: {
  message: Message;
  head: boolean;
  inThread?: boolean;
}) {
  const author = useAuthors().author(message);
  return (
    <article
      className="group relative flex gap-3 px-4 py-0.5 hover:bg-accent/40"
      data-head={head || undefined}
    >
      <div className="flex w-9 shrink-0 justify-end">
        {head ? (
          <div className="pt-1">
            <AuthorAvatar author={author} />
          </div>
        ) : (
          <MessageTime
            iso={message.createdAt}
            className="pt-1 text-[10px] whitespace-nowrap text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          />
        )}
      </div>
      <div className={head ? "min-w-0 flex-1 pt-1" : "min-w-0 flex-1"}>
        {head && (
          <AuthorLine author={author}>
            <MessageTime iso={message.createdAt} />
          </AuthorLine>
        )}
        {message.bodyMd !== "" && <MessageBody bodyMd={message.bodyMd} />}
        {message.editedAt && <span className="text-xs text-muted-foreground">(수정됨)</span>}
        <MessageAttachments
          attachments={message.attachments}
          exclude={referencedAttachmentIds(message.components, message.attachments)}
        />
        <Components message={message} />
        {!inThread && message.threadSummary && (
          <ThreadChip message={message} summary={message.threadSummary} />
        )}
      </div>
      {!inThread && <ReplyInThread message={message} />}
    </article>
  );
}
