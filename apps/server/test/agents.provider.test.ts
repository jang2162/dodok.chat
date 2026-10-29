import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { Agent } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { agents } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { bootTestApp, login } from "./helpers/app";
import { newTestDb } from "./helpers/db";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";
import { createRunnerAgentForTest, seedWorkspace } from "./helpers/seed";

// 러너 스펙 2장·판정 P9 — 에이전트 제공자는 openclaw·runner. providerAgentId 는 같은 제공자·같은 연결 안에서만 유일하다 — 서버가
// 런·정본·승인을 「연결 id + 세션 키」로 가르므로 제공자를 가로지른 같은 id 는 섞이지 않는다(멀티 Gateway 스펙 「바뀌는 표」 절).
// 러너 에이전트의 id 는 서버가 짓는다(러너 일반화 계획 판정 PR4)

const conflictOn = (field: string) =>
  expect.objectContaining({
    status: 409,
    body: expect.objectContaining({ code: "CONFLICT", details: { field } }),
  });

describe("createAgent — providerAgentId 는 같은 제공자 안에서 유일하다", () => {
  /** 워크스페이스 하나와 그 Gateway 하나 — OpenClaw 에이전트의 id 는 같은 Gateway 안에서 유일하다 */
  const setup = () => {
    const db = newTestDb();
    const workspaceId = seedWorkspace(db).workspaceId;
    return { db, workspaceId, gatewayId: insertGateway(db, workspaceId, { id: uuid() }).id };
  };

  it("러너 에이전트의 id 는 서버가 짓는다 — r- + 소문자 hex 10, 에이전트마다 다르고 세션 키 규칙 안", () => {
    const { db, workspaceId } = setup();
    const a = createRunnerAgentForTest(db, { workspaceId, handle: "aa" }).agent;
    const b = createRunnerAgentForTest(db, { workspaceId, handle: "bb" }).agent;
    expect(a.providerAgentId).toMatch(/^r-[0-9a-f]{10}$/);
    expect(b.providerAgentId).toMatch(/^r-[0-9a-f]{10}$/);
    expect(a.providerAgentId).not.toBe(b.providerAgentId);
    expect(a).toMatchObject({ provider: "runner", program: "claude" });
  });

  it("같은 Gateway 의 같은 OpenClaw id 는 409(providerAgentId)", () => {
    const { db, workspaceId, gatewayId } = setup();
    createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev", gatewayId });
    expect(() =>
      createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev2", name: "x", gatewayId }),
    ).toThrow(conflictOn("providerAgentId"));
  });

  it("대소문자만 다른 옛 행(Dev)도 같은 id 로 본다 — 세션 키는 소문자로 접힌다", () => {
    const { db, workspaceId, gatewayId } = setup();
    db.insert(agents)
      .values({
        id: uuid(),
        workspaceId,
        provider: "openclaw",
        providerAgentId: "Dev",
        handle: "legacy",
        name: "Legacy",
        createdAt: new Date(),
        gatewayId,
      })
      .run();
    expect(() =>
      createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "x", gatewayId }),
    ).toThrow(conflictOn("providerAgentId"));
  });

  it("다른 워크스페이스의 같은 id 는 막지 않는다", () => {
    const { db, workspaceId } = setup();
    createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev" });
    const other = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    expect(
      createAgent(db, { workspaceId: other, providerAgentId: "dev", handle: "dev", name: "x" }),
    ).toMatchObject({ provider: "openclaw", providerAgentId: "dev" });
  });
});

describe("REST — 러너 에이전트 등록과 discover?provider [P9]", () => {
  let app: App;
  let runner: FakeAdapter<"runner">;
  let headers: { authorization: string };

  beforeAll(async () => {
    runner = new FakeAdapter({ provider: "runner" });
    app = await bootTestApp({}, { adapters: [new FakeAdapter(), runner] });
    headers = (await login(app)).headers;
  });
  afterAll(async () => {
    await app.close();
  });

  const api = (method: "GET" | "POST", url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });

  it("러너 에이전트를 id 로 가져오는 등록은 400(러너 프로젝트에서 만든다), 빠지면 openclaw, 모르는 provider 는 400", async () => {
    const coder = await api("POST", "/agents", {
      provider: "runner",
      providerAgentId: "coder",
      handle: "coder",
      name: "Coder",
    });
    expect(coder.statusCode).toBe(400);
    expect(coder.json()).toMatchObject({ code: "VALIDATION", details: { field: "provider" } });

    const dev = await api("POST", "/agents", {
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(dev.statusCode).toBe(201);
    expect(dev.json().agent.provider).toBe("openclaw");
    expect(Agent.parse(dev.json().agent).program).toBeNull();

    const codex = await api("POST", "/agents", {
      provider: "codex",
      providerAgentId: "cx",
      handle: "cx",
      name: "Cx",
    });
    expect(codex.statusCode).toBe(400);
    // 옛 제공자 이름(claude)은 runner 로 바뀌었다 — 받지 않는다
    const old = await api("POST", "/agents", {
      provider: "claude",
      providerAgentId: "old",
      handle: "old",
      name: "Old",
    });
    expect(old.statusCode).toBe(400);
    expect(codex.json().code).toBe("VALIDATION");
  });

  it("REST 로도 같은 Gateway 의 같은 id 는 409(providerAgentId)", async () => {
    await api("POST", "/agents", {
      providerAgentId: "shared",
      handle: "shared",
      name: "S",
      gatewayId: FAKE_GATEWAY_ID,
    });
    const again = await api("POST", "/agents", {
      providerAgentId: "shared",
      handle: "shared3",
      name: "S3",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "CONFLICT", details: { field: "providerAgentId" } });
  });

  it("discover?provider=runner 는 러너 어댑터의 listAgents, 빠지면 openclaw(그 Gateway), 모르는 값은 400", async () => {
    const listed = [{ providerAgentId: "coder", name: "Coder", hint: "macbook · repo · sonnet" }];
    vi.spyOn(runner, "listAgents").mockResolvedValue(listed);

    const fromRunner = await api("GET", "/agents/discover?provider=runner");
    expect(fromRunner.statusCode).toBe(200);
    expect(fromRunner.json()).toEqual({ agents: listed });

    const fromOpenclaw = await api("GET", `/agents/discover?gatewayId=${FAKE_GATEWAY_ID}`);
    expect(fromOpenclaw.statusCode).toBe(200);
    expect(fromOpenclaw.json().agents.map((a: { providerAgentId: string }) => a.providerAgentId)).toEqual([
      "dev",
      "fin",
    ]);
    expect(
      (await api("GET", `/agents/discover?provider=openclaw&gatewayId=${FAKE_GATEWAY_ID}`)).json(),
    ).toEqual(fromOpenclaw.json());

    const bogus = await api("GET", "/agents/discover?provider=codex");
    expect(bogus.statusCode).toBe(400);
  });
});

describe("REST — 러너 어댑터가 없으면 discover?provider=runner 는 503", () => {
  it("ADAPTER_UNAVAILABLE", async () => {
    const app = await bootTestApp({}, { adapters: [new FakeAdapter()] });
    try {
      const { headers } = await login(app);
      const res = await app.fastify.inject({
        method: "GET",
        url: "/api/v1/agents/discover?provider=runner",
        headers,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("ADAPTER_UNAVAILABLE");
    } finally {
      await app.close();
    }
  });
});
