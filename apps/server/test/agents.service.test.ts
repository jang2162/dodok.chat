import { Agent } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { agents } from "../src/db/schema.sqlite";
import { agentForRole, createAgent, getAgent, listAgents, updateAgent } from "../src/modules/agents/service";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { createRunnerAgentForTest, seedWorkspace } from "./helpers/seed";

/** 워크스페이스 하나와 그 Gateway 하나 — OpenClaw 에이전트는 Gateway 에 묶여 등록된다 */
function setup() {
  const db = newTestDb();
  const { workspaceId } = seedWorkspace(db);
  const gatewayId = insertGateway(db, workspaceId, { id: uuid(), name: "사무실" }).id;
  return { db, workspaceId, gatewayId };
}

describe("agents service", () => {
  it("createAgent 는 만든 사람(createdBy)을 남기고, 주지 않으면 null(기록 없음)", () => {
    const { db, workspaceId, gatewayId } = setup();
    const ownerId = seedWorkspace(db, { userHandle: "boss" }).userId;
    const made = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId,
      createdBy: ownerId,
    });
    expect(made.createdBy).toBe(ownerId);
    expect(getAgent(db, made.id)?.createdBy).toBe(ownerId);
    const legacy = createAgent(db, {
      workspaceId,
      providerAgentId: "fin",
      handle: "fin",
      name: "Fin",
      gatewayId,
    });
    expect(legacy.createdBy).toBeNull();
    // OpenClaw 에이전트에는 새 세션 시작값이 없다(러너만 — 세션 설정 스펙 S1)
    expect(made.sessionDefaults).toBeUndefined();
  });

  it("러너 에이전트의 새 세션 시작값은 member 에게도 실리고 정의(runnerAgent)는 admin 이상에게만 [세션 설정 스펙 S10·S11]", () => {
    const { db, workspaceId } = setup();
    const { agent } = createRunnerAgentForTest(db, {
      workspaceId,
      handle: "coder",
      model: "claude-sonnet-5-5",
    });
    const forMember = agentForRole(agent, "member");
    expect(forMember.sessionDefaults).toEqual({
      model: "claude-sonnet-5-5",
      effort: null,
      permissionMode: null,
    });
    expect(forMember.runnerAgent).toBeUndefined();
    expect(agentForRole(agent, "admin").runnerAgent).toBeDefined();
    const plain = createRunnerAgentForTest(db, { workspaceId, handle: "plain" }).agent;
    expect(agentForRole(plain, "member").sessionDefaults).toEqual({
      model: null,
      effort: null,
      permissionMode: null,
    });
  });

  it("기본 프롬프트(basePrompt)는 admin 이상에게만 — member 에게는 OpenClaw·러너 에이전트 모두 키가 없다", () => {
    const { db, workspaceId, gatewayId } = setup();
    const oc = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId,
      basePrompt: "SECRET-PROMPT",
    });
    expect(agentForRole(oc, "member")).not.toHaveProperty("basePrompt");
    expect(agentForRole(oc, undefined)).not.toHaveProperty("basePrompt");
    expect(agentForRole(oc, "admin").basePrompt).toBe("SECRET-PROMPT");
    const runner = createRunnerAgentForTest(db, { workspaceId, handle: "coder" }).agent;
    const withPrompt = updateAgent(db, runner.id, { basePrompt: "지시" });
    expect(agentForRole(withPrompt, "member")).not.toHaveProperty("basePrompt");
    expect(agentForRole(withPrompt, "owner").basePrompt).toBe("지시");
  });

  it("계약(AvatarUrl)에 안 맞는 옛 아바타 주소(http·data·공백)는 읽기를 깨지 않고 avatarUrl 없이 실린다", () => {
    const { db, workspaceId, gatewayId } = setup();
    const made = [
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "https://example.com/a b.png",
    ].map((url, i) => {
      const agent = createAgent(db, {
        workspaceId,
        providerAgentId: `old${i}`,
        handle: `old${i}`,
        name: `Old${i}`,
        gatewayId,
      });
      // 옛 z.url() 이 받던 값 — 지금 쓰기 길은 거절하므로 행에 바로 넣는다
      db.update(agents).set({ avatarUrl: url }).where(eq(agents.id, agent.id)).run();
      return agent.id;
    });
    const good = createAgent(db, {
      workspaceId,
      providerAgentId: "good",
      handle: "good",
      name: "Good",
      gatewayId,
      avatarUrl: "https://example.com/good.png",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const listed = listAgents(db, workspaceId);
      for (const id of made) {
        expect(listed.find((a) => a.id === id)).not.toHaveProperty("avatarUrl");
        expect(getAgent(db, id)).not.toHaveProperty("avatarUrl");
      }
      expect(listed.find((a) => a.id === good.id)?.avatarUrl).toBe("https://example.com/good.png");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("createAgent 는 provider openclaw·enabled true 로 만들고 워크스페이스별로 나열한다", () => {
    const { db, workspaceId, gatewayId } = setup();
    const agent = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId,
    });
    expect(Agent.parse(agent)).toEqual(agent);
    expect(agent).toMatchObject({ workspaceId, provider: "openclaw", providerAgentId: "dev", enabled: true });
    expect(agent.basePrompt).toBeUndefined();
    // REST 응답에만 Gateway 요약이 붙는다
    expect(agent.gateway).toEqual({ id: gatewayId, name: "사무실" });
    const { gateway: _gateway, ...plain } = agent;
    expect(getAgent(db, agent.id)).toEqual(plain);
    expect(getAgent(db, agent.id, workspaceId)).toEqual(plain);
    expect(listAgents(db, workspaceId)).toEqual([agent]);

    const other = seedWorkspace(db, { userHandle: "other" });
    expect(listAgents(db, other.workspaceId)).toEqual([]);
    expect(getAgent(db, agent.id, other.workspaceId)).toBeUndefined();
  });

  it("같은 워크스페이스에서 handle 이, 같은 Gateway 에서 providerAgentId 가 겹치면 CONFLICT", () => {
    const { db, workspaceId, gatewayId } = setup();
    createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev", gatewayId });
    expect(() =>
      createAgent(db, { workspaceId, providerAgentId: "dev2", handle: "dev", name: "x", gatewayId }),
    ).toThrow(expect.objectContaining({ status: 409, body: expect.objectContaining({ code: "CONFLICT" }) }));
    expect(() =>
      createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev2", name: "x", gatewayId }),
    ).toThrow(expect.objectContaining({ status: 409 }));
    // 다른 워크스페이스는 겹쳐도 된다
    const other = seedWorkspace(db, { userHandle: "other" });
    expect(
      createAgent(db, { workspaceId: other.workspaceId, providerAgentId: "dev", handle: "dev", name: "x" }),
    ).toMatchObject({ handle: "dev" });
  });

  it("updateAgent 는 필드를 바꾸고, handle 충돌은 CONFLICT, 없는 id 는 NOT_FOUND", () => {
    const { db, workspaceId, gatewayId } = setup();
    const dev = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      basePrompt: "p",
      gatewayId,
    });
    createAgent(db, { workspaceId, providerAgentId: "fin", handle: "fin", name: "Fin", gatewayId });

    const updated = updateAgent(db, dev.id, { name: "Developer", enabled: false, basePrompt: null });
    expect(updated).toMatchObject({ id: dev.id, name: "Developer", enabled: false, handle: "dev" });
    expect(updated.basePrompt).toBeUndefined();
    expect(updated.gateway).toEqual({ id: gatewayId, name: "사무실" });
    const { gateway: _gateway, ...plain } = updated;
    expect(getAgent(db, dev.id)).toEqual(plain);

    // 자기 handle 로 다시 저장하는 건 충돌이 아니다
    expect(updateAgent(db, dev.id, { handle: "dev" }).handle).toBe("dev");
    expect(() => updateAgent(db, dev.id, { handle: "fin" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => updateAgent(db, uuid(), { name: "x" })).toThrow(expect.objectContaining({ status: 404 }));
  });
});
