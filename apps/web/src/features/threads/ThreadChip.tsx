import type { Message, ThreadSummary } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { MessageSquareReplyIcon } from "lucide-react";
import { useMemo } from "react";
import { useAgents } from "@/api/queries";
import { agentColorVar } from "@/theme/agentColor";
import { Avatar, AvatarFallback, AvatarImage } from "@/ui/avatar";
import { threadRootOf } from "./queries";
import { useNoteThreadOpener } from "./threadOpener";

/** 칩에 그리는 에이전트 아바타 수 — 요약의 agentIds 는 최근에 답한 에이전트부터다 */
const AVATARS_MAX = 3;
const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });
const FULL = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeStyle: "short" });

/** 마지막 답글 시각 — 오늘이면 시각, 아니면 날짜 */
export function lastReplyLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? TIME.format(d) : DATE.format(d);
}

/**
 * 루트 아래 답글 요약 칩(스레드·검색 스펙 4.2) — 「답글 N · 마지막 시각 · 에이전트 아바타(최대 3)」, 누르면 그 스레드.
 * 요약은 서버가 루트에 싣는다(`threadSummary` — 답글이 있을 때만). 모르는 에이전트(지워졌거나 아직 목록을 못 받았다)는 건너뛴다
 */
export function ThreadChip({ message, summary }: { message: Message; summary: ThreadSummary }) {
  const agents = useAgents().data;
  const faces = useMemo(() => {
    const byId = new Map((agents ?? []).map((a) => [a.id, a]));
    return summary.agentIds.flatMap((id) => byId.get(id) ?? []).slice(0, AVATARS_MAX);
  }, [agents, summary.agentIds]);
  const noteOpener = useNoteThreadOpener(message.id);
  return (
    <Link
      to="/c/$channelId/s/$conversationId/t/$rootId"
      params={{ channelId: message.channelId, conversationId: message.conversationId, rootId: message.id }}
      onClick={noteOpener}
      data-slot="thread-chip"
      className="mt-1 inline-flex max-w-full items-center gap-2 rounded-md border border-transparent px-1.5 py-0.5 text-xs hover:border-border hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {faces.length > 0 && (
        <span className="flex -space-x-1.5" aria-hidden>
          {faces.map((a) => (
            <Avatar
              key={a.id}
              size="sm"
              className="size-5 border-2"
              style={{ borderColor: agentColorVar(a.handle) }}
            >
              {a.avatarUrl && <AvatarImage src={a.avatarUrl} alt="" />}
              <AvatarFallback className="text-[10px]">{a.name.slice(0, 1)}</AvatarFallback>
            </Avatar>
          ))}
        </span>
      )}
      <span className="font-medium text-primary">답글 {summary.count}개</span>
      <span className="truncate text-muted-foreground">
        마지막 답글{" "}
        <time dateTime={summary.lastAt} title={FULL.format(new Date(summary.lastAt))}>
          {lastReplyLabel(summary.lastAt)}
        </time>
      </span>
    </Link>
  );
}

/**
 * 메시지 메뉴의 「스레드에서 답하기」 — 답글이면 그 답글의 루트 스레드를 연다(스레드 안의 스레드는 없다, Review Focus 1).
 * 마우스를 올리거나 행 안에 초점이 있을 때 보이고, 호버가 없는 기기(터치)에서는 늘 보인다
 */
export function ReplyInThread({ message }: { message: Message }) {
  const rootId = threadRootOf(message);
  const noteOpener = useNoteThreadOpener(rootId);
  return (
    <Link
      to="/c/$channelId/s/$conversationId/t/$rootId"
      params={{ channelId: message.channelId, conversationId: message.conversationId, rootId }}
      onClick={noteOpener}
      aria-label="스레드에서 답하기"
      title="스레드에서 답하기"
      data-slot="reply-in-thread"
      className="absolute top-1 right-3 inline-flex size-7 items-center justify-center rounded-md border bg-background text-muted-foreground opacity-0 shadow-xs group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none [@media(hover:none)]:opacity-100"
    >
      <MessageSquareReplyIcon className="size-4" aria-hidden />
    </Link>
  );
}
