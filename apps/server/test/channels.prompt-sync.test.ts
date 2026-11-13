/**
 * 채널 프롬프트를 보낼 Gateway(멀티 Gateway 계획 판정 PG10) — 그 채널의 에이전트 멤버가 속한 Gateway 들. 다른 Gateway 의 에이전트가
 * 처음 들어오거나 옮겨 오면 그 Gateway 에 한 번, Gateway 의 플러그인이 hello 하면 그 Gateway 의 채널들을 다시 보낸다(꺼졌던
 * Gateway 를 다시 켠 뒤 그 사이 바뀐 프롬프트가 따라온다).
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { GatewaySetupEntry } from "@dodok/openclaw-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { hasGateways } from "../src/adapters/types";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";
import { seedConversation } from "./helpers/seed";

const HOME_ID = "00000000-0000-4000-8000-0000000000b2";

/** Gateway 마다 플러그인이 붙은 때(connectedAt)를 따로 쥐는 FakeAdapter — hello 는 그 값을 바꾸고 setup 을 낸다 */
class HelloAdapter extends FakeAdapter {
  readonly plugins = new Map<string, string>([
    [FAKE_GATEWAY_ID, "2026-10-05T00:00:00.000Z"],
    [HOME_ID, "2026-10-05T00:00:00.000Z"],
  ]);

  override gatewaySetupDetails(): GatewaySetupEntry[] {
    return super.gatewaySetupDetails().map((entry) => {
      const connectedAt = entry.enabled ? this.plugins.get(entry.id) : undefined;
      return {
        ...entry,
        bridge:
          connectedAt === undefined
            ? { state: "down", plugin: null }
            : {
                state: "connected",
                plugin: {
                  version: "0.0.0",
                  sdkVersion: "0.0.0",
                  gatewayVersion: null,
                  bundleSha256: null,
                  tokenId: null,
                  connectedAt,
                },
              },
      };
    });
  }

  hello(gatewayId: string, connectedAt: string): void {
    this.plugins.set(gatewayId, connectedAt);
    this.emit({ kind: "setup" });
  }
}

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const adapter = new HelloAdapter();
  const app = await bootTestApp({}, { adapters: [adapter] });
  apps.push(app);
  const home = insertGateway(app.db, app.workspaceId, { id: HOME_ID, name: "집" });
  const openclaw = app.registry.forProvider("openclaw");
  if (openclaw && hasGateways(openclaw)) openclaw.upsertGateway(home);
  // 부팅 뒤 넣은 두 Gateway 의 플러그인이 붙은 것(첫 hello) — 채널이 없어 보낼 것이 없다
  adapter.emit({ kind: "setup" });
  const { headers } = await login(app);
  const inject = (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: object) =>
    app.fastify.inject({ method, url, headers, payload });
  let n = 0;
  const agent = (gatewayId: string) => {
    const id = `ag${++n}`;
    return createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: id,
      handle: id,
      name: id,
      gatewayId,
    });
  };
  const channel = async (prompt?: string) => {
    const res = await inject("POST", "/api/v1/channels", { name: `c${++n}`, ...(prompt ? { prompt } : {}) });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  };
  const join = async (channelId: string, agentId: string) =>
    expect(
      (
        await inject("POST", `/api/v1/channels/${channelId}/members`, {
          memberType: "agent",
          memberId: agentId,
        })
      ).statusCode,
    ).toBe(201);
  /** 그 채널의 새 세션에 에이전트를 초대한다(세션 에이전트 초대 스펙 5.3) — 세션 id 를 돌려준다 */
  const inviteTo = async (
    channelId: string,
    agentId: string,
    conversationId = seedConversation(app.db, channelId),
  ) => {
    const res = await inject("POST", `/api/v1/conversations/${conversationId}/agents`, { agentId });
    expect(res.statusCode).toBe(200);
    return conversationId;
  };
  const setPrompt = async (channelId: string, prompt: string) =>
    expect((await inject("PATCH", `/api/v1/channels/${channelId}`, { prompt })).statusCode).toBe(200);
  /** 지금까지 보낸 것을 [채널, Gateway, 프롬프트] 로 — 비운다 */
  const takeSyncs = () => {
    const out = adapter.calls.syncChannelConfig.map((c, i) => [
      c.channelId,
      adapter.calls.connections.syncChannelConfig[i],
      c.config.systemPrompt,
    ]);
    adapter.calls.syncChannelConfig.length = 0;
    adapter.calls.connections.syncChannelConfig.length = 0;
    return out;
  };
  return { app, adapter, inject, agent, channel, join, inviteTo, setPrompt, takeSyncs };
}

