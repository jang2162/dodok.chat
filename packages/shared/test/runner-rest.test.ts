import { describe, expect, it } from "vitest";
import {
  ArchiveRunnerProjectBody,
  CreateAgentBody,
  CreateWorktreeBody,
  CreateRunnerAgentBody,
  compareVersions,
  GatewaySetup,
  RunnerSummary,
  DiscoverAgentsQuery,
  findControlTool,
  RunnerFsQuery,
  RunnerProject,
  RunnerRunAgent,
  UpdateAgentBody,
} from "../src";

// 러너 일반화 계획 태스크 4 — 「러너」 탭·러너 에이전트 REST 본문. 정의 필드는 run.start.agent(RunnerRunAgent)와 같은 상한이고,
// 제어 도구는 러너 구성을 받지 않는다(스펙 6장)

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";

describe("러너 에이전트 본문", () => {
  const base = { provider: "runner", runnerProjectId: ID, program: "claude", handle: "coder", name: "Coder" };

  it("금지 도구는 RunnerRunAgent 와 같은 상한, 옛 모델·권한 모드·허용 도구는 버린다(400 아님) [세션 설정 스펙 5.5]", () => {
    expect(CreateRunnerAgentBody.parse(base)).toMatchObject({ enabled: true });
    for (const extra of [{ disallowedTools: [""] }, { program: "gpt" }]) {
      expect(CreateRunnerAgentBody.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
    }
    expect(RunnerRunAgent.shape.disallowedTools.safeParse([""]).success).toBe(false);
    const legacy = CreateRunnerAgentBody.parse({
      ...base,
      model: "opus",
      permissionMode: "bypassPermissions",
      allowedTools: ["Read"],
    });
    expect(legacy).not.toHaveProperty("model");
    expect(legacy).not.toHaveProperty("permissionMode");
    expect(legacy).not.toHaveProperty("allowedTools");
    expect(UpdateAgentBody.parse({ model: "opus", permissionMode: "acceptEdits" })).toEqual({});
  });

  it("UpdateAgentBody.sessionDefaults — 보낸 필드만, null 은 「기본」, bypassPermissions·모르는 effort 는 거절", () => {
    expect(UpdateAgentBody.parse({ sessionDefaults: { model: null, effort: "high" } })).toEqual({
      sessionDefaults: { model: null, effort: "high" },
    });
    expect(
      UpdateAgentBody.safeParse({ sessionDefaults: { permissionMode: "bypassPermissions" } }).success,
    ).toBe(false);
    expect(UpdateAgentBody.safeParse({ sessionDefaults: { effort: "extreme" } }).success).toBe(false);
  });

  it("POST /agents 는 OpenClaw·러너 합집합 — provider 없으면 OpenClaw", () => {
    expect(CreateAgentBody.parse({ providerAgentId: "dev", handle: "dev", name: "Dev" })).toMatchObject({
      provider: "openclaw",
    });
    expect(CreateAgentBody.parse(base)).toMatchObject({ provider: "runner", runnerProjectId: ID });
  });
});

describe("러너 봇 본문(러너 봇 스펙 B2·B3·B12)", () => {
  const def = { purpose: "리뷰 봇", watches: "PR", does: "읽는다", reports: "요약" };
  const bot = {
    provider: "runner",
    runnerTokenId: ID,
    program: "claude",
    handle: "rev",
    name: "Rev",
    bot: def,
  };

  it("러너 토큰 + 정의로 만든다 — 기본 지시는 버린다", () => {
    const parsed = CreateRunnerAgentBody.parse({ ...bot, basePrompt: "무시" });
    expect(parsed).toMatchObject({ runnerTokenId: ID, bot: def, enabled: true });
    expect(parsed).not.toHaveProperty("basePrompt");
    expect(CreateAgentBody.parse(bot)).toMatchObject({ provider: "runner", bot: def });
  });

  it("runnerProjectId 와 bot 을 함께 실으면 거절, 러너 토큰 없는 봇도 거절", () => {
    expect(CreateRunnerAgentBody.safeParse({ ...bot, runnerProjectId: ID }).success).toBe(false);
    const { runnerTokenId: _, ...noToken } = bot;
    expect(CreateRunnerAgentBody.safeParse(noToken).success).toBe(false);
  });

  it("정의 상한 — 목적 200, 나머지 2000(넘으면 거절)", () => {
    const at = {
      purpose: "가".repeat(200),
      watches: "a".repeat(2000),
      does: "a".repeat(2000),
      reports: "a".repeat(2000),
    };
    expect(CreateRunnerAgentBody.safeParse({ ...bot, bot: at }).success).toBe(true);
    for (const key of ["purpose", "watches", "does", "reports"] as const) {
      const over = { ...at, [key]: "a".repeat(key === "purpose" ? 201 : 2001) };
      expect(CreateRunnerAgentBody.safeParse({ ...bot, bot: over }).success, key).toBe(false);
      expect(UpdateAgentBody.safeParse({ bot: over }).success, key).toBe(false);
    }
  });

  it("정의 수정은 네 칸 통째로 — 빠진 칸은 거절", () => {
    expect(UpdateAgentBody.parse({ bot: def })).toEqual({ bot: def });
    expect(UpdateAgentBody.safeParse({ bot: { purpose: "x" } }).success).toBe(false);
  });
});

describe("둘러보기 쿼리", () => {
  it("relPath 를 빼면 루트 자신, 루트 밖 꼴은 거절", () => {
    expect(RunnerFsQuery.parse({ rootId: "src" })).toEqual({ rootId: "src", relPath: "" });
    for (const relPath of ["..", "a/../b", "/abs", "a//b", "a\\b"])
      expect(RunnerFsQuery.safeParse({ rootId: "src", relPath }).success, relPath).toBe(false);
    expect(RunnerFsQuery.safeParse({ rootId: "Src" }).success).toBe(false);
  });
});

describe("제어 도구는 러너 구성을 받지 않는다", () => {
  it("discover_agents·register_agent 는 OpenClaw 만, update_agent 입력에 러너 정의 필드가 없다(strict)", () => {
    expect(DiscoverAgentsQuery.safeParse({ provider: "runner" }).success).toBe(false);
    expect(findControlTool("discover_agents").input.safeParse({ provider: "runner" }).success).toBe(false);
    const register = findControlTool("register_agent").input;
    expect(
      register.safeParse({ provider: "runner", providerAgentId: "x", handle: "xx", name: "X" }).success,
    ).toBe(false);
    expect(
      register.safeParse({ runnerProjectId: ID, providerAgentId: "x", handle: "xx", name: "X" }).success,
    ).toBe(false);
    const update = findControlTool("update_agent").input;
    expect(update.safeParse({ agentId: ID, name: "새 이름" }).success).toBe(true);
    for (const key of ["model", "permissionMode", "allowedTools", "disallowedTools", "dmAccess", "enabled"])
      expect(update.safeParse({ agentId: ID, [key]: null }).success, key).toBe(false);
  });
});

describe("러너 워크트리 REST", () => {
  const project = {
    id: ID,
    runnerId: ID,
    rootId: "src",
    rootLabel: "src",
    relPath: "dodok/.worktrees/feat",
    label: "feat",
    agentCount: 0,
    archivedAt: null,
  };

  it("RunnerProject 에 parentProjectId·branch·isGit·cleanupIssue", () => {
    const wt = { ...project, parentProjectId: ID, branch: "dodok/feat", isGit: false, cleanupIssue: "dirty" };
    expect(RunnerProject.parse(wt)).toEqual(wt);
    const plain = { ...project, parentProjectId: null, branch: null, isGit: true, cleanupIssue: null };
    expect(RunnerProject.parse(plain)).toEqual(plain);
    expect(RunnerProject.safeParse(project).success).toBe(false);
  });

  it("CreateWorktreeBody — 이름 필수, 브랜치·위치 선택", () => {
    expect(CreateWorktreeBody.parse({ label: "feat" })).toEqual({ label: "feat" });
    const full = { label: "feat", branch: "dodok/x", location: { rootId: "src", relPath: "wt/feat" } };
    expect(CreateWorktreeBody.parse(full)).toEqual(full);
    expect(CreateWorktreeBody.safeParse({}).success).toBe(false);
    expect(
      CreateWorktreeBody.safeParse({ label: "x", location: { rootId: "src", relPath: "/abs" } }).success,
    ).toBe(false);
  });

  it("ArchiveRunnerProjectBody — keepFolder 는 true 만", () => {
    expect(ArchiveRunnerProjectBody.parse({})).toEqual({});
    expect(ArchiveRunnerProjectBody.parse({ keepFolder: true })).toEqual({ keepFolder: true });
    expect(ArchiveRunnerProjectBody.safeParse({ keepFolder: false }).success).toBe(false);
  });
});

describe("원격 업데이트 — 판 비교·상세 응답(원격 업데이트 스펙 U2·U9)", () => {
  it.each([
    ["0.9.0", "0.8.0", 1],
    ["0.8.0", "0.9.0", -1],
    ["0.10.0", "0.9.9", 1],
    ["1.0.0", "1.0.0", 0],
    ["1.0.0", "1.0.0-rc.1", 1],
    ["1.0.0-rc.2", "1.0.0-rc.10", -1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0-beta", "1.0.0-alpha", 1],
  ])("%s 대 %s", (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
  it("semver 가 아니면 NaN", () => {
    expect(compareVersions("dev", "0.9.0")).toBeNaN();
    expect(compareVersions("0.9.0", "latest")).toBeNaN();
  });
  it("러너 요약은 최신 판·원격 업데이트·진행을 싣는다(옛 서버는 싣지 않는다)", () => {
    const summary = {
      id: ID,
      label: "맥북",
      connected: true,
      revoked: false,
      runnerVersion: "0.8.0",
      browse: true,
      roots: [],
      programs: [],
      capabilities: ["remoteUpdate"],
      projectCount: 0,
    };
    expect(RunnerSummary.parse(summary)).toEqual(summary);
    const withUpdate = {
      ...summary,
      latestVersion: null,
      remoteUpdate: "off",
      update: { state: "failed", message: "npm 설치 실패", at: "2026-11-23T00:00:00.000Z" },
    };
    expect(RunnerSummary.parse(withUpdate)).toEqual(withUpdate);
    expect(RunnerSummary.safeParse({ ...summary, remoteUpdate: "maybe" }).success).toBe(false);
  });
  it("Gateway 상세의 플러그인은 원격 업데이트·마지막 결과를, Gateway 는 진행을 싣는다", () => {
    const at = "2026-11-23T00:00:00.000Z";
    const gateway = {
      id: ID,
      name: "사무실",
      url: "ws://x",
      enabled: true,
      approved: true,
      gateway: {
        state: "connected",
        host: "x",
        version: null,
        pinned: "2026.9.4",
        drift: false,
        pairing: null,
      },
      bridge: {
        state: "connected",
        plugin: {
          version: "0.0.0",
          sdkVersion: "2026.9.4",
          gatewayVersion: null,
          bundleSha256: null,
          tokenId: null,
          connectedAt: at,
          remoteUpdate: "on",
          lastUpdate: { ok: true, at },
        },
      },
      pluginMatches: false,
      update: { state: "updating", targetVersion: null, startedAt: at, deadline: at },
    };
    expect(GatewaySetup.parse(gateway)).toEqual(gateway);
  });
});
