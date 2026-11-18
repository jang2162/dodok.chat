/**
 * 러너 프로젝트(러너 일반화 스펙 5장) — 러너 하나(runner_tokens 행)의 루트 안 디렉터리. 저장하는 것은 루트 id 와 그 안의 상대
 * 경로뿐이다 — 호스트 경로는 서버로 오지 않는다(스펙 결정 3). 그 자리가 실제로 쓸 만한지는 러너가 안다: REST 는 더하기 전에
 * 러너 어댑터 projectCheck 를 부르고, 러너는 런마다 천장 검사로 다시 본다
 */
import { randomBytes } from "node:crypto";
import {
  RunnerRelPath,
  RunnerRootId,
  type RunnerPermissionMode,
  type RunnerProgram,
  type RunnerProjectRef,
} from "@dodok/shared";
import type { RunnerAdapter } from "@dodok/runner-adapter";
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, notInArray } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { agents, agentSessions, runnerProjects, runnerTokens, runs } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { TERMINAL_STATUSES } from "../runs/machine";

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
    /** 러너 project.check 의 isGitTop(W14) — 옛 러너는 없어 거짓 */
    isGit?: boolean;
    /** 워크트리 하위 프로젝트면 부모 프로젝트와 브랜치(createWorktreeProject 가 채운다) */
    parentProjectId?: string;
    branch?: string;
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
        parentProjectId: input.parentProjectId ?? null,
        branch: input.branch ?? null,
        isGit: input.isGit ?? false,
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

/** 보관 안 된 워크트리가 있는 부모는 보관·옮기기를 막는다(W9) */
export const ARCHIVE_WORKTREES_FIRST = "워크트리를 먼저 보관하세요";
/** 보관 안 된 에이전트가 있거나 런이 도는 워크트리는 보관을 막는다(W11) */
export const ARCHIVE_AGENTS_FIRST = "에이전트를 먼저 보관하세요";

/** 그 부모 아래 보관하지 않은 워크트리가 있으면 409(W9) */
function assertNoActiveWorktrees(db: DbOrTx, projectId: string): void {
  const child = db
    .select({ id: runnerProjects.id })
    .from(runnerProjects)
    .where(and(eq(runnerProjects.parentProjectId, projectId), isNull(runnerProjects.archivedAt)))
    .get();
  if (child) throw apiError("CONFLICT", ARCHIVE_WORKTREES_FIRST, { reason: "active_worktrees" });
}

/**
 * 워크트리에 보관하지 않은 에이전트가 있거나 그 프로젝트 에이전트의 런이 돌고 있으면 409(W11) — 폴더를 지우면 남은 에이전트의 다음 런이
 * 천장 검사 path 로 깨진다. 「폴더를 남기고 보관」도 같다(되살리기가 막혀 그 에이전트가 고아가 된다)
 */
export function assertWorktreeIdle(db: DbOrTx, projectId: string): void {
  const agent = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.runnerProjectId, projectId), isNull(agents.archivedAt)))
    .get();
  const running =
    agent ??
    db
      .select({ id: runs.id })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(agents.runnerProjectId, projectId), notInArray(runs.status, [...TERMINAL_STATUSES])))
      .get();
  if (running) throw apiError("CONFLICT", ARCHIVE_AGENTS_FIRST, { reason: "active_agents" });
}

/**
 * 보관 — 일반 프로젝트는 목록 정리일 뿐이다(스펙 8장): 그 프로젝트로 새 에이전트를 만들 수 없지만 이미 있는 에이전트는 남고 런도
 * 돈다. 이미 보관했으면 그대로. 보관 안 된 워크트리가 있는 부모는 409(W9), 워크트리는 W11 검사 뒤 행만 보관한다 — 폴더 정리(러너에
 * 묻기)는 archiveRunnerProject 몫이다. 정리 실패 사유(worktree_cleanup)는 보관하며 비운다
 */
export function archiveProject(
  db: Db,
  input: { workspaceId: string; id: string },
  now = new Date(),
): RunnerProjectRow {
  return db.transaction((tx) => {
    const current = getProject(tx, input.workspaceId, input.id);
    if (!current) throw apiError("NOT_FOUND", "runner project not found");
    if (current.archivedAt !== null) return current;
    if (current.parentProjectId === null) assertNoActiveWorktrees(tx, current.id);
    else assertWorktreeIdle(tx, current.id);
    const row = tx
      .update(runnerProjects)
      .set({ archivedAt: now, worktreeCleanup: null })
      .where(and(eq(runnerProjects.id, input.id), isNull(runnerProjects.archivedAt)))
      .returning()
      .get();
    return row ?? current;
  });
}

