import { defaultRangeExtractor, type Range, useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon } from "lucide-react";
import {
  type FocusEvent,
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
import { useUnread } from "@/features/reads/useUnread";
import { useRunStore } from "@/features/runs/runStore";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { groupRows, type Row } from "./groupRows";
import { jumpToFirstRootAfter, loadLatest } from "./jump";
import { MessageErrorBoundary } from "./MessageErrorBoundary";
import { MessageItem } from "./MessageItem";
import { PendingItem } from "./PendingItem";
import { SystemCard } from "./SystemCard";
import { useJump } from "./useJump";
import { useNewerPages } from "./useNewerPages";
import { reportPageError, useOlderPages } from "./useOlderPages";
import { NEW_CONVERSATION, type Timeline } from "./timeline";
import { useTimelineState } from "./useTimeline";

/** 하단에서 이만큼 안이면 「맨 아래에 붙어 있다」 — 새 행을 따라간다(스펙 5.5) */
const STICK_PX = 80;
/** 첫 붙임 — 총 높이가 이만큼 연속 프레임 그대로면 측정이 끝난 것으로 본다 */
const SETTLE_FRAMES = 3;
/** 그래도 이 시간을 넘기면 놓는다 — 끝없이 붙들지 않는다 */
const SETTLE_MAX_MS = 1_000;
/** 이 중 하나라도 오면 사용자가 스크롤을 잡은 것이다 — 첫 붙임을 그만둔다 */
const HANDS_ON = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
/** 안 읽은 채널을 열 때 「새 메시지」 구분선이 뷰포트 위에서 이만큼 아래에 선다 — 앞 메시지 한두 줄(머리가 있는 줄 약 60px × 2)이 위에 남아 어디서 이어지는지 보인다 */
const UNREAD_CONTEXT_PX = 128;
/** 이어 받기를 기다리며 읽음을 붙잡는 가장 긴 시간 — 응답이 끝내 안 오면 놓는다 */
const AWAIT_UNREAD_MAX_MS = 5_000;
const NO_RUNS: readonly string[] = [];
const DAY = new Intl.DateTimeFormat("ko-KR", { dateStyle: "full" });

export type MessageListProps = {
  channelId: string;
  /** 그 채널의 세션 — 목록·버블·승인 카드는 이 세션의 것만(채널 세션 계획 판정 PS6·PS7). 새 세션 창이면 `NEW_CONVERSATION` */
  conversationId: string;
  /** 스레드 패널이면 그 루트 — 루트·답글과 그 스레드의 버블·승인 카드만 그린다. 없으면 세션 타임라인(루트만) */
  threadRootId?: string;
  /** 좁은 화면의 패널 시트가 이 목록을 덮고 있다 — 끝이 보이는 것으로 치지 않는다(읽음을 보내지 않는다) */
  covered?: boolean;
  /** 세션에 들어갈 때 잡은 읽음 위치(`captureEntryRead`) — 없으면 「새 메시지」 구분선도 배너도 없고 끝에서 연다. 있으면 구분선이 받은 행 안일 때 그 선에서 연다(0 이면 끝에서). 스레드 패널은 넘기지 않는다 */
  entryReadSeq?: number;
  /** 태스크 8: 보일 스트리밍 버블의 runId(순서대로) 와 그 버블 */
  bubbleRunIds?: readonly string[];
  bubbles?: (runId: string) => ReactNode;
  /** 처음 재기 전의 스크롤 영역 크기(jsdom 테스트용) */
  initialRect?: { width: number; height: number };
  /** 메시지가 없을 때의 문구 — 없으면 채널의 것(멘션을 권한다). DM 은 멘션이 없어 따로 준다(첫 안내 등) */
  emptyText?: string;
};

/** 세션 메시지 목록(스펙 5.5)·스레드 패널의 목록. 스크롤 위치·「새 메시지」 칩은 세션·스레드마다 새로 시작한다 */
export function MessageList(props: MessageListProps) {
  return (
    <ChannelMessages
      key={`${props.channelId}:${props.conversationId}:${props.threadRootId ?? ""}`}
      {...props}
    />
  );
}

function ChannelMessages({
  channelId,
  conversationId,
  threadRootId,
  covered = false,
  entryReadSeq,
  bubbleRunIds = NO_RUNS,
  bubbles,
  initialRect,
  emptyText,
}: MessageListProps) {
  const { timeline, ready } = useTimelineState(channelId, conversationId, threadRootId);
  const archived = useChannelArchived();
  // 승인 카드는 스토어에서 바로 읽는다(설계 5.3) — 카드 안은 `ApprovalCard` 가 스스로 구독하므로 여기는 행 자리만 본다.
  // 그 세션의 승인만(계획 판정 PS7), 스레드 런의 승인은 그 스레드에만(런의 소속으로 가른다, 판정 R3′)
  const approvals = useApprovalStore(useShallow(selectChannelApprovals(channelId)));
  const runThreads = useRunStore((s) => s.threads);
  const approvalFacts = useMemo(
    () =>
      approvals
        .map((v) => v.approval)
        .filter(
          (a) =>
            a.conversationId === conversationId &&
            (a.runId === undefined ? undefined : runThreads[a.runId]) === threadRootId,
        ),
    [approvals, runThreads, conversationId, threadRootId],
  );
  const me = useMe().data?.user.id;
  const rows = useMemo(
    () => (timeline ? groupRows(timeline, bubbleRunIds, approvalFacts, undefined, { entryReadSeq, me }) : []),
    [timeline, bubbleRunIds, approvalFacts, entryReadSeq, me],
  );
  // 구분선이 있는 채널은 처음 위치를 정하기 전까지 끝 보임으로 치지 않는다 — 첫 렌더의 `stuck`(true) 가 읽음 요청을 먼저 내보내지 않게.
  // 읽은 자리가 0 인 채널(새 멤버가 처음 여는 채널 등)은 끝에서 연다(사용자 결정) — 기록 전체가 안 읽음이라 구분선에서 열면
  // 첫 구독 한 쪽(루트 200개)에 다 드는 채널은 맨 첫 글에서 열린다
  const entryTracked = threadRootId === undefined && entryReadSeq !== undefined && entryReadSeq > 0;
  const [entryHold, setEntryHold] = useState(entryTracked);
  /**
   * 캐시가 낡은 채로 열렸다 — 서버가 아는 최신 seq(없으면 undefined). 이어 받기가 거기까지 닿을 때까지 읽음을 붙잡고 끝 보임으로
   * 치지 않는다: 구분선이 캐시에 이미 있어도 이어 받을 글이 붙기 전의 끝 보임으로 보내면 받지 않은 글까지 읽음이 된다.
   * `pin` 이 지금 값을 보므로 ref 로도 든다
   */
  const [awaitSeq, setAwaitSeqState] = useState<number>();
  const awaitRef = useRef<number | undefined>(undefined);
  const setAwaitSeq = useCallback((seq: number | undefined) => {
    awaitRef.current = seq;
    setAwaitSeqState(seq);
  }, []);
  // 마운트 때 캐시가 없었으면 첫 응답이 최신 쪽이라 이어 받을 것이 없다 — 그 `lastSeq` 는 루트만의 최대라 채널의 끝이 답글이면
  // 서버가 아는 최신에 끝내 닿지 못하므로 기다리지 않는다
  const [cachedAtMount] = useState(timeline !== undefined);
  /** 기다리는 동안 사용자가 스크롤을 잡았다 — 그 뒤로는 구분선으로 겨누지 않는다 */
  const awaitTouched = useRef(false);
  /** 기다리는 동안 사용자가 끝으로 갔다(칩·보내기) — 다 받으면 구분선이 아니라 끝으로 */
  const awaitToEnd = useRef(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  // 결과로 가기로 받은 떨어진 창(timeline.ts `Timeline` 의 `hasNewer`)
  const hasNewer = timeline?.hasNewer === true;
  const getItemKey = useCallback((i: number) => rows[i]?.key ?? i, [rows]);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /**
   * 초점이 든 행의 key — 범위 밖으로 밀려나도 그 행은 늘 그린다. 지우면 그 안의 초점이 body 로 떨어진다(새 글이 몰려 들어오거나
   * 스크롤해도). 행은 절대 위치라 범위 밖에 하나 더 그려도 자리가 맞다
   */
  const focusedKey = useRef<string | undefined>(undefined);
  const rangeExtractor = useCallback((range: Range) => {
    const indexes = defaultRangeExtractor(range);
    const key = focusedKey.current;
    if (key === undefined) return indexes;
    const index = rowsRef.current.findIndex((r) => r.key === key);
    if (index < 0 || indexes.includes(index)) return indexes;
    return [...indexes, index].sort((a, b) => a - b);
  }, []);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
    getItemKey,
    rangeExtractor,
    // 채팅 모드: 앞에 붙는 행(과거 페이지)은 보던 행을 기준으로 자리를 지키고, 끝에 붙어 있으면 새 행·자라는 행을 따라간다
    anchorTo: "end",
    // 떨어진 창에서는 따라가지 않는다 — 아래로 이어 받은 행을 따라 내려가면 또 아래 끝이라 다음 쪽이 연달아 불린다.
    // 이어 받기를 기다리는 동안도 — 받는 글을 따라 내려가면 구분선을 지나쳐 보지 않은 글이 끝 보임에 든다
    followOnAppend: !hasNewer && awaitSeq === undefined,
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
  const [unseen, setSeen] = useUnseen(timeline, stuck, stuckRef);
  const older = useOlderPages(channelId, conversationId, threadRootId);
  const newer = useNewerPages(channelId, conversationId, threadRootId, hasNewer);
  const qc = useQueryClient();

  /** 첫 붙임이 겨누는 곳 — 안 읽은 곳(「새 메시지」 행)이면 true, 아니면 맨 아래 */
  const aimUnread = useRef(false);
  /** 다시 겨눌 때 올린다 — 행 수가 그대로여도(이어 받기 기다림이 시간으로 끝날 때) 첫 붙임 효과를 다시 돌린다 */
  const [aimNonce, setAimNonce] = useState(0);

  const positioned = useRef(false);
  /** 첫 붙임을 놓을 시각(performance.now 기준). 0 이면 끝났거나 사용자가 잡았다 — 효과가 다시 돌아도 되살아나지 않는다 */
  const settleUntil = useRef(0);
  // 결과로 가기(스레드·검색 스펙 5.3) — 그 행을 가운데로. 끝에 붙어 있지 않으므로 첫 붙임·끝 따라가기를 멈춘다
  const arrive = useCallback(
    (index: number) => {
      settleUntil.current = 0;
      aimUnread.current = false;
      setStuck(false);
      virtualizer.scrollToIndex(index, { align: "center" });
    },
    [setStuck, virtualizer],
  );
  const jump = useJump(channelId, conversationId, threadRootId, timeline, ready, rows, arrive);
  // 배너로 받은 창에서 첫 안 읽은 곳(구분선 행)으로 — 행은 받은 창이 목록에 반영된 뒤에야 생긴다. 받은 창에서 한 번만 찾는다:
  // 없다고 남겨 두면 나중에 다른 창(이어 받기·과거 페이지)에 구분선이 생기는 순간 보던 자리를 그리로 끌고 간다.
  // 구분선이 없으면(그 창의 안 읽은 글이 다 내 글 등) 배너가 물은 첫 루트 행으로 간다 — 이동을 거두면 들어갈 때의 끝 맞추기
  // (virtual-core 가 5초 동안 끝을 다시 겨눈다)가 살아 있는 동안 받은 목록의 끝까지 끌려 내려간다
  const [toUnread, setToUnread] = useState(false);
  const [bannerGone, setBannerGone] = useState(false);
  useEffect(() => {
    if (!toUnread) return;
    setToUnread(false);
    let index = rows.findIndex((r) => r.kind === "unread");
    if (index < 0 && entryReadSeq !== undefined)
      index = rows.findIndex((r) => r.kind === "message" && r.message.seq > entryReadSeq);
    if (index >= 0) arrive(index);
  }, [toUnread, rows, arrive, entryReadSeq]);
  // 「끝이 보임」은 붙어 있음(`stuck`)이다. 그 처음 값(true)은 스크롤하기 전 값이라 떨어진 창과 결과로 가기 목표를 따로 뺀다 —
  // 떨어진 창의 아래 끝은 진짜 끝이 아니고(`lastSeq` 는 창이 아니라 채널의 끝이라 보내면 받지 않은 메시지까지 읽음이 된다),
  // 목표를 안고 열린 목록은 끝으로 가지 않는다
  useReadAtEnd(
    conversationId,
    threadRootId === undefined && !covered && conversationId !== NEW_CONVERSATION,
    stuck && !hasNewer && !jump.pending && !entryHold,
    timeline?.lastSeq ?? 0,
  );

  // 처음(캐시가 있으면 마운트 때, 없으면 첫 응답 때) 맨 아래로.
  // 한 번 겨누고 마는 것으로는 모자란다 — 행은 추정 높이(64)로 먼저 잡혔다가 그 뒤에 실제로 재어지는데,
  // 겨누기는 맞게 되고 그 다음 프레임에 도로 맨 위로 떨어진다. 브라우저에서 잰 것(80건 채널, 뷰포트 658):
  // scrollToEnd 직후 scrollTop 4526/총 5184 → 다음 프레임 0/4029. 줄어든 만큼(−1155)이 아니라 0 이 된다 —
  // virtual-core 가 줄어든 총 높이를 보정할 때 아직 한 번도 못 본 스크롤 오프셋(0)에서 빼는 것으로 보인다.
  // 그래서 총 높이가 잦아들 때까지 프레임마다 끝에 다시 붙인다. 사용자가 손을 대면 그 자리에서 멈춘다 —
  // 스스로 위로 올린 사람을 끌어내리지 않는다(스펙 5.5: 맨 아래에 붙어 있을 때만 따라간다).
  // 결과로 가기 목표를 안고 열렸으면 끝으로 가지 않는다 — 그 메시지로 간다(`useJump`).
  // 안 읽은 채널은 끝이 아니라 첫 안 읽은 곳 — 「새 메시지」 행이 뷰포트 위쪽(`UNREAD_CONTEXT_PX`)에 오게 같은 방식으로 붙인다.
  // 그때는 끝에 붙지 않았으므로 읽음이 가지 않는다(끝까지 내리면 간다). 구분선과 끝이 한 화면에 다 보이면 끝에 붙은 것이다.
  // 캐시가 낡았으면(`awaitSeq`) 행이 아직 없을 때는 끝으로 열어 두고 그 행이 생길 때 한 번 내려앉으며, 다 받으면 그 자리에서
  // 끝 보임을 다시 잰다. 처음 한 번만이다 — 그 뒤의 새 글·과거 페이지·패널 여닫기는 다시 끌고 가지 않는다
  const jumpPending = jump.pending;
  // 이어 받기를 기다리던 구분선이 생겼다 / 다 받았다(서버가 아는 최신에 닿았다). 사용자가 손을 댔거나 시간이 지난 것은 아래 효과
  useLayoutEffect(() => {
    if (awaitSeq === undefined) return;
    if ((timeline?.lastSeq ?? 0) >= awaitSeq) finishAwait();
    else if (!aimUnread.current && !awaitTouched.current && rows.some((r) => r.kind === "unread"))
      aimAtUnread();
  });
  useEffect(() => {
    const el = scrollRef.current;
    if (awaitSeq === undefined || !el) return;
    // 손을 대면 그 뒤로는 겨누지 않는다 — 스스로 움직인 사람을 끌고 가지 않는다. 읽음은 다 받을 때까지 그대로 붙잡는다.
    // 끝내 다 받지 못하면 가진 것으로 판정한다
    const handsOn = () => {
      awaitTouched.current = true;
    };
    const timer = setTimeout(finishAwait, AWAIT_UNREAD_MAX_MS);
    for (const type of HANDS_ON) el.addEventListener(type, handsOn, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const type of HANDS_ON) el.removeEventListener(type, handsOn);
    };
  }, [awaitSeq]);
  // 보일 행이 하나도 없는 채널(답글뿐 등)은 붙잡을 것이 없다
  const empty = timeline !== undefined && rows.length === 0;
  useEffect(() => {
    if (empty) setEntryHold(false);
  }, [empty]);
  /** 끝으로 가려 했다 — 구분선으로 겨누지 않는다. 기다리는 중이면 다 받을 때 끝으로 가게 표시한다(그 자리에서 풀면 읽음이 샌다) */
  function markGoingToEnd() {
    settleUntil.current = 0;
    aimUnread.current = false;
    if (awaitRef.current !== undefined) awaitTouched.current = awaitToEnd.current = true;
  }
  function settleSoon() {
    const win = scrollRef.current?.ownerDocument.defaultView;
    if (win) settleUntil.current = win.performance.now() + SETTLE_MAX_MS;
  }
  /** 「새 메시지」 행으로 (다시) 겨눈다 — 첫 붙임을 잠깐 되살려 `pin` 이 그 자리와 끝 보임을 정한다. 칩은 들어갈 때의 읽음 위치부터 센다 */
  function aimAtUnread() {
    aimUnread.current = true;
    settleSoon();
    setStuck(false);
    setSeen(entryReadSeq ?? 0);
    setAimNonce((n) => n + 1);
  }
  /**
   * 이어 받기 기다림을 끝내고 읽음을 놓는다. 그 사이 손을 댄 사람은 그 자리에서 끝이 보이는지만 다시 잰다. 아니면 구분선이 있으면
   * 다 받은 목록에서 다시 겨누고, 없으면(전부 내 글·답글) 열어 둔 끝으로 — 기다리는 동안은 받은 글을 따라가지 않았다
   */
  function finishAwait() {
    setAwaitSeq(undefined);
    setEntryHold(false);
    const el = scrollRef.current;
    if (awaitToEnd.current) {
      setStuck(true);
      virtualizer.scrollToEnd();
    } else if (awaitTouched.current) {
      if (el) setStuck(el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX);
    } else if (rowsRef.current.some((r) => r.kind === "unread")) aimAtUnread();
    else {
      setStuck(true);
      virtualizer.scrollToEnd();
    }
  }
  /** 서버는 가진 목록 뒤에도 글이 있다고 안다 — 이어 받기가 거기까지 닿을 때까지 읽음을 붙잡고 끝에 붙지 않은 것으로 둔다. 아니면 곧바로 놓는다 */
  function holdForCatchUp() {
    const latest = useUnread.getState().byConversation[conversationId]?.seenSeq ?? 0;
    if (cachedAtMount && latest > (timeline?.lastSeq ?? 0)) {
      setAwaitSeq(latest);
      setStuck(false);
    } else setEntryHold(false);
  }
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const win = el?.ownerDocument.defaultView;
    if (!el || !win || rows.length === 0) return;
    const pin = () => {
      if (!aimUnread.current) {
        el.scrollTop = el.scrollHeight - el.clientHeight;
        return;
      }
      const index = rowsRef.current.findIndex((r) => r.kind === "unread");
      // `getOffsetForIndex` 는 스크롤 끝으로 잘라 돌려줘 끝 가까운 구분선의 자리가 틀어진다 — 행의 시작을 직접 읽는다(브라우저가 자른다)
      const start = index < 0 ? undefined : virtualizer.measurementsCache[index]?.start;
      if (start === undefined) return;
      const top = Math.max(0, start - UNREAD_CONTEXT_PX);
      virtualizer.scrollToOffset(top);
      el.scrollTop = top;
      // 구분선을 위에 둬도 끝이 함께 보이면(한 화면에 다 들어가는 안 읽음) 끝에 붙은 것이다 — 이어 받기를 기다리는 동안은 아니다
      const atEnd =
        awaitRef.current === undefined && el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
      if (atEnd !== stuckRef.current) setStuck(atEnd);
    };
    if (!positioned.current) {
      positioned.current = true;
      if (jumpPending) {
        settleUntil.current = 0;
        setEntryHold(false);
        return;
      }
      if (entryTracked && rows.some((r) => r.kind === "unread")) {
        aimUnread.current = true;
        setStuck(false);
        setSeen(entryReadSeq ?? 0);
        holdForCatchUp();
      } else {
        if (entryTracked) holdForCatchUp();
        virtualizer.scrollToEnd();
      }
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
    // 구분선으로 내려앉는 때(이어 받기를 기다리다 행이 생긴 순간)는 앞서 걸린 끝 겨누기를 지금 바로 갈아 끼운다
    if (aimUnread.current) pin();
    raf = win.requestAnimationFrame(tick);
    for (const type of HANDS_ON) el.addEventListener(type, handsOn, { passive: true });
    return stop;
  }, [rows.length, virtualizer, jumpPending, aimNonce]);

  // 내가 보낸 항목이 붙으면 위를 보고 있었어도 끝으로. 떨어진 창이면 먼저 최신으로 — 보내는 중 항목은 늘 목록 끝이라
  // 창 뒤에 곧바로 붙으면 그 사이의 받지 않은 메시지가 보이지 않은 채 이어진 것처럼 보인다
  const lastPending = timeline?.pending.at(-1)?.clientMsgId;
  const prevPending = useRef(lastPending);
  useLayoutEffect(() => {
    if (lastPending === prevPending.current) return;
    prevPending.current = lastPending;
    if (lastPending === undefined) return;
    markGoingToEnd();
    setStuck(true);
    if (hasNewer) {
      loadLatest(qc, channelId, conversationId, threadRootId).then(
        () => virtualizer.scrollToEnd(),
        reportPageError,
      );
      return;
    }
    virtualizer.scrollToEnd();
  }, [lastPending, virtualizer, hasNewer, qc, channelId, conversationId, threadRootId, setStuck]);

  // 끝에 붙은 채 마지막 행이 다른 key 로 바뀌면(버블 → 확정 메시지, 보내는 중 → 확정) 끝으로. 행 수가 같아 followOnAppend 가
  // 걸리지 않고, 새 행이 추정 높이로 먼저 잡혔다 재어지면 virtual-core 는 끝까지 남은 거리를 그대로 둔다.
  // scrollToEnd 는 다시 그려진 뒤에도 끝이 맞을 때까지 프레임마다 다시 겨눈다
  const lastKey = rows.at(-1)?.key;
  const prevLastKey = useRef(lastKey);
  useLayoutEffect(() => {
    if (lastKey === prevLastKey.current) return;
    prevLastKey.current = lastKey;
    if (stuckRef.current) virtualizer.scrollToEnd();
  }, [lastKey, virtualizer]);

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

  // 떨어진 창의 아래 끝은 목록의 끝이 아니다 — 붙어 있지 않은 것으로 둬 새 행을 따라가지 않는다(아래로 이어 받기가 연달아 돌지 않게).
  // 이어 받기를 기다리는 동안의 끝도 아직 끝이 아니다 — 다 받으면 `finishAwait` 가 잰다
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStuck(fromBottom <= STICK_PX && !hasNewer && awaitRef.current === undefined);
    older.onScrollTop(el.scrollTop);
    newer.onScrollBottom(fromBottom);
  };

  // 초점이 든 행을 기억한다(`rangeExtractor`). 영역을 떠나면 잊는다 — 떠나는 순간(focusout)에는 아직 새 자리가 정해지지 않았으므로
  // 한 틱 뒤에 본다. 창이 초점을 잃을 때(다른 앱·탭)는 초점이 그 요소에 그대로 남으므로 잊지 않는다
  const onFocusCapture = (e: FocusEvent) => {
    const row = (e.target as Element).closest<HTMLElement>("[data-index]");
    const key = row ? rowsRef.current[Number(row.dataset.index)]?.key : undefined;
    focusedKey.current = key;
  };
  const onBlurCapture = () => {
    queueMicrotask(() => {
      const el = scrollRef.current;
      if (!el?.contains(el.ownerDocument.activeElement)) focusedKey.current = undefined;
    });
  };

  // 칩은 누르면 사라진다 — 초점을 목록으로 옮겨 잃지 않게
  const toEnd = () => {
    // 첫 붙임이 아직 구분선을 겨누고 있어도 그만둔다 — 끝으로 간 사람을 되끌지 않는다
    markGoingToEnd();
    setStuck(true);
    virtualizer.scrollToEnd();
    scrollRef.current?.focus({ preventScroll: true });
  };
  const toLatest = async () => {
    try {
      await loadLatest(qc, channelId, conversationId, threadRootId);
    } catch (e) {
      reportPageError(e);
      return;
    }
    toEnd();
  };

  // 처음 안 읽은 곳이 불러온 가장 옛 메시지보다 앞이면 불러온 목록에 없다 — 그곳을 가운데 둔 창을 받는다.
  // 받은 것이 지금 것이 되기 전(사본에서 복원했거나 다시 받는 중)에는 띄우지 않는다: 받은 창을 뒤이은 다시 받기가 최신 쪽으로 덮는다(`useJump` 와 같다).
  // 옛 쪽이 남았을 때만 — seq 는 채널의 세션들이 같이 써서, 세션을 처음부터 다 불러왔어도 가장 옛 seq 앞에 다른 세션 몫의 빈틈이 있다
  const oldestSeq = timeline?.items[0]?.seq;
  const showBanner =
    entryReadSeq !== undefined &&
    !bannerGone &&
    ready &&
    timeline?.hasOlder === true &&
    oldestSeq !== undefined &&
    entryReadSeq + 1 < oldestSeq;
  const toFirstUnread = async () => {
    if (entryReadSeq === undefined) return;
    let found: boolean;
    try {
      found = await jumpToFirstRootAfter(qc, channelId, conversationId, entryReadSeq);
    } catch (e) {
      reportPageError(e);
      return;
    }
    setBannerGone(true);
    if (found) setToUnread(true);
    else toEnd();
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
      {showBanner && (
        <div
          className={cn("absolute inset-x-0 z-10 flex justify-center", older.loading ? "top-11" : "top-2")}
        >
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full shadow-md"
            onClick={() => void toFirstUnread()}
          >
            안 읽은 메시지가 더 있어요 · 처음 안 읽은 곳으로
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        data-scroller
        role="region"
        aria-label={threadRootId === undefined ? "메시지" : "스레드 메시지"}
        tabIndex={0}
        onScroll={onScroll}
        onFocus={onFocusCapture}
        onBlur={onBlurCapture}
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
            {archived
              ? "메시지가 없습니다."
              : (emptyText ?? "아직 메시지가 없습니다. @멘션으로 에이전트를 불러 보세요.")}
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
      case "unread":
        return <NewMessagesDivider />;
    }
  },
  (a: RowProps, b: RowProps) =>
    a.bubble === b.bubble &&
    a.channelId === b.channelId &&
    a.inThread === b.inThread &&
    sameRow(a.row, b.row),
);

