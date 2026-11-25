import type { Message } from "@dodok/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMe } from "@/api/queries";
import { BotIcon, CornerDownRightIcon } from "lucide-react";
import { type MouseEvent, type PointerEvent, type ReactNode, useRef } from "react";
import { toast } from "sonner";
import { MessageActivity } from "@/features/activity/InlineActivity";
import { MessageAttachments } from "@/features/attachments/MessageAttachments";
import { insertMention } from "@/features/composer/insertMention";
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
import { useNoteThreadOpener, useThreadOpenSearch } from "@/features/threads/threadOpener";
import { getThread, getTimeline } from "@/realtime/timelineCache";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { previewOf } from "./bundles";
import { MessageBody } from "./MessageBody";
import { CopyLinkButton } from "./messageLink";
import { type Author, useAuthors } from "./useAuthors";

const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const FULL = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeStyle: "short" });

/** 12시간 숫자만(오전·오후 없이) — 이어진 메시지의 36px 칸에 들어가게(스펙 2026-11-19 U3). 오전·오후는 title 에 남는다 */
function shortTime(d: Date): string {
  return `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function MessageTime({
  iso,
  className,
  short = false,
}: {
  iso: string;
  className?: string;
  short?: boolean;
}) {
  const d = new Date(iso);
  return (
    <time dateTime={iso} title={FULL.format(d)} className={className}>
      {short ? shortTime(d) : TIME.format(d)}
    </time>
  );
}

/** 아바타 36px(스펙 7.1). 에이전트는 테두리 2px 에이전트 색, 사람은 테두리 없음(스펙 7.2) */
export function AuthorAvatar({ author, onOpen }: { author: Author; onOpen?: () => void }) {
  const avatar = (
    <IdentityAvatar
      kind={author.isAgent ? "agent" : "person"}
      // 누구인지 모르는 작성자(시스템·자동화)는 이름으로 색을 고정한다
      id={author.ref?.id ?? author.name}
      name={author.name}
      handle={author.handle}
      avatarUrl={author.avatarUrl}
      size={36}
    />
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

/** 에이전트 이름 메뉴(UI 시안 02) — 「멘션」·「프로필」. macOS 는 ⌘+클릭, 그 밖은 Ctrl+클릭이면 메뉴 없이 바로 멘션 */
export const NOT_MENTIONABLE = "이 자리의 작성기에서 부를 수 없는 에이전트입니다";
/** macOS·iOS 인가 — 부를 때마다 본다(시험이 플랫폼을 바꿔 잰다) */
export const isApplePlatform = (): boolean => {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return /mac|iphone|ipad|ipod/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
};
// macOS 의 Ctrl+클릭은 컨텍스트 메뉴라 바로 멘션으로 잡지 않는다
const directMention = (e: { metaKey: boolean; ctrlKey: boolean }) =>
  isApplePlatform() ? e.metaKey : e.ctrlKey;

function AgentNameMenu({
  name,
  onMention,
  onOpen,
}: {
  name: string;
  onMention: () => void;
  onOpen?: (() => void) | undefined;
}) {
  // 항목을 골라 닫혔으면 초점을 이름에 되돌리지 않는다(작성기·프로필이 가져간다). Esc 로 닫으면 Radix 기본대로 이름 단추로
  const picked = useRef(false);
  const pick = (fn: () => void) => () => {
    picked.current = true;
    fn();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="truncate font-semibold hover:underline"
          title={`${isApplePlatform() ? "⌘" : "Ctrl"}+클릭으로 바로 멘션`}
          // 메뉴는 누르는 순간(pointerdown) 열린다 — 바로 멘션 수정 키가 있으면 막고 클릭에서 바로 멘션
          onPointerDown={(e: PointerEvent) => {
            if (directMention(e)) e.preventDefault();
          }}
          onClick={(e: MouseEvent) => {
            if (!directMention(e)) return;
            e.preventDefault();
            onMention();
          }}
        >
          {name}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        onCloseAutoFocus={(e) => {
          if (!picked.current) return;
          picked.current = false;
          e.preventDefault();
        }}
      >
        <DropdownMenuItem onSelect={pick(onMention)}>멘션</DropdownMenuItem>
        {onOpen && <DropdownMenuItem onSelect={pick(onOpen)}>프로필</DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 머리 줄: 이름 · 에이전트면 「AI」 배지(보관했으면 「삭제됨」도) · 비활성 멤버면 「비활성」 · 시각(또는 상태) */
export function AuthorLine({
  author,
  children,
  onOpen,
  onMention,
}: {
  author: Author;
  children: ReactNode;
  /** 이름을 누르면 프로필(프로필 스펙 3.1) — 세션 화면에서만 */
  onOpen?: (() => void) | undefined;
  /** 에이전트 이름을 누르면 「멘션」·「프로필」 메뉴(UI 시안 02) — 이 자리 작성기에 멘션을 넣는다 */
  onMention?: (() => void) | undefined;
}) {
  return (
    <div className="flex items-baseline gap-2 text-[15px] leading-snug">
      {author.isAgent && onMention ? (
        <AgentNameMenu name={author.name} onMention={onMention} onOpen={onOpen} />
      ) : onOpen ? (
        <button type="button" onClick={onOpen} className="truncate font-semibold hover:underline">
          {author.name}
        </button>
      ) : (
        <span className="truncate font-semibold">{author.name}</span>
      )}
      {author.isAgent && (
        <Badge
          variant="outline"
          className="gap-0.5 self-center border-transparent px-1.5 py-0 text-xs text-foreground [&>svg]:size-[13px]"
          style={{
            backgroundColor: `color-mix(in oklch, ${author.colorVar ?? "var(--muted-foreground)"} 18%, transparent)`,
          }}
        >
          <BotIcon aria-hidden />
          AI
        </Badge>
      )}
      {author.archived && (
        <Badge variant="secondary" className="px-1.5 py-0 text-xs text-muted-foreground">
          삭제됨
        </Badge>
      )}
      {author.deactivated && (
        <Badge variant="secondary" className="px-1.5 py-0 text-xs text-muted-foreground">
          비활성
        </Badge>
      )}
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

/** 「스레드에 댓글 남김」 줄의 루트 발췌 글자 수 */
const ROOT_EXCERPT_MAX = 40;

/**
 * 채널에도 보낸 답글의 루트 발췌 — 세션 캐시에 루트가 있으면 그 본문, 없으면 스레드 캐시, 둘 다 없으면 「원래 글」. 캐시는 읽기만 한다
 * (루트가 세션 목록에 있으면 같은 목록이 다시 그릴 때 따라온다)
 */
function useRootExcerpt(message: Message, rootId: string): string {
  const qc = useQueryClient();
  const { mention } = useAuthors();
  const { channelId, conversationId } = message;
  const root =
    getTimeline(qc, channelId, conversationId)?.items.find((m) => m.id === rootId) ??
    getThread(qc, channelId, conversationId, rootId)?.items.find((m) => m.id === rootId);
  const text = root ? previewOf(root.bodyMd, mention) : "";
  if (text === "") return "원래 글";
  const chars = [...text];
  return chars.length > ROOT_EXCERPT_MAX ? `${chars.slice(0, ROOT_EXCERPT_MAX).join("")}…` : text;
}

/** 세션 타임라인의 채널에도 보낸 답글 위 줄(UI 시안 05) — 「↳ 스레드에 댓글 남김: <루트 발췌>」, 누르면 그 스레드(마지막으로 쓴 보기) */
function AlsoInChannelLink({ message, rootId }: { message: Message; rootId: string }) {
  const excerpt = useRootExcerpt(message, rootId);
  const noteOpener = useNoteThreadOpener(rootId);
  const search = useThreadOpenSearch();
  return (
    <Link
      to="/c/$channelId/s/$conversationId/t/$rootId"
      params={{ channelId: message.channelId, conversationId: message.conversationId, rootId }}
      search={search}
      onClick={noteOpener}
      data-slot="also-in-channel-link"
      className="flex max-w-full min-w-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <CornerDownRightIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        스레드에 댓글 남김: <span className="font-semibold">{excerpt}</span>
      </span>
    </Link>
  );
}

/**
 * 마우스 없는 기기(`hover: none`)에서는 동작 버튼이 늘 보여 머리 줄이 없는 이어진 메시지의 본문 첫 줄들 위에 뜬다 —
 * 그 조건에서만 본문 칸 오른쪽을 버튼 폭만큼 비운다(행 `px-4` 를 뺀 값: 버튼이 right-3 부터 28px·간격 8px 로 놓이므로 하나면 24px,
 * 둘이면 64px, 셋이면 96px — 스레드 답하기·반응 추가·링크 복사). 버튼이 없으면 비우지 않는다.
 * 클래스는 Tailwind 가 읽도록 통째로 적는다.
 */
function touchGutter(buttons: number): string | undefined {
  if (buttons >= 3) return "[@media(hover:none)]:pr-24";
  if (buttons === 2) return "[@media(hover:none)]:pr-16";
  if (buttons === 1) return "[@media(hover:none)]:pr-6";
  return undefined;
}

/** 동작 줄의 n 번째 버튼(오른쪽부터 0) 자리 — touchGutter 와 같은 간격. 클래스는 Tailwind 가 읽도록 통째로 적는다 */
const ACTION_SLOT = ["right-3", "right-12", "right-21"] as const;

/**
 * 사람·에이전트 메시지(스펙 5.3): 머리(아바타·이름·「AI」·시각) + 본문 + 첨부 + components 카드.
 * 글 없는 첨부 메시지는 본문을 그리지 않는다(빈 단락이 줄을 차지하지 않게). 카드가 가리킨 첨부는 본문 아래에 다시 그리지 않는다(첨부 스펙 6.3).
 * 같은 작성자의 연속(`head: false`)은 머리를 생략하고 시각은 마우스를 올리거나 행 안에 초점이 있을 때만 보인다 —
 * 투명도로만 숨겨 스크린 리더는 늘 읽는다(visibility:hidden 은 접근성 트리에서도 빠진다, web-t7 리뷰 m6).
 * 채널 타임라인에서는 루트 아래에 답글 요약 칩과 「스레드에서 답하기」가 붙는다(스레드·검색 스펙 4.2) — 스레드 패널
 * 안(`inThread`)에서는 둘 다 없다: 이미 그 스레드이고, 스레드 안의 스레드는 없다.
 * 반응(리액션 스펙 「웹」 장): 본문·첨부·카드 아래에 칩, 동작 줄에 「반응 추가」(보관한 채널은 숨김·칩은 읽기만, 시스템 메시지는 둘 다 없음).
 * DM 에는 스레드가 없다(에이전트 DM 스펙 결정 7) — 칩·「스레드에서 답하기」 없이 스레드 패널 안처럼 그린다. 읽기 전용 DM 은 반응을 달 수 없다(서버 409).
 * 채널에도 보낸 답글(`alsoInChannel`)은 세션 타임라인에서 글 위에 「스레드에 댓글 남김」 줄을 두고 칩·「스레드에서 답하기」는 없다(링크
 * 줄이 그 스레드로 간다). 스레드 안에서는 머리 줄 옆에 작은 「채널에도 보냄」
 */
export function MessageItem({
  message,
  head,
  inThread = false,
  activity = true,
}: {
  message: Message;
  head: boolean;
  inThread?: boolean;
  /** 활동 요약 줄을 붙여도 되는가 — 목록은 한 런의 메시지 가운데 가장 앞 것에만 준다(`groupRows`) */
  activity?: boolean;
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
  // 채널(세션) 타임라인에 그린 채널에도 보낸 답글 — 그 스레드로 가는 길은 링크 줄 하나
  const alsoRootId = !inThread && message.alsoInChannel ? message.threadRootId : undefined;
  // 스레드 행동이 없는 자리 — 스레드 패널 안, 그리고 에이전트 DM(사람 DM·그룹 DM 은 스레드를 연다 — 사람 간 DM 스펙 결정 10)
  const noThreads = inThread || dm?.kind === "dm" || alsoRootId !== undefined;
  // 에이전트 이름 메뉴의 「멘션」(UI 시안 02) — 이 글이 보이는 자리의 작성기로(스레드 패널이면 그 스레드). 글을 쓸 수 없는 자리·에이전트 DM 은 없다
  const handle = author.isAgent && !author.archived ? author.handle : undefined;
  const mentionAuthor =
    handle !== undefined && !archived && dm?.kind !== "dm"
      ? () => {
          const scope = {
            channelId: message.channelId,
            conversationId: message.conversationId,
            ...(inThread ? { threadRootId: threadRootOf(message) } : {}),
          };
          if (!insertMention(scope, handle)) toast.info(NOT_MENTIONABLE, { id: "mention-author" });
        }
      : undefined;
  // 채널 타임라인의 루트도 스레드를 넘긴다 — 나란히 열린 스레드 패널의 같은 루트가 곧바로 바뀐다(연 적 없는 스레드면 updateThread 가 그냥 지나간다)
  const setReaction = useSetReaction(message.channelId, message.conversationId, threadRootOf(message));
  // 시스템 메시지에는 달 수 없다(보내는 중 항목은 PendingItem 이라 여기에 오지 않는다)
  const reactable = message.kind === "normal";
  const pickable = reactable && !archived;
  // 링크 복사(메시지 링크 스펙 「복사 자리」) — 시스템 메시지는 가리킬 까닭이 없다
  const linkable = message.kind === "normal";
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
            short
            className="pt-1 text-xs whitespace-nowrap tabular-nums text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          />
        )}
      </div>
      <div
        className={cn(
          "min-w-0 flex-1",
          head && "pt-1",
          head || touchGutter(Number(!noThreads) + Number(pickable) + Number(linkable)),
        )}
      >
        {alsoRootId !== undefined && <AlsoInChannelLink message={message} rootId={alsoRootId} />}
        {head && (
          <AuthorLine author={author} onOpen={openAuthor} onMention={mentionAuthor}>
            <MessageTime iso={message.createdAt} />
            {inThread && message.alsoInChannel && (
              <>
                <span aria-hidden className="mx-1">
                  ·
                </span>
                <span>채널에도 보냄</span>
              </>
            )}
          </AuthorLine>
        )}
        {!head && inThread && message.alsoInChannel && (
          <span className="text-xs text-muted-foreground">채널에도 보냄</span>
        )}
        {/* 에이전트 답의 활동(스펙 「모양」) — 요약 줄만, 이벤트는 펼칠 때 */}
        {activity && message.authorType === "agent" && message.runId !== undefined && (
          <MessageActivity runId={message.runId} />
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
        {/* 답글이 없어도 그 스레드에 진행 중 런이 있으면 칩이 뜬다 — 그릴지는 칩이 정한다 */}
        {!noThreads && message.threadRootId === undefined && (
          <ThreadChip message={message} summary={message.threadSummary} />
        )}
      </div>
      {pickable && (
        <ReactionPicker
          className={ACTION_SLOT[Number(!noThreads)]}
          onPick={(e) => setReaction(message.id, e, true)}
        />
      )}
      {linkable && (
        <CopyLinkButton message={message} className={ACTION_SLOT[Number(!noThreads) + Number(pickable)]} />
      )}
      {!noThreads && <ReplyInThread message={message} />}
    </article>
  );
}
