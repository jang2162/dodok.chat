import type { Message } from "@dodok/shared";
import { useMe } from "@/api/queries";
import type { ReactNode } from "react";
import { MessageAttachments } from "@/features/attachments/MessageAttachments";
import { useLoadAutomationAuthors } from "@/features/automations/queries";
import { referencedAttachmentIds } from "@/features/attachments/resolve";
import { Components } from "@/features/components/Components";
import { useChannelArchived } from "@/features/channels/archived";
import { useConversationClosed } from "@/features/conversations/closed";
import { useDmView } from "@/features/dms/context";
import { WithPresence } from "@/features/presence/PresenceDot";
import { useOpenProfile } from "@/features/profile/openProfile";
import { ReactionChips } from "@/features/reactions/ReactionChips";
import { ReactionPicker } from "@/features/reactions/ReactionPicker";
import { useSetReaction } from "@/features/reactions/useSetReaction";
import { threadRootOf } from "@/features/threads/queries";
import { ReplyInThread, ThreadChip } from "@/features/threads/ThreadChip";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
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
export function AuthorAvatar({ author, onOpen }: { author: Author; onOpen?: () => void }) {
  const avatar = (
    <Avatar
      className={author.isAgent ? "size-9 border-2" : "size-9"}
      style={author.colorVar ? { borderColor: author.colorVar } : undefined}
    >
      {author.avatarUrl && <AvatarImage src={author.avatarUrl} alt="" />}
      <AvatarFallback>{author.name.slice(0, 1)}</AvatarFallback>
    </Avatar>
  );
  // 접속 점(프로필 스펙 3.3) — 누구인지 모르는 작성자(시스템·자동화)는 점이 없다
  if (!author.ref) return avatar;
  const dotted = (
    <WithPresence kind={author.ref.kind} id={author.ref.id}>
      {avatar}
    </WithPresence>
  );
  if (!onOpen) return dotted;
  return (
    <button type="button" aria-label={`${author.name} 프로필`} onClick={onOpen} className="rounded-full">
      {dotted}
    </button>
  );
}