/** 워크트리는 옮기지 않는다(400 — 스펙 2장), 보관 안 된 워크트리가 있는 부모도 옮기지 않는다(409 — W9) */
export function assertMovable(db: DbOrTx, project: RunnerProjectRow): void {
  if (project.parentProjectId !== null)
    throw apiError("VALIDATION", "워크트리는 다른 러너로 옮길 수 없습니다", { field: "runnerId" });
  assertNoActiveWorktrees(db, project.id);
}

/**
 * 다른 러너로 옮긴다(러너 일반화 계획 판정 PR8) — 프로젝트와 그 에이전트의 러너 토큰을 한 트랜잭션에서 함께 바꾸고(둘이 어긋나면 런의
 * 정의가 없다 — definition.ts), 그 에이전트들의 러너 세션 id 를 비운다(세션 전사는 옛 머신에 있다 — 다음 런은 새 세션). 옮길 러너가
 * 붙어 있고 그 자리가 project.check 를 지나는지는 호출자 몫이다. 대상 토큰은 같은 워크스페이스의 폐기되지 않은 것(아니면 VALIDATION),
 * 대상 러너에 같은 루트·경로의 보관 안 된 다른 프로젝트가 있으면 CONFLICT. 이미 그 러너면 그대로. 도는 런은 맡은 연결에서 끝까지 간다
 */
export function moveProject(
  db: Db,
  input: { workspaceId: string; id: string; runnerTokenId: string },
): { project: RunnerProjectRow; agentIds: string[] } {
  return db.transaction((tx) => {
    const project = getProject(tx, input.workspaceId, input.id);
    if (!project) throw apiError("NOT_FOUND", "runner project not found");
    assertMovable(tx, project);
    const token = tx
      .select({ revokedAt: runnerTokens.revokedAt })
      .from(runnerTokens)
      .where(and(eq(runnerTokens.id, input.runnerTokenId), eq(runnerTokens.workspaceId, input.workspaceId)))
      .get();
    if (!token || token.revokedAt !== null)
      throw apiError("VALIDATION", "runner not found", { field: "runnerId" });
    if (project.runnerTokenId === input.runnerTokenId) return { project, agentIds: [] };
    const taken = tx
      .select({ id: runnerProjects.id })
      .from(runnerProjects)
      .where(
        and(
          eq(runnerProjects.runnerTokenId, input.runnerTokenId),
          eq(runnerProjects.rootId, project.rootId),
          eq(runnerProjects.relPath, project.relPath),
          isNull(runnerProjects.archivedAt),
          ne(runnerProjects.id, project.id),
        ),
      )
      .get();
    if (taken)
      throw apiError("CONFLICT", "옮길 러너에 같은 자리의 프로젝트가 이미 있다", { projectId: taken.id });
    const moved = tx
      .update(runnerProjects)
      .set({ runnerTokenId: input.runnerTokenId })
      .where(eq(runnerProjects.id, project.id))
      .returning()
      .get();
    if (!moved) throw apiError("NOT_FOUND", "runner project not found");
    const agentIds = tx
      .update(agents)
      .set({ runnerTokenId: input.runnerTokenId })
      .where(and(eq(agents.workspaceId, input.workspaceId), eq(agents.runnerProjectId, project.id)))
      .returning({ id: agents.id })
      .all()
      .map((r) => r.id);
    if (agentIds.length > 0)
      tx.update(agentSessions)
        .set({ providerSessionId: null })
        .where(inArray(agentSessions.agentId, agentIds))
        .run();
    return { project: moved, agentIds };
  });
}

/** 프로젝트의 보관하지 않은 에이전트의 정의 — 옮기기가 옮길 러너의 천장과 대조한다(태스크 4 리뷰 L1) */
export function activeProjectAgents(
  db: DbOrTx,
  projectId: string,
): {
  id: string;
  program: RunnerProgram | null;
  /** 새 세션 시작값의 권한 — null 이면 「기본」(그 러너 상한 안으로 계산된다 — 대조할 것이 없다) */
  permissionMode: RunnerPermissionMode | null;
}[] {
  return db
    .select({
      id: agents.id,
      program: agents.program,
      permissionMode: agents.sessionDefaultPermissionMode,
    })
    .from(agents)
    .where(and(eq(agents.runnerProjectId, projectId), isNull(agents.archivedAt)))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .all();
}

