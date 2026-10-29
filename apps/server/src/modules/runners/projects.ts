/**
 * 러너 프로젝트(러너 일반화 스펙 5장) — 러너 하나(runner_tokens 행)의 루트 안 디렉터리. 저장하는 것은 루트 id 와 그 안의 상대
 * 경로뿐이다 — 호스트 경로는 서버로 오지 않는다(스펙 결정 3). 그 자리가 실제로 쓸 만한지는 러너가 안다: REST 는 더하기 전에
 * 러너 어댑터 projectCheck 를 부르고, 러너는 런마다 천장 검사로 다시 본다
 */
import { RunnerRelPath, RunnerRootId } from "@dodok/shared";
import { and, asc, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { runnerProjects, runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";

export type RunnerProjectRow = typeof runnerProjects.$inferSelect;

/** 프로젝트 라벨 상한 — 루트 라벨(shared RunnerHello roots[].label)과 같다 */
export const RUNNER_PROJECT_LABEL_MAX = 64;

function cleanLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed === "" || trimmed.length > RUNNER_PROJECT_LABEL_MAX)
    throw apiError("VALIDATION", `라벨은 1~${RUNNER_PROJECT_LABEL_MAX}자여야 한다`, { field: "label" });
  return trimmed;
}

/** 라벨을 주지 않았을 때 — relPath 의 마지막 성분, 루트 자신이면 루트 라벨(모르면 루트 id) */
function defaultLabel(relPath: string, rootId: string, rootLabel: string | undefined): string {
  const last = relPath.split("/").at(-1);
  const label = relPath === "" || last === undefined ? (rootLabel ?? rootId) : last;
  return label.length > RUNNER_PROJECT_LABEL_MAX ? label.slice(0, RUNNER_PROJECT_LABEL_MAX) : label;
}

/**
 * 프로젝트를 더한다. 러너 토큰은 같은 워크스페이스의 폐기되지 않은 것이어야 한다(아니면 VALIDATION — 없는 것과 남의 것을 가르지
 * 않는다). 같은 러너·루트·경로의 보관 안 된 프로젝트가 있으면 CONFLICT. 러너에 묻는 확인(project.check)은 호출자 몫이다
 */
export function createProject(
  db: Db,
  input: {
    workspaceId: string;
    runnerTokenId: string;
    rootId: string;
    relPath: string;
    label?: string;
    /** 빈 relPath(루트 자신)의 기본 라벨 — 러너가 hello 로 알린 그 루트의 라벨 */
    rootLabel?: string;
    createdBy?: string;
  },
  now = new Date(),
): RunnerProjectRow {
  const rootId = RunnerRootId.safeParse(input.rootId);
  if (!rootId.success)
    throw apiError("VALIDATION", "root id must match [a-z0-9-]{1,32}", { field: "rootId" });
  const relPath = RunnerRelPath.safeParse(input.relPath);
  if (!relPath.success)
    throw apiError("VALIDATION", "relPath must be a relative path inside the root", { field: "relPath" });
  const label =
    input.label === undefined
      ? defaultLabel(relPath.data, rootId.data, input.rootLabel)
      : cleanLabel(input.label);
  return db.transaction((tx) => {
    const token = tx
      .select({ revokedAt: runnerTokens.revokedAt })
      .from(runnerTokens)
      .where(and(eq(runnerTokens.id, input.runnerTokenId), eq(runnerTokens.workspaceId, input.workspaceId)))
      .get();
    if (!token || token.revokedAt !== null)
      throw apiError("VALIDATION", "runner not found", { field: "runnerTokenId" });
    const taken = tx
      .select({ id: runnerProjects.id })
      .from(runnerProjects)
      .where(
        and(
          eq(runnerProjects.runnerTokenId, input.runnerTokenId),
          eq(runnerProjects.rootId, rootId.data),
          eq(runnerProjects.relPath, relPath.data),
          isNull(runnerProjects.archivedAt),
        ),
      )
      .get();
    if (taken) throw apiError("CONFLICT", "같은 자리의 프로젝트가 이미 있다", { projectId: taken.id });
    return tx
      .insert(runnerProjects)
      .values({
        id: uuidv7(),
        workspaceId: input.workspaceId,
        runnerTokenId: input.runnerTokenId,
        rootId: rootId.data,
        relPath: relPath.data,
        label,
        createdBy: input.createdBy ?? null,
        createdAt: now,
        archivedAt: null,
      })
      .returning()
      .get();
  });
}

/** 그 러너의 프로젝트 — 보관한 것도 싣는다(archivedAt 으로 가른다), 더한 차례 */
export function listProjects(db: DbOrTx, runnerTokenId: string): RunnerProjectRow[] {
  return db
    .select()
    .from(runnerProjects)
    .where(eq(runnerProjects.runnerTokenId, runnerTokenId))
    .orderBy(asc(runnerProjects.createdAt), asc(runnerProjects.id))
    .all();
}

/** 같은 워크스페이스의 프로젝트 하나 — 없거나 남의 것이면 undefined */
export function getProject(db: DbOrTx, workspaceId: string, id: string): RunnerProjectRow | undefined {
  return db
    .select()
    .from(runnerProjects)
    .where(and(eq(runnerProjects.id, id), eq(runnerProjects.workspaceId, workspaceId)))
    .get();
}

export function renameProject(
  db: Db,
  input: { workspaceId: string; id: string; label: string },
): RunnerProjectRow {
  const label = cleanLabel(input.label);
  const row = db
    .update(runnerProjects)
    .set({ label })
    .where(and(eq(runnerProjects.id, input.id), eq(runnerProjects.workspaceId, input.workspaceId)))
    .returning()
    .get();
  if (!row) throw apiError("NOT_FOUND", "runner project not found");
  return row;
}

/**
 * 보관 — 목록 정리일 뿐이다(스펙 8장): 그 프로젝트로 새 에이전트를 만들 수 없지만 이미 있는 에이전트는 남고 런도 돈다. 이미
 * 보관했으면 그대로
 */
export function archiveProject(
  db: Db,
  input: { workspaceId: string; id: string },
  now = new Date(),
): RunnerProjectRow {
  const row =
    db
      .update(runnerProjects)
      .set({ archivedAt: now })
      .where(
        and(
          eq(runnerProjects.id, input.id),
          eq(runnerProjects.workspaceId, input.workspaceId),
          isNull(runnerProjects.archivedAt),
        ),
      )
      .returning()
      .get() ?? getProject(db, input.workspaceId, input.id);
  if (!row) throw apiError("NOT_FOUND", "runner project not found");
  return row;
}
