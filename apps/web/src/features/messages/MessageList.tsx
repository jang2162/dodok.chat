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
import { useQueryClient } from "@tanstack/react-query";
import { useShallow } from "zustand/react/shallow";
import { useMe } from "@/api/queries";
import { ApprovalCard } from "@/features/approvals/ApprovalCard";
import { useChannelArchived } from "@/features/channels/archived";
import { selectChannelApprovals, useApprovalStore } from "@/features/approvals/approvalStore";
import { useReadAtEnd } from "@/features/reads/readSender";
import { useRunStore } from "@/features/runs/runStore";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { groupRows, type Row } from "./groupRows";
import { loadLatest } from "./jump";
import { MessageErrorBoundary } from "./MessageErrorBoundary";
import { MessageItem } from "./MessageItem";
import { PendingItem } from "./PendingItem";
import { SystemCard } from "./SystemCard";
import { useJump } from "./useJump";
import { useNewerPages } from "./useNewerPages";
import { reportPageError, useOlderPages } from "./useOlderPages";
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
  /** 스레드 패널이면 그 루트 — 루트·답글과 그 스레드의 버블·승인 카드만 그린다. 없으면 채널 타임라인(루트만) */
  threadRootId?: string;
  /** 태스크 8: 보일 스트리밍 버블의 runId(순서대로) 와 그 버블 */
  bubbleRunIds?: readonly string[];
  bubbles?: (runId: string) => ReactNode;
  /** 처음 재기 전의 스크롤 영역 크기(jsdom 테스트용) */
  initialRect?: { width: number; height: number };
};

/** 채널 메시지 목록(스펙 5.5)·스레드 패널의 목록. 스크롤 위치·「새 메시지」 칩은 채널·스레드마다 새로 시작한다 */
export function MessageList(props: MessageListProps) {
  return <ChannelMessages key={`${props.channelId}:${props.threadRootId ?? ""}`} {...props} />;
}