describe("채널 프롬프트 — Gateway 별 동기화", () => {
  it("사무실 에이전트만 있는 채널의 프롬프트는 사무실에만, 집 에이전트가 들어오면 집에 한 번 — 같은 Gateway 에이전트가 더 들어와도 다시 보내지 않는다", async () => {
    const { agent, channel, join, setPrompt, takeSyncs } = await setup();
    const ch = await channel("규칙 1");
    await join(ch, agent(FAKE_GATEWAY_ID).id);
    expect(takeSyncs()).toEqual([[ch, FAKE_GATEWAY_ID, "규칙 1"]]);

    await setPrompt(ch, "규칙 2");
    expect(takeSyncs()).toEqual([[ch, FAKE_GATEWAY_ID, "규칙 2"]]);

    await join(ch, agent(HOME_ID).id);
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "규칙 2"]]);
    await join(ch, agent(HOME_ID).id);
    await join(ch, agent(FAKE_GATEWAY_ID).id);
    expect(takeSyncs()).toEqual([]);

    await setPrompt(ch, "규칙 3");
    expect(takeSyncs()).toEqual(
      expect.arrayContaining([
        [ch, FAKE_GATEWAY_ID, "규칙 3"],
        [ch, HOME_ID, "규칙 3"],
      ]),
    );
  });

  it("에이전트를 다른 Gateway 로 옮기면 그 채널에 새로 들어온 Gateway 에 한 번", async () => {
    const { agent, channel, join, inject, takeSyncs } = await setup();
    const ch = await channel("옮기기 규칙");
    const both = await channel("둘 다");
    const moving = agent(FAKE_GATEWAY_ID);
    await join(ch, moving.id);
    await join(both, moving.id);
    await join(both, agent(HOME_ID).id);
    takeSyncs();

    const res = await inject("PUT", `/api/v1/agents/${moving.id}/gateway`, { gatewayId: HOME_ID });
    expect(res.statusCode).toBe(200);
    // both 에는 집이 이미 있었다
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "옮기기 규칙"]]);
  });

  it("꺼진 Gateway 로 옮기면 보내지 않는다 — 다시 켜고 플러그인이 붙을 때 보낸다", async () => {
    const { adapter, agent, channel, join, inject, takeSyncs } = await setup();
    const ch = await channel("꺼진 곳");
    const moving = agent(FAKE_GATEWAY_ID);
    await join(ch, moving.id);
    expect((await inject("PATCH", `/api/v1/gateways/${HOME_ID}`, { enabled: false })).statusCode).toBe(200);
    adapter.emit({ kind: "setup" });
    takeSyncs();

    expect(
      (await inject("PUT", `/api/v1/agents/${moving.id}/gateway`, { gatewayId: HOME_ID })).statusCode,
    ).toBe(200);
    expect(takeSyncs()).toEqual([]);

    expect((await inject("PATCH", `/api/v1/gateways/${HOME_ID}`, { enabled: true })).statusCode).toBe(200);
    adapter.hello(HOME_ID, "2026-10-05T03:00:00.000Z");
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "꺼진 곳"]]);
  });

  it("플러그인이 hello 하면 그 Gateway 에 에이전트를 둔 채널만 그 Gateway 로 다시 보낸다 — 같은 플러그인의 setup 은 무시", async () => {
    const { adapter, agent, channel, join, takeSyncs } = await setup();
    const officeOnly = await channel("사무실");
    const mixed = await channel("섞임");
    await join(officeOnly, agent(FAKE_GATEWAY_ID).id);
    await join(mixed, agent(FAKE_GATEWAY_ID).id);
    await join(mixed, agent(HOME_ID).id);
    takeSyncs();

    adapter.emit({ kind: "setup" });
    expect(takeSyncs()).toEqual([]);

    adapter.hello(HOME_ID, "2026-10-05T01:00:00.000Z");
    expect(takeSyncs()).toEqual([[mixed, HOME_ID, "섞임"]]);
  });

  it("집 Gateway 를 끈 사이 바꾼 프롬프트는 다시 켜고 플러그인이 붙으면 집에도 간다", async () => {
    const { adapter, inject, agent, channel, join, setPrompt, takeSyncs } = await setup();
    const ch = await channel("처음");
    await join(ch, agent(FAKE_GATEWAY_ID).id);
    await join(ch, agent(HOME_ID).id);
    takeSyncs();

    expect((await inject("PATCH", `/api/v1/gateways/${HOME_ID}`, { enabled: false })).statusCode).toBe(200);
    adapter.emit({ kind: "setup" }); // 실물은 끄면 브리지가 끊겨 setup 을 낸다
    await setPrompt(ch, "끈 사이");
    expect(takeSyncs()).toEqual([[ch, FAKE_GATEWAY_ID, "끈 사이"]]);

    expect((await inject("PATCH", `/api/v1/gateways/${HOME_ID}`, { enabled: true })).statusCode).toBe(200);
    adapter.hello(HOME_ID, "2026-10-05T02:00:00.000Z");
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "끈 사이"]]);
  });
});

