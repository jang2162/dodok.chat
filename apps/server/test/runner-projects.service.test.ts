import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agents } from "../src/db/schema.sqlite";
import { eq } from "drizzle-orm";
import {
  archiveAgent,
  createAgent,
  listAgents,
  restoreAgent,
  RUNNER_AGENT_WITHOUT_PROJECT,
  updateAgent,
} from "../src/modules/agents/service";
import { runnerAgentDefinition } from "../src/modules/runners/definition";
import {
  archiveProject,
  archiveRunnerProject,
  createProject,
  createWorktreeProject,
  getProject,
  listProjects,
  renameProject,
  slugOf,
} from "../src/modules/runners/projects";
import { runnerProjects, runs } from "../src/db/schema.sqlite";
import { issueRunnerToken, revokeRunnerToken } from "../src/modules/runners/tokens";
import { insertRun } from "../src/modules/runs/store";
import type { RunnerWorktreeCreateResult, RunnerWorktreeRemoveResult } from "@dodok/shared";
import { newTestDb } from "./helpers/db";
import {
  channelConversation,
  createRunnerAgentForTest,
  seedChannelWithAgent,
  seedWorkspace,
} from "./helpers/seed";

// 러너 일반화 계획 태스크 3 — 러너 프로젝트 서비스와 러너 에이전트 갈래(PR4)·정의(run.start.agent)

let db: Db;
let ws: string;
let token: string;

beforeEach(() => {
  db = newTestDb();
  ws = seedWorkspace(db).workspaceId;
  token = issueRunnerToken(db, ws, "laptop", null).record.id;
});

const noop = { orchestrator: { abort: async () => {} } };
const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error as { status: number; body: { code: string; details?: Record<string, unknown> } };
  }
  throw new Error("expected a throw");
};

describe("createProject", () => {
  it("라벨 기본값은 relPath 의 마지막 성분, 루트 자신이면 루트 라벨(없으면 루트 id) — 준 라벨은 trim", () => {
    expect(
      createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "team/api" }).label,
    ).toBe("api");
    expect(
      createProject(db, {
        workspaceId: ws,
        runnerTokenId: token,
        rootId: "src",
        relPath: "",
        rootLabel: "내 저장소들",
      }).label,
    ).toBe("내 저장소들");
    expect(
      createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "work", relPath: "" }).label,
    ).toBe("work");
    expect(
      createProject(db, {
        workspaceId: ws,
        runnerTokenId: token,
        rootId: "src",
        relPath: "x",
        label: "  엑스 ",
      }).label,
    ).toBe("엑스");
    expect(listProjects(db, token).map((p) => [p.rootId, p.relPath])).toEqual([
      ["src", "team/api"],
      ["src", ""],
      ["work", ""],
      ["src", "x"],
    ]);
  });

  it.each([
    ["..", "relPath"],
    ["a//b", "relPath"],
    ["/abs", "relPath"],
    ["a\\b", "relPath"],
  ])("relPath %j 는 VALIDATION(%s) — 서버도 러너와 같은 스키마로 거른다", (relPath, field) => {
    const error = errorOf(() =>
      createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath }),
    );
    expect(error.body).toMatchObject({ code: "VALIDATION", details: { field } });
  });

  it("루트 id 꼴·빈 라벨·65자 라벨은 VALIDATION", () => {
    for (const [input, field] of [
      [{ rootId: "Src" }, "rootId"],
      [{ label: "  " }, "label"],
      [{ label: "가".repeat(65) }, "label"],
    ] as const) {
      const base = { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "a" };
      const error = errorOf(() => createProject(db, { ...base, ...input }));
      expect(error.body, field).toMatchObject({ code: "VALIDATION", details: { field } });
    }
  });

  it("같은 러너·루트·경로의 보관 안 된 프로젝트는 CONFLICT — 보관한 뒤에는 다시 더한다, 다른 러너는 따로", () => {
    const first = createProject(db, {
      workspaceId: ws,
      runnerTokenId: token,
      rootId: "src",
      relPath: "dodok",
    });
    expect(
      errorOf(() =>
        createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "dodok" }),
      ).body,
    ).toMatchObject({ code: "CONFLICT", details: { projectId: first.id } });
    const other = issueRunnerToken(db, ws, "desktop", null).record.id;
    expect(
      createProject(db, { workspaceId: ws, runnerTokenId: other, rootId: "src", relPath: "dodok" }).id,
    ).not.toBe(first.id);
    archiveProject(db, { workspaceId: ws, id: first.id });
    expect(
      createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "dodok" }).id,
    ).not.toBe(first.id);
  });

  it("폐기된 러너·다른 워크스페이스의 러너는 VALIDATION(runnerTokenId)", () => {
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    const foreign = issueRunnerToken(db, other, "x", null).record.id;
    expect(
      errorOf(() =>
        createProject(db, { workspaceId: ws, runnerTokenId: foreign, rootId: "src", relPath: "a" }),
      ).body,
    ).toMatchObject({ code: "VALIDATION", details: { field: "runnerTokenId" } });
    revokeRunnerToken(db, ws, token);
    expect(
      errorOf(() => createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "a" }))
        .body,
    ).toMatchObject({ code: "VALIDATION", details: { field: "runnerTokenId" } });
  });

  it("이름 바꾸기·보관(멱등) — 다른 워크스페이스의 id 는 NOT_FOUND", () => {
    const p = createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "dodok" });
    expect(renameProject(db, { workspaceId: ws, id: p.id, label: "도독" }).label).toBe("도독");
    const archived = archiveProject(db, { workspaceId: ws, id: p.id }, new Date("2026-10-29T00:00:00.000Z"));
    expect(archived.archivedAt?.toISOString()).toBe("2026-10-29T00:00:00.000Z");
    expect(archiveProject(db, { workspaceId: ws, id: p.id }).archivedAt?.toISOString()).toBe(
      "2026-10-29T00:00:00.000Z",
    );
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    expect(getProject(db, other, p.id)).toBeUndefined();
    expect(errorOf(() => renameProject(db, { workspaceId: other, id: p.id, label: "x" })).status).toBe(404);
  });
});

