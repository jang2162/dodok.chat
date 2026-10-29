import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import {
  RunnerFsEntry,
  RunnerProgramStatus,
  RunnerProjectCheckResult,
  RunnerRelPath,
  RunnerRootId,
} from "../runner";

// 「러너」 탭 REST(러너 일반화 스펙 5·6·7장) — admin 이상. 러너는 runner_tokens 행 하나다. 연결 상태·hello 내용은 서버 메모리에만
// 있어(스펙 5장) 끊긴 러너는 「마지막으로 알린」 값 없이 null·빈 목록으로 온다

/** GET /api/v1/runners 의 러너 하나 — 끊겼으면 runnerVersion·browse 가 null, roots·programs 가 빈 목록 */
export const RunnerSummary = z.object({
  id: Id,
  label: z.string(),
  connected: z.boolean(),
  revoked: z.boolean(),
  runnerVersion: z.string().nullable(),
  browse: z.boolean().nullable(),
  roots: z.array(z.object({ id: RunnerRootId, label: z.string() })),
  programs: z.array(RunnerProgramStatus),
  /** 보관하지 않은 프로젝트 수 */
  projectCount: z.int().min(0),
});
export type RunnerSummary = z.infer<typeof RunnerSummary>;

/** GET /api/v1/runners/:id/fs 쿼리 — relPath 를 빼면 루트 자신 */
export const RunnerFsQuery = z.object({ rootId: RunnerRootId, relPath: RunnerRelPath.default("") });
export type RunnerFsQuery = z.infer<typeof RunnerFsQuery>;

/**
 * GET /api/v1/runners/:id/fs 응답 — 러너 fs.list 의 ok 결과. 러너가 둘러보기를 껐으면 403 FORBIDDEN, 루트·디렉터리가 없거나 루트
 * 밖이면 404 NOT_FOUND
 */
export const RunnerFsListing = z.object({ entries: z.array(RunnerFsEntry), truncated: z.boolean() });
export type RunnerFsListing = z.infer<typeof RunnerFsListing>;

/** 러너 프로젝트 하나 — rootLabel 이 null 이면 러너가 끊겼거나 그 루트를 더는 알리지 않는다(「루트 없음」 — Review Focus 2) */
export const RunnerProject = z.object({
  id: Id,
  runnerId: Id,
  rootId: RunnerRootId,
  rootLabel: z.string().nullable(),
  relPath: RunnerRelPath,
  label: z.string(),
  /** 보관하지 않은 에이전트 수 */
  agentCount: z.int().min(0),
  archivedAt: IsoDateTime.nullable(),
});
export type RunnerProject = z.infer<typeof RunnerProject>;

/** POST /api/v1/runners/:id/projects — 서버가 먼저 러너에 project.check 를 묻는다(실패면 400 VALIDATION, details.reason) */
export const CreateRunnerProjectBody = z.object({
  rootId: RunnerRootId,
  relPath: RunnerRelPath,
  label: z.string().optional(),
});
export type CreateRunnerProjectBody = z.infer<typeof CreateRunnerProjectBody>;

/** PATCH /api/v1/runner-projects/:id */
export const RenameRunnerProjectBody = z.object({ label: z.string() });
export type RenameRunnerProjectBody = z.infer<typeof RenameRunnerProjectBody>;

/**
 * POST /api/v1/runner-projects/:id/move — 옮길 러너가 붙어 있고 같은 rootId·relPath 가 그 러너의 project.check 를 지날 때만.
 * 프로젝트의 에이전트가 함께 가고 그 에이전트들의 러너 세션 id 를 비운다(세션 전사는 옛 머신에 있다 — 스펙 5장)
 */
export const MoveRunnerProjectBody = z.object({ runnerId: Id });
export type MoveRunnerProjectBody = z.infer<typeof MoveRunnerProjectBody>;

/** POST /api/v1/runner-projects/:id/check 응답 — 러너 project.check 결과 그대로 */
export const RunnerProjectCheck = RunnerProjectCheckResult;
export type RunnerProjectCheck = z.infer<typeof RunnerProjectCheck>;