function NewMessagesDivider() {
  return (
    <div role="separator" aria-label="새 메시지" className="flex items-center gap-3 px-4 py-2">
      <div className="h-px flex-1 bg-primary/40" />
      <span className="text-xs font-medium text-primary">새 메시지</span>
      <div className="h-px flex-1 bg-primary/40" />
    </div>
  );
}

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
 * 내 메시지는 세지 않는다(보낼 때 끝으로 간다). 기준은 처음에 가진 마지막 메시지의 seq 이고, 구분선에서 열면 부르는 쪽이
 * 돌려받은 setter 로 들어갈 때의 읽음 위치로 옮긴다(칩이 그 뒤에 온 수를 센다). 타임라인의 `lastSeq` 를 쓰지 않는 까닭 — 사본에서
 * 복원한 타임라인은 그것이 0 이라(첫 구독을 새로 받게) 오프라인에서 위로 올리자마자 전부 새 메시지로 센다
 */
function useUnseen(
  timeline: Timeline | undefined,
  stuck: boolean,
  stuckRef: { readonly current: boolean },
): [number, (seq: number) => void] {
  const me = useMe().data?.user.id;
  const lastSeq = timeline?.items.at(-1)?.seq ?? 0;
  const [seenSeq, setSeenSeq] = useState(lastSeq);
  // 끝에 붙은 것은 지금 값(ref)으로 본다 — 처음 위치가 구분선이면 이 렌더의 `stuck` 은 아직 true 인데 이미 붙어 있지 않다
  useEffect(() => {
    if (stuckRef.current && seenSeq !== lastSeq) setSeenSeq(lastSeq);
  }, [stuck, stuckRef, lastSeq, seenSeq]);
  const unseen =
    stuck || !timeline
      ? 0
      : timeline.items.filter((m) => m.seq > seenSeq && !(m.authorType === "user" && m.authorId === me))
          .length;
  return [unseen, setSeenSeq];
}
