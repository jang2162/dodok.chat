import type { RunnerFsListing, RunnerProject, RunnerSummary } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 「러너」 탭의 서버 상태(러너 일반화 스펙 7장, admin 이상) — 러너는 runner_tokens 행 하나다. 연결·hello 내용은 서버 메모리에만
 * 있어 끊긴 러너는 판본·루트·프로그램이 비어 온다. wire `adapter.status`(러너)가 오면 러너 목록·프로젝트가 낡는다(realtime/handlers — 둘러보기는 빼고)
 */
export const useRunners = () =>
  useQuery({
    queryKey: qk.runners(),
    queryFn: async () => (await api<{ runners: RunnerSummary[] }>("GET", "/runners")).runners,
  });

/** 그 러너의 프로젝트 — 보관한 것도 함께 온다(더한 차례) */
export const useRunnerProjects = (runnerId: string | undefined) =>
  useQuery({
    queryKey: qk.runnerProjects(runnerId ?? ""),
    queryFn: async () =>
      (await api<{ projects: RunnerProject[] }>("GET", `/runners/${runnerId}/projects`)).projects,
    enabled: runnerId !== undefined,
  });

/**
 * 루트 안 디렉터리 하나의 하위 디렉터리(러너 fs.list). 403(둘러보기 꺼짐)·404(없는 디렉터리)·503(끊김)은 둘러보기 칸이 그리므로
 * 전역 토스트를 끄고 되풀이하지 않는다 — 서버가 사용자당 분당 60번으로 막는다(`LIMITS.runnerBrowsePerMin`). 같은 까닭으로 받은 목록은
 * 낡지 않는다(빵 부스러기로 돌아와도 다시 받지 않는다) — 「프로젝트 추가」를 열 때 그 러너의 것을 버려 새로 받는다
 */
export const useRunnerFs = (runnerId: string, rootId: string, relPath: string, enabled: boolean) =>
  useQuery({
    queryKey: qk.runnerFs(runnerId, rootId, relPath),
    queryFn: () =>
      api<RunnerFsListing>(
        "GET",
        `/runners/${runnerId}/fs?rootId=${encodeURIComponent(rootId)}&relPath=${encodeURIComponent(relPath)}`,
      ),
    enabled,
    staleTime: Infinity,
    retry: false,
    refetchOnReconnect: false,
    meta: { silent: true },
  });
