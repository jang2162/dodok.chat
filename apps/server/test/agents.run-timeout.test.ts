import type { Agent } from "@dodok/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { HANDLERS, type HandlerContext } from "../src/modules/control/handlers";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { createRunnerAgentForTest } from "./helpers/seed";

// 에이전트별 런 상한(분) — 기본은 없음(null). REST PATCH 와 제어 도구 update_agent 로 바꾼다

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const app = await bootTestApp();
  apps.push(app);
  const { headers } = await login(app);
  const patch = (id: string, payload: object) =>
    app.fastify.inject({ method: "PATCH", url: `/api/v1/agents/${id}`, headers, payload });
  return { app, patch };
}

describe("에이전트 런 상한", () => {
  it("새 에이전트는 상한이 없고(null), REST PATCH 로 분을 주고 null 로 지운다", async () => {
    const { app, patch } = await setup();
    const dev = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "dev",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(dev.runTimeoutMinutes).toBeNull();

    const set = await patch(dev.id, { runTimeoutMinutes: 180 });
    expect(set.statusCode).toBe(200);
    expect((set.json() as { agent: Agent }).agent.runTimeoutMinutes).toBe(180);

    const cleared = await patch(dev.id, { runTimeoutMinutes: null });
    expect((cleared.json() as { agent: Agent }).agent.runTimeoutMinutes).toBeNull();

    expect((await patch(dev.id, { runTimeoutMinutes: 0 })).statusCode).toBe(400);
    expect((await patch(dev.id, { runTimeoutMinutes: 1441 })).statusCode).toBe(400);
  });

  it("러너 에이전트도 REST 로 바꾼다", async () => {
    const { app, patch } = await setup();
    const { agent: coder } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: "coder",
    });
    const res = await patch(coder.id, { runTimeoutMinutes: 30 });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { agent: Agent }).agent.runTimeoutMinutes).toBe(30);
  });

  it("제어 도구 update_agent — 러너 에이전트도 상한을 바꾸고, 확인 카드 요약에 싣는다", async () => {
    const { app } = await setup();
    const { agent: coder } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: "coder",
    });
    const ctx = { db: app.db, workspaceId: app.workspaceId } as HandlerContext;
    expect(() =>
      HANDLERS.update_agent.check?.(ctx, { agentId: coder.id, runTimeoutMinutes: 60 }),
    ).not.toThrow();
    expect(HANDLERS.update_agent.summary?.(ctx, { agentId: coder.id, runTimeoutMinutes: 60 })).toBe(
      "런 상한: 60분",
    );
    expect(HANDLERS.update_agent.summary?.(ctx, { agentId: coder.id, runTimeoutMinutes: null })).toBe(
      "런 상한: 없음",
    );
  });
});
