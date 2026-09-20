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
/** 첫 붙임 — 총 높이가 이만큼 연속 프레임 그대로면 측정이 끝난 것으로 본다 */
const SETTLE_FRAMES = 3;
/** 그래도 이 시간을 넘기면 놓는다 — 끝없이 붙들지 않는다 */
const SETTLE_MAX_MS = 1_000;
/** 이 중 하나라도 오면 사용자가 스크롤을 잡은 것이다 — 첫 붙임을 그만둔다 */
const HANDS_ON = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
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
    // 잰 크기를 ResizeObserver 콜백 안에서 바로 반영하면 같은 프레임에 또 배치가 바뀌어
    // 「ResizeObserver loop completed with undelivered notifications」 가 난다(브라우저 검증 결함 4 — 개발 모드에서
    // Vite 오버레이를 띄워 진짜 오류를 가린다). 한 프레임 미루면 사라진다. 끝에 붙어 있는 동안에는
    // `scrollToEnd` 가 프레임마다 다시 겨누므로 한 프레임 늦은 반영이 보이지 않는다
    useAnimationFrameWithResizeObserver: true,
    ...(initialRect ? { initialRect } : {}),
  });

  const [stuck, setStuckState] = useState(true);
  // 끝에 붙어 있는지 — ResizeObserver 콜백은 다시 그려지길 기다리지 않으므로 지금 값을 ref 로도 들고 있는다
  const stuckRef = useRef(true);
  const setStuck = useCallback((next: boolean) => {
    stuckRef.current = next;
    setStuckState(next);
  }, []);
  const unseen = useUnseen(timeline, stuck);
  const older = useOlderPages(channelId);

  // 처음(캐시가 있으면 마운트 때, 없으면 첫 응답 때) 맨 아래로.
  // 한 번 겨누고 마는 것으로는 모자란다 — 행은 추정 높이(64)로 먼저 잡혔다가 그 뒤에 실제로 재어지는데,
  // 겨누기는 맞게 되고 그 다음 프레임에 도로 맨 위로 떨어진다. 브라우저에서 잰 것(80건 채널, 뷰포트 658):
  // scrollToEnd 직후 scrollTop 4526/총 5184 → 다음 프레임 0/4029. 줄어든 만큼(−1155)이 아니라 0 이 된다 —
  // virtual-core 가 줄어든 총 높이를 보정할 때 아직 한 번도 못 본 스크롤 오프셋(0)에서 빼는 것으로 보인다.
  // 그래서 총 높이가 잦아들 때까지 프레임마다 끝에 다시 붙인다. 사용자가 손을 대면 그 자리에서 멈춘다 —
  // 스스로 위로 올린 사람을 끌어내리지 않는다(스펙 5.5: 맨 아래에 붙어 있을 때만 따라간다)
  const positioned = useRef(false);
  /** 첫 붙임을 놓을 시각(performance.now 기준). 0 이면 끝났거나 사용자가 잡았다 — 효과가 다시 돌아도 되살아나지 않는다 */
  const settleUntil = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win || rows.length === 0) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight - el.clientHeight;
    };
    if (!positioned.current) {
      positioned.current = true;
      virtualizer.scrollToEnd();
      pin();
      settleUntil.current = win.performance.now() + SETTLE_MAX_MS;
    }
    if (settleUntil.current <= win.performance.now()) return;
    let raf = 0;
    let stableFrames = 0;
    let lastHeight = el.scrollHeight;
    const stop = () => {
      win.cancelAnimationFrame(raf);
      for (const type of HANDS_ON) el.removeEventListener(type, handsOn);
    };
    /** 사용자가 스크롤을 잡았다 — 다시 붙이지 않는다 */
    function handsOn() {
      settleUntil.current = 0;
      stop();
    }
    const tick = () => {
      if (win.performance.now() > settleUntil.current) return stop();
      stableFrames = el.scrollHeight === lastHeight ? stableFrames + 1 : 0;
      lastHeight = el.scrollHeight;
      pin();
      if (stableFrames >= SETTLE_FRAMES) {
        settleUntil.current = 0;
        return stop();
      }
      raf = win.requestAnimationFrame(tick);
    };
    raf = win.requestAnimationFrame(tick);
    for (const type of HANDS_ON) el.addEventListener(type, handsOn, { passive: true });
    return stop;
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

  // 끝에 붙은 채 마지막 행이 다른 key 로 바뀌면(버블 → 확정 메시지, 보내는 중 → 확정) 끝으로. 행 수가 같아 followOnAppend 가
  // 걸리지 않고, 새 행이 추정 높이로 먼저 잡혔다 재어지면 virtual-core 는 끝까지 남은 거리를 그대로 둔다.
  // scrollToEnd 는 다시 그려진 뒤에도 끝이 맞을 때까지 프레임마다 다시 겨눈다
  const lastKey = rows.at(-1)?.key;
  const prevLastKey = useRef(lastKey);
  useLayoutEffect(() => {
    if (lastKey === prevLastKey.current) return;
    prevLastKey.current = lastKey;
    if (stuck) virtualizer.scrollToEnd();
  }, [lastKey, stuck, virtualizer]);

  // 뷰포트가 줄면(연결 배너가 생기거나 창이 작아지면) 브라우저는 scrollTop 을 그대로 둬 끝에서 그만큼 떨어진다 —
  // 붙어 있는 동안에만 다시 겨눈다. 스스로 위로 올린 사람은 끌어내리지 않는다(스펙 5.5, 태스크 13 수정 라운드 규칙).
  // 반영은 한 프레임 미룬다 — ResizeObserver 콜백 안에서 배치를 또 바꾸면 「loop completed with undelivered notifications」 가 난다
  // 타임라인을 받기 전에는 스크롤 영역 대신 자리표시를 그린다 — 붙을 때 다시 건다
  const mounted = timeline !== undefined;
  useEffect(() => {
    const el = scrollRef.current;
    const win = el?.ownerDocument.defaultView;
    if (!mounted || !el || !win) return;
    let raf = 0;
    const observer = new win.ResizeObserver(() => {
      if (!stuckRef.current) return;
      win.cancelAnimationFrame(raf);
      raf = win.requestAnimationFrame(() => {
        if (!stuckRef.current) return;
        virtualizer.scrollToEnd();
        el.scrollTop = el.scrollHeight - el.clientHeight;
      });
    });
    observer.observe(el);
    return () => {
      win.cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, [mounted, virtualizer]);

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
