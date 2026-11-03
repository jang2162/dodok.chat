/**
 * OpenClaw 에이전트를 Gateway 별로 찾고·등록하고·옮긴다(멀티 Gateway 스펙 「에이전트 API」·「오류 처리」 절, Review Focus 4). 같은 id(`main`)도 Gateway 가
 * 다르면 둘 다 등록되고, 지운 Gateway 의 에이전트는 남아 다른 Gateway 로 옮긴 뒤 「다시 실행」이 통한다.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { Agent, ConnectionId } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasGateways } from "../src/adapters/types";
import type { App } from "../src/app";
import { workspaces } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, runErrorMessages } from "../src/modules/messages/service";
import { RETRY_RUN_ITEM } from "../src/modules/router/service";
import { getRun } from "../src/modules/runs/store";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";
import { channelConversation, createRunnerAgentForTest } from "./helpers/seed";

const HOME_ID = "00000000-0000-4000-8000-0000000000b2";

/** Gateway 마다 다른 agents.list 를 내는 FakeAdapter */
class PerGatewayAdapter extends FakeAdapter {
  override async listAgents(connectionId: ConnectionId | null) {
    await super.listAgents(connectionId);
    return connectionId === HOME_ID
      ? [{ providerAgentId: "main", name: "집 main" }]
      : [{ providerAgentId: "main", name: "사무실 main" }, { providerAgentId: "fin" }];
  }
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** 사무실(FAKE_GATEWAY_ID, 기본 Gateway)·집 두 Gateway 의 앱 + owner 세션 */
async function setup() {
  const adapter = new PerGatewayAdapter();
  const app = await bootTestApp({}, { adapters: [adapter] });
  apps.push(app);
  const home = insertGateway(app.db, app.workspaceId, { id: HOME_ID, name: "집" });
  const openclaw = app.registry.forProvider("openclaw");
  if (openclaw && hasGateways(openclaw)) openclaw.upsertGateway(home);
  const { headers } = await login(app);
  const inject = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: object, h = headers) =>
    app.fastify.inject({ method, url, headers: h, ...(payload === undefined ? {} : { payload }) });
  const register = (body: object) => inject("POST", "/api/v1/agents", body);
  return { app, adapter, home, inject, register, headers };
}