function ChannelMessages({
  channelId,
  threadRootId,
  bubbleRunIds = NO_RUNS,
  bubbles,
  initialRect,
}: MessageListProps) {
  const timeline = useTimeline(channelId, threadRootId);
  const archived = useChannelArchived();
  // 승인 카드는 스토어에서 바로 읽는다(설계 5.3) — 카드 안은 `ApprovalCard` 가 스스로 구독하므로 여기는 행 자리만 본다.
  // 스레드 런의 승인은 그 스레드에만(런의 소속으로 가른다, 판정 R3′)
  const approvals = useApprovalStore(useShallow(selectChannelApprovals(channelId)));
  const runThreads = useRunStore((s) => s.threads);
  const approvalFacts = useMemo(
    () =>
      approvals
        .map((v) => v.approval)
        .filter((a) => (a.runId === undefined ? undefined : runThreads[a.runId]) === threadRootId),
    [approvals, runThreads, threadRootId],
  );
  const rows = useMemo(
    () => (timeline ? groupRows(timeline, bubbleRunIds, approvalFacts) : []),
    [timeline, bubbleRunIds, approvalFacts],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // 결과로 가기로 받은 떨어진 창(timeline.ts `Timeline` 의 `hasNewer`)
  const hasNewer = timeline?.hasNewer === true;
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey,
    // 채팅 모드: 앞에 붙는 행(과거 페이지)은 보던 행을 기준으로 자리를 지키고, 끝에 붙어 있으면 새 행·자라는 행을 따라간다
    anchorTo: "end",
    // 떨어진 창에서는 따라가지 않는다 — 아래로 이어 받은 행을 따라 내려가면 또 아래 끝이라 다음 쪽이 연달아 불린다
    followOnAppend: !hasNewer,
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
  const older = useOlderPages(channelId, threadRootId);
  const newer = useNewerPages(channelId, threadRootId, hasNewer);
  const qc = useQueryClient();

  const positioned = useRef(false);
  /** 첫 붙임을 놓을 시각(performance.now 기준). 0 이면 끝났거나 사용자가 잡았다 — 효과가 다시 돌아도 되살아나지 않는다 */
  const settleUntil = useRef(0);
  // 결과로 가기(스레드·검색 스펙 5.3) — 그 행을 가운데로. 끝에 붙어 있지 않으므로 첫 붙임·끝 따라가기를 멈춘다
  const arrive = useCallback(
    (index: number) => {
      settleUntil.current = 0;
      setStuck(false);
      virtualizer.scrollToIndex(index, { align: "center" });
    },
    [setStuck, virtualizer],
  );
  const jump = useJump(channelId, threadRootId, timeline, rows, arrive);
  // 「끝이 보임」은 붙어 있음(`stuck`)이다. 그 처음 값(true)은 스크롤하기 전 값이라 떨어진 창과 결과로 가기 목표를 따로 뺀다 —
  // 떨어진 창의 아래 끝은 진짜 끝이 아니고(`lastSeq` 는 창이 아니라 채널의 끝이라 보내면 받지 않은 메시지까지 읽음이 된다),
  // 목표를 안고 열린 목록은 끝으로 가지 않는다
  useReadAtEnd(
    channelId,
    threadRootId === undefined,
    stuck && !hasNewer && !jump.pending,
    timeline?.lastSeq ?? 0,
  );

  // 처음(캐시가 있으면 마운트 때, 없으면 첫 응답 때) 맨 아래로.
  // 한 번 겨누고 마는 것으로는 모자란다 — 행은 추정 높이(64)로 먼저 잡혔다가 그 뒤에 실제로 재어지는데,
  // 겨누기는 맞게 되고 그 다음 프레임에 도로 맨 위로 떨어진다. 브라우저에서 잰 것(80건 채널, 뷰포트 658):
  // scrollToEnd 직후 scrollTop 4526/총 5184 → 다음 프레임 0/4029. 줄어든 만큼(−1155)이 아니라 0 이 된다 —
  // virtual-core 가 줄어든 총 높이를 보정할 때 아직 한 번도 못 본 스크롤 오프셋(0)에서 빼는 것으로 보인다.
  // 그래서 총 높이가 잦아들 때까지 프레임마다 끝에 다시 붙인다. 사용자가 손을 대면 그 자리에서 멈춘다 —
  // 스스로 위로 올린 사람을 끌어내리지 않는다(스펙 5.5: 맨 아래에 붙어 있을 때만 따라간다).
  // 결과로 가기 목표를 안고 열렸으면 끝으로 가지 않는다 — 그 메시지로 간다(`useJump`)
  const jumpPending = jump.pending;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win || rows.length === 0) return;
    const pin = () => {
      el.scrollTop = el.scrollHeight - el.clientHeight;
    };
    if (!positioned.current) {
      positioned.current = true;
      if (jumpPending) {
        settleUntil.current = 0;
        return;
      }
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
  }, [rows.length, virtualizer, jumpPending]);

  // 내가 보낸 항목이 붙으면 위를 보고 있었어도 끝으로. 떨어진 창이면 먼저 최신으로 — 보내는 중 항목은 늘 목록 끝이라
  // 창 뒤에 곧바로 붙으면 그 사이의 받지 않은 메시지가 보이지 않은 채 이어진 것처럼 보인다
  const lastPending = timeline?.pending.at(-1)?.clientMsgId;
  const prevPending = useRef(lastPending);
  useLayoutEffect(() => {
    if (lastPending === prevPending.current) return;
    prevPending.current = lastPending;
    if (lastPending === undefined) return;
    setStuck(true);
    if (hasNewer) {
      loadLatest(qc, channelId, threadRootId).then(() => virtualizer.scrollToEnd(), reportPageError);
      return;
    }
    virtualizer.scrollToEnd();
  }, [lastPending, virtualizer, hasNewer, qc, channelId, threadRootId, setStuck]);

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

  // 떨어진 창의 아래 끝은 목록의 끝이 아니다 — 붙어 있지 않은 것으로 둬 새 행을 따라가지 않는다(아래로 이어 받기가 연달아 돌지 않게)
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStuck(fromBottom <= STICK_PX && !hasNewer);
    older.onScrollTop(el.scrollTop);
    newer.onScrollBottom(fromBottom);
  };

  // 칩은 누르면 사라진다 — 초점을 목록으로 옮겨 잃지 않게
  const toEnd = () => {
    setStuck(true);
    virtualizer.scrollToEnd();
    scrollRef.current?.focus({ preventScroll: true });
  };
  const toLatest = async () => {
    try {
      await loadLatest(qc, channelId, threadRootId);
    } catch (e) {
      reportPageError(e);
      return;
    }
    toEnd();
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
        aria-label={threadRootId === undefined ? "메시지" : "스레드 메시지"}
        tabIndex={0}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {items.map((v) => {
            const row = rows[v.index];
            if (!row) return null;
            // 결과로 가기가 도착한 메시지 — 색이 옅어지며 풀린다. 움직임을 줄이는 설정이면 색만 바뀐다
            const lit = row.kind === "message" && row.message.id === jump.highlighted;
            return (
              <div
                key={v.key}
                data-index={v.index}
                data-highlighted={lit || undefined}
                ref={virtualizer.measureElement}
                className={cn(
                  "absolute top-0 left-0 w-full transition-colors duration-700 motion-reduce:transition-none",
                  lit && "bg-yellow-100/70 dark:bg-yellow-500/15",
                )}
                style={{ transform: `translateY(${v.start}px)` }}
              >
                <MessageErrorBoundary resetKey={resetKeyOf(row)}>
                  <RowView
                    row={row}
                    channelId={channelId}
                    inThread={threadRootId !== undefined}
                    bubble={row.kind === "bubble" ? bubbles?.(row.runId) : undefined}
                  />
                </MessageErrorBoundary>
              </div>
            );
          })}
        </div>
        {rows.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {/* 보관한 채널에는 멘션을 보낼 수 없다 — 부르라는 안내를 빼고 */}
            {archived ? "메시지가 없습니다." : "아직 메시지가 없습니다. @멘션으로 에이전트를 불러 보세요."}
          </p>
        )}
      </div>
      {newer.loading && (
        <p
          role="status"
          className="absolute inset-x-0 bottom-14 z-10 mx-auto w-fit rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm"
        >
          다음 메시지를 불러오는 중…
        </p>
      )}
      <div aria-live="polite" className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        {hasNewer ? (
          <Button
            size="sm"
            className="pointer-events-auto rounded-full shadow-md"
            onClick={() => void toLatest()}
          >
            최신 메시지로
            <ArrowDownIcon aria-hidden />
          </Button>
        ) : (
          unseen > 0 && (
            <Button size="sm" className="pointer-events-auto rounded-full shadow-md" onClick={toEnd}>
              새 메시지 {unseen}개
              <ArrowDownIcon aria-hidden />
            </Button>
          )
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
  // 구분선(날짜)·버블(runId)·승인(approvalId)은 key 에 다 들어 있다 — 카드 안은 저마다 스토어를 구독한다
  return true;
}

type RowProps = { row: Row; channelId: string; inThread: boolean; bubble: ReactNode };
const RowView = memo(
  function RowView({ row, channelId, inThread, bubble }: RowProps) {
    switch (row.kind) {
      case "divider":
        return <DayDivider date={row.date} />;
      case "message":
        return row.message.kind === "system" ? (
          <SystemCard message={row.message} />
        ) : (
          <MessageItem message={row.message} head={row.head} inThread={inThread} />
        );
      case "pending":
        return <PendingItem pending={row.pending} />;
      case "bubble":
        return bubble ?? null;
      case "approval":
        return <ApprovalCard approvalId={row.approvalId} channelId={channelId} />;
    }
  },
  (a: RowProps, b: RowProps) =>
    a.bubble === b.bubble &&
    a.channelId === b.channelId &&
    a.inThread === b.inThread &&
    sameRow(a.row, b.row),
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
 * 내 메시지는 세지 않는다(보낼 때 끝으로 간다). 기준은 가진 마지막 메시지의 seq — 사본에서 복원한 타임라인은
 * `lastSeq` 가 0 이라(첫 구독을 새로 받게) 그것을 쓰면 오프라인에서 위로 올리자마자 전부 새 메시지로 센다
 */
function useUnseen(timeline: ReturnType<typeof useTimeline>, stuck: boolean): number {
  const me = useMe().data?.user.id;
  const lastSeq = timeline?.items.at(-1)?.seq ?? 0;
  const [seenSeq, setSeenSeq] = useState(lastSeq);
  useEffect(() => {
    if (stuck && seenSeq !== lastSeq) setSeenSeq(lastSeq);
  }, [stuck, lastSeq, seenSeq]);
  if (stuck || !timeline) return 0;
  return timeline.items.filter((m) => m.seq > seenSeq && !(m.authorType === "user" && m.authorId === me))
    .length;
}
