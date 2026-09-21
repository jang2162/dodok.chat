import type { RunState } from "@dodok/shared";
import { useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChannelRuns } from "@/api/queries";
import { ApprovalCard } from "@/features/approvals/ApprovalCard";
import { selectPendingApproval, useApprovalStore } from "@/features/approvals/approvalStore";
import { selectChannelRuns, TERMINAL, useRunStore } from "@/features/runs/runStore";
import { RunList } from "./RunList";
import { RunTimeline } from "./RunTimeline";
import { freezeDurations, mergeRuns } from "./timeline";

/**
 * 활동 탭(`/c/$channelId/activity`, 설계 5.1·5.2): 런 목록과 툴 타임라인. 바깥 틀(패널 ↔ 시트·탭 머리·닫기)은
 * 부모인 ChannelPage 의 `PanelTabs` 가 맡는다 — 탭을 옮겨도 머리가 살아 있게(D3).
 * ChannelPage 가 채널을 확인한 뒤에만 마운트된다
 */
export function ActivityPanel() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  // 채널을 옮기면 고른 런을 버린다
  return <ActivityBody key={channelId} channelId={channelId} />;
}

function ActivityBody({ channelId }: { channelId: string }) {
  const rest = useChannelRuns(channelId);
  const live = useRunStore(useShallow(selectChannelRuns(channelId)));

  /**
   * 종료 상태를 한 번이라도 본 런은 여기 적어 두고 목록에 계속 싣는다(브라우저 검증 D2·D9).
   * 끝난 런은 몇 초 뒤 런 스토어에서 빠지는데(버블 정리, 스펙 4.5) REST 재조회는 그보다 늦다 —
   * 그 사이 목록에서 사라지면 고른 런이 옛 런으로 넘어가고 타임라인이 새로 서서 펼침·스크롤이 날아간다.
   * 종료는 마지막 사실이라(더 바뀌지 않는다) 남겨 둬도 낡지 않는다. 목록 조회가 실패해도 남는다.
   * 렌더 중에 적는다 — 효과로 미루면 한 프레임 동안 목록에서 빠져 선택이 튄다. 채널을 옮기면 통째로 버린다(`key`)
   */
  const ended = useRef(new Map<string, RunState>());
  for (const v of live) if (TERMINAL.has(v.state.status)) ended.current.set(v.state.id, v.state);

  /**
   * 종료를 **못 본 채** 런 스토어에서 빠진 런(브라우저 검증 D12). 재접속 스냅샷은 「이 런은 더는 진행 중이
   * 아니다」만 말해 주고(`subscriptions.applySubscribed`), 무엇으로 언제 끝났는지(status·endedAt)는 REST 가 안다.
   * 그래서 마지막으로 본 상태를 **REST 밑에** 깔아 둔다: 줄이 한 프레임도 비지 않아 선택이 옛 런으로 튀지 않고,
   * 아래 재조회가 서버 사실을 받아 오면 그쪽이 이 자리를 덮는다(`ended` 는 반대로 REST 위다 — 이미 본 종료가 정본).
   * 종료를 본 런(버블 정리로 빠진 것)은 `ended` 가 맡으므로 여기 넣지 않는다. 채널을 옮기면 통째로 버린다(`key`)
   *
   * 빠진 것을 안 시각도 적는다(`stopped`) — 끝난 시각을 모르는 동안 그 줄의 소요를 거기서 멈춘다(`freezeDurations`).
   * 재조회가 실패하면 자리값(또는 끊기기 전에 받아 둔 REST 줄)이 그대로 남는데, 소요까지 흐르면 「아직 기다리는 중」이라는
   * 지어낸 사실이 되고 1초 틱도 영원히 돈다(p2-t14 리뷰 §A.2). 다시 실시간으로 오면 더는 멈춘 줄이 아니다
   */
  const vanished = useRef(new Map<string, RunState>());
  const stopped = useRef(new Map<string, string>());
  const wasLive = useRef(new Map<string, RunState>());
  const liveIds = new Set(live.map((v) => v.state.id));
  for (const [id, state] of wasLive.current)
    if (!liveIds.has(id) && !ended.current.has(id)) {
      vanished.current.set(id, state);
      stopped.current.set(id, new Date().toISOString());
    }
  for (const id of liveIds) stopped.current.delete(id);
  wasLive.current = new Map(live.map((v) => [v.state.id, v.state]));

  const runs = useMemo(
    () =>
      freezeDurations(
        mergeRuns(
          [...vanished.current.values(), ...(rest.data ?? [])],
          [...ended.current.values(), ...live.map((v) => v.state)],
        ),
        stopped.current,
      ),
    [rest.data, live],
  );
  /**
   * 끝난 것으로 판정된 런이 늘면 REST 목록을 다시 받아 둔다. 몫이 둘이다 — ① `ended` 는 **캐시**를 위해서다:
   * 보이는 줄은 이미 서버 사실(끝난 시각까지)로 덮여 있고, 다시 받아 두지 않으면 캐시는 그 런을 모르는 채로
   * 남아 다음 마운트(탭·채널 복귀)가 첫 프레임에 그 런 없이 선다. ② `vanished` 는 **화면**을 위해서다:
   * 자리값을 서버 사실로 바꿔 줄 곳이 이 재조회뿐이다(D12)
   */
  const settledKey = [...ended.current.keys(), ...vanished.current.keys()].sort().join(",");
  const seenSettled = useRef(settledKey);
  const refetchRuns = rest.refetch;
  useEffect(() => {
    if (seenSettled.current === settledKey) return;
    seenSettled.current = settledKey;
    void refetchRuns();
  }, [settledKey, refetchRuns]);

  // 고르지 않았으면 가장 최근 런. 고른 런이 목록에서 사라지면(채널을 옮긴 뒤 등) 다시 최근 런으로 돌아간다
  const [picked, setPicked] = useState<string>();
  const selected = runs.find((r) => r.id === picked) ?? runs[0];

  /**
   * 승인은 채널 것을 본다 — 고른 런으로 거르지 않는다. 옛 런을 들여다보는 동안에도 답해야 할 카드는 맨 위에 남는다.
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
      <RunList
        runs={runs}
        selectedId={selected?.id}
        onSelect={setPicked}
        loading={rest.isPending}
        error={rest.isError}
        onRetry={() => void rest.refetch()}
        retrying={rest.isFetching}
      />
      {/* 런을 바꾸면 타임라인을 새로 세운다 — 툴 행의 펼침 상태·「끝에 붙어 있다」가 앞 런에서 이어지지 않게 */}
      {selected && (
        <RunTimeline
          key={selected.id}
          runId={selected.id}
          running={!TERMINAL.has(selected.status)}
          approval={approvalOf}
        />
      )}
    </div>
  );
}
