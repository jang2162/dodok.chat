import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChannelRuns } from "@/api/queries";
import { PanelTabs } from "@/app/layout/PanelTabs";
import { selectChannelRuns, TERMINAL, useRunStore } from "@/features/runs/runStore";
import { RunList } from "./RunList";
import { RunTimeline } from "./RunTimeline";
import { mergeRuns } from "./timeline";

/**
 * 활동 탭(`/c/$channelId/activity`, 설계 5.1·5.2): 런 목록과 툴 타임라인. 바깥 틀은 `PanelTabs` 가 맡는다.
 * ChannelPage 가 채널을 확인한 뒤에만 마운트된다
 */
export function ActivityPanel() {
  const { channelId } = useParams({ strict: false }) as { channelId: string };
  return (
    <PanelTabs channelId={channelId} active="activity" scroll={false}>
      {/* 채널을 옮기면 고른 런을 버린다 */}
      <ActivityBody key={channelId} channelId={channelId} />
    </PanelTabs>
  );
}

function ActivityBody({ channelId }: { channelId: string }) {
  const rest = useChannelRuns(channelId);
  const live = useRunStore(useShallow(selectChannelRuns(channelId)));
  const runs = useMemo(
    () =>
      mergeRuns(
        rest.data ?? [],
        live.map((v) => v.state),
      ),
    [rest.data, live],
  );
  // 끝난 런은 몇 초 뒤 런 스토어에서 빠진다(버블 정리, 스펙 4.5) — 그 전에 REST 목록을 다시 받아 둔다.
  // 안 그러면 방금 끝난 런이 목록에서 사라진다. 스토어에서 빠질 때 한 번 더 받아 마지막 상태를 맞춘다
  const endedKey = live
    .filter((v) => TERMINAL.has(v.state.status))
    .map((v) => v.state.id)
    .sort()
    .join(",");
  const seenEnded = useRef(endedKey);
  const refetchRuns = rest.refetch;
  useEffect(() => {
    if (seenEnded.current === endedKey) return;
    seenEnded.current = endedKey;
    void refetchRuns();
  }, [endedKey, refetchRuns]);

  // 고르지 않았으면 가장 최근 런. 고른 런이 목록에서 사라지면(채널을 옮긴 뒤 등) 다시 최근 런으로 돌아간다
  const [picked, setPicked] = useState<string>();
  const selected = runs.find((r) => r.id === picked) ?? runs[0];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 승인 카드 자리 — 태스크 8 이 여기에 고정 카드를 넣는다(설계 5.3) */}
      <div data-slot="approval-card" className="empty:hidden" />
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
        <RunTimeline key={selected.id} runId={selected.id} running={!TERMINAL.has(selected.status)} />
      )}
    </div>
  );
}
