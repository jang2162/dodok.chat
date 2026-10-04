import { Agent } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { createAgent, getAgent, listAgents, updateAgent } from "../src/modules/agents/service";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { seedWorkspace } from "./helpers/seed";

/** 워크스페이스 하나와 그 Gateway 하나 — OpenClaw 에이전트는 Gateway 에 묶여 등록된다 */
function setup() {
  const db = newTestDb();
  const { workspaceId } = seedWorkspace(db);
  const gatewayId = insertGateway(db, workspaceId, { id: uuid(), name: "사무실" }).id;
  return { db, workspaceId, gatewayId };
}

describe("agents service", () => {
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