describe("createAgent — 러너 갈래(계획 판정 PR4)", () => {
  const project = () =>
    createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath: "dodok" });

  it("프로젝트의 러너 토큰에 묶이고, 정의 필드를 저장한다 — 기본은 모델 null·default·도구 null·막는 도구 없음", () => {
    const p = project();
    const agent = createAgent(db, {
      workspaceId: ws,
      provider: "runner",
      runnerProjectId: p.id,
      program: "claude",
      handle: "coder",
      name: "Coder",
    });
    const row = db.select().from(agents).where(eq(agents.id, agent.id)).get();
    expect(row).toMatchObject({
      provider: "runner",
      program: "claude",
      runnerTokenId: token,
      runnerProjectId: p.id,
      sessionDefaultModel: null,
      sessionDefaultEffort: null,
      sessionDefaultPermissionMode: null,
      disallowedToolsJson: [],
      instructionsRevision: 0,
    });
    expect(agent.runner).toEqual({ tokenId: token, label: "laptop", revoked: false, projectLabel: "dodok" });
  });

  it.each([
    [{ disallowedTools: ["x".repeat(201)] }, "disallowedTools"],
    [{ disallowedTools: Array.from({ length: 101 }, (_, i) => `t${i}`) }, "disallowedTools"],
  ])("RunnerRunAgent 필드 상한 밖이면 VALIDATION — %j", (over, field) => {
    const p = project();
    const error = errorOf(() =>
      createAgent(db, {
        workspaceId: ws,
        provider: "runner",
        runnerProjectId: p.id,
        program: "claude",
        handle: "coder",
        name: "Coder",
        ...(over as object),
      }),
    );
    expect(error.body).toMatchObject({ code: "VALIDATION", details: { field } });
  });

  it("없는 프로젝트·남의 프로젝트·보관한 프로젝트는 VALIDATION(runnerProjectId)", () => {
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    const foreign = createProject(db, {
      workspaceId: other,
      runnerTokenId: issueRunnerToken(db, other, "x", null).record.id,
      rootId: "src",
      relPath: "a",
    });
    const archived = project();
    archiveProject(db, { workspaceId: ws, id: archived.id });
    for (const id of ["01a09fc9-d204-7551-89d6-38544d07a1ff", foreign.id, archived.id]) {
      const error = errorOf(() =>
        createAgent(db, {
          workspaceId: ws,
          provider: "runner",
          runnerProjectId: id,
          program: "claude",
          handle: "coder",
          name: "c",
        }),
      );
      expect(error.body).toMatchObject({ code: "VALIDATION", details: { field: "runnerProjectId" } });
    }
  });
});

