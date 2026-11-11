import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { agents } from "../src/db/schema.sqlite";
import { eq } from "drizzle-orm";
import {
  archiveAgent,
  createAgent,
  restoreAgent,
  RUNNER_AGENT_WITHOUT_PROJECT,
  updateAgent,
} from "../src/modules/agents/service";
import { runnerAgentDefinition } from "../src/modules/runners/definition";
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  renameProject,
} from "../src/modules/runners/projects";
import { issueRunnerToken, revokeRunnerToken } from "../src/modules/runners/tokens";
import { newTestDb } from "./helpers/db";
import { createRunnerAgentForTest, seedWorkspace } from "./helpers/seed";

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
    expect(agent.runner).toEqual({ tokenId: token, label: "laptop", revoked: false });
  });

  it.each([
    [{ model: "m".repeat(129) }, "model"],
    [{ model: "" }, "model"],
    [{ permissionMode: "bypassPermissions" }, "permissionMode"],
    [{ allowedTools: ["x".repeat(201)] }, "allowedTools"],
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
      allowedTools: ["Read"],
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
