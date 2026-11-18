import type {
  CreateWorktreeBody,
  CreateRunnerProjectBody,
  MoveRunnerProjectBody,
  RunnerProject,
  RunnerProjectCheck,
} from "@dodok/shared";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 프로젝트를 바꾼 뒤 — 러너 카드의 프로젝트 수(`projectCount`)와 그 러너의 목록을 다시 받는다. 응답의 프로젝트로 캐시를 고치지 않는
 * 까닭은 옮기기다: 프로젝트가 두 러너의 목록 사이를 건너간다
 */
const projectsChanged = (qc: QueryClient) =>
  Promise.all([
    qc.invalidateQueries({ queryKey: qk.runnerProjectsAll }),
    qc.invalidateQueries({ queryKey: qk.runners() }),
  ]);

/** 프로젝트 더하기 — 서버가 먼저 러너에 project.check 를 묻는다. 실패 사유·충돌·끊김은 대화상자가 그린다(`silent`) */
export function useCreateRunnerProject(runnerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateRunnerProjectBody) =>
      (await api<{ project: RunnerProject }>("POST", `/runners/${runnerId}/projects`, body)).project,
    meta: { silent: true },
    onSuccess: () => projectsChanged(qc),
  });
}

/** 이름 바꾸기 — 라벨 규칙 오류는 폼이 그린다 */
export function useRenameRunnerProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, label }: { id: string; label: string }) =>
      (await api<{ project: RunnerProject }>("PATCH", `/runner-projects/${id}`, { label })).project,
    onSuccess: () => projectsChanged(qc),
  });
}

/**
 * 보관 — 그 프로젝트에 새 에이전트를 만들 수 없게 된다. 이미 있는 에이전트는 남고 런은 돈다(스펙 8장). 워크트리는 러너가 폴더를
 * 지워야 보관된다(워크트리 스펙 W7) — 409(정리 실패)는 그 줄이 그리므로 워크트리 보관은 `silent`. keepFolder 면 폴더를 남기고
 * 행만(W12). 실패해도 목록을 다시 받는다 — 서버가 그 줄에 정리 실패 사유(cleanupIssue)를 남겼다
 */
export function useArchiveRunnerProject({ silent = false }: { silent?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, keepFolder }: { id: string; keepFolder?: boolean }) =>
      (
        await api<{ project: RunnerProject }>(
          "POST",
          `/runner-projects/${id}/archive`,
          keepFolder ? { keepFolder: true } : undefined,
        )
      ).project,
    meta: { silent },
    onSettled: () => projectsChanged(qc),
  });
}

/** 워크트리 만들기 — 러너가 폴더·브랜치를 만들고 나서 행이 생긴다. 400(러너 사유)·409 는 대화상자·폼이 그린다(`silent`) */
export function useCreateWorktree(parentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: CreateWorktreeBody) =>
      (await api<{ project: RunnerProject }>("POST", `/runner-projects/${parentId}/worktrees`, body)).project,
    meta: { silent: true },
    onSuccess: () => projectsChanged(qc),
  });
}

/** 「확인」 — 러너 project.check 그대로(실패 사유도 200). 끊김·제한시간은 그 줄이 그린다(`silent`) */
export function useCheckRunnerProject() {
  return useMutation({
    mutationFn: (id: string) => api<RunnerProjectCheck>("POST", `/runner-projects/${id}/check`),
    meta: { silent: true },
  });
}

/**
 * 다른 러너로 옮기기 — 프로젝트와 그 에이전트가 함께 가고 러너 세션은 새로 열린다. 400(천장 밖 에이전트·확인 실패)·409·503 은
 * 대화상자가 그린다(`silent`). 에이전트 줄의 러너 이름이 바뀌므로 에이전트 목록도 다시 받는다
 */
export function useMoveRunnerProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, runnerId }: { id: string } & MoveRunnerProjectBody) =>
      (await api<{ project: RunnerProject }>("POST", `/runner-projects/${id}/move`, { runnerId })).project,
    meta: { silent: true },
    // exact — 등록 대화상자의 찾기 목록도 [agents] 아래다
    onSuccess: () =>
      Promise.all([projectsChanged(qc), qc.invalidateQueries({ queryKey: qk.agents, exact: true })]),
  });
}