/** 프로젝트마다 보관하지 않은 에이전트 수 — 없는 프로젝트는 0 */
export function activeAgentCounts(db: DbOrTx, projectIds: string[]): Map<string, number> {
  if (projectIds.length === 0) return new Map();
  const rows = db
    .select({ projectId: agents.runnerProjectId, n: count() })
    .from(agents)
    .where(and(inArray(agents.runnerProjectId, projectIds), isNull(agents.archivedAt)))
    .groupBy(agents.runnerProjectId)
    .all();
  return new Map(rows.flatMap((r) => (r.projectId === null ? [] : [[r.projectId, r.n] as const])));
}

/** 러너(토큰)마다 보관하지 않은 프로젝트 수 */
export function activeProjectCounts(db: DbOrTx, workspaceId: string): Map<string, number> {
  const rows = db
    .select({ runnerTokenId: runnerProjects.runnerTokenId, n: count() })
    .from(runnerProjects)
    .where(and(eq(runnerProjects.workspaceId, workspaceId), isNull(runnerProjects.archivedAt)))
    .groupBy(runnerProjects.runnerTokenId)
    .all();
  return new Map(rows.map((r) => [r.runnerTokenId, r.n]));
}

// ── git 워크트리(워크트리 스펙) — 저장소 프로젝트 아래 하위 프로젝트. 러너가 폴더를 만들고 지운다

const SLUG_MAX = 40;

/**
 * 이름 → 폴더·브랜치 슬러그. 소문자 ASCII·숫자·`-` 만 남기고(나머지는 `-` 로, 이어진 `-` 는 하나로) 앞뒤 `-` 를 떼고 40자. 비면(한글
 * 이름 등) `wt-<6 hex>` — 사람이 브랜치·위치를 바꿀 수 있으니 안전한 기본이면 된다(스펙 6장). 웹 worktreeDefaults 와 같은 규칙
 */
export function slugOf(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? `wt-${randomBytes(3).toString("hex")}` : slug;
}

/** 기본 위치 `<부모 relPath>/.worktrees/<슬러그>`(W3), 기본 브랜치 `dodok/<슬러그>`(W6) */
export function worktreeDefaults(
  parent: RunnerProjectRef,
  slug: string,
): { branch: string; location: RunnerProjectRef } {
  return {
    branch: `dodok/${slug}`,
    location: {
      rootId: parent.rootId,
      relPath: parent.relPath === "" ? `.worktrees/${slug}` : `${parent.relPath}/.worktrees/${slug}`,
    },
  };
}

/** 서버가 쓰는 러너 어댑터의 워크트리 몫 — live.ts RunnerLiveApi 의 부분 */
export type WorktreeRunnerApi = {
  runnerInfo(tokenId: string): unknown;
  hasCapability(tokenId: string, capability: "worktrees"): boolean;
  worktreeCreate: RunnerAdapter["worktreeCreate"];
  worktreeRemove: RunnerAdapter["worktreeRemove"];
};

export const WORKTREE_RUNNER_OUTDATED = "러너를 업데이트하세요(워크트리는 0.7.0 부터)";
export const WORKTREE_RUNNER_OFFLINE = "러너가 연결되어 있어야 합니다";
export const WORKTREE_CLEANUP_OFFLINE = "러너가 연결되어 있어야 정리할 수 있습니다";
export const WORKTREE_CLEANUP_DIRTY = "정리하지 못했습니다 — 커밋하지 않은 변경이 있습니다";
export const WORKTREE_CLEANUP_REVOKED = "러너가 폐기되어 폴더를 정리할 수 없습니다";
export const WORKTREE_CLEANUP_FAILED = "정리하지 못했습니다";