describe("runnerAgentDefinition — run.start.agent 는 에이전트 행·프로젝트 행 그대로", () => {
  it("그 토큰의 러너 에이전트면 정의, 다른 토큰·OpenClaw·없는 id 는 null, 대소문자는 무시", () => {
    const { agent } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "coder",
      name: "코더",
      runnerTokenId: token,
      rootId: "work",
      relPath: "team/api",
      model: "opus",
      permissionMode: "acceptEdits",
      disallowedTools: ["WebFetch"],
      basePrompt: "짧게 답한다",
    });
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, token)).toEqual({
      name: "코더",
      instructions: "짧게 답한다",
      agent: {
        program: "claude",
        project: { rootId: "work", relPath: "team/api" },
        model: "opus",
        effort: null,
        permissionMode: "acceptEdits",
        allowedTools: null,
        disallowedTools: ["WebFetch"],
      },
    });
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId.toUpperCase(), token)).not.toBeNull();
    const other = issueRunnerToken(db, ws, "desktop", null).record.id;
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, other)).toBeNull();
    createAgent(db, { workspaceId: ws, providerAgentId: "dev", handle: "dev", name: "Dev" });
    expect(runnerAgentDefinition(db, ws, "dev", token)).toBeNull();
    expect(runnerAgentDefinition(db, ws, "r-0000000000", token)).toBeNull();
  });

  it("보관한 프로젝트의 에이전트도 정의가 있다(런은 돈다 — 스펙 8장), 프로젝트가 없는 행은 null", () => {
    const { agent, projectId } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "coder",
      runnerTokenId: token,
    });
    archiveProject(db, { workspaceId: ws, id: projectId });
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, token)?.agent.project).toEqual({
      rootId: "src",
      relPath: "coder",
    });
    db.update(agents).set({ runnerProjectId: null }).where(eq(agents.id, agent.id)).run();
    expect(runnerAgentDefinition(db, ws, agent.providerAgentId, token)).toBeNull();
  });
});

describe("지시 리비전(계획 판정 PR2)", () => {
  const revision = (id: string) =>
    db.select({ r: agents.instructionsRevision }).from(agents).where(eq(agents.id, id)).get()?.r;

  it("base_prompt 가 실제로 바뀔 때만 +1 — 이름만·같은 값은 그대로, 지우면 +1", () => {
    const { agent } = createRunnerAgentForTest(db, { workspaceId: ws, handle: "coder", basePrompt: "하나" });
    updateAgent(db, agent.id, { name: "새 이름" });
    expect(revision(agent.id)).toBe(0);
    updateAgent(db, agent.id, { basePrompt: "하나" });
    expect(revision(agent.id)).toBe(0);
    updateAgent(db, agent.id, { basePrompt: "둘" });
    expect(revision(agent.id)).toBe(1);
    updateAgent(db, agent.id, { basePrompt: null });
    expect(revision(agent.id)).toBe(2);
    updateAgent(db, agent.id, { basePrompt: null });
    expect(revision(agent.id)).toBe(2);
  });
});

