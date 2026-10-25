import type { Conversation } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { Button } from "@/ui/button";
import { Input } from "@/ui/input";
import { useConversationUnread } from "@/features/reads/useUnread";
import { useConversationPermissions } from "./permissions";
import { useConversationActivity, useConversationList } from "./queries";

/** 제목 검색을 서버에 묻기 전에 기다리는 시간 — 글자마다 요청이 나가지 않게 */
export const SEARCH_DEBOUNCE_MS = 250;

const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });
const FULL = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeStyle: "short" });

/** 마지막 활동 — 오늘이면 시각, 아니면 날짜 */
function ActivityTime({ iso }: { iso: string }) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return (
    <time dateTime={iso} title={FULL.format(d)} className="shrink-0 text-xs text-muted-foreground">
      {today ? TIME.format(d) : DAY.format(d)}
    </time>
  );
}

/**
 * 채널의 세션 목록(채널 세션 스펙 「웹」 장) — 넓은 화면은 타임라인 왼쪽 칸, 좁은 화면은 시트 안에 같은 것을 그린다(배치는 부르는 쪽).
 * 「열림/닫힘」 필터, 제목 검색(서버 `q`), 최근 활동순, 지금 세션은 `aria-current`. 「새 세션」은 만들 수 있는 사람에게만(정책·역할 —
 * `useConversationPermissions`). 읽지 않음 점·멘션 배지는 줄마다 읽음 쪽(features/reads)의 그 세션 값을 듣는다 — 현황 전·실패·끊김이면 그리지 않는다. `onPick` 은 항목·「새 세션」을 눌렀을 때 —
 * 시트를 닫으려고. 칸이 떠 있는 동안 새 글로 순서를 올린다(`useConversationActivity`)
 */
export function ConversationList({
  channelId,
  conversationId,
  onPick,
  inSheet = false,
}: {
  channelId: string;
  conversationId: string;
  onPick?: () => void;
  /** 좁은 화면 시트 안 — 머리 오른쪽을 시트의 닫기 단추 자리만큼 비운다(패널 시트 머리 `PanelTabs` 와 같은 pr-12) */
  inSheet?: boolean;
}) {
  const [status, setStatus] = useState<"open" | "closed">("open");
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const next = input.trim();
    if (next === q) return;
    const timer = setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input, q]);
  const list = useConversationList(channelId, status, q);
  useConversationActivity(channelId);
  const { canCreate } = useConversationPermissions(channelId);
  const searchId = useId();

  return (
    <nav aria-label="세션 목록" data-testid="conversation-list" className="flex min-h-0 flex-1 flex-col">
      <div className={cn("flex items-center gap-2 px-3 pt-3", inSheet && "pr-12")}>
        <h2 className="flex-1 text-sm font-semibold">세션</h2>
        {canCreate && (
          <Button asChild variant="outline" size="xs">
            <Link
              to="/c/$channelId/s/$conversationId"
              params={{ channelId, conversationId: NEW_CONVERSATION }}
              onClick={onPick}
            >
              <PlusIcon />새 세션
            </Link>
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2">
        <div role="group" aria-label="세션 상태" className="flex gap-1">
          {(["open", "closed"] as const).map((s) => (
            <Button
              key={s}
              type="button"
              size="xs"
              variant={status === s ? "secondary" : "ghost"}
              aria-pressed={status === s}
              onClick={() => setStatus(s)}
            >
              {s === "open" ? "열림" : "닫힘"}
            </Button>
          ))}
        </div>
        <label htmlFor={searchId} className="sr-only">
          세션 제목 검색
        </label>
        <Input
          id={searchId}
          type="search"
          placeholder="제목 검색"
          value={input}
          maxLength={80}
          className="h-8"
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        <ListBody
          list={list}
          status={status}
          searching={q !== ""}
          channelId={channelId}
          conversationId={conversationId}
          onPick={onPick}
        />
      </div>
    </nav>
  );
}

function ListBody({
  list,
  status,
  searching,
  channelId,
  conversationId,
  onPick,
}: {
  list: ReturnType<typeof useConversationList>;
  status: "open" | "closed";
  searching: boolean;
  channelId: string;
  conversationId: string;
  onPick?: () => void;
}) {
  if (list.data === undefined) {
    return list.isError ? (
      <div className="flex flex-col items-start gap-2 px-1.5 text-sm text-muted-foreground">
        세션 목록을 불러오지 못했습니다
        <Button variant="outline" size="xs" onClick={() => void list.refetch()}>
          다시 시도
        </Button>
      </div>
    ) : (
      <p role="status" className="px-1.5 text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  }
  if (list.conversations.length === 0) {
    return (
      <p className="px-1.5 text-sm text-muted-foreground">
        {searching
          ? "찾는 세션이 없습니다."
          : status === "open"
            ? "열린 세션이 없습니다."
            : "닫힌 세션이 없습니다."}
      </p>
    );
  }
  return (
    <>
      <ul className="flex flex-col gap-0.5">
        {list.conversations.map((c) => (
          <ConversationItem
            key={c.id}
            channelId={channelId}
            conversation={c}
            current={c.id === conversationId}
            onPick={onPick}
          />
        ))}
      </ul>
      {list.hasNextPage && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1 w-full"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "불러오는 중…" : "더 보기"}
        </Button>
      )}
    </>
  );
}

function ConversationItem({
  channelId,
  conversation,
  current,
  onPick,
}: {
  channelId: string;
  conversation: Conversation;
  current: boolean;
  onPick?: () => void;
}) {
  const mark = useConversationUnread(conversation.id);
  const unread = mark?.unread === true && !current;
  const mentions = mark?.mentions ?? 0;
  return (
    <li>
      <Link
        to="/c/$channelId/s/$conversationId"
        params={{ channelId, conversationId: conversation.id }}
        aria-current={current ? "page" : undefined}
        data-unread={unread || undefined}
        onClick={onPick}
        className={cn(
          "flex items-center gap-2 rounded-md px-1.5 py-1.5 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none",
          current && "bg-accent",
        )}
      >
        <span className={cn("min-w-0 flex-1 truncate", unread && "font-semibold")}>{conversation.title}</span>
        {mentions > 0 && (
          <span
            data-slot="mention-badge"
            className="shrink-0 rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground"
          >
            <span aria-hidden>{mentions > 99 ? "99+" : mentions}</span>
            <span className="sr-only">{`나를 멘션한 글 ${mentions}개`}</span>
          </span>
        )}
        {unread && mentions === 0 && (
          <span data-slot="unread-dot" className="size-2 shrink-0 rounded-full bg-primary">
            <span className="sr-only">읽지 않음</span>
          </span>
        )}
        <ActivityTime iso={conversation.lastMessageAt ?? conversation.createdAt} />
      </Link>
    </li>
  );
}
