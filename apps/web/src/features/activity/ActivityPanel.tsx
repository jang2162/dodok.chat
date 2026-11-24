import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChannelRuns } from "@/api/queries";
import { ApprovalCard } from "@/features/approvals/ApprovalCard";
import { selectPendingApproval, useApprovalStore } from "@/features/approvals/approvalStore";
import { selectChannelRuns, useRunStore } from "@/features/runs/runStore";
import { Notice } from "./Notice";
import { RunCards } from "./RunCard";
import { freezeDurations, mergeRuns } from "./timeline";
import { useSettledRuns } from "./useSettledRuns";

/**
 * 활동 탭(`/c/$channelId/s/$conversationId/activity`, 설계 5.1·5.2·재설계 스펙 목표 7): 런마다 펼치는 카드(안에 타임라인). 바깥 틀(패널 ↔ 시트·탭 머리·닫기)은
 * 부모인 ChannelPage 의 `PanelTabs` 가 맡는다 — 탭을 옮겨도 머리가 살아 있게(D3).
 * ChannelPage 가 채널을 확인한 뒤에만 마운트된다
 */
export function ActivityPanel() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  // 채널을 옮기면 펼침(과 거르기)을 버린다
  return <ActivityBody key={channelId} channelId={channelId} />;
}

function ActivityBody({ channelId }: { channelId: string }) {
  const rest = useChannelRuns(channelId);
  const live = useRunStore(useShallow(selectChannelRuns(channelId)));

  const liveStates = useMemo(() => live.map((v) => v.state), [live]);
  // 끝난 런 기억(ended·vanished·stopped)과 그 상한·빠진 런 타임라인 재조회는 훅 한곳에 있다
  const { ended, vanished, stopped, settledKey } = useSettledRuns(liveStates);

  const runs = useMemo(
    () =>
      freezeDurations(
        mergeRuns([...vanished.values(), ...(rest.data ?? [])], [...ended.values(), ...liveStates]),
        stopped,
      ),
    // ended·vanished·stopped 는 늘 같은 Map 이다(훅이 렌더 중에 고쳐 쓴다) — 다시 셈하는 때는 live·REST 가 바뀔 때다
    [rest.data, liveStates, ended, vanished, stopped],
  );
  /**
   * 끝난 것으로 판정된 런이 늘면 REST 목록을 다시 받아 둔다. 몫이 둘이다 — ① `ended` 는 **캐시**를 위해서다:
   * 보이는 줄은 이미 서버 사실(끝난 시각까지)로 덮여 있고, 다시 받아 두지 않으면 캐시는 그 런을 모르는 채로
   * 남아 다음 마운트(탭·채널 복귀)가 첫 프레임에 그 런 없이 선다. ② `vanished` 는 **화면**을 위해서다:
   * 자리값을 서버 사실로 바꿔 줄 곳이 이 재조회뿐이다(D12)
   */
  const seenSettled = useRef(settledKey);
  const refetchRuns = rest.refetch;
  useEffect(() => {
    if (seenSettled.current === settledKey) return;
    seenSettled.current = settledKey;
    void refetchRuns();
  }, [settledKey, refetchRuns]);

  /**
   * 펼침 — 손댄 카드는 그 선택(`toggled`), 손대지 않은 카드는 가장 최근 런만 펼친다(런이 수백 개여도 처음엔 하나만 — 타임라인 조회는
   * 펼친 카드만). 끝난 런이 스토어에서 빠져도 목록에 남으므로(`useSettledRuns`) 펼친 카드가 접히거나 다른 런으로 넘어가지 않는다(D2)
   */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const latestId = runs[0]?.id;
  const isExpanded = useCallback(
    (runId: string) => toggled.get(runId) ?? runId === latestId,
    [toggled, latestId],
  );
  const toggle = useCallback(
    (runId: string) =>
      setToggled((prev) => new Map(prev).set(runId, !(prev.get(runId) ?? runId === latestId))),
    [latestId],
  );

  /**
   * 승인은 채널 것을 본다 — 펼친 런으로 거르지 않는다. 옛 런 카드를 들여다보는 동안에도 답해야 할 카드는 맨 위에 남는다.
   * 메시지 흐름의 카드와 **같은 스토어**라 잠금·확정 표시가 함께 움직인다(설계 5.3)
   */
  const pending = useApprovalStore(selectPendingApproval(channelId));
  /**
   * 한 번 띄운 카드는 확정된 뒤에도 결과 한 줄로 남긴다(설계 5.3 「사라지지 않는다 — 기록이다」) —
   * 누른 자리에서 「허용됨」을 봐야 한다. 새 승인이 오면 그쪽으로 바뀌고, 채널을 옮기면 버린다(`key={channelId}`).
   * 열기 전에 이미 끝나 있던 옛 승인은 띄우지 않는다 — 그 기록은 메시지 흐름과 타임라인 행에 있다
   */
  const [shown, setShown] = useState<string>();
  const pendingId = pending?.approval.id;
  useEffect(() => {
    if (pendingId) setShown(pendingId);
  }, [pendingId]);
  const cardId = pendingId ?? shown;
  const approvals = useApprovalStore((s) => s.byChannel[channelId]);
  // 툴 행의 「승인」 칩이 승인 레코드를 찾는 길(Ruling 2) — 런 이벤트의 toolCallId 는 비어 있을 수 있다
  const approvalOf = useCallback((approvalId: string) => approvals?.[approvalId]?.approval, [approvals]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 승인 카드는 패널 맨 위에 고정(설계 5.3) */}
      {cardId && <ApprovalCard approvalId={cardId} channelId={channelId} />}
      {rest.isError && (
        <Notice onRetry={() => void rest.refetch()} retrying={rest.isFetching}>
          런 목록을 불러오지 못했습니다.
        </Notice>
      )}
      {/*
       * 조회가 실패해도 실시간으로 아는 런은 그대로 그린다(태스크 7 리뷰 이월 6) —
       * 잠깐 끊긴 사이에 진행 중인 런이 화면에서 사라지면 「멈춘 것」처럼 보인다
       */}
      {runs.length > 0 ? (
        <RunCards runs={runs} isExpanded={isExpanded} onToggle={toggle} approval={approvalOf} />
      ) : (
        !rest.isError && <Notice>{rest.isPending ? "불러오는 중…" : "아직 실행 기록이 없습니다."}</Notice>
      )}
    </div>
  );
}
