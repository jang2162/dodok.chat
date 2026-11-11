import { describe, expect, it } from "vitest";
import {
  AgentSettingsPatch,
  AgentCeiling,
  ConversationAgentSettings,
  MessageSend,
  RunnerEffort,
  SessionDefaults,
} from "../src";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;

describe("RunnerEffort", () => {
  it("다섯 값만 받는다", () => {
    expect(RunnerEffort.options).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(RunnerEffort.safeParse("extreme").success).toBe(false);
  });
});

describe("AgentSettingsPatch", () => {
  it("빈 객체는 거절한다 — 하나 이상", () => {
    expect(AgentSettingsPatch.safeParse({}).success).toBe(false);
  });

  it("null 은 「기본」으로 받는다", () => {
    expect(AgentSettingsPatch.parse({ permissionMode: null })).toEqual({ permissionMode: null });
    expect(AgentSettingsPatch.parse({ model: "opus", effort: null })).toEqual({
      model: "opus",
      effort: null,
    });
  });

  it("bypassPermissions·모르는 effort 는 거절한다", () => {
    expect(AgentSettingsPatch.safeParse({ permissionMode: "bypassPermissions" }).success).toBe(false);
    expect(AgentSettingsPatch.safeParse({ effort: "extreme" }).success).toBe(false);
    expect(AgentSettingsPatch.safeParse({ model: "" }).success).toBe(false);
  });
});

describe("ConversationAgentSettings·SessionDefaults", () => {
  it("모두 null 인 행을 받는다", () => {
    const row = {
      agentId: ID(1),
      model: null,
      effort: null,
      permissionMode: null,
      contextPercent: null,
      ceiling: null,
    };
    expect(ConversationAgentSettings.parse(row)).toEqual(row);
    expect(SessionDefaults.parse({ model: null, effort: null, permissionMode: null })).toEqual({
      model: null,
      effort: null,
      permissionMode: null,
    });
  });

  it("contextPercent 는 0~100 정수", () => {
    const row = {
      agentId: ID(1),
      model: "opus",
      effort: "high",
      permissionMode: "plan",
      contextPercent: 42,
      ceiling: "default",
    };
    expect(ConversationAgentSettings.parse(row)).toEqual(row);
    expect(ConversationAgentSettings.safeParse({ ...row, contextPercent: 101 }).success).toBe(false);
    expect(ConversationAgentSettings.safeParse({ ...row, contextPercent: 4.2 }).success).toBe(false);
  });

  it("ceiling 은 권한 모드나 null — 빠지면 거절, AgentCeiling 도 같다", () => {
    const row = { agentId: ID(1), model: null, effort: null, permissionMode: null, contextPercent: null };
    expect(ConversationAgentSettings.safeParse(row).success).toBe(false);
    expect(ConversationAgentSettings.safeParse({ ...row, ceiling: "root" }).success).toBe(false);
    expect(AgentCeiling.parse({ agentId: ID(1), ceiling: null })).toEqual({ agentId: ID(1), ceiling: null });
    expect(AgentCeiling.safeParse({ agentId: ID(1), ceiling: "root" }).success).toBe(false);
  });
});

describe("MessageSend.agentSettings", () => {
  const base = { channelId: ID(1), clientMsgId: "c1", bodyMd: "안녕" };

  it("newConversation 과 함께면 받는다", () => {
    const v = MessageSend.parse({
      ...base,
      newConversation: {},
      agentSettings: [{ agentId: ID(2), permissionMode: "plan" }],
    });
    expect(v.agentSettings).toEqual([{ agentId: ID(2), permissionMode: "plan" }]);
  });

  it("conversationId 와 함께면 거절한다 — 새 세션의 첫 글만", () => {
    expect(
      MessageSend.safeParse({
        ...base,
        conversationId: ID(3),
        agentSettings: [{ agentId: ID(2), model: "opus" }],
      }).success,
    ).toBe(false);
  });

  it("같은 agentId 둘은 거절한다", () => {
    expect(
      MessageSend.safeParse({
        ...base,
        newConversation: {},
        agentSettings: [
          { agentId: ID(2), model: "opus" },
          { agentId: ID(2), effort: "high" },
        ],
      }).success,
    ).toBe(false);
  });

  it("항목마다 바꿀 값이 하나는 있어야 한다", () => {
    expect(
      MessageSend.safeParse({ ...base, newConversation: {}, agentSettings: [{ agentId: ID(2) }] }).success,
    ).toBe(false);
  });
});
