import { describe, expect, it } from "vitest";
import {
  CreateAgentBody,
  CreateRunnerAgentBody,
  DiscoverAgentsQuery,
  findControlTool,
  RunnerFsQuery,
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