describe("채널 프롬프트 — 세션에 초대한 OpenClaw 에이전트의 Gateway [세션 에이전트 초대 스펙 I5]", () => {
  it("채널 멤버가 없는 Gateway 의 에이전트를 초대하면 그 Gateway 에 한 번 — 같은 Gateway 를 다시 초대해도 다시 보내지 않는다", async () => {
    const { agent, channel, join, inviteTo, takeSyncs } = await setup();
    const ch = await channel("세션 규칙");
    await join(ch, agent(FAKE_GATEWAY_ID).id);
    takeSyncs();
    const session = await inviteTo(ch, agent(HOME_ID).id);
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "세션 규칙"]]);
    await inviteTo(ch, agent(HOME_ID).id, session);
    await inviteTo(ch, agent(FAKE_GATEWAY_ID).id, session);
    expect(takeSyncs()).toEqual([]);
  });

  it("프롬프트를 바꾸면 초대한 에이전트의 Gateway 에도, 그 Gateway 의 플러그인 hello 에도 그 채널을 보낸다", async () => {
    const { adapter, agent, channel, join, inviteTo, setPrompt, takeSyncs } = await setup();
    const ch = await channel("처음");
    await join(ch, agent(FAKE_GATEWAY_ID).id);
    await inviteTo(ch, agent(HOME_ID).id);
    takeSyncs();
    await setPrompt(ch, "바뀜");
    expect(takeSyncs()).toEqual(
      expect.arrayContaining([
        [ch, FAKE_GATEWAY_ID, "바뀜"],
        [ch, HOME_ID, "바뀜"],
      ]),
    );
    adapter.hello(HOME_ID, "2026-10-05T05:00:00.000Z");
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "바뀜"]]);
  });

  it("초대한 에이전트를 다른 Gateway 로 옮기면 그 채널에 새로 들어온 Gateway 에 한 번", async () => {
    const { agent, channel, inviteTo, inject, takeSyncs } = await setup();
    const ch = await channel("옮겨 간 초대");
    const moving = agent(FAKE_GATEWAY_ID);
    await inviteTo(ch, moving.id);
    takeSyncs();
    expect(
      (await inject("PUT", `/api/v1/agents/${moving.id}/gateway`, { gatewayId: HOME_ID })).statusCode,
    ).toBe(200);
    expect(takeSyncs()).toEqual([[ch, HOME_ID, "옮겨 간 초대"]]);
  });
});
