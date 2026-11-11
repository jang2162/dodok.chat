/**
 * 러너 일반화 계획 태스크 4 — 「러너」 탭 REST(러너 목록·둘러보기·프로젝트·옮기기), 러너 에이전트 만들기·고치기의 천장 대조, 토큰
 * 다시 발급(PR7·Review Focus 5). 실제 서버(실제 러너 어댑터) + 가짜 러너(`/runner` 에 붙는 socket.io-client). 모델 런 0
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Agent,
  type Channel,
  IssueRunnerTokenResult,
  ReissueRunnerTokenResult,
  RunnerProject,
  RunnerSummary,
} from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { io } from "socket.io-client";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { agents, agentSessions, runnerProjects, workspaces } from "../src/db/schema.sqlite";
import { runnerAgentDefinition } from "../src/modules/runners/definition";
import { RUNNER_TOKEN_FILE } from "../src/modules/runners/routes";
import {
  FAKE_CLAUDE_PROGRAM,
  FAKE_CODEX_PROGRAM,
  type FakeRunner,
  type FakeRunnerScript,
  startFakeRunner,
} from "./fakes/fake-runner";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { bootLiveApp, type LiveApp } from "./helpers/live-app";
import { openChannelWire, rest, sendMessage, type WireLog } from "./helpers/scenario-steps";
import {
  channelConversation,
  createRunnerAgentForTest,
  insertRunnerToken,
  seedAgentSession,
} from "./helpers/seed";
import type { WireClient } from "./helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** 핸드셰이크만 해 본다 — 붙으면 "connected", 거절되면 connect_error 메시지 */
function tryRunner(url: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = io(`${url}/runner`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    socket.once("connect", () => {
      socket.close();
      resolve("connected");
    });
    socket.once("connect_error", (err) => {
      socket.close();
      resolve(err.message);
    });
  });
}

