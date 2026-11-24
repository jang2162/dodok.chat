import type { RunEvent } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "@/api/http";
import { qk } from "@/api/queries";
import { useRunStore } from "@/features/runs/runStore";
import { keepTimelineEvents, mergeRunEvents } from "./timeline";

export type RunActivityState = {
  /** 활동 이벤트. 아직 모르면 undefined(펼치기 전·불러오는 중·실패) */
  events: readonly RunEvent[] | undefined;
  status: "idle" | "pending" | "error" | "ready";
  /** 이 탭이 처음부터 본 런이라 런 스토어에서 바로 그렸다 — 비었으면 활동이 정말 없던 런이다 */
  known: boolean;
  fetching: boolean;
  refetch: () => void;
};

/**
 * 확정 메시지의 활동(스펙 「모양」). 그 탭이 처음부터 끝(끝 이벤트)까지 본 런이면(런 스토어 기록이 `complete`) 호출 없이 그것을 쓰고,
 * 아니면 `enabled`(펼쳤을 때)에만 `GET /runs/:id/events` 를 한 번 부른다 — 화면의 모든 메시지마다 미리 받지 않는다.
 * 키가 활동 탭 타임라인(`useRunEvents`)과 같아 한쪽에서 받은 것을 다른 쪽이 쓴다. 실패는 그 자리에서만 알린다(`meta.silent`)
 */
export function useRunActivity(runId: string, { enabled }: { enabled: boolean }): RunActivityState {
  const stored = useRunStore((s) => s.activity[runId]);
  const known = stored?.complete === true;
  const rest = useQuery({
    queryKey: qk.runEvents(runId),
    queryFn: async () => (await api<{ events: RunEvent[] }>("GET", `/runs/${runId}/events`)).events,
    enabled: enabled && !known,
    meta: { silent: true },
  });
  const base = useMemo(() => (rest.data ? keepTimelineEvents(rest.data) : undefined), [rest.data]);
  const events = useMemo(() => {
    if (known) return stored.events;
    // 아직 도는 런이면 받은 바탕 위에 이 탭이 본 것을 seq 로 합친다
    return base && mergeRunEvents(base, stored?.events ?? []);
  }, [known, stored, base]);

  const status: RunActivityState["status"] = known
    ? "ready"
    : rest.isError
      ? "error"
      : rest.data
        ? "ready"
        : enabled
          ? "pending"
          : "idle";
  return { events, status, known, fetching: rest.isFetching, refetch: () => void rest.refetch() };
}