/** 러너 worktree.create 실패 사유 → 사람에게 보일 문구(400 의 message, details.reason 은 사유 코드 그대로) */
const CREATE_FAILURE: Record<string, string> = {
  not_git: "git 저장소가 아닙니다",
  is_worktree: "워크트리 안에는 워크트리를 만들 수 없습니다",
  target_exists: "그 위치에 이미 파일이 있습니다",
  outside_root: "러너의 허용 루트 밖입니다",
  root_missing: "러너가 그 루트를 알리지 않습니다",
  branch_in_use: "그 브랜치는 다른 워크트리가 쓰고 있습니다",
  invalid_branch: "브랜치 이름이 올바르지 않습니다",
  git_failed: "git 이 실패했습니다",
};

/**
 * 워크트리 하위 프로젝트를 만든다 — 부모 검사(보관·워크트리·git 아님이면 400) → 러너 붙음(아니면 409)·능력(아니면 400) → 기본값 →
 * 같은 자리의 보관 안 된 행이 있으면 러너에 묻기 전에 409 → worktree.create → 성공이면 행(실패면 행 없음, 400 details.reason).
 * 권한(W10)·러너 폐기는 호출자(REST)가 먼저 본다
 */
export async function createWorktreeProject(
  db: Db,
  runners: WorktreeRunnerApi | null,
  input: {
    workspaceId: string;
    parentId: string;
    label: string;
    branch?: string;
    location?: RunnerProjectRef;
    createdBy?: string;
  },
  ask: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<RunnerProjectRow> {
  const parent = getProject(db, input.workspaceId, input.parentId);
  if (!parent) throw apiError("NOT_FOUND", "runner project not found");
  if (parent.archivedAt !== null)
    throw apiError("VALIDATION", "보관한 프로젝트에는 워크트리를 만들 수 없습니다", { field: "parentId" });
  if (parent.parentProjectId !== null)
    throw apiError("VALIDATION", "워크트리 안에는 워크트리를 만들 수 없습니다", { field: "parentId" });
  if (!parent.isGit)
    throw apiError("VALIDATION", "git 저장소의 맨 위 프로젝트에서만 만들 수 있습니다", { field: "parentId" });
  const label = cleanLabel(input.label);
  if (!runners || runners.runnerInfo(parent.runnerTokenId) === null)
    throw apiError("CONFLICT", WORKTREE_RUNNER_OFFLINE, { reason: "runner_offline" });
  if (!runners.hasCapability(parent.runnerTokenId, "worktrees"))
    throw apiError("VALIDATION", WORKTREE_RUNNER_OUTDATED, { reason: "runner_outdated" });
  const defaults = worktreeDefaults(parent, slugOf(label));
  const branch = input.branch?.trim() || defaults.branch;
  if (branch.length > 200) throw apiError("VALIDATION", "브랜치 이름이 너무 깁니다", { field: "branch" });
  const location = input.location ?? defaults.location;
  const place = RunnerRelPath.safeParse(location.relPath);
  if (!place.success || !RunnerRootId.safeParse(location.rootId).success)
    throw apiError("VALIDATION", "relPath must be a relative path inside the root", { field: "location" });
  const sameRoot = location.rootId === parent.rootId;
  if (sameRoot && location.relPath === parent.relPath)
    throw apiError("VALIDATION", "저장소 자신에는 워크트리를 만들 수 없습니다", { field: "location" });
  const taken = () =>
    db
      .select({ id: runnerProjects.id })
      .from(runnerProjects)
      .where(
        and(
          eq(runnerProjects.runnerTokenId, parent.runnerTokenId),
          eq(runnerProjects.rootId, location.rootId),
          eq(runnerProjects.relPath, location.relPath),
          isNull(runnerProjects.archivedAt),
        ),
      )
      .get();
  const existing = taken();
  if (existing) throw apiError("CONFLICT", "같은 자리의 프로젝트가 이미 있다", { projectId: existing.id });
  const result = await ask(() =>
    runners.worktreeCreate(parent.runnerTokenId, {
      repo: { rootId: parent.rootId, relPath: parent.relPath },
      target: location,
      branch,
    }),
  );
  if (!result.ok)
    throw apiError("VALIDATION", CREATE_FAILURE[result.reason] ?? WORKTREE_CLEANUP_FAILED, {
      field: "branch",
      reason: result.reason,
      ...(result.message === undefined ? {} : { message: result.message }),
    });
  // 같은 이름을 두 번 누른 경쟁 — 앞의 것이 행을 만들었으면 createProject 가 CONFLICT(러너 쪽 폴더는 앞의 행의 것이다)
  return createProject(db, {
    workspaceId: input.workspaceId,
    runnerTokenId: parent.runnerTokenId,
    rootId: location.rootId,
    relPath: location.relPath,
    label,
    parentProjectId: parent.id,
    branch,
    isGit: false,
    ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
  });
}

function saveCleanupIssue(db: Db, id: string, reason: string): void {
  db.update(runnerProjects).set({ worktreeCleanup: reason }).where(eq(runnerProjects.id, id)).run();
}

/**
 * 보관 — 워크트리면 러너에 폴더 정리(worktree.remove)를 묻고 성공해야 보관한다(W7·W8). keepFolder 면 묻지 않고 행만(W12). 정리가
 * 실패하면 사유를 worktree_cleanup 에 남기고 409 details.reason(runner_revoked·runner_offline·dirty·not_worktree·git_failed).
 * 일반 프로젝트·이미 보관한 행은 archiveProject 그대로
 */
export async function archiveRunnerProject(
  db: Db,
  runners: WorktreeRunnerApi | null,
  input: { workspaceId: string; id: string; keepFolder?: boolean },
  ask: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn(),
): Promise<RunnerProjectRow> {
  const project = getProject(db, input.workspaceId, input.id);
  if (!project) throw apiError("NOT_FOUND", "runner project not found");
  if (project.parentProjectId === null || project.archivedAt !== null || input.keepFolder)
    return archiveProject(db, input);
  assertWorktreeIdle(db, project.id);
  const fail = (reason: string, message: string, extra: Record<string, unknown> = {}): never => {
    saveCleanupIssue(db, project.id, reason);
    throw apiError("CONFLICT", message, { reason, ...extra });
  };
  const token = db
    .select({ revokedAt: runnerTokens.revokedAt })
    .from(runnerTokens)
    .where(eq(runnerTokens.id, project.runnerTokenId))
    .get();
  if (!token || token.revokedAt !== null) return fail("runner_revoked", WORKTREE_CLEANUP_REVOKED);
  if (!runners || runners.runnerInfo(project.runnerTokenId) === null)
    return fail("runner_offline", WORKTREE_CLEANUP_OFFLINE);
  const parent =
    project.parentProjectId === null ? undefined : getProject(db, input.workspaceId, project.parentProjectId);
  if (!parent) return fail("git_failed", WORKTREE_CLEANUP_FAILED);
  let result;
  try {
    result = await ask(() =>
      runners.worktreeRemove(project.runnerTokenId, {
        repo: { rootId: parent.rootId, relPath: parent.relPath },
        target: { rootId: project.rootId, relPath: project.relPath },
      }),
    );
  } catch (err) {
    // 묻는 사이 끊김(503)·늦음(504) — 그 줄에 사유를 남기고 409 로 「폴더를 남기고 보관」에 잇는다
    const code = (err as { body?: { code?: string } }).body?.code;
    if (code === "ADAPTER_UNAVAILABLE") return fail("runner_offline", WORKTREE_CLEANUP_OFFLINE);
    if (code === "TIMEOUT")
      return fail("git_failed", `${WORKTREE_CLEANUP_FAILED} — 러너가 제때 답하지 않았습니다`);
    throw err;
  }
  if (!result.ok)
    return fail(
      result.reason,
      result.reason === "dirty" ? WORKTREE_CLEANUP_DIRTY : WORKTREE_CLEANUP_FAILED,
      result.message === undefined ? {} : { message: result.message },
    );
  return archiveProject(db, input);
}

/** 「확인」·만들기 때 러너 project.check 의 isGitTop 을 저장한다(W14) */
export function setProjectIsGit(db: Db, id: string, isGit: boolean): void {
  db.update(runnerProjects).set({ isGit }).where(eq(runnerProjects.id, id)).run();
}

/** 보관한 워크트리면 그 에이전트는 되살리지 않는다(W11 — 폴더가 없다) */
export function isArchivedWorktree(db: DbOrTx, projectId: string): boolean {
  return (
    db
      .select({ id: runnerProjects.id })
      .from(runnerProjects)
      .where(
        and(
          eq(runnerProjects.id, projectId),
          isNotNull(runnerProjects.parentProjectId),
          isNotNull(runnerProjects.archivedAt),
        ),
      )
      .get() !== undefined
  );
}
