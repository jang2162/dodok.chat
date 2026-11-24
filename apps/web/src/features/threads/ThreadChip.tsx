import type { Message, RunStatus, ThreadSummary } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { MessageSquareReplyIcon } from "lucide-react";
import { useMemo } from "react";
import { useAgents, usePeople } from "@/api/queries";
import { AvatarGroup, AvatarGroupCount } from "@/ui/avatar";
import { IdentityAvatar } from "@/ui/identity-avatar";
import { cn } from "@/lib/utils";
import { threadRootOf } from "./queries";
import { activeLabel, threadFaces, useThreadActiveRuns } from "./threadParticipants";
import { useNoteThreadOpener } from "./threadOpener";

/** 칩에 그리는 참여자 아바타 수 — 나머지는 +N(채널 헤더의 「참여 에이전트」와 같은 모양) */
const AVATARS_MAX = 4;
const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const DATE = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });
const FULL = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full", timeStyle: "short" });

/** 마지막 답글 시각 — 오늘이면 시각, 아니면 날짜 */
export function lastReplyLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  return d.toDateString() === now.toDateString() ? TIME.format(d) : DATE.format(d);
}

type ResolvedFace = {
  kind: "person" | "agent";
  id: string;
  name: string;
  handle: string;
  avatarUrl?: string | null | undefined;
  /** 그 스레드에서 끝나지 않은 런의 상태 — 에이전트만 */
  active?: RunStatus | undefined;
};

/**
 * 루트 아래 스레드 칩(스레드·검색 스펙 4.2) — 「참여자 아바타(최대 4 + N) · 답글 N개 · 마지막 시각」, 그 스레드에서 끝나지 않은 런이
 * 있으면 그 에이전트 아바타에 링과 「@핸들 응답 중…」. 누르면 그 스레드. 요약은 서버가 루트에 싣는다(`threadSummary` — 답글이
 * 있을 때만) — 요약도 진행 중 런도 없으면 그리지 않는다. 모르는 사람·에이전트(지워졌거나 아직 목록을 못 받았다)는 건너뛰고 +N 에도
 * 세지 않는다. 문구에 aria-live 는 두지 않는다 — 채널 목록의 칩마다 읽히면 시끄럽다(문구는 링크 이름에 든다)
 */
export function ThreadChip({ message, summary }: { message: Message; summary?: ThreadSummary | undefined }) {
  const agents = useAgents().data;
  const people = usePeople().data;
  const active = useThreadActiveRuns(message.channelId, message.conversationId, message.id);
  const faces = useMemo(() => {
    const agentById = new Map((agents ?? []).map((a) => [a.id, a]));
    const personById = new Map((people ?? []).map((p) => [p.id, p]));
    return threadFaces(summary, active).flatMap((f): ResolvedFace[] => {
      if (f.kind === "agent") {
        const a = agentById.get(f.id);
        return a
          ? [
              {
                kind: "agent",
                id: a.id,
                name: a.name,
                handle: a.handle,
                avatarUrl: a.avatarUrl,
                active: f.active,
              },
            ]
          : [];
      }
      const p = personById.get(f.id);
      return p
        ? [{ kind: "person", id: p.id, name: p.displayName, handle: p.handle, avatarUrl: p.avatarUrl }]
        : [];
    });
  }, [agents, people, summary, active]);
  const noteOpener = useNoteThreadOpener(message.id);
  if (summary === undefined && active.length === 0) return null;
  const shown = faces.slice(0, AVATARS_MAX);
  const hidden = faces.length - shown.length;
  const running = faces.filter((f) => f.active !== undefined);
  const firstStatus = running[0]?.active;
  return (
    <Link
      to="/c/$channelId/s/$conversationId/t/$rootId"
      params={{ channelId: message.channelId, conversationId: message.conversationId, rootId: message.id }}
      onClick={noteOpener}
      data-slot="thread-chip"
      className="mt-1 inline-flex min-h-8 max-w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-sm hover:border-border hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      {shown.length > 0 && (
        <AvatarGroup role="group" aria-label="스레드 참여자" className="shrink-0">
          {shown.map((f) => (
            <IdentityAvatar
              key={`${f.kind}:${f.id}`}
              kind={f.kind}
              id={f.id}
              name={f.name}
              handle={f.handle}
              avatarUrl={f.avatarUrl}
              size={24}
              role="img"
              aria-label={f.kind === "agent" ? `@${f.handle}` : f.name}
              title={`${f.name} (@${f.handle})`}
              data-active={f.active !== undefined ? "true" : undefined}
              className={cn(f.active !== undefined && "ring-primary! motion-safe:animate-pulse")}
            />
          ))}
          {hidden > 0 && (
            <AvatarGroupCount role="img" className="size-6 text-xs" aria-label={`참여자 ${hidden}명 더`}>
              +{hidden}
            </AvatarGroupCount>
          )}
        </AvatarGroup>
      )}
      <span className="shrink-0 font-medium text-primary">
        {summary ? `답글 ${summary.count}개` : "스레드"}
      </span>{" "}
      {firstStatus !== undefined ? (
        <span data-slot="thread-chip-active" className="truncate text-primary">
          {activeLabel(
            running.map((f) => f.handle),
            firstStatus,
          )}
        </span>
      ) : (
        summary && (
          <span className="truncate text-muted-foreground">
            마지막 답글{" "}
            <time dateTime={summary.lastAt} title={FULL.format(new Date(summary.lastAt))}>
              {lastReplyLabel(summary.lastAt)}
            </time>
          </span>
        )
      )}
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
