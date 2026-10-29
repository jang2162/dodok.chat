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

  it("정의 필드는 RunnerRunAgent 와 같은 상한 — bypassPermissions·129자 모델·101개 도구는 거절", () => {
    expect(CreateRunnerAgentBody.parse(base)).toMatchObject({ enabled: true });
    for (const extra of [
      { permissionMode: "bypassPermissions" },
      { model: "m".repeat(129) },
      { allowedTools: Array.from({ length: 101 }, (_, i) => `T${i}`) },
      { disallowedTools: [""] },
      { program: "gpt" },
    ]) {
      expect(CreateRunnerAgentBody.safeParse({ ...base, ...extra }).success, JSON.stringify(extra)).toBe(
        false,
      );
      const [field] = Object.keys(extra);
      if (field !== "program")
        expect(
          RunnerRunAgent.shape[field as keyof typeof RunnerRunAgent.shape].safeParse(Object.values(extra)[0])
            .success,
        ).toBe(false);
    }
    expect(UpdateAgentBody.safeParse({ permissionMode: "bypassPermissions" }).success).toBe(false);
    expect(UpdateAgentBody.parse({ model: null, allowedTools: null })).toEqual({
      model: null,
      allowedTools: null,
    });
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
