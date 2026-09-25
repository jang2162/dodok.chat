import type { OpsEventsPage, OpsRunsSummary, OpsSeverity, OpsStatus } from "@dodok/shared";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 운영 화면이 떠 있는 동안 상태를 다시 받는 주기 — 사건이 없는 변화(디스크가 조금씩 줄어듦·오늘 런 수)를 따라간다 */
export const OPS_STATUS_POLL_MS = 30_000;

/**
 * 운영 상태(스펙 6장) — owner 화면만 부른다(아니면 403). 사이드바 배지도 이 캐시의 `unacked` 를 읽고, 실시간 `ops.event` 가
 * 그 칸을 덮고 상태를 다시 받게 한다. `poll` 이면 탭이 보이는 동안 주기로 다시 받는다(운영 화면만). `enabled` 가 거짓이면
 * 부르지 않는다 — owner 인지 모르는 자리(좁은 화면 메뉴 버튼)가 member 로 403 을 받지 않게.
 * 조회 실패는 화면 안에 그린다(`silent`) — 사이드바가 늘 부르므로 토스트를 띄우지 않는다
 */
export const useOpsStatus = ({ poll = false, enabled = true }: { poll?: boolean; enabled?: boolean } = {}) =>
  useQuery({
    queryKey: qk.opsStatus,
    queryFn: () => api<OpsStatus>("GET", "/ops/status"),
    enabled,
    refetchInterval: poll ? OPS_STATUS_POLL_MS : false,
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