describe("에이전트 등록 — Gateway 별", () => {
  it("두 Gateway 에 main 을 핸들 main-office·main-home 으로 등록하고, 응답·목록에 Gateway 요약이 실린다", async () => {
    const { register, inject } = await setup();
    const office = await register({
      providerAgentId: "main",
      handle: "main-office",
      name: "main",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(office.statusCode).toBe(201);
    expect(office.json().agent.gateway).toEqual({ id: FAKE_GATEWAY_ID, name: "가짜 Gateway" });
    const home = await register({
      providerAgentId: "main",
      handle: "main-home",
      name: "main",
      gatewayId: HOME_ID,
    });
    expect(home.statusCode).toBe(201);
    expect(home.json().agent.gateway).toEqual({ id: HOME_ID, name: "집" });

    const list = (await inject("GET", "/api/v1/agents")).json().agents as Agent[];
    expect(list.map((a) => [a.handle, a.gateway?.name])).toEqual([
      ["main-office", "가짜 Gateway"],
      ["main-home", "집"],
    ]);
  });

  it("같은 Gateway 에 같은 id(대소문자 무시)는 409, 핸들 겹침도 409", async () => {
    const { register } = await setup();
    await register({
      providerAgentId: "main",
      handle: "main-office",
      name: "main",
      gatewayId: FAKE_GATEWAY_ID,
    });
    const again = await register({
      providerAgentId: "main",
      handle: "main-2",
      name: "main",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "CONFLICT", details: { field: "providerAgentId" } });
    const handle = await register({
      providerAgentId: "main",
      handle: "main-office",
      name: "main",
      gatewayId: HOME_ID,
    });
    expect(handle.statusCode).toBe(409);
    expect(handle.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });
  });

  it("OpenClaw 는 gatewayId 필수(없으면 400), 없는 Gateway·다른 워크스페이스 Gateway 는 400", async () => {
    const { app, register } = await setup();
    const missing = await register({ providerAgentId: "main", handle: "main", name: "main" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: "VALIDATION", details: { field: "gatewayId" } });
    expect(
      (await register({ providerAgentId: "main", handle: "main", name: "main", gatewayId: uuid() }))
        .statusCode,
    ).toBe(400);
    const otherWs = uuid();
    app.db.insert(workspaces).values({ id: otherWs, name: "other", createdAt: new Date() }).run();
    const foreign = insertGateway(app.db, otherWs, { id: uuid(), name: "남의 것" });
    const res = await register({
      providerAgentId: "main",
      handle: "main",
      name: "main",
      gatewayId: foreign.id,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION", details: { field: "gatewayId" } });
  });
});

describe("에이전트 찾기 — Gateway 별", () => {
  it("gatewayId 마다 그 Gateway 의 목록, 없으면 400", async () => {
    const { inject, adapter } = await setup();
    const office = await inject(
      "GET",
      `/api/v1/agents/discover?provider=openclaw&gatewayId=${FAKE_GATEWAY_ID}`,
    );
    expect(office.json().agents.map((a: { providerAgentId: string }) => a.providerAgentId)).toEqual([
      "main",
      "fin",
    ]);
    const home = await inject("GET", `/api/v1/agents/discover?provider=openclaw&gatewayId=${HOME_ID}`);
    expect(home.json().agents).toEqual([{ providerAgentId: "main", name: "집 main" }]);
    expect(adapter.calls.connections.listAgents).toEqual([FAKE_GATEWAY_ID, HOME_ID]);
    const none = await inject("GET", "/api/v1/agents/discover?provider=openclaw");
    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ code: "VALIDATION", details: { field: "gatewayId" } });
  });

  it("워크스페이스에 없는 Gateway 는 400 이고 어댑터에 묻지 않는다, 꺼진 Gateway 는 ADAPTER_UNAVAILABLE", async () => {
    const { app, inject, adapter } = await setup();
    const unknown = await inject("GET", `/api/v1/agents/discover?provider=openclaw&gatewayId=${uuid()}`);
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json()).toMatchObject({ code: "VALIDATION", details: { field: "gatewayId" } });
    expect(adapter.calls.connections.listAgents).toEqual([]);

    app.db.$client.prepare("UPDATE gateways SET enabled = 0 WHERE id = ?").run(HOME_ID);
    const off = await inject("GET", `/api/v1/agents/discover?provider=openclaw&gatewayId=${HOME_ID}`);
    expect(off.statusCode).toBe(503);
    expect(off.json()).toMatchObject({ code: "ADAPTER_UNAVAILABLE" });
    expect(adapter.calls.connections.listAgents).toEqual([]);
  });
});