describe("「러너」 탭 REST /api/v1/runners·/runner-projects", () => {
  let app: App;
  let owner: { authorization: string };
  let admin: { authorization: string };
  let member: { authorization: string };
  const lines: string[] = [];
  const runners: FakeRunner[] = [];

  beforeAll(async () => {
    const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], runnerAdapter: true, logger });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = (await login(app)).headers;
    admin = { authorization: `Bearer ${(await userWithRole(app, "ada", "admin")).token}` };
    member = { authorization: `Bearer ${(await userWithRole(app, "mo", "member")).token}` };
  });
  afterEach(() => {
    for (const runner of runners.splice(0)) runner.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (headers: Record<string, string>, method: Method, url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
  const issue = async (label: string) => {
    const res = await call(owner, "POST", "/setup/runner-tokens", { label });
    expect(res.statusCode).toBe(201);
    return IssueRunnerTokenResult.parse(res.json());
  };
  const connect = async (token: string, hello?: Parameters<typeof startFakeRunner>[0]["hello"]) => {
    const runner = await startFakeRunner({ url: app.url, token, ...(hello ? { hello } : {}) });
    runners.push(runner);
    return runner;
  };
  /** 토큰 발급 + 가짜 러너 접속 */
  const runnerWith = async (label: string, hello?: Parameters<typeof startFakeRunner>[0]["hello"]) => {
    const issued = await issue(label);
    const runner = await connect(issued.token, hello);
    return { id: issued.record.id, token: issued.token, runner };
  };
  const summaries = async () => {
    const res = await call(admin, "GET", "/runners");
    expect(res.statusCode).toBe(200);
    return (res.json() as { runners: unknown[] }).runners.map((r) => RunnerSummary.parse(r));
  };
  const addProject = (runnerId: string, body: object) =>
    call(admin, "POST", `/runners/${runnerId}/projects`, body);
  const projectOf = async (runnerId: string, relPath: string) => {
    const res = await addProject(runnerId, { rootId: "src", relPath });
    expect(res.statusCode, res.body).toBe(201);
    return RunnerProject.parse((res.json() as { project: unknown }).project);
  };
  const createRunnerAgent = (body: object) =>
    call(admin, "POST", "/agents", { provider: "runner", program: "claude", ...body });

  it("GET /runners — 붙은 러너는 hello(루트·프로그램·둘러보기·판본)와 프로젝트 수, 끊긴·폐기한 러너는 null·빈 목록", async () => {
    const live = await runnerWith("live-one", { browse: false });
    const quiet = await issue("quiet-one");
    const revoked = await issue("revoked-one");
    await call(owner, "DELETE", `/setup/runner-tokens/${revoked.record.id}`);
    await projectOf(live.id, "a");
    const archived = await projectOf(live.id, "b");
    await call(admin, "POST", `/runner-projects/${archived.id}/archive`);

    const list = await summaries();
    expect(list.find((r) => r.id === live.id)).toEqual({
      id: live.id,
      label: "live-one",
      connected: true,
      revoked: false,
      runnerVersion: "0.0.0-fake",
      browse: false,
      roots: [{ id: "src", label: "내 저장소들" }],
      programs: [FAKE_CLAUDE_PROGRAM, FAKE_CODEX_PROGRAM],
      projectCount: 1,
    });
    expect(list.find((r) => r.id === quiet.record.id)).toEqual({
      id: quiet.record.id,
      label: "quiet-one",
      connected: false,
      revoked: false,
      runnerVersion: null,
      browse: null,
      roots: [],
      programs: [],
      projectCount: 0,
    });
    expect(list.find((r) => r.id === revoked.record.id)).toMatchObject({ connected: false, revoked: true });
  });

  it("다른 워크스페이스의 러너는 없는 것과 같은 404 — 둘러보기·프로젝트 목록·더하기·옮기기 대상 [태스크 4 리뷰 T5]", async () => {
    const otherWs = uuid();
    app.db.insert(workspaces).values({ id: otherWs, name: "other", createdAt: new Date() }).run();
    const foreign = insertRunnerToken(app.db, otherWs, "foreign");
    const { id } = await runnerWith("ws-home");
    const project = await projectOf(id, "ws-home");
    for (const [method, url, body] of [
      ["GET", `/runners/${foreign}/fs?rootId=src`, undefined],
      ["GET", `/runners/${foreign}/projects`, undefined],
      ["POST", `/runners/${foreign}/projects`, { rootId: "src", relPath: "x" }],
      ["POST", `/runner-projects/${project.id}/move`, { runnerId: foreign }],
    ] as const) {
      const res = await call(admin, method, url, body);
      expect(res.statusCode, url).toBe(404);
    }
    expect((await summaries()).map((r) => r.id)).not.toContain(foreign);
  });

  describe("둘러보기 GET /runners/:id/fs", () => {
    it("러너 fs.list 그대로 — 쿼리의 루트·경로를 실어 묻고, 운영 로그 한 줄에는 사용자·러너·루트 id 만(relPath 원문은 요청 줄에도 없다)", async () => {
      const { id, runner } = await runnerWith("browse-ok");
      runner.onFsList = () => ({
        ok: true,
        entries: [
          { name: "dodok", isGitRepo: true },
          { name: "notes", isGitRepo: false },
        ],
        truncated: true,
      });
      const secretDir = `client-${uuid()}`;
      const res = await call(admin, "GET", `/runners/${id}/fs?rootId=src&relPath=${secretDir}/inner`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        entries: [
          { name: "dodok", isGitRepo: true },
          { name: "notes", isGitRepo: false },
        ],
        truncated: true,
      });
      expect(runner.fsRequests).toEqual([["fs.list", { rootId: "src", relPath: `${secretDir}/inner` }]]);
      const browse = lines.filter((l) => l.includes('"runner fs browse"'));
      expect(browse).toHaveLength(1);
      expect(JSON.parse(browse[0] ?? "{}")).toMatchObject({
        runnerId: id,
        rootId: "src",
        userId: expect.any(String),
      });
      expect(lines.join("\n")).not.toContain(secretDir);
      expect(lines.some((l) => l.includes(`/api/v1/runners/${id}/fs?rootId=src&relPath=…`))).toBe(true);

      // relPath 를 빼면 루트 자신
      expect((await call(admin, "GET", `/runners/${id}/fs?rootId=src`)).statusCode).toBe(200);
      expect(runner.fsRequests.at(-1)).toEqual(["fs.list", { rootId: "src", relPath: "" }]);
    });

    it("러너가 둘러보기를 껐으면 403, 없는 디렉터리 404, 끊긴 러너 503, 없는 러너 404, 루트 밖 꼴의 경로는 묻지 않고 400", async () => {
      const { id, runner } = await runnerWith("browse-no");
      runner.onFsList = () => ({ ok: false, code: "FORBIDDEN" });
      const forbidden = await call(admin, "GET", `/runners/${id}/fs?rootId=src`);
      expect(forbidden.statusCode).toBe(403);
      expect(forbidden.json().code).toBe("FORBIDDEN");
      runner.onFsList = () => ({ ok: false, code: "NOT_FOUND" });
      expect((await call(admin, "GET", `/runners/${id}/fs?rootId=src&relPath=gone`)).statusCode).toBe(404);
      const asked = runner.fsRequests.length;
      for (const bad of ["..", "a/../b", "/abs", "a//b"]) {
        const res = await call(
          admin,
          "GET",
          `/runners/${id}/fs?rootId=src&relPath=${encodeURIComponent(bad)}`,
        );
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().code).toBe("VALIDATION");
      }
      expect(runner.fsRequests).toHaveLength(asked);
      expect((await call(admin, "GET", `/runners/${uuid()}/fs?rootId=src`)).statusCode).toBe(404);
      const quiet = await issue("browse-quiet");
      const down = await call(admin, "GET", `/runners/${quiet.record.id}/fs?rootId=src`);
      expect(down.statusCode).toBe(503);
      expect(down.json().code).toBe("ADAPTER_UNAVAILABLE");
    });

    it("사용자당 분당 60 — 61번째는 429, 다른 사용자는 따로 센다", async () => {
      const { id } = await runnerWith("browse-limit");
      const heavy = { authorization: `Bearer ${(await userWithRole(app, "heavy", "admin")).token}` };
      for (let i = 0; i < 60; i += 1)
        expect((await call(heavy, "GET", `/runners/${id}/fs?rootId=src`)).statusCode, `요청 ${i + 1}`).toBe(
          200,
        );
      const over = await call(heavy, "GET", `/runners/${id}/fs?rootId=src`);
      expect(over.statusCode).toBe(429);
      expect(over.json().code).toBe("RATE_LIMITED");
      expect((await call(owner, "GET", `/runners/${id}/fs?rootId=src`)).statusCode).toBe(200);
    });
  });

  describe("프로젝트", () => {
    it("더하기는 러너 project.check 를 먼저 묻는다 — 쓸 수 없는 자리는 400(details.reason), 같은 자리 409, 라벨 기본은 마지막 성분·루트 자신이면 루트 라벨", async () => {
      const { id, runner } = await runnerWith("proj");
      const created = await addProject(id, { rootId: "src", relPath: "team/api" });
      expect(created.statusCode).toBe(201);
      const project = RunnerProject.parse(created.json().project);
      expect(project).toMatchObject({
        runnerId: id,
        rootId: "src",
        rootLabel: "내 저장소들",
        relPath: "team/api",
        label: "api",
        agentCount: 0,
        archivedAt: null,
      });
      expect(runner.fsRequests).toEqual([["project.check", { rootId: "src", relPath: "team/api" }]]);
      const root = await addProject(id, { rootId: "src", relPath: "" });
      expect(RunnerProject.parse(root.json().project).label).toBe("내 저장소들");

      const dup = await addProject(id, { rootId: "src", relPath: "team/api" });
      expect(dup.statusCode).toBe(409);
      expect(dup.json().code).toBe("CONFLICT");

      for (const reason of ["root_missing", "not_found", "not_directory", "outside_root"] as const) {
        runner.onProjectCheck = () => ({ ok: false, reason });
        const res = await addProject(id, { rootId: "src", relPath: `x-${reason}` });
        expect(res.statusCode, reason).toBe(400);
        expect(res.json()).toMatchObject({ code: "VALIDATION", details: { reason } });
      }
      const listed = await call(admin, "GET", `/runners/${id}/projects`);
      expect((listed.json() as { projects: RunnerProject[] }).projects.map((p) => p.relPath)).toEqual([
        "team/api",
        "",
      ]);
    });

    it("끊긴 러너에는 더할 수 없고(503), 목록의 rootLabel 은 null — 러너가 그 루트를 알리지 않아도 null(「루트 없음」)", async () => {
      const { id, runner } = await runnerWith("proj-down");
      const project = await projectOf(id, "kept");
      runner.disconnect();
      await vi.waitFor(async () =>
        expect((await summaries()).find((r) => r.id === id)?.connected).toBe(false),
      );
      const res = await addProject(id, { rootId: "src", relPath: "later" });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("ADAPTER_UNAVAILABLE");
      const listed = (await call(admin, "GET", `/runners/${id}/projects`)).json() as {
        projects: RunnerProject[];
      };
      expect(listed.projects).toEqual([{ ...project, rootLabel: null }]);

      await runner.reconnect({ hello: { roots: [{ id: "work", label: "회사" }] } });
      const again = (await call(admin, "GET", `/runners/${id}/projects`)).json() as {
        projects: RunnerProject[];
      };
      expect(again.projects[0]?.rootLabel).toBeNull();
    });

    it("이름 바꾸기·보관·확인 — 확인은 러너 결과 그대로(쓸 수 없어도 200), 남의 것·없는 것 404, 폐기한 러너에 더하기 409", async () => {
      const { id, runner } = await runnerWith("proj-edit");
      const project = await projectOf(id, "edit-me");
      const renamed = await call(admin, "PATCH", `/runner-projects/${project.id}`, { label: " 새 이름 " });
      expect(renamed.statusCode).toBe(200);
      expect(renamed.json().project.label).toBe("새 이름");
      expect((await call(admin, "PATCH", `/runner-projects/${project.id}`, { label: "  " })).statusCode).toBe(
        400,
      );

      runner.onProjectCheck = () => ({ ok: true, isGitRepo: true });
      const checked = await call(admin, "POST", `/runner-projects/${project.id}/check`);
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toEqual({ ok: true, isGitRepo: true });
      runner.onProjectCheck = () => ({ ok: false, reason: "not_found" });
      expect((await call(admin, "POST", `/runner-projects/${project.id}/check`)).json()).toEqual({
        ok: false,
        reason: "not_found",
      });

      const archived = await call(admin, "POST", `/runner-projects/${project.id}/archive`);
      expect(archived.statusCode).toBe(200);
      expect(archived.json().project.archivedAt).not.toBeNull();
      for (const [method, url] of [
        ["PATCH", `/runner-projects/${uuid()}`],
        ["POST", `/runner-projects/${uuid()}/archive`],
        ["POST", `/runner-projects/${uuid()}/check`],
        ["GET", `/runners/${uuid()}/projects`],
      ] as const) {
        const res = await call(admin, method, url, method === "PATCH" ? { label: "x" } : undefined);
        expect(res.statusCode, url).toBe(404);
      }
      const gone = await issue("proj-revoked");
      await call(owner, "DELETE", `/setup/runner-tokens/${gone.record.id}`);
      expect((await addProject(gone.record.id, { rootId: "src", relPath: "x" })).statusCode).toBe(409);
    });
  });

  describe("러너 에이전트 만들기·고치기 — 붙은 러너의 천장과 대조", () => {
    it("붙은 러너의 프로젝트에 만든다 — 그 러너에 묶이고 응답에 정의(runnerAgent)", async () => {
      const { id } = await runnerWith("agent-ok");
      const project = await projectOf(id, "agent-ok");
      const res = await createRunnerAgent({
        runnerProjectId: project.id,
        handle: "maker",
        name: "Maker",
        // 옛 클라이언트가 보내는 모델·권한 모드·허용 도구는 버린다 — 400 이 아니다(세션 설정 스펙 5.5)
        model: "opus",
        permissionMode: "acceptEdits",
        allowedTools: ["Read"],
        disallowedTools: ["WebFetch"],
        basePrompt: "테스트를 돌린다",
        dmAccess: "everyone",
      });
      expect(res.statusCode, res.body).toBe(201);
      const agent = res.json().agent as Agent;
      expect(agent).toMatchObject({
        provider: "runner",
        program: "claude",
        handle: "maker",
        basePrompt: "테스트를 돌린다",
        dmAccess: "everyone",
        runner: { tokenId: id, label: "agent-ok", revoked: false },
        runnerAgent: { projectId: project.id, disallowedTools: ["WebFetch"] },
        sessionDefaults: { model: null, effort: null, permissionMode: null },
      });
      expect(agent.providerAgentId).toMatch(/^r-[0-9a-f]{10}$/);
      const listed = (await call(admin, "GET", `/runners/${id}/projects`)).json() as {
        projects: RunnerProject[];
      };
      expect(listed.projects.find((p) => p.id === project.id)?.agentCount).toBe(1);
      // 빼면 []
      const plain = await createRunnerAgent({ runnerProjectId: project.id, handle: "plain", name: "Plain" });
      expect((plain.json().agent as Agent).runnerAgent).toEqual({
        projectId: project.id,
        disallowedTools: [],
      });
    });

    it("천장 밖은 400 VALIDATION + 항목 이름 — 꺼진·없는 프로그램. 권한 모드·허용 도구는 만들 때 받지 않아 상한과 상관없다 [세션 설정 스펙 5.5]", async () => {
      const { id } = await runnerWith("agent-ceiling", {
        programs: [
          {
            ...FAKE_CLAUDE_PROGRAM,
            ceiling: { maxPermissionMode: "default", allowedToolsCeiling: ["Read", "Grep"] },
          },
          { ...FAKE_CODEX_PROGRAM, available: false, reason: "설치되지 않음" },
        ],
      });
      const project = await projectOf(id, "ceiling");
      const cases: Array<[string, object]> = [
        ["program", { program: "codex" }],
        ["program", { program: "opencode" }],
      ];
      for (const [field, extra] of cases) {
        const res = await createRunnerAgent({
          runnerProjectId: project.id,
          handle: `c${uuid().slice(-6)}`,
          name: "C",
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
        expect(res.json()).toMatchObject({ code: "VALIDATION", details: { field } });
      }
      const ok = await createRunnerAgent({
        runnerProjectId: project.id,
        handle: "within",
        name: "W",
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Bash"],
      });
      expect(ok.statusCode, ok.body).toBe(201);

      const tight = await runnerWith("agent-plan-only", {
        programs: [
          { ...FAKE_CLAUDE_PROGRAM, ceiling: { maxPermissionMode: "plan", allowedToolsCeiling: null } },
        ],
      });
      const tightProject = await projectOf(tight.id, "tight");
      const defaulted = await createRunnerAgent({
        runnerProjectId: tightProject.id,
        handle: "deflt",
        name: "D",
      });
      // 상한 plan 러너에도 만들어진다 — 권한 「기본」은 실행 때 min(default, 상한)(S5)
      expect(defaulted.statusCode, defaulted.body).toBe(201);
    });

    it("끊긴 러너 503, 보관한·없는 프로젝트는 러너를 묻기 전에 400(runnerProjectId), 긴 금지 도구 이름은 400", async () => {
      const { id, runner } = await runnerWith("agent-down");
      const project = await projectOf(id, "down");
      const archived = await projectOf(id, "archived");
      await call(admin, "POST", `/runner-projects/${archived.id}/archive`);
      for (const extra of [{ disallowedTools: ["x".repeat(201)] }]) {
        const res = await createRunnerAgent({
          runnerProjectId: project.id,
          handle: "bad1",
          name: "B",
          ...extra,
        });
        expect(res.statusCode, JSON.stringify(extra)).toBe(400);
      }
      runner.disconnect();
      await vi.waitFor(async () =>
        expect((await summaries()).find((r) => r.id === id)?.connected).toBe(false),
      );
      const down = await createRunnerAgent({ runnerProjectId: project.id, handle: "down1", name: "D" });
      expect(down.statusCode).toBe(503);
      for (const runnerProjectId of [archived.id, uuid()]) {
        const res = await createRunnerAgent({ runnerProjectId, handle: "down2", name: "D" });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: "VALIDATION", details: { field: "runnerProjectId" } });
      }
    });

    it("PATCH 러너 필드 — 새 세션 시작값은 붙은 러너의 상한 안이면 저장, 위면 400(permissionMode), 끊겨 있으면 대조를 건너뛴다, 옛 필드는 버린다, OpenClaw 에이전트면 400", async () => {
      const { id, runner } = await runnerWith("patch", {
        programs: [
          {
            ...FAKE_CLAUDE_PROGRAM,
            ceiling: { maxPermissionMode: "default", allowedToolsCeiling: ["Read"] },
          },
        ],
      });
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "patchy",
        runnerTokenId: id,
      });
      const patch = (body: object) => call(admin, "PATCH", `/agents/${agent.id}`, body);
      const saved = await patch({
        sessionDefaults: { model: "sonnet", effort: "high", permissionMode: "plan" },
        disallowedTools: ["Bash"],
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.json().agent as Agent).toMatchObject({
        runnerAgent: { disallowedTools: ["Bash"] },
        sessionDefaults: { model: "sonnet", effort: "high", permissionMode: "plan" },
      });
      // 보낸 필드만 — effort 는 그대로
      const partial = await patch({ sessionDefaults: { model: null } });
      expect((partial.json().agent as Agent).sessionDefaults).toEqual({
        model: null,
        effort: "high",
        permissionMode: "plan",
      });
      expect((await patch({ sessionDefaults: { permissionMode: "acceptEdits" } })).json()).toMatchObject({
        code: "VALIDATION",
        details: { field: "permissionMode" },
      });
      // 옛 클라이언트의 model·permissionMode·allowedTools — 버리고 200, 아무것도 바뀌지 않는다
      const legacy = await patch({ model: "opus", permissionMode: "acceptEdits", allowedTools: ["Write"] });
      expect(legacy.statusCode, legacy.body).toBe(200);
      expect((legacy.json().agent as Agent).sessionDefaults).toEqual({
        model: null,
        effort: "high",
        permissionMode: "plan",
      });
      // 이름만 바꾸는 것은 상한과 상관없다
      expect((await patch({ name: "새 이름" })).statusCode).toBe(200);
      runner.disconnect();
      await vi.waitFor(async () =>
        expect((await summaries()).find((r) => r.id === id)?.connected).toBe(false),
      );
      const offline = await patch({ sessionDefaults: { permissionMode: "acceptEdits" } });
      expect(offline.statusCode).toBe(200);
      expect((offline.json().agent as Agent).sessionDefaults?.permissionMode).toBe("acceptEdits");

      const oc = await call(admin, "POST", "/agents", {
        providerAgentId: "oc-patch",
        handle: "oc-patch",
        name: "oc",
        gatewayId: FAKE_GATEWAY_ID,
      });
      expect(oc.statusCode).toBe(201);
      const ocPatch = await call(admin, "PATCH", `/agents/${(oc.json().agent as Agent).id}`, {
        sessionDefaults: { model: "opus" },
      });
      expect(ocPatch.statusCode).toBe(400);
      expect(ocPatch.json()).toMatchObject({ code: "VALIDATION", details: { field: "sessionDefaults" } });
      expect((oc.json().agent as Agent).runnerAgent).toBeUndefined();
    });

    it("PATCH 는 프로그램·프로젝트를 받지 않는다 — 러너 에이전트면 400(field), 아무것도 바꾸지 않는다 [태스크 4 리뷰 L4]", async () => {
      const { id } = await runnerWith("patch-fixed");
      const other = await projectOf(id, "patch-fixed-other");
      const { agent, projectId } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "fixed",
        runnerTokenId: id,
      });
      for (const [field, body] of [
        ["program", { program: "codex" }],
        ["program", { name: "섞음", program: "claude" }],
        ["runnerProjectId", { runnerProjectId: other.id }],
        ["runnerProjectId", { runnerProjectId: null }],
      ] as const) {
        const res = await call(admin, "PATCH", `/agents/${agent.id}`, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
        expect(res.json()).toMatchObject({ code: "VALIDATION", details: { field } });
      }
      expect(app.db.select().from(agents).where(eq(agents.id, agent.id)).get()).toMatchObject({
        name: agent.name,
        program: "claude",
        runnerProjectId: projectId,
      });
    });

    it("PATCH 천장 대조는 프로그램 available 을 보지 않는다 — 러너가 그 프로그램을 못 쓴다고 알려도 상한 안의 고치기는 된다 [태스크 4 리뷰 T3]", async () => {
      const { id } = await runnerWith("patch-unavailable", {
        programs: [{ ...FAKE_CLAUDE_PROGRAM, available: false, reason: "로그인 필요" }],
      });
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "unavail",
        runnerTokenId: id,
        permissionMode: "acceptEdits",
      });
      const res = await call(admin, "PATCH", `/agents/${agent.id}`, {
        sessionDefaults: { permissionMode: "default" },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json().agent as Agent).sessionDefaults?.permissionMode).toBe("default");
    });

    it("러너 에이전트 정의(runnerAgent)는 admin 이상에게만 — GET /agents·GET /dms 에서 member 에게는 빠지고 나머지는 그대로 [태스크 4 리뷰 L2]", async () => {
      const { id } = await runnerWith("defs");
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "defs",
        runnerTokenId: id,
        permissionMode: "plan",
        disallowedTools: ["Bash"],
      });
      expect((await call(admin, "PATCH", `/agents/${agent.id}`, { dmAccess: "everyone" })).statusCode).toBe(
        200,
      );
      const listedBy = async (headers: Record<string, string>) => {
        const res = await call(headers, "GET", "/agents");
        expect(res.statusCode).toBe(200);
        return (res.json().agents as Agent[]).find((a) => a.id === agent.id);
      };
      const forMember = await listedBy(member);
      expect(forMember).toMatchObject({ provider: "runner", program: "claude", runner: { tokenId: id } });
      expect(forMember).not.toHaveProperty("runnerAgent");
      expect((await listedBy(admin))?.runnerAgent).toMatchObject({ disallowedTools: ["Bash"] });
      // 시작값은 모두에게 — 새 세션 창의 상태 줄이 이 값에서 출발한다(S11)
      expect((await listedBy(member))?.sessionDefaults?.permissionMode).toBe("plan");

      const dmAgentFor = async (headers: Record<string, string>) => {
        expect((await call(headers, "POST", "/dms", { agentId: agent.id })).statusCode).toBe(200);
        const res = await call(headers, "GET", "/dms");
        expect(res.statusCode).toBe(200);
        return (res.json().dms as Array<{ agent: Agent }>).find((d) => d.agent.id === agent.id)?.agent;
      };
      const dmForMember = await dmAgentFor(member);
      expect(dmForMember).toMatchObject({ id: agent.id, provider: "runner" });
      expect(dmForMember).not.toHaveProperty("runnerAgent");
      expect((await dmAgentFor(admin))?.runnerAgent).toMatchObject({ disallowedTools: ["Bash"] });
    });

    it("프로젝트 없는 옛 러너 에이전트(0031 이 보관)는 REST 로 되살릴 수 없다 — 400", async () => {
      const id = uuid();
      app.db
        .insert(agents)
        .values({
          id,
          workspaceId: app.workspaceId,
          provider: "runner",
          program: "claude",
          providerAgentId: "legacy-coder",
          handle: "legacy-coder",
          name: "Legacy",
          createdAt: new Date(),
          archivedAt: new Date(),
        })
        .run();
      const res = await call(admin, "POST", `/agents/${id}/restore`);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ code: "VALIDATION", details: { field: "runnerProjectId" } });
    });
  });

  describe("옮기기 POST /runner-projects/:id/move [PR8]", () => {
    it("옮길 러너가 끊겼으면 503, 그 러너의 project.check 가 실패하면 400 — 둘 다 아무것도 바꾸지 않는다", async () => {
      const from = await runnerWith("move-from-1");
      const to = await runnerWith("move-to-1");
      const project = await projectOf(from.id, "repo1");
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "mover1",
        runnerTokenId: from.id,
        relPath: "repo1",
      });
      to.runner.onProjectCheck = () => ({ ok: false, reason: "not_found" });
      const failed = await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      expect(failed.statusCode).toBe(400);
      expect(failed.json()).toMatchObject({ code: "VALIDATION", details: { reason: "not_found" } });
      expect(to.runner.fsRequests).toEqual([["project.check", { rootId: "src", relPath: "repo1" }]]);

      to.runner.disconnect();
      await vi.waitFor(async () =>
        expect((await summaries()).find((r) => r.id === to.id)?.connected).toBe(false),
      );
      const down = await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      expect(down.statusCode).toBe(503);

      const row = app.db.select().from(runnerProjects).where(eq(runnerProjects.id, project.id)).get();
      expect(row?.runnerTokenId).toBe(from.id);
      expect(app.db.select().from(agents).where(eq(agents.id, agent.id)).get()?.runnerTokenId).toBe(from.id);
      expect(
        (await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: uuid() })).statusCode,
      ).toBe(404);
      // 폐기한 대상은 끊김(503)이 아니라 409 — 다시 붙을 수 없다 [태스크 4 리뷰 T2]
      const revoked = await issue("move-revoked-1");
      await call(owner, "DELETE", `/setup/runner-tokens/${revoked.record.id}`);
      const toRevoked = await call(admin, "POST", `/runner-projects/${project.id}/move`, {
        runnerId: revoked.record.id,
      });
      expect(toRevoked.statusCode).toBe(409);
      expect(toRevoked.json().code).toBe("CONFLICT");
    });

    it("성공 — 프로젝트와 그 에이전트가 함께 옮겨 가고 그 에이전트들의 러너 세션 id 가 비고, 새 러너로 정의가 선다(옛 러너는 없다)", async () => {
      const from = await runnerWith("move-from-2");
      const to = await runnerWith("move-to-2");
      const project = await projectOf(from.id, "repo2");
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "mover2",
        runnerTokenId: from.id,
        relPath: "repo2",
      });
      const { agent: bystander } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "stay2",
        runnerTokenId: from.id,
        relPath: "other2",
      });
      const channel = (await call(owner, "POST", "/channels", { name: "move-2" })).json().channel as Channel;
      const conversationId = channelConversation(app.db, channel.id);
      for (const who of [agent, bystander]) {
        seedAgentSession(app.db, { conversationId, agentId: who.id });
        app.db
          .update(agentSessions)
          .set({ providerSessionId: uuid() })
          .where(eq(agentSessions.agentId, who.id))
          .run();
      }
      const changed: unknown[] = [];
      const off = app.bus.on("agents.changed", (p) => changed.push(p));
      const res = await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      off();
      expect(res.statusCode, res.body).toBe(200);
      expect(RunnerProject.parse(res.json().project)).toMatchObject({
        id: project.id,
        runnerId: to.id,
        agentCount: 1,
      });
      expect(changed).toEqual([{}]);
      expect(app.db.select().from(agents).where(eq(agents.id, agent.id)).get()?.runnerTokenId).toBe(to.id);
      const sessionOf = (agentId: string) =>
        app.db.select().from(agentSessions).where(eq(agentSessions.agentId, agentId)).get()
          ?.providerSessionId;
      expect(sessionOf(agent.id)).toBeNull();
      expect(sessionOf(bystander.id)).not.toBeNull();
      expect(
        runnerAgentDefinition(app.db, app.workspaceId, agent.providerAgentId, to.id)?.agent.project,
      ).toEqual({
        rootId: "src",
        relPath: "repo2",
      });
      expect(runnerAgentDefinition(app.db, app.workspaceId, agent.providerAgentId, from.id)).toBeNull();
      expect((await call(admin, "GET", `/runners/${from.id}/projects`)).json().projects).toEqual([
        expect.objectContaining({ relPath: "other2" }),
      ]);
      // 같은 러너로 옮기기는 그대로(러너에 묻지 않는다)
      const asked = to.runner.fsRequests.length;
      expect(
        (await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id })).statusCode,
      ).toBe(200);
      expect(to.runner.fsRequests).toHaveLength(asked);
    });

    it("옮길 러너에 같은 자리의 보관 안 된 프로젝트가 있으면 409", async () => {
      const from = await runnerWith("move-from-3");
      const to = await runnerWith("move-to-3");
      const project = await projectOf(from.id, "repo3");
      const taken = await projectOf(to.id, "repo3");
      const res = await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("CONFLICT");
      // 보관한 같은 자리 프로젝트는 막지 않는다 [태스크 4 리뷰 T4]
      expect((await call(admin, "POST", `/runner-projects/${taken.id}/archive`)).statusCode).toBe(200);
      const moved = await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      expect(moved.statusCode, moved.body).toBe(200);
      expect(RunnerProject.parse(moved.json().project).runnerId).toBe(to.id);
    });

    it("옮길 러너의 천장 밖 에이전트가 있으면 400(field runnerId·agentIds·item) — 러너에 묻지도 옮기지도 않는다, 낮추고 나면 옮겨진다(보관한 에이전트는 대조하지 않는다) [태스크 4 리뷰 L1]", async () => {
      const from = await runnerWith("move-from-4");
      const to = await runnerWith("move-to-4", {
        programs: [
          {
            ...FAKE_CLAUDE_PROGRAM,
            ceiling: { maxPermissionMode: "default", allowedToolsCeiling: ["Read"] },
          },
          { ...FAKE_CODEX_PROGRAM, available: false, reason: "설치되지 않음" },
        ],
      });
      const project = await projectOf(from.id, "repo4");
      const seed = (
        handle: string,
        extra: Omit<Parameters<typeof createRunnerAgentForTest>[1], "workspaceId" | "handle">,
      ) =>
        createRunnerAgentForTest(app.db, {
          workspaceId: app.workspaceId,
          handle,
          runnerTokenId: from.id,
          relPath: "repo4",
          ...extra,
        }).agent;
      const ok = seed("ceil-ok", {});
      const high = seed("ceil-mode", { permissionMode: "acceptEdits" });
      const tools = seed("ceil-tools", {});
      const codex = seed("ceil-codex", { program: "codex" });
      const archived = seed("ceil-archived", { permissionMode: "acceptEdits" });
      app.db.update(agents).set({ archivedAt: new Date() }).where(eq(agents.id, archived.id)).run();

      const move = () => call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      const refused = await move();
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        code: "VALIDATION",
        // 허용 도구는 저장하지 않아(세션 설정 스펙 S4) tools 는 걸리지 않는다
        details: { field: "runnerId", agentIds: [high.id, codex.id], item: "permissionMode" },
      });
      expect(to.runner.fsRequests).toEqual([]);
      expect(
        app.db.select().from(runnerProjects).where(eq(runnerProjects.id, project.id)).get()?.runnerTokenId,
      ).toBe(from.id);
      for (const agent of [ok, high, tools, codex, archived])
        expect(app.db.select().from(agents).where(eq(agents.id, agent.id)).get()?.runnerTokenId).toBe(
          from.id,
        );

      // 사람이 먼저 낮춘다 — 남은 것의 항목이 details.item
      expect(
        (await call(admin, "PATCH", `/agents/${high.id}`, { sessionDefaults: { permissionMode: "default" } }))
          .statusCode,
      ).toBe(200);
      expect((await move()).json()).toMatchObject({ details: { agentIds: [codex.id], item: "program" } });
      expect((await call(admin, "DELETE", `/agents/${codex.id}`)).statusCode).toBe(200);
      const moved = await move();
      expect(moved.statusCode, moved.body).toBe(200);
      for (const agent of [ok, high, tools, codex, archived])
        expect(app.db.select().from(agents).where(eq(agents.id, agent.id)).get()?.runnerTokenId).toBe(to.id);
    });

    it("보관한 에이전트도 함께 옮긴다 — 보관 → 옮기기 → 되살리기 뒤 새 러너로 정의가 선다 [태스크 4 리뷰 T1]", async () => {
      const from = await runnerWith("move-from-5");
      const to = await runnerWith("move-to-5");
      const project = await projectOf(from.id, "repo5");
      const { agent } = createRunnerAgentForTest(app.db, {
        workspaceId: app.workspaceId,
        handle: "sleeper5",
        runnerTokenId: from.id,
        relPath: "repo5",
      });
      expect((await call(admin, "DELETE", `/agents/${agent.id}`)).statusCode).toBe(200);
      const moved = await call(admin, "POST", `/runner-projects/${project.id}/move`, { runnerId: to.id });
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await call(admin, "POST", `/agents/${agent.id}/restore`)).statusCode).toBe(200);
      expect(runnerAgentDefinition(app.db, app.workspaceId, agent.providerAgentId, to.id)).not.toBeNull();
      expect(runnerAgentDefinition(app.db, app.workspaceId, agent.providerAgentId, from.id)).toBeNull();
    });
  });

  it("다시 발급 — 같은 행·같은 묶임에 새 원문(no-store), 옛 원문 소켓은 끊기고 다시 못 붙는다, 새 원문은 붙는다 [PR7]", async () => {
    const issued = await issue("reissue-me");
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: "reissued",
      runnerTokenId: issued.record.id,
    });
    const runner = await connect(issued.token);
    const setupEvents: unknown[] = [];
    const off = app.bus.on("setup.status", (p) => setupEvents.push(p));
    const res = await call(owner, "POST", `/setup/runner-tokens/${issued.record.id}/reissue`);
    off();
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const again = ReissueRunnerTokenResult.parse(res.json());
    expect(again.token).not.toBe(issued.token);
    expect(again.record).toMatchObject({ id: issued.record.id, label: "reissue-me", revokedAt: null });
    expect(again.record.prefix).toBe(again.token.slice(4, 10));
    expect(again.runnerConfig.tokenFile).toBe(RUNNER_TOKEN_FILE);
    expect(setupEvents.length).toBeGreaterThan(0);
    await vi.waitFor(() => expect(runner.connected).toBe(false));
    expect(runner.disconnectReasons).toContain("io server disconnect");
    expect(await tryRunner(app.url, issued.token)).toBe("UNAUTHORIZED");
    expect(await tryRunner(app.url, again.token)).toBe("connected");
    expect(app.db.select().from(agents).where(eq(agents.id, agent.id)).get()?.runnerTokenId).toBe(
      issued.record.id,
    );
    expect(lines.join("\n")).not.toContain(again.token.slice(4));

    expect((await call(owner, "POST", `/setup/runner-tokens/${uuid()}/reissue`)).statusCode).toBe(404);
    const gone = await issue("revoked-reissue");
    await call(owner, "DELETE", `/setup/runner-tokens/${gone.record.id}`);
    const revoked = await call(owner, "POST", `/setup/runner-tokens/${gone.record.id}/reissue`);
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().code).toBe("CONFLICT");

    // 붙은 러너가 없어도(끊김 알림이 없어도) 연결 페이지가 새 접두사를 받게 setup.status [태스크 4 리뷰 T6]
    const quiet = await issue("reissue-quiet");
    const quietEvents: unknown[] = [];
    const offQuiet = app.bus.on("setup.status", (p) => quietEvents.push(p));
    expect((await call(owner, "POST", `/setup/runner-tokens/${quiet.record.id}/reissue`)).statusCode).toBe(
      200,
    );
    offQuiet();
    expect(quietEvents.length).toBeGreaterThan(0);
  });
});