/** 머리 줄: 이름 · 에이전트면 「AI」 배지(보관했으면 「삭제됨」도) · 비활성 멤버면 「비활성」 · 시각(또는 상태) */
export function AuthorLine({
  author,
  children,
  onOpen,
}: {
  author: Author;
  children: ReactNode;
  /** 이름을 누르면 프로필(프로필 스펙 3.1) — 세션 화면에서만 */
  onOpen?: () => void;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[15px] leading-snug">
      {onOpen ? (
        <button type="button" onClick={onOpen} className="truncate font-semibold hover:underline">
          {author.name}
        </button>
      ) : (
        <span className="truncate font-semibold">{author.name}</span>
      )}
      {author.isAgent && (
        <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
          AI
        </Badge>
      )}
      {author.archived && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-muted-foreground">
          삭제됨
        </Badge>
      )}
      {author.deactivated && (
        <Badge variant="secondary" className="px-1.5 py-0 text-[10px] text-muted-foreground">
          비활성
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

/**
 * 마우스 없는 기기(`hover: none`)에서는 동작 버튼이 늘 보여 머리 줄이 없는 이어진 메시지의 본문 첫 줄들 위에 뜬다 —
 * 그 조건에서만 본문 칸 오른쪽을 버튼 폭만큼 비운다(행 `px-4` 를 뺀 값: 스레드 답하기 right-3 + 28px 이면 24px,
 * 반응 추가가 right-12 에 더 있으면 64px, 스레드 패널은 반응 추가가 right-3 이라 24px). 버튼이 없으면 비우지 않는다.
 * 클래스는 Tailwind 가 읽도록 통째로 적는다.
 */
function touchGutter(inThread: boolean, hasPicker: boolean): string | undefined {
  if (hasPicker && !inThread) return "[@media(hover:none)]:pr-16";
  if (hasPicker || !inThread) return "[@media(hover:none)]:pr-6";
  return undefined;
}

/**
 * 사람·에이전트 메시지(스펙 5.3): 머리(아바타·이름·「AI」·시각) + 본문 + 첨부 + components 카드.
 * 글 없는 첨부 메시지는 본문을 그리지 않는다(빈 단락이 줄을 차지하지 않게). 카드가 가리킨 첨부는 본문 아래에 다시 그리지 않는다(첨부 스펙 6.3).
 * 같은 작성자의 연속(`head: false`)은 머리를 생략하고 시각은 마우스를 올리거나 행 안에 초점이 있을 때만 보인다 —
 * 투명도로만 숨겨 스크린 리더는 늘 읽는다(visibility:hidden 은 접근성 트리에서도 빠진다, web-t7 리뷰 m6).
 * 채널 타임라인에서는 루트 아래에 답글 요약 칩과 「스레드에서 답하기」가 붙는다(스레드·검색 스펙 4.2) — 스레드 패널
 * 안(`inThread`)에서는 둘 다 없다: 이미 그 스레드이고, 스레드 안의 스레드는 없다.
 * 반응(리액션 스펙 「웹」 장): 본문·첨부·카드 아래에 칩, 동작 줄에 「반응 추가」(보관한 채널은 숨김·칩은 읽기만, 시스템 메시지는 둘 다 없음).
 * DM 에는 스레드가 없다(에이전트 DM 스펙 결정 7) — 칩·「스레드에서 답하기」 없이 스레드 패널 안처럼 그린다. 읽기 전용 DM 은 반응을 달 수 없다(서버 409)
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
  const openProfile = useOpenProfile();
  const ref = author.ref;
  const openAuthor = ref && openProfile ? () => openProfile(ref) : undefined;
  useLoadAutomationAuthors([message]);
  const me = useMe().data?.user.id;
  // 보관한 채널·닫힌 세션은 반응을 달 수 없다(서버 409) — 칩은 읽기만
  const channelArchived = useChannelArchived();
  const closed = useConversationClosed();
  const dm = useDmView();
  const archived = channelArchived || closed || (dm !== null && dm.readOnly !== null);
  // 스레드 행동이 없는 자리 — 스레드 패널 안, 그리고 에이전트 DM(사람 DM·그룹 DM 은 스레드를 연다 — 사람 간 DM 스펙 결정 10)
  const noThreads = inThread || dm?.kind === "dm";
  // 채널 타임라인의 루트도 스레드를 넘긴다 — 나란히 열린 스레드 패널의 같은 루트가 곧바로 바뀐다(연 적 없는 스레드면 updateThread 가 그냥 지나간다)
  const setReaction = useSetReaction(message.channelId, message.conversationId, threadRootOf(message));
  // 시스템 메시지에는 달 수 없다(보내는 중 항목은 PendingItem 이라 여기에 오지 않는다)
  const reactable = message.kind === "normal";
  return (
    <article
      className="group relative flex gap-3 px-4 py-0.5 hover:bg-accent/40"
      data-head={head || undefined}
    >
      <div className="flex w-9 shrink-0 justify-end">
        {head ? (
          <div className="pt-1">
            <AuthorAvatar author={author} onOpen={openAuthor} />
          </div>
        ) : (
          <MessageTime
            iso={message.createdAt}
            className="pt-1 text-[10px] whitespace-nowrap text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          />
        )}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1",
          head && "pt-1",
          head || touchGutter(noThreads, reactable && !archived),
        )}
      >
        {head && (
          <AuthorLine author={author} onOpen={openAuthor}>
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
        {reactable && me && (
          <ReactionChips message={message} me={me} onToggle={(e, on) => setReaction(message.id, e, on)} />
        )}
        {!noThreads && message.threadSummary && (
          <ThreadChip message={message} summary={message.threadSummary} />
        )}
      </div>
      {reactable && !archived && (
        <ReactionPicker
          className={noThreads ? "right-3" : "right-12"}
          onPick={(e) => setReaction(message.id, e, true)}
        />
      )}
      {!noThreads && <ReplyInThread message={message} />}
    </article>
  );
}
