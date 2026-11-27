import { describe, expect, it } from "vitest";
import { Agent, AGENT_RUN_TIMEOUT_MINUTES_MAX, findControlTool, UpdateAgentBody } from "../src";

// 에이전트별 런 상한 — 기본은 상한 없음(null), 값은 분 단위 정수 1~1440

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const agent = {
  id: ID,
  workspaceId: ID,
  provider: "openclaw",
  providerAgentId: "dev",
  handle: "dev",
  name: "Dev",
  enabled: true,
  createdAt: "2026-11-27T00:00:00.000Z",
  archivedAt: null,
};

describe("Agent.runTimeoutMinutes", () => {
  it("없으면 null(상한 없음)", () => {
    expect(Agent.parse(agent).runTimeoutMinutes).toBeNull();
    expect(Agent.parse({ ...agent, runTimeoutMinutes: 90 }).runTimeoutMinutes).toBe(90);
  });

  it("UpdateAgentBody — 1~1440 정수와 null(지움)만 받는다", () => {
    expect(AGENT_RUN_TIMEOUT_MINUTES_MAX).toBe(1440);
    expect(UpdateAgentBody.parse({ runTimeoutMinutes: 1 })).toEqual({ runTimeoutMinutes: 1 });
    expect(UpdateAgentBody.parse({ runTimeoutMinutes: 1440 })).toEqual({ runTimeoutMinutes: 1440 });
    expect(UpdateAgentBody.parse({ runTimeoutMinutes: null })).toEqual({ runTimeoutMinutes: null });
    expect(UpdateAgentBody.parse({})).toEqual({});
    for (const bad of [0, -1, 1441, 1.5, "30"]) {
      expect(UpdateAgentBody.safeParse({ runTimeoutMinutes: bad }).success, String(bad)).toBe(false);
    }
  });

  it("제어 도구 update_agent 도 받는다", () => {
    const tool = findControlTool("update_agent");
    expect(tool?.input.parse({ agentId: ID, runTimeoutMinutes: 60 })).toMatchObject({
      runTimeoutMinutes: 60,
    });
    expect(tool?.input.parse({ agentId: ID, runTimeoutMinutes: null })).toMatchObject({
      runTimeoutMinutes: null,
    });
    expect(tool?.input.safeParse({ agentId: ID, runTimeoutMinutes: 0 }).success).toBe(false);
  });
});
