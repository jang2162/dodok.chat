import type { OpsEventsPage, OpsRunsSummary, OpsSeverity, OpsStatus } from "@dodok/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 운영 상태(스펙 6장) — owner 화면만 부른다(아니면 403). 사이드바 배지도 이 캐시의 `unacked` 를 읽고, 실시간 `ops.event` 가
 * 그 칸만 덮는다. 조회 실패는 화면 안에 그린다(`silent`) — 사이드바가 늘 부르므로 토스트를 띄우지 않는다
 */
export const useOpsStatus = () =>
  useQuery({
    queryKey: qk.opsStatus,
    queryFn: () => api<OpsStatus>("GET", "/ops/status"),
    meta: { silent: true },
  });

export const useOpsRuns = (days: 1 | 7) =>
  useQuery({
    queryKey: qk.opsRuns(days),
    queryFn: () => api<OpsRunsSummary>("GET", `/ops/runs?days=${days}`),
    meta: { silent: true },
  });

/** 사건 목록 — `last_at` 내림차순 50개씩, 「더 보기」가 `nextCursor` 로 잇는다 */
export const useOpsEvents = (severity: OpsSeverity | undefined) =>
  useInfiniteQuery({
    queryKey: qk.opsEvents(severity),
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams();
      if (pageParam !== undefined) q.set("cursor", pageParam);
      if (severity !== undefined) q.set("severity", severity);
      const qs = q.toString();
      return api<OpsEventsPage>("GET", `/ops/events${qs ? `?${qs}` : ""}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    meta: { silent: true },
  });
