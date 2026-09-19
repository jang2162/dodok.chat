import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMe } from "@/api/queries";
import { Button } from "@/ui/button";
import { groupRows, type Row } from "./groupRows";
import { MessageErrorBoundary } from "./MessageErrorBoundary";
import { MessageItem } from "./MessageItem";
import { PendingItem } from "./PendingItem";
import { SystemCard } from "./SystemCard";
import { useOlderPages } from "./useOlderPages";
import { useTimeline } from "./useTimeline";

/** 하단에서 이만큼 안이면 「맨 아래에 붙어 있다」 — 새 행을 따라간다(스펙 5.5) */
const STICK_PX = 80;
const NO_RUNS: readonly string[] = [];
const DAY = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full" });

export type MessageListProps = {
  channelId: string;
  /** 태스크 8: 보일 스트리밍 버블의 runId(순서대로) 와 그 버블 */
  bubbleRunIds?: readonly string[];
  bubbles?: (runId: string) => ReactNode;
  /** 처음 재기 전의 스크롤 영역 크기(jsdom 테스트용) */
  initialRect?: { width: number; height: number };
};

/** 채널 메시지 목록(스펙 5.5). 스크롤 위치·「새 메시지」 칩은 채널마다 새로 시작한다 */
export function MessageList(props: MessageListProps) {
  return <ChannelMessages key={props.channelId} {...props} />;
}

function ChannelMessages({ channelId, bubbleRunIds = NO_RUNS, bubbles, initialRect }: MessageListProps) {
  const timeline = useTimeline(channelId);
  const rows = useMemo(() => (timeline ? groupRows(timeline, bubbleRunIds) : []), [timeline, bubbleRunIds]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey,
    // 채팅 모드: 앞에 붙는 행(과거 페이지)은 보던 행을 기준으로 자리를 지키고, 끝에 붙어 있으면 새 행·자라는 행을 따라간다
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: STICK_PX,
    ...(initialRect ? { initialRect } : {}),
  });

  const [stuck, setStuck] = useState(true);
  const unseen = useUnseen(timeline, stuck);
  const older = useOlderPages(channelId);

  // 처음(캐시가 있으면 마운트 때, 없으면 첫 응답 때) 맨 아래로
  const positioned = useRef(false);
  useLayoutEffect(() => {
    if (positioned.current || rows.length === 0) return;
    positioned.current = true;
    virtualizer.scrollToEnd();
  }, [rows.length, virtualizer]);

  // 내가 보낸 항목이 붙으면 위를 보고 있었어도 끝으로
  const lastPending = timeline?.pending.at(-1)?.clientMsgId;
  const prevPending = useRef(lastPending);
  useLayoutEffect(() => {
    if (lastPending === prevPending.current) return;
    prevPending.current = lastPending;
    if (lastPending === undefined) return;
    setStuck(true);
    virtualizer.scrollToEnd();
  }, [lastPending, virtualizer]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setStuck(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX);
    older.onScrollTop(el.scrollTop);
  };

  // 칩은 누르면 사라진다 — 초점을 목록으로 옮겨 잃지 않게
  const toEnd = () => {
    setStuck(true);
    virtualizer.scrollToEnd();
    scrollRef.current?.focus({ preventScroll: true });
  };

  if (!timeline) return <Skeleton />;
  const items = virtualizer.getVirtualItems();
  return (
    <div data-slot="messages" className="relative flex min-h-0 flex-1 flex-col">
      {older.loading && (
        <p
          role="status"
          className="absolute inset-x-0 top-2 z-10 mx-auto w-fit rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm"
        >
          이전 메시지를 불러오는 중…
        </p>
      )}
      <div
        ref={scrollRef}
        data-scroller
        role="region"
        aria-label="메시지"
        tabIndex={0}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            return (
              <div
                key={v.key}
                data-index={v.index}
                ref={virtualizer.measureElement}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <MessageErrorBoundary resetKey={resetKeyOf(row)}>
                  <RowView row={row} bubble={row.kind === "bubble" ? bubbles?.(row.runId) : undefined} />
                </MessageErrorBoundary>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            아직 메시지가 없습니다. @멘션으로 에이전트를 불러 보세요.
          </p>
        )}
      </div>
      <div aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        {unseen > 0 && (
          <Button size="sm" className="pointer-events-auto rounded-full shadow-md" onClick={toEnd}>
            새 메시지 {unseen}개
            <ArrowDownIcon aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}

/** 행 내용이 바뀌면 에러 경계를 풀어 다시 그려 본다(수정된 메시지·보내는 중 상태) */
function resetKeyOf(row: Row): unknown {
  if (row.kind === "message") return row.message;
  if (row.kind === "pending") return row.pending;
  return row.key;
}

/** groupRows 는 갱신마다 행 객체를 새로 만든다 — 내용(메시지·보내는 중 항목의 정체성, 머리 여부)이 같으면 다시 그리지 않는다 */
function sameRow(a: Row, b: Row): boolean {
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "message" && b.kind === "message") return a.message === b.message && a.head === b.head;
  if (a.kind === "pending" && b.kind === "pending") return a.pending === b.pending;
  return true; // 구분선(날짜)·버블(runId)은 key 에 다 들어 있다
}

type RowProps = { row: Row; bubble: ReactNode };
const RowView = memo(
  function RowView({ row, bubble }: RowProps) {
    switch (row.kind) {
      case "divider":
        return <DayDivider date={row.date} />;
      case "message":
        return row.message.kind === "system" ? (
          <SystemCard message={row.message} />
        ) : (
          <MessageItem message={row.message} head={row.head} />
        );
      case "pending":
        return <PendingItem pending={row.pending} />;
      case "bubble":
        return bubble ?? null;
    }
  },
  (a: RowProps, b: RowProps) => a.bubble === b.bubble && sameRow(a.row, b.row),
);

function DayDivider({ date }: { date: string }) {
  // date 는 그 시간대의 YYYY-MM-DD — 정오로 만들어 어느 시간대에서 읽어도 같은 날이 되게
  const label = DAY.format(new Date(`${date}T12:00:00`));
  return (
    <div role="separator" aria-label={label} className="flex items-center gap-3 px-4 py-2">
      <div className="h-px flex-1 bg-border" />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

function Skeleton() {
  return (
    <div
      data-slot="messages"
      role="status"
      aria-label="메시지를 불러오는 중"
      className="min-h-0 flex-1 space-y-5 p-4"
    >
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-3">
          <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="h-3 w-2/3 rounded bg-muted" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 맨 아래에 붙어 있지 않을 때 들어온 확정 메시지 수(스펙 5.5 칩). 붙어 있으면 본 것으로 친다.
 * 내 메시지는 세지 않는다(보낼 때 끝으로 간다)
 */
function useUnseen(timeline: ReturnType<typeof useTimeline>, stuck: boolean): number {
  const me = useMe().data?.user.id;
  const lastSeq = timeline?.lastSeq ?? 0;
  const [seenSeq, setSeenSeq] = useState(lastSeq);
  useEffect(() => {
    if (stuck && seenSeq !== lastSeq) setSeenSeq(lastSeq);
  }, [stuck, lastSeq, seenSeq]);
  if (stuck || !timeline) return 0;
  return timeline.items.filter((m) => m.seq > seenSeq && !(m.authorType === "user" && m.authorId === me))
    .length;
}
