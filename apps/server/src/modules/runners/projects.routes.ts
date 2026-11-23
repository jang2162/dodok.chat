/**
 * 러너 REST(러너 일반화 스펙 5·6·7장) — 그 러너의 주인·admin 이상(authorizeRunnerManage, 연결 탭 통합 스펙 5.2). 러너 목록(member 는 자기
 * 러너만)·디렉터리 둘러보기·프로젝트 더하기·이름 바꾸기·보관·확인·옮기기(두 러너가 다 자기 것이거나 admin 이상). 러너 토큰 발급·다시
 * 발급·폐기는 routes.ts, 러너 에이전트 만들기·고치기는 POST·PATCH /agents(agents/routes.ts). 연결 상태·hello 내용은 메모리에만 있다 — 끊긴 러너는 null·빈 목록으로 보인다(스펙 5장)
 */
import {
  ArchiveRunnerProjectBody,
  compareVersions,
  CreateRunnerProjectBody,
  CreateWorktreeBody,
  Id,
  MoveRunnerProjectBody,
  RenameRunnerProjectBody,
  RunnerCapability,
  type RunnerFsListing,
  RunnerFsQuery,
  type RunnerProject,
  type RunnerProjectCheck,
  type RunnerSummary,
  RUNNER_UPDATE_DEADLINE_MS,
  type RemoteUpdateStarted,
} from "@dodok/shared";
import type { RunnerLive } from "@dodok/runner-adapter";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeProjectMove, authorizeRunnerManage } from "../../auth/policies";
import { requireSession } from "../../auth/roles";
import { sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { canReadConnection, isOwner } from "../connections/owner";
import {
  type RemoteUpdates,
  runnerSupport,
  runnerUpdateKey,
  sendUpdate,
} from "../connections/remote-updates";
import { recordRateLimit } from "../ops/http-limits";
import type { Limits } from "../ops/limits";
import { KeyedLimiter } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import type { LatestRunnerVersion } from "./latest";
import { askRunner, ceilingMiss, liveRunner, type RunnerLiveApi } from "./live";
import {
  activeAgentCounts,
  activeProjectAgents,
  activeProjectCounts,
  archiveRunnerProject,
  assertMovable,
  createProject,
  createWorktreeProject,
  getProject,
  listProjects,
  moveProject,
  renameProject,
  type RunnerProjectRow,
  setProjectIsGit,
} from "./projects";
import { listRunnerTokens } from "./tokens";

export type RunnerAdminRouteContext = {
  auth: Auth;
  db: Db;
  logger: Logger;
  workspaceId: string;
  bus: ServerBus;
  /** 러너 어댑터 — 없으면 러너에 묻는 경로는 503 ADAPTER_UNAVAILABLE */
  runners: RunnerLiveApi | null;
  limits: Pick<Limits, "runnerBrowsePerMin">;
  ops: Pick<OpsService, "record">;
  /** 레이트리밋 시계 — app.ts 의 limitClock(테스트가 주입) */
  now: () => number;
  /** npm @dodok/runner latest(원격 업데이트 스펙 U2) */
  latest: LatestRunnerVersion;
  /** 원격 업데이트 진행(U9) — Gateway 라우트와 같은 것 */
  remoteUpdates: RemoteUpdates;
};

const RunnerParams = z.object({ id: Id });
const ProjectParams = z.object({ id: Id });

function toApiProject(
  row: RunnerProjectRow,
  live: RunnerLive | null,
  agentCounts: ReadonlyMap<string, number>,
): RunnerProject {
  return {
    id: row.id,
    runnerId: row.runnerTokenId,
    rootId: row.rootId,
    rootLabel: live?.roots.find((r) => r.id === row.rootId)?.label ?? null,
    relPath: row.relPath,
    label: row.label,
    agentCount: agentCounts.get(row.id) ?? 0,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    parentProjectId: row.parentProjectId,
    branch: row.branch,
    isGit: row.isGit,
    cleanupIssue: row.worktreeCleanup,
  };
}

export function registerRunnerAdminRoutes(fastify: FastifyInstance, ctx: RunnerAdminRouteContext): void {
  const session = requireSession(ctx);
  // 둘러보기는 사람 머신에 요청을 보낸다 — REST 상한(requireSession 이 먼저 부른다) 위에 사용자당 한 번 더
  const browseLimiter = new KeyedLimiter({ perMin: ctx.limits.runnerBrowsePerMin, now: ctx.now });
  const browseLimit = async (request: FastifyRequest): Promise<void> => {
    if (browseLimiter.take(sessionUser(request).id)) return;
    recordRateLimit(ctx.ops, request);
    throw apiError("RATE_LIMITED", "둘러보기 요청이 너무 많습니다");
  };

  // 트리의 프로젝트 줄이 바뀌었다 — 열린 「연결」 탭이 GET /connections 를 다시 받게(연결 탭 통합 스펙 5.3)
  const connectionsChanged = () => ctx.bus.emit("connections.changed", {});
  const live = (tokenId: string): RunnerLive | null => ctx.runners?.runnerInfo(tokenId) ?? null;
  /** 이 워크스페이스의 러너(토큰 행) — 없으면 404. 폐기한 러너도 돌려준다(목록·프로젝트 보기는 된다) */
  const runnerRow = (id: string) => {
    const row = ctx.db
      .select({
        id: runnerTokens.id,
        revokedAt: runnerTokens.revokedAt,
        ownerUserId: runnerTokens.ownerUserId,
      })
      .from(runnerTokens)
      .where(and(eq(runnerTokens.id, id), eq(runnerTokens.workspaceId, ctx.workspaceId)))
      .get();
    if (!row) throw apiError("NOT_FOUND", "runner not found");
    return row;
  };
  /** 폐기한 러너에는 더하거나 옮기지 않는다 — 다시 붙을 수 없다 */
  const activeRunner = (id: string) => {
    const row = runnerRow(id);
    if (row.revokedAt !== null) throw apiError("CONFLICT", "runner token is revoked");
    return row;
  };
  const projectOr404 = (id: string): RunnerProjectRow => {
    const row = getProject(ctx.db, ctx.workspaceId, id);
    if (!row) throw apiError("NOT_FOUND", "runner project not found");
    return row;
  };
  /** 이 요청의 사람이 그 러너(주인)를 다룰 수 있는가 — 없는 러너는 먼저 404 */
  const owns = (request: FastifyRequest, ownerUserId: string | null) => {
    const user = sessionUser(request);
    return { role: user.role, ownsConnection: isOwner(ownerUserId, user.id) };
  };
  const manageRunner = (request: FastifyRequest, id: string) => {
    const row = runnerRow(id);
    authorizeRunnerManage(owns(request, row.ownerUserId));
    return row;
  };
  /** 프로젝트는 자기가 있는 러너의 주인을 따른다 */
  const manageProject = (request: FastifyRequest, id: string): RunnerProjectRow => {
    const project = projectOr404(id);
    authorizeRunnerManage(owns(request, runnerRow(project.runnerTokenId).ownerUserId));
    return project;
  };
  /** 둘러보기 — 상한은 판정을 지난 요청만 센다(거절된 요청이 버킷을 쓰지 않게) */
  const browseGuard = async (request: FastifyRequest): Promise<void> => {
    manageRunner(request, parseParams(RunnerParams, request.params).id);
  };
  const apiProject = (row: RunnerProjectRow): RunnerProject =>
    toApiProject(row, live(row.runnerTokenId), activeAgentCounts(ctx.db, [row.id]));
  /** 러너의 project.check — 쓸 수 없는 자리면 400 VALIDATION(details.reason 은 러너의 사유) */
  const checkPlace = async (tokenId: string, place: { rootId: string; relPath: string }) => {
    const check = await askRunner(ctx.runners, (api) => api.projectCheck(tokenId, place));
    if (!check.ok)
      throw apiError("VALIDATION", `project check failed: ${check.reason}`, {
        field: "relPath",
        reason: check.reason,
      });
    return check;
  };
  /** 러너에 묻는 서비스 호출 — 어댑터 오류를 API 오류로(askRunner 와 같은 규칙) */
  const viaRunner = <T>(fn: () => Promise<T>): Promise<T> => askRunner(ctx.runners, () => fn());

  /** member 는 자기 러너만(루트·프로그램은 그 머신의 사정이다), admin 이상은 모두 */
  fastify.get(
    "/api/v1/runners",
    { preHandler: session },
    async (request): Promise<{ runners: RunnerSummary[] }> => {
      const user = sessionUser(request);
      const projectCounts = activeProjectCounts(ctx.db, ctx.workspaceId);
      // 레지스트리를 기다리지 않는다(리뷰 L2) — 쥔 값이 없거나 낡았으면 뒤에서 묻고, 값이 바뀌면 연결 변경으로 웹이 다시 받는다. 한 번도
      // 묻지 않았으면 latestVersion 없이 답한다(웹은 판 줄을 숨긴다)
      const peeked = ctx.latest.peek();
      if (!peeked.fresh)
        void ctx.latest.get().then((value) => {
          if (value !== peeked.value) connectionsChanged();
        });
      const latestVersion = peeked.value;
      return {
        runners: listRunnerTokens(ctx.db, ctx.workspaceId, new Set())
          .filter((token) => canReadConnection(user, token.ownerUserId))
          .map((token) => {
            const hello = live(token.id);
            return {
              id: token.id,
              label: token.label,
              connected: hello !== null,
              revoked: token.revokedAt !== null,
              runnerVersion: hello?.runnerVersion ?? null,
              browse: hello?.browse ?? null,
              roots: hello?.roots ?? [],
              programs: hello?.programs ?? [],
              capabilities: hello
                ? RunnerCapability.options.filter((c) => ctx.runners?.hasCapability(token.id, c) ?? false)
                : [],
              projectCount: projectCounts.get(token.id) ?? 0,
              ...(latestVersion === undefined ? {} : { latestVersion }),
              remoteUpdate: hello
                ? runnerSupport((c) => ctx.runners?.hasCapability(token.id, c) ?? false)
                : null,
              update: ctx.remoteUpdates.runnerView(token.id, hello),
            };
          }),
      };
    },
  );

  /**
   * 원격 업데이트(원격 업데이트 스펙 U3·U7·U9) — 그 러너의 주인·admin 이상. 붙어 있고(503), 능력이 있고 켜져 있고(409), npm latest 를 알고
   * (503 「최신을 알 수 없음」), 지금보다 높을 때만. 진행 중이면 409(Review Focus 4). 러너의 곧바른 거절(런 중·꺼짐 등)은 409 와 그 사유,
   * 받아들여지면 202 — 다시 붙으면 끝, 상한 3분
   */
  fastify.post(
    "/api/v1/runners/:id/update",
    { preHandler: session },
    async (request, reply): Promise<RemoteUpdateStarted> => {
      const { id } = parseParams(RunnerParams, request.params);
      const row = manageRunner(request, id);
      if (row.revokedAt !== null) throw apiError("CONFLICT", "runner token is revoked");
      const hello = liveRunner(ctx.runners, id);
      const support = runnerSupport((c) => ctx.runners?.hasCapability(id, c) ?? false);
      if (support === "unsupported")
        throw apiError(
          "CONFLICT",
          "이 러너 판은 원격 업데이트를 지원하지 않습니다 — 그 머신에서 npm i -g @dodok/runner@latest",
          { reason: "unsupported" },
        );
      if (support === "off")
        throw apiError("CONFLICT", "이 머신에서 원격 업데이트를 껐습니다", { reason: "disabled" });
      const latest = await ctx.latest.get();
      if (latest === null)
        throw apiError("ADAPTER_UNAVAILABLE", "최신 판을 알 수 없습니다 — npm 레지스트리에 닿지 않습니다");
      if (!(compareVersions(latest, hello.runnerVersion) > 0))
        throw apiError("CONFLICT", "이미 최신 판입니다", { reason: "invalid_version" });
      const key = runnerUpdateKey(id);
      const { view, startedAt } = ctx.remoteUpdates.begin(key, {
        targetVersion: latest,
        deadlineMs: RUNNER_UPDATE_DEADLINE_MS,
      });
      ctx.logger.info(
        { userId: sessionUser(request).id, runnerId: id, from: hello.runnerVersion, to: latest },
        "runner remote update requested",
      );
      await sendUpdate({
        updates: ctx.remoteUpdates,
        key,
        startedAt,
        send: () => askRunner(ctx.runners, (api) => api.runnerUpdate(id, latest)),
        onLate: connectionsChanged,
      });
      connectionsChanged();
      return reply.status(202).send({ update: view });
    },
  );

  /**
   * 디렉터리 둘러보기 — 러너 fs.list 그대로. 운영 로그 한 줄은 누가·어느 러너·루트 id 만 남긴다 — relPath 는 머신의 디렉터리 구조라
   * 싣지 않는다(스펙 6장, 요청 줄의 쿼리는 logger.ts redactUrl 이 가린다)
   */
  fastify.get(
    "/api/v1/runners/:id/fs",
    { preHandler: [session, browseGuard, browseLimit] },
    async (request): Promise<RunnerFsListing> => {
      const { id } = parseParams(RunnerParams, request.params);
      const { rootId, relPath } = parseQuery(RunnerFsQuery, request.query);
      ctx.logger.info({ userId: sessionUser(request).id, runnerId: id, rootId }, "runner fs browse");
      const result = await askRunner(ctx.runners, (api) => api.fsList(id, { rootId, relPath }));
      if (result.ok) return { entries: result.entries, truncated: result.truncated };
      if (result.code === "FORBIDDEN") throw apiError("FORBIDDEN", "this runner does not allow browsing");
      throw apiError("NOT_FOUND", "directory not found");
    },
  );

  fastify.get(
    "/api/v1/runners/:id/projects",
    { preHandler: session },
    async (request): Promise<{ projects: RunnerProject[] }> => {
      const { id } = parseParams(RunnerParams, request.params);
      manageRunner(request, id);
      const rows = listProjects(ctx.db, id);
      const counts = activeAgentCounts(
        ctx.db,
        rows.map((r) => r.id),
      );
      const hello = live(id);
      return { projects: rows.map((row) => toApiProject(row, hello, counts)) };
    },
  );

  /** 프로젝트 더하기 — 러너에 project.check 를 먼저 묻는다(붙어 있지 않으면 503) */
  fastify.post("/api/v1/runners/:id/projects", { preHandler: session }, async (request, reply) => {
    const { id } = parseParams(RunnerParams, request.params);
    manageRunner(request, id);
    const body = parseBody(CreateRunnerProjectBody, request.body);
    activeRunner(id);
    const check = await checkPlace(id, body);
    const rootLabel = live(id)?.roots.find((r) => r.id === body.rootId)?.label;
    const row = createProject(ctx.db, {
      workspaceId: ctx.workspaceId,
      runnerTokenId: id,
      rootId: body.rootId,
      relPath: body.relPath,
      ...(body.label === undefined ? {} : { label: body.label }),
      ...(rootLabel === undefined ? {} : { rootLabel }),
      createdBy: sessionUser(request).id,
      isGit: check.isGitTop ?? false,
    });
    ctx.logger.info({ runnerId: id, projectId: row.id, rootId: row.rootId }, "runner project added");
    connectionsChanged();
    return reply.code(201).send({ project: apiProject(row) });
  });

  fastify.patch("/api/v1/runner-projects/:id", { preHandler: session }, async (request) => {
    const { id } = parseParams(ProjectParams, request.params);
    manageProject(request, id);
    const { label } = parseBody(RenameRunnerProjectBody, request.body);
    const renamed = renameProject(ctx.db, { workspaceId: ctx.workspaceId, id, label });
    connectionsChanged();
    return { project: apiProject(renamed) };
  });

  /**
   * 워크트리 만들기(워크트리 스펙 5.4) — 부모(git 저장소 프로젝트)를 다룰 수 있는 사람(W10), 폐기하지 않은 러너. 러너에
   * worktree.create 를 묻고 성공해야 행을 만든다. 실패면 400(details.reason 은 러너 사유), 끊김·같은 자리면 409
   */
  fastify.post("/api/v1/runner-projects/:id/worktrees", { preHandler: session }, async (request, reply) => {
    const { id } = parseParams(ProjectParams, request.params);
    const parent = manageProject(request, id);
    const body = parseBody(CreateWorktreeBody, request.body);
    activeRunner(parent.runnerTokenId);
    const row = await createWorktreeProject(
      ctx.db,
      ctx.runners,
      {
        workspaceId: ctx.workspaceId,
        parentId: id,
        label: body.label,
        ...(body.branch === undefined ? {} : { branch: body.branch }),
        ...(body.location === undefined ? {} : { location: body.location }),
        createdBy: sessionUser(request).id,
      },
      viaRunner,
    );
    ctx.logger.info({ projectId: row.id, parentId: id, rootId: row.rootId }, "runner worktree created");
    connectionsChanged();
    return reply.code(201).send({ project: apiProject(row) });
  });

  /**
   * 보관 — 일반 프로젝트는 목록 정리일 뿐 이미 있는 에이전트는 남고 런도 돈다(스펙 8장). 워크트리는 러너가 폴더를 지워야 보관한다(W7),
   * 본문 { keepFolder: true } 면 묻지 않고 행만(W12). 정리 실패는 409 details.reason, 그 줄의 cleanupIssue 로 남는다
   */
  fastify.post("/api/v1/runner-projects/:id/archive", { preHandler: session }, async (request) => {
    const { id } = parseParams(ProjectParams, request.params);
    manageProject(request, id);
    const body = parseBody(ArchiveRunnerProjectBody, request.body ?? {});
    try {
      const archived = await archiveRunnerProject(
        ctx.db,
        ctx.runners,
        { workspaceId: ctx.workspaceId, id, ...(body.keepFolder ? { keepFolder: true } : {}) },
        viaRunner,
      );
      connectionsChanged();
      return { project: apiProject(archived) };
    } catch (err) {
      // 정리 실패 사유가 그 줄에 남았다 — 열린 「연결」 탭이 다시 받게
      connectionsChanged();
      throw err;
    }
  });

  /** 확인 — 그 러너의 project.check 결과 그대로(쓸 수 없는 자리도 200 — ok:false 와 사유) */
  fastify.post(
    "/api/v1/runner-projects/:id/check",
    { preHandler: session },
    async (request): Promise<RunnerProjectCheck> => {
      const { id } = parseParams(ProjectParams, request.params);
      const project = manageProject(request, id);
      const check = await askRunner(ctx.runners, (api) =>
        api.projectCheck(project.runnerTokenId, { rootId: project.rootId, relPath: project.relPath }),
      );
      // git 여부를 갱신한다(W14) — 워크트리 행은 언제나 거짓(워크트리 안의 워크트리 막기)
      if (check.ok && project.parentProjectId === null) {
        const isGit = check.isGitTop ?? false;
        if (isGit !== project.isGit) {
          setProjectIsGit(ctx.db, project.id, isGit);
          connectionsChanged();
        }
      }
      return check;
    },
  );

  /**
   * 다른 러너로 옮기기(계획 판정 PR8) — 옮길 러너가 붙어 있고, 그 프로젝트의 보관 안 된 에이전트가 모두 그 러너의 천장 안이고(태스크
   * 4 리뷰 L1 — 아니면 옮긴 뒤 런마다 RUNNER_CEILING 카드다. 사람이 에이전트를 먼저 낮추고 옮긴다), 같은 자리가 그 러너의
   * project.check 를 지날 때만. 천장 밖이면 400 VALIDATION details { field: "runnerId", agentIds, item(첫 에이전트의 항목) } — 아무것도
   * 옮기지 않는다
   */
  fastify.post("/api/v1/runner-projects/:id/move", { preHandler: session }, async (request) => {
    const { id } = parseParams(ProjectParams, request.params);
    const { runnerId } = parseBody(MoveRunnerProjectBody, request.body);
    const project = projectOr404(id);
    const from = runnerRow(project.runnerTokenId);
    const to = runnerRow(runnerId);
    const userId = sessionUser(request).id;
    // 남의 러너로 밀어 넣으면 남의 컴퓨터가 일을 떠맡는다 — 두 러너가 다 자기 것이거나 admin 이상(스펙 5.2)
    authorizeProjectMove(
      sessionUser(request).role,
      isOwner(from.ownerUserId, userId) && isOwner(to.ownerUserId, userId),
    );
    assertMovable(ctx.db, project);
    if (project.runnerTokenId === runnerId) return { project: apiProject(project) };
    activeRunner(runnerId);
    const target = liveRunner(ctx.runners, runnerId);
    const misses = activeProjectAgents(ctx.db, id).flatMap((agent) => {
      const item =
        agent.program === null
          ? null
          : ceilingMiss(
              target,
              agent.program,
              agent.permissionMode === null ? {} : { permissionMode: agent.permissionMode },
              { requireAvailable: true },
            );
      return item ? [{ agentId: agent.id, item }] : [];
    });
    const first = misses[0];
    if (first)
      throw apiError(
        "VALIDATION",
        `옮길 러너의 설정이 이 프로젝트의 에이전트를 허용하지 않습니다(${first.item})`,
        {
          field: "runnerId",
          agentIds: misses.map((m) => m.agentId),
          item: first.item,
        },
      );
    await checkPlace(runnerId, project);
    const { project: moved, agentIds } = moveProject(ctx.db, {
      workspaceId: ctx.workspaceId,
      id,
      runnerTokenId: runnerId,
    });
    ctx.logger.info(
      { projectId: id, from: project.runnerTokenId, to: runnerId, agents: agentIds.length },
      "runner project moved",
    );
    // 에이전트 응답의 runner(묶인 러너 라벨)가 바뀌었다
    if (agentIds.length > 0) ctx.bus.emit("agents.changed", {});
    connectionsChanged();
    return { project: apiProject(moved) };
  });
}