describe("되살리기 — 보관되지 않은 러너 에이전트는 프로젝트가 있다", () => {
  it("프로젝트가 없는(0031 이 보관한) 러너 에이전트는 VALIDATION, 프로젝트가 있으면 되살린다", async () => {
    const { agent } = createRunnerAgentForTest(db, { workspaceId: ws, handle: "coder" });
    await archiveAgent(db, noop, agent.id, ws);
    expect(restoreAgent(db, agent.id, ws).agent.archivedAt).toBeNull();
    await archiveAgent(db, noop, agent.id, ws);
    db.update(agents).set({ runnerProjectId: null }).where(eq(agents.id, agent.id)).run();
    const error = errorOf(() => restoreAgent(db, agent.id, ws));
    expect(error.body).toMatchObject({ code: "VALIDATION", message: RUNNER_AGENT_WITHOUT_PROJECT });
    expect(
      db.select({ a: agents.archivedAt }).from(agents).where(eq(agents.id, agent.id)).get()?.a,
    ).not.toBeNull();
  });
});

describe("워크트리 — slugOf·보관 막기 [워크트리 스펙 W3·W9·W11]", () => {
  it("slugOf — 소문자 ASCII·숫자·- 만, 40자, 비면 wt-<6 hex>", () => {
    expect(slugOf("Feat Login")).toBe("feat-login");
    expect(slugOf("--x")).toBe("x");
    expect(slugOf("로그인")).toMatch(/^wt-[0-9a-f]{6}$/);
    expect(slugOf("a__b..c")).toBe("a-b-c");
    expect(slugOf("x".repeat(60))).toHaveLength(40);
    expect(slugOf(`${"a".repeat(39)}-b`)).toBe("a".repeat(39));
  });

  const worktreeOf = (parentId: string, relPath: string) => {
    const row = createProject(db, { workspaceId: ws, runnerTokenId: token, rootId: "src", relPath });
    db.update(runnerProjects)
      .set({ parentProjectId: parentId, branch: "dodok/x" })
      .where(eq(runnerProjects.id, row.id))
      .run();
    return row;
  };

  it("보관 안 된 워크트리가 있는 부모는 보관을 409 「워크트리를 먼저 보관하세요」", () => {
    const parent = createProject(db, {
      workspaceId: ws,
      runnerTokenId: token,
      rootId: "src",
      relPath: "repo",
    });
    const wt = worktreeOf(parent.id, "repo/.worktrees/x");
    const error = errorOf(() => archiveProject(db, { workspaceId: ws, id: parent.id }));
    expect(error.status).toBe(409);
    expect(error.body).toMatchObject({ code: "CONFLICT", message: "워크트리를 먼저 보관하세요" });
    archiveProject(db, { workspaceId: ws, id: wt.id });
    expect(archiveProject(db, { workspaceId: ws, id: parent.id }).archivedAt).not.toBeNull();
  });

  it("보관 안 된 에이전트가 있는 워크트리는 보관을 409 「에이전트를 먼저 보관하세요」 — 일반 프로젝트는 그대로", async () => {
    const parent = createProject(db, {
      workspaceId: ws,
      runnerTokenId: token,
      rootId: "src",
      relPath: "repo",
    });
    const wt = worktreeOf(parent.id, "repo/.worktrees/x");
    const { agent } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "wtc",
      runnerTokenId: token,
      relPath: "repo/.worktrees/x",
    });
    const error = errorOf(() => archiveProject(db, { workspaceId: ws, id: wt.id }));
    expect(error.body).toMatchObject({ code: "CONFLICT", message: "에이전트를 먼저 보관하세요" });
    await archiveAgent(db, noop, agent.id, ws);
    expect(archiveProject(db, { workspaceId: ws, id: wt.id }).archivedAt).not.toBeNull();
    const { projectId } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "plain",
      runnerTokenId: token,
    });
    expect(archiveProject(db, { workspaceId: ws, id: projectId }).archivedAt).not.toBeNull();
  });

  const asyncErrorOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (error) {
      return error as {
        status: number;
        body: { code: string; message: string; details?: Record<string, unknown> };
      };
    }
    throw new Error("expected a rejection");
  };

  /** 러너 어댑터의 워크트리 몫 — 답을 손으로 풀 수 있게 */
  const fakeRunners = (opts: {
    create?: () => Promise<RunnerWorktreeCreateResult>;
    remove?: () => Promise<RunnerWorktreeRemoveResult>;
  }) => ({
    runnerInfo: () => ({}),
    hasCapability: () => true,
    worktreeCreate: async () =>
      opts.create ? opts.create() : { ok: true as const, created: true, adopted: false, base: "abc" },
    worktreeRemove: async () => (opts.remove ? opts.remove() : { ok: true as const }),
  });

  const gitParent = () => {
    const parent = createProject(db, {
      workspaceId: ws,
      runnerTokenId: token,
      rootId: "src",
      relPath: "repo",
      isGit: true,
    });
    return parent;
  };

  it("W11 — 에이전트는 보관했어도 그 에이전트의 런이 아직 돌면 보관 409 active_agents", async () => {
    const s = seedChannelWithAgent(db);
    const t = issueRunnerToken(db, s.workspaceId, "desk", null).record.id;
    const parent = createProject(db, {
      workspaceId: s.workspaceId,
      runnerTokenId: t,
      rootId: "src",
      relPath: "repo",
    });
    const { agent, projectId } = createRunnerAgentForTest(db, {
      workspaceId: s.workspaceId,
      handle: "wtrun",
      runnerTokenId: t,
      relPath: "repo/.worktrees/r",
    });
    db.update(runnerProjects)
      .set({ parentProjectId: parent.id, branch: "dodok/r" })
      .where(eq(runnerProjects.id, projectId))
      .run();
    await archiveAgent(db, noop, agent.id, s.workspaceId);
    const run = insertRun(db, {
      channelId: s.channelId,
      conversationId: channelConversation(db, s.channelId),
      agentId: agent.id,
      triggerKind: "mention",
      rootMessageId: "00000000-0000-4000-8000-0000000000aa",
      relayDepth: 0,
      sessionKey: `k:${agent.id}`,
      createdAt: new Date(),
    });
    const error = errorOf(() => archiveProject(db, { workspaceId: s.workspaceId, id: projectId }));
    expect(error.status).toBe(409);
    expect(error.body.details).toMatchObject({ reason: "active_agents" });
    db.update(runs).set({ status: "done" }).where(eq(runs.id, run.id)).run();
    expect(archiveProject(db, { workspaceId: s.workspaceId, id: projectId }).archivedAt).not.toBeNull();
  });

  it("만들기 — 러너를 기다리는 사이 부모가 보관되면 400, 행 없음", async () => {
    const parent = gitParent();
    const runners = fakeRunners({
      create: async () => {
        archiveProject(db, { workspaceId: ws, id: parent.id });
        return { ok: true, created: true, adopted: false, base: "abc" };
      },
    });
    const error = await asyncErrorOf(
      createWorktreeProject(db, runners, { workspaceId: ws, parentId: parent.id, label: "feat" }),
    );
    expect(error.status).toBe(400);
    expect(error.body.message).toBe("보관한 프로젝트에는 워크트리를 만들 수 없습니다");
    expect(listProjects(db, token).filter((p) => p.parentProjectId === parent.id)).toEqual([]);
  });

  it("보관 — 러너가 폴더를 지우는 동안 그 워크트리의 에이전트 만들기·되살리기는 409 worktree_archiving", async () => {
    const parent = gitParent();
    const wt = await createWorktreeProject(db, fakeRunners({}), {
      workspaceId: ws,
      parentId: parent.id,
      label: "feat",
    });
    const { agent } = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "old",
      runnerTokenId: token,
      relPath: wt.relPath,
    });
    await archiveAgent(db, noop, agent.id, ws);
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const archiving = archiveRunnerProject(
      db,
      fakeRunners({
        remove: async () => {
          await pending;
          return { ok: true };
        },
      }),
      { workspaceId: ws, id: wt.id },
    );
    await Promise.resolve();
    const create = errorOf(() =>
      createAgent(db, {
        workspaceId: ws,
        provider: "runner",
        runnerProjectId: wt.id,
        program: "claude",
        handle: "late",
        name: "late",
      }),
    );
    expect(create.status).toBe(409);
    expect(create.body.details).toMatchObject({ reason: "worktree_archiving" });
    const restore = errorOf(() => restoreAgent(db, agent.id, ws));
    expect(restore.status).toBe(409);
    expect(restore.body.details).toMatchObject({ reason: "worktree_archiving" });
    release();
    expect((await archiving).archivedAt).not.toBeNull();
    // 끝나면 표시가 풀린다 — 일반 프로젝트의 만들기는 그대로
    const other = createProject(db, {
      workspaceId: ws,
      runnerTokenId: token,
      rootId: "src",
      relPath: "plain",
    });
    expect(() =>
      createAgent(db, {
        workspaceId: ws,
        provider: "runner",
        runnerProjectId: other.id,
        program: "claude",
        handle: "fresh",
        name: "fresh",
      }),
    ).not.toThrow();
  });

  it("보관 — 러너가 unmerged_detached 로 답하면 409 「브랜치에 없는 커밋」, 사유가 그 줄에 남는다", async () => {
    const parent = gitParent();
    const wt = await createWorktreeProject(db, fakeRunners({}), {
      workspaceId: ws,
      parentId: parent.id,
      label: "d",
    });
    const error = await asyncErrorOf(
      archiveRunnerProject(
        db,
        fakeRunners({ remove: async () => ({ ok: false, reason: "unmerged_detached" }) }),
        {
          workspaceId: ws,
          id: wt.id,
        },
      ),
    );
    expect(error.status).toBe(409);
    expect(error.body).toMatchObject({
      message: "정리하지 못했습니다 — 브랜치에 없는 커밋이 있습니다",
      details: { reason: "unmerged_detached" },
    });
    const row = getProject(db, ws, wt.id);
    expect(row?.archivedAt).toBeNull();
    expect(row?.worktreeCleanup).toBe("unmerged_detached");
  });

  it("만들기 — 이름·브랜치·위치에 제어 문자가 있으면 러너에 묻기 전에 400", async () => {
    const parent = gitParent();
    let asked = 0;
    const runners = fakeRunners({
      create: async () => {
        asked += 1;
        return { ok: true, created: true, adopted: false, base: "abc" };
      },
    });
    for (const [input, field] of [
      [{ label: "a\nb" }, "label"],
      [{ label: "ok", branch: "dodok/a\rb" }, "branch"],
      [{ label: "ok", location: { rootId: "src", relPath: "repo/sub\nREADME.md" } }, "location"],
      [{ label: "ok", branch: "dodok/\x7f" }, "branch"],
    ] as const) {
      const error = await asyncErrorOf(
        createWorktreeProject(db, runners, { workspaceId: ws, parentId: parent.id, ...input }),
      );
      expect(error.status, field).toBe(400);
      expect(error.body.details, field).toMatchObject({ field });
    }
    expect(asked).toBe(0);
  });

  it("Agent.runner.projectLabel — 워크트리면 「부모 라벨 · 브랜치」, 일반 프로젝트면 그 라벨(경로는 없다)", async () => {
    const parent = gitParent();
    const wt = await createWorktreeProject(db, fakeRunners({}), {
      workspaceId: ws,
      parentId: parent.id,
      label: "feat",
    });
    const inWt = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "w1",
      runnerTokenId: token,
      relPath: wt.relPath,
    });
    const inRepo = createRunnerAgentForTest(db, {
      workspaceId: ws,
      handle: "w2",
      runnerTokenId: token,
      relPath: "repo",
    });
    expect(inWt.agent.runner?.projectLabel).toBe("repo · dodok/feat");
    expect(inRepo.agent.runner?.projectLabel).toBe("repo");
    const listed = new Map(listAgents(db, ws).map((a) => [a.id, a]));
    expect(listed.get(inWt.agent.id)?.runner).toEqual({
      tokenId: token,
      label: "laptop",
      revoked: false,
      projectLabel: "repo · dodok/feat",
    });
    expect(listed.get(inRepo.agent.id)?.runner?.projectLabel).toBe("repo");
  });
});