describe("다시 발급과 열린 런·보관한 프로젝트의 런 [Review Focus 5·스펙 8장]", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  const runners: FakeRunner[] = [];

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.close();
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function start(script: FakeRunnerScript) {
    live = await bootLiveApp();
    const issued = IssueRunnerTokenResult.parse(
      (await rest(live, "POST", "/setup/runner-tokens", { label: "macbook" })).body,
    );
    const runner = await startFakeRunner({ url: live.app.url, token: issued.token, script });
    runners.push(runner);
    const { agent: coder, projectId } = createRunnerAgentForTest(live.app.db, {
      workspaceId: live.app.workspaceId,
      handle: "coder",
      runnerTokenId: issued.record.id,
      relPath: "dodok",
    });
    const { channel } = (await rest<{ channel: Channel }>(live, "POST", "/channels", { name: "runner" }))
      .body;
    await rest(live, "POST", `/channels/${channel.id}/members`, { memberType: "agent", memberId: coder.id });
    const log = await openChannelWire(live, channel.id, sockets);
    return { issued, runner, coder, projectId, channel, log };
  }

  const runOf = (log: WireLog, agentId: string, n = 0) =>
    log.until(
      () =>
        log.states
          .filter((s) => s.agentId === agentId)
          .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i)[n],
      `에이전트 ${agentId} 런 ${n}`,
    );

  it("런이 도는 중에 다시 발급 — 옛 연결이 끊기고 열린 런은 ADAPTER_UNAVAILABLE + 「다시 실행」, 프로젝트·에이전트는 남고 새 토큰으로 붙은 러너에서 「다시 실행」이 돈다", async () => {
    let hold = true;
    const { issued, runner, coder, projectId, channel, log } = await start(async (run) => {
      if (hold) {
        run.text("하는 중");
        await run.aborted; // 끊길 때까지 — 끝내지 않는다
        return;
      }
      run.final("다시 했습니다");
    });
    await sendMessage(log.socket, channel.id, "@coder 오래 걸리는 일");
    const run = await runOf(log, coder.id);
    await vi.waitFor(() => expect(runner.runStarts).toHaveLength(1));

    const res = await rest<unknown>(live, "POST", `/setup/runner-tokens/${issued.record.id}/reissue`);
    expect(res.status).toBe(200);
    const again = ReissueRunnerTokenResult.parse(res.body);
    await vi.waitFor(() => expect(runner.connected).toBe(false));
    expect(await log.terminal(run.id)).toMatchObject({
      status: "error",
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
    const card = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_error" && m.systemMeta.runId === run.id),
      "다시 실행 카드",
    );
    expect(card.components?.blocks).toEqual([
      expect.objectContaining({ items: [expect.objectContaining({ id: "retry_run", label: "다시 실행" })] }),
    ]);
    expect(await tryRunner(live.app.url, issued.token)).toBe("UNAUTHORIZED");
    expect(
      live.app.db.select().from(runnerProjects).where(eq(runnerProjects.id, projectId)).get(),
    ).toMatchObject({
      runnerTokenId: issued.record.id,
      archivedAt: null,
    });
    expect(live.app.db.select().from(agents).where(eq(agents.id, coder.id)).get()).toMatchObject({
      runnerTokenId: issued.record.id,
      runnerProjectId: projectId,
      archivedAt: null,
    });

    hold = false;
    await runner.reconnect({ token: again.token });
    const componentId = card.components?.id;
    if (componentId === undefined) throw new Error("카드에 버튼이 없다");
    const pressed = (await log.socket.emitWithAck("component.interact", {
      messageId: card.id,
      componentId,
      itemId: "retry_run",
      values: {},
    })) as { ok: boolean };
    expect(pressed.ok).toBe(true);
    const retried = await runOf(log, coder.id, 1);
    expect((await log.terminal(retried.id)).status).toBe("done");
    expect(runner.runStarts).toHaveLength(2);
    expect(runner.runStarts[1]?.agent.project).toEqual({ rootId: "src", relPath: "dodok" });
  });

  it("보관한 프로젝트의 이미 있는 에이전트는 런이 돈다 — 보관은 목록 정리일 뿐(스펙 8장)", async () => {
    const { runner, coder, projectId, channel, log } = await start((run) => run.final("돌았습니다"));
    expect((await rest(live, "POST", `/runner-projects/${projectId}/archive`)).status).toBe(200);
    await sendMessage(log.socket, channel.id, "@coder 아직 돌아?");
    const run = await runOf(log, coder.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    expect(runner.runStarts[0]?.agent.project).toEqual({ rootId: "src", relPath: "dodok" });
  });
});