describe("Gateway 옮기기 — PUT /api/v1/agents/:id/gateway", () => {
  /** 사무실 main 을 둔 채널 하나 + 멘션 도우미 */
  async function withChannel() {
    const s = await setup();
    const main = (
      await s.register({
        providerAgentId: "main",
        handle: "main-office",
        name: "main",
        gatewayId: FAKE_GATEWAY_ID,
      })
    ).json().agent as Agent;
    const channel = createChannel(s.app.db, {
      workspaceId: s.app.workspaceId,
      createdBy: s.app.ownerUserId,
      name: "office",
    });
    addMember(s.app.db, channel.id, { memberType: "agent", memberId: main.id }, s.app.logger);
    let n = 0;
    const say = async (bodyMd: string) => {
      const message = createUserMessage(s.app.db, s.app.bus, {
        conversationId: channelConversation(s.app.db, channel.id),
        authorId: s.app.ownerUserId,
        bodyMd,
        clientMsgId: `move-${++n}`,
      });
      await s.app.services.router.routeMessage(message);
    };
    const runs = () =>
      s.app.db.$client
        .prepare("SELECT id FROM runs WHERE channel_id = ? ORDER BY created_at, id")
        .all(channel.id)
        .map((r) => getRun(s.app.db, (r as { id: string }).id));
    const move = (gatewayId: string, h = s.headers) =>
      s.inject("PUT", `/api/v1/agents/${main.id}/gateway`, { gatewayId }, h);
    return { ...s, main, channel, say, runs, move };
  }

  it("[Review Focus 4] Gateway 를 지우면 gateway null, 멘션은 ADAPTER_UNAVAILABLE 카드, 옮긴 뒤 「다시 실행」은 새 Gateway 로 간다", async () => {
    const { app, adapter, inject, main, channel, say, runs, move } = await withChannel();
    const del = await inject("DELETE", `/api/v1/gateways/${FAKE_GATEWAY_ID}`);
    expect(del.statusCode).toBe(200);
    const listed = (await inject("GET", "/api/v1/agents")).json().agents as Agent[];
    expect(listed.find((a) => a.id === main.id)?.gateway).toBeNull();

    await say("@main-office 안녕");
    await vi.waitFor(() => expect(runs()[0]?.status).toBe("error"));
    const failed = runs()[0];
    expect(failed?.error?.code).toBe("ADAPTER_UNAVAILABLE");
    const [card] = runErrorMessages(app.db, channel.id, failed?.id ?? "");
    expect(card).toBeDefined();

    const moved = await move(HOME_ID);
    expect(moved.statusCode).toBe(200);
    expect(moved.json().agent.gateway).toEqual({ id: HOME_ID, name: "집" });

    await app.services.runs.interact({
      messageId: card?.id as string,
      componentId: card?.components?.id as string,
      itemId: RETRY_RUN_ITEM,
      values: {},
      userId: app.ownerUserId,
    });
    await vi.waitFor(() => expect(adapter.calls.connections.send.at(-1)).toBe(HOME_ID));
    const retried = runs()[1];
    expect(retried?.parentRunId).toBe(failed?.id);
    expect(retried?.status).not.toBe("error");
  });

  it("대상 Gateway 에 같은 id 가 있으면 409, 러너 에이전트는 400, 없는 Gateway 는 400, 없는 에이전트는 404", async () => {
    const { app, inject, main, move } = await withChannel();
    // 대소문자 무시 — REST 는 소문자만 받으므로 대문자 행은 등록 규칙 전의 옛 행 꼴로 직접 넣는다
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "MAIN",
      handle: "main-home",
      name: "main",
      gatewayId: HOME_ID,
    });
    const clash = await move(HOME_ID);
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ code: "CONFLICT", details: { field: "providerAgentId" } });

    const { agent: runner } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: "coder",
    });
    const runnerMove = await inject("PUT", `/api/v1/agents/${runner.id}/gateway`, { gatewayId: HOME_ID });
    expect(runnerMove.statusCode).toBe(400);
    expect(runnerMove.json()).toMatchObject({ code: "VALIDATION" });

    expect((await move(uuid())).statusCode).toBe(400);
    expect((await inject("PUT", `/api/v1/agents/${uuid()}/gateway`, { gatewayId: HOME_ID })).statusCode).toBe(
      404,
    );
    // 같은 Gateway 로 옮기면 그대로
    const same = await move(FAKE_GATEWAY_ID);
    expect(same.statusCode).toBe(200);
    expect(same.json().agent).toMatchObject({ id: main.id, gateway: { id: FAKE_GATEWAY_ID } });
  });

  it("남의 Gateway 사이는 admin 이상 — member 는 403·바뀌지 않고, admin 은 옮긴다(연결 탭 통합 스펙 5.2)", async () => {
    const { app, inject, main, move } = await withChannel();
    const member = await userWithRole(app, "mia", "member");
    const denied = await move(HOME_ID, { authorization: `Bearer ${member.token}` });
    expect(denied.statusCode).toBe(403);
    const listed = (await inject("GET", "/api/v1/agents")).json().agents as Agent[];
    expect(listed.find((a) => a.id === main.id)?.gateway?.id).toBe(FAKE_GATEWAY_ID);
    const admin = await userWithRole(app, "ada", "admin");
    const moved = await move(HOME_ID, { authorization: `Bearer ${admin.token}` });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().agent).toMatchObject({ id: main.id, gateway: { id: HOME_ID } });
  });
});
