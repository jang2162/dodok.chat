import { describe, expect, it } from "vitest";
import { InviteAgentBody, InvitedAgent, MAX_INVITED_AGENTS } from "../src";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;

describe("세션 에이전트 초대 계약 [세션 에이전트 초대 스펙 5.3·I8]", () => {
  it("초대는 세션 하나에 8까지", () => {
    expect(MAX_INVITED_AGENTS).toBe(8);
  });

  it("InvitedAgent — 초대한 사람은 지워졌으면 null", () => {
    const row = { agentId: ID(1), invitedBy: ID(2), invitedAt: "2026-11-13T00:00:00.000Z" };
    expect(InvitedAgent.parse(row)).toEqual(row);
    expect(InvitedAgent.parse({ ...row, invitedBy: null }).invitedBy).toBeNull();
    expect(InvitedAgent.safeParse({ ...row, invitedAt: "어제" }).success).toBe(false);
  });

  it("InviteAgentBody — agentId 는 uuid", () => {
    expect(InviteAgentBody.parse({ agentId: ID(3) })).toEqual({ agentId: ID(3) });
    expect(InviteAgentBody.safeParse({ agentId: "dev" }).success).toBe(false);
    expect(InviteAgentBody.safeParse({}).success).toBe(false);
  });
});
