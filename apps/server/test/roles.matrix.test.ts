import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, type TeamRole, WIRE_PROTOCOL } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { channelMembers, channels, memberships } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import * as approvalStore from "../src/modules/approvals/store";
import { addMember, type ChannelRecord, createChannel } from "../src/modules/channels/service";
import { createGateway } from "../src/modules/gateways/service";
import { createTriggerLookups } from "../src/modules/push/service";
import { targetsForApproval } from "../src/modules/push/triggers";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { connectWire, openWire, type WireClient } from "./helpers/wire";

// 역할 매트릭스(팀 스펙 2장 표) — owner·admin·member 세 세션으로 경로마다 허용·거부를 본다.
// 거부는 REST 403 FORBIDDEN·wire ack FORBIDDEN, membership 이 없는 세션은 어디서나 401

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type Case = {
  name: string;
  min: TeamRole;
  /** 허용일 때의 상태 코드 */
  ok: number;
  /** 역할마다 새 대상을 만든다 — 허용된 요청이 상태를 바꿔도 다음 역할의 요청이 같은 조건에서 돈다 */
  request: () => { method: Method; url: string; payload?: object };
};

const ROLES: TeamRole[] = ["member", "admin", "owner"];
const RANK: Record<TeamRole, number> = { member: 0, admin: 1, owner: 2 };

describe("역할 매트릭스(스펙 2장)", () => {
  let app: App;
  let adapter: FakeAdapter;
  const tokens = {} as Record<TeamRole, string>;
  const ids = {} as Record<TeamRole, string>;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapters: [adapter] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    tokens.owner = (await login(app)).token;
    ids.owner = app.ownerUserId;
    for (const role of ["admin", "member"] as const) {
      const user = await userWithRole(app, `role-${role}`, role);
      tokens[role] = user.token;
      ids[role] = user.id;
    }
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  const call = (token: string | undefined, req: { method: Method; url: string; payload?: object }) =>
    app.fastify.inject({
      method: req.method,
      url: req.url,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      ...(req.payload === undefined ? {} : { payload: req.payload }),
    });

  const newAgent = (): Agent =>
    createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: `ag${++n}`,
      handle: `ag${n}`,
      name: `ag${n}`,
    });
  const newGateway = (): string =>
    createGateway(app.db, app.workspaceId, { name: `gw${++n}`, url: "ws://127.0.0.1:1", token: "t" }).id;
  const newChannel = (): ChannelRecord =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name: `role-${++n}` });
  /** 에이전트가 들어간 채널 */
  const channelWithAgent = () => {
    const channel = newChannel();
    const agent = newAgent();
    addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
    return { channel, agent };
  };
  const channelRow = (id: string) => app.db.select().from(channels).where(eq(channels.id, id)).get();
  const agentMemberRow = (channelId: string, agentId: string) =>
    app.db
      .select()
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.memberId, agentId)))
      .get();
  const setRole = (userId: string, role: TeamRole | "guest") =>
    app.db
      .update(memberships)
      .set({ role })
      .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, userId)))
      .run();

  const CASES: Case[] = [
    {
      name: "GET /agents",
      min: "member",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/agents" }),
    },
    {
      name: "POST /agents",
      min: "admin",
      ok: 201,
      request: () => {
        const handle = `new${++n}`;
        return {
          method: "POST",
          url: "/api/v1/agents",
          payload: { providerAgentId: handle, handle, name: handle, gatewayId: FAKE_GATEWAY_ID },
        };
      },
    },
    {
      name: "PATCH /agents/:id",
      min: "admin",
      ok: 200,
      request: () => ({
        method: "PATCH",
        url: `/api/v1/agents/${newAgent().id}`,
        payload: { name: "바뀐 이름" },
      }),
    },
    {
      name: "GET /agents/discover",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: `/api/v1/agents/discover?gatewayId=${FAKE_GATEWAY_ID}` }),
    },
    {
      name: "PUT /agents/:id/gateway",
      min: "owner",
      ok: 200,
      request: () => ({
        method: "PUT",
        url: `/api/v1/agents/${newAgent().id}/gateway`,
        payload: { gatewayId: newGateway() },
      }),
    },
    ...(
      [
        ["{name}", "member", {}],
        ["{name, topic}", "member", { topic: "설명" }],
        ["{name, prompt}", "admin", { prompt: "새 프롬프트" }],
        ["{name, relayPolicy}", "admin", { relayPolicy: { maxRelayTurns: 2, allowPairs: "all" } }],
        ["{name, visibility}", "admin", { visibility: "private" }],
      ] as const
    ).map(([label, min, extra]): Case => ({
      name: `POST /channels ${label}`,
      min,
      ok: 201,
      request: () => ({ method: "POST", url: "/api/v1/channels", payload: { name: `c${++n}`, ...extra } }),
    })),
    ...(
      [
        ["{name}", "member", { name: "새 이름" }],
        ["{topic}", "member", { topic: "새 설명" }],
        ["{name, topic}", "member", { name: "새 이름", topic: null }],
        ["{prompt}", "admin", { prompt: "새 프롬프트" }],
        ["{relayPolicy}", "admin", { relayPolicy: { maxRelayTurns: 2, allowPairs: "all" } }],
        ["{visibility}", "admin", { visibility: "private" }],
      ] as const
    ).map(([label, min, payload]): Case => ({
      name: `PATCH /channels/:id ${label}`,
      min,
      ok: 200,
      request: () => ({ method: "PATCH", url: `/api/v1/channels/${newChannel().id}`, payload }),
    })),
    ...(
      [
        ["{aliases}", "member", { aliases: ["bot"] }],
        ["{promptOverride}", "admin", { promptOverride: "따로" }],
        ["{autoRespond}", "admin", { autoRespond: true }],
      ] as const
    ).map(([label, min, extra]): Case => ({
      name: `POST /channels/:id/members agent ${label}`,
      min,
      ok: 201,
      request: () => ({
        method: "POST",
        url: `/api/v1/channels/${newChannel().id}/members`,
        payload: { memberType: "agent", memberId: newAgent().id, ...extra },
      }),
    })),
    {
      name: "POST /channels/:id/members agent (필드 없음)",
      min: "member",
      ok: 201,
      request: () => ({
        method: "POST",
        url: `/api/v1/channels/${newChannel().id}/members`,
        payload: { memberType: "agent", memberId: newAgent().id },
      }),
    },
    ...(
      [
        ["{aliases}", "member", { aliases: ["bot"] }],
        ["{promptOverride}", "admin", { promptOverride: "따로" }],
        ["{autoRespond}", "admin", { autoRespond: true }],
      ] as const
    ).map(([label, min, payload]): Case => ({
      name: `PATCH /channels/:id/members/:memberId ${label}`,
      min,
      ok: 200,
      request: () => {
        const { channel, agent } = channelWithAgent();
        return { method: "PATCH", url: `/api/v1/channels/${channel.id}/members/${agent.id}`, payload };
      },
    })),
    {
      name: "DELETE /channels/:id/members/:memberId",
      min: "member",
      ok: 200,
      request: () => {
        const { channel, agent } = channelWithAgent();
        return { method: "DELETE", url: `/api/v1/channels/${channel.id}/members/${agent.id}` };
      },
    },
    {
      name: "POST /channels/:id/agents/:agentId/reset",
      min: "admin",
      ok: 200,
      request: () => {
        const { channel, agent } = channelWithAgent();
        return { method: "POST", url: `/api/v1/channels/${channel.id}/agents/${agent.id}/reset` };
      },
    },
    {
      name: "GET /ops/status",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/ops/status" }),
    },
    {
      name: "GET /ops/events",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/ops/events" }),
    },
    {
      name: "PATCH /ops/settings",
      min: "admin",
      ok: 200,
      request: () => ({ method: "PATCH", url: "/api/v1/ops/settings", payload: { dailyRunLimit: 300 } }),
    },
    {
      name: "GET /setup/status",
      min: "owner",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/setup/status" }),
    },
    // Gateway·브리지 토큰은 owner 만(멀티 Gateway 스펙 「권한」 절)
    {
      name: "GET /gateways",
      min: "owner",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/gateways" }),
    },
    {
      name: "POST /gateways",
      min: "owner",
      ok: 201,
      request: () => ({
        method: "POST",
        url: "/api/v1/gateways",
        payload: { name: `gw${++n}`, url: "ws://127.0.0.1:1", token: "t" },
      }),
    },
    {
      name: "PATCH /gateways/:id",
      min: "owner",
      ok: 200,
      request: () => ({
        method: "PATCH",
        url: `/api/v1/gateways/${newGateway()}`,
        payload: { name: `gw${++n}` },
      }),
    },
    {
      name: "DELETE /gateways/:id",
      min: "owner",
      ok: 200,
      request: () => ({ method: "DELETE", url: `/api/v1/gateways/${newGateway()}` }),
    },
    {
      name: "GET /gateways/:id/bridge-tokens",
      min: "owner",
      ok: 200,
      request: () => ({ method: "GET", url: `/api/v1/gateways/${newGateway()}/bridge-tokens` }),
    },
    {
      name: "POST /gateways/:id/bridge-tokens",
      min: "owner",
      ok: 201,
      request: () => ({
        method: "POST",
        url: `/api/v1/gateways/${newGateway()}/bridge-tokens`,
        payload: { label: "x" },
      }),
    },
    {
      name: "DELETE /gateways/:id/bridge-tokens/:tokenId",
      min: "owner",
      ok: 204,
      request: () => {
        const gatewayId = newGateway();
        const { record } = issueBridgeToken(app.db, app.workspaceId, gatewayId, "x");
        return { method: "DELETE", url: `/api/v1/gateways/${gatewayId}/bridge-tokens/${record.id}` };
      },
    },
  ];

  it.each(CASES.flatMap((c) => ROLES.map((role) => [c.name, role, c] as const)))(
    "%s — %s",
    async (_name, role, c) => {
      const res = await call(tokens[role], c.request());
      if (RANK[role] >= RANK[c.min]) {
        expect(res.statusCode, res.body).toBe(c.ok);
      } else {
        expect(res.statusCode, res.body).toBe(403);
        expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
      }
    },
  );

  it("세션이 없으면 역할 경로도 401", async () => {
    for (const c of CASES) expect((await call(undefined, c.request())).statusCode, c.name).toBe(401);
  });

  it("member 의 PATCH /channels/:id {name, prompt} 는 통째로 403 — 이름도 바뀌지 않는다 [Review Focus 4]", async () => {
    const channel = newChannel();
    const res = await call(tokens.member, {
      method: "PATCH",
      url: `/api/v1/channels/${channel.id}`,
      payload: { name: "바꿔치기", prompt: "몰래" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(channelRow(channel.id)).toMatchObject({
      name: channel.name,
      prompt: null,
      promptRevision: 1,
    });
  });

  it("member 의 POST /channels {name, prompt} 는 403 — 채널이 생기지 않는다", async () => {
    const name = `sneaky${++n}`;
    const res = await call(tokens.member, {
      method: "POST",
      url: "/api/v1/channels",
      payload: { name, prompt: "관리자 몰래" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    expect(app.db.select().from(channels).where(eq(channels.name, name)).get()).toBeUndefined();
  });

  it("member 의 PATCH /channels/:id 에 모르는 필드가 섞이면 admin 몫이다 — 목록에 없는 필드는 admin", async () => {
    const channel = newChannel();
    const res = await call(tokens.member, {
      method: "PATCH",
      url: `/api/v1/channels/${channel.id}`,
      payload: { name: "바꿔치기", dailyRunLimit: 3 },
    });
    expect(res.statusCode).toBe(403);
    expect(channelRow(channel.id)?.name).toBe(channel.name);
  });

  it("member 의 PATCH 멤버 {aliases, autoRespond} 는 통째로 403 — aliases 도 그대로", async () => {
    const { channel, agent } = channelWithAgent();
    const res = await call(tokens.member, {
      method: "PATCH",
      url: `/api/v1/channels/${channel.id}/members/${agent.id}`,
      payload: { aliases: ["bot"], autoRespond: true },
    });
    expect(res.statusCode).toBe(403);
    expect(agentMemberRow(channel.id, agent.id)).toMatchObject({ aliases: [], autoRespond: false });
  });

  it("member 의 POST 멤버 {promptOverride} 는 403 — 멤버가 생기지 않는다", async () => {
    const channel = newChannel();
    const agent = newAgent();
    const res = await call(tokens.member, {
      method: "POST",
      url: `/api/v1/channels/${channel.id}/members`,
      payload: { memberType: "agent", memberId: agent.id, aliases: ["bot"], promptOverride: "따로" },
    });
    expect(res.statusCode).toBe(403);
    expect(agentMemberRow(channel.id, agent.id)).toBeUndefined();
  });

  it("역할을 member 로 내린 직후 같은 세션의 admin 경로는 403, 다시 올리면 통과 [Review Focus 5]", async () => {
    const bee = await userWithRole(app, `demoted${++n}`, "admin");
    const patch = () =>
      call(bee.token, { method: "PATCH", url: `/api/v1/agents/${newAgent().id}`, payload: { name: "x" } });
    expect((await patch()).statusCode).toBe(200);
    setRole(bee.id, "member");
    const res = await patch();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "FORBIDDEN" });
    setRole(bee.id, "admin");
    expect((await patch()).statusCode).toBe(200);
    // 승인 푸시 수신자(아래)를 흐리지 않게 되돌린다
    setRole(bee.id, "member");
  });

  describe("membership 이 없는 세션", () => {
    let gone: { id: string; token: string };
    beforeAll(async () => {
      gone = await userWithRole(app, "gone", "member");
      app.db
        .delete(memberships)
        .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, gone.id)))
        .run();
    });

    it("/auth/me 401", async () => {
      const res = await call(gone.token, { method: "GET", url: "/api/v1/auth/me" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("membership role 이 guest 면 /auth/me 401 — 모르는 역할은 membership 이 없는 것과 같다", async () => {
      const guest = await userWithRole(app, `guest${++n}`, "member");
      setRole(guest.id, "guest");
      const res = await call(guest.token, { method: "GET", url: "/api/v1/auth/me" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it.each(CASES.map((c) => [c.name, c] as const))("%s — 401", async (_name, c) => {
      const res = await call(gone.token, c.request());
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("wire 핸드셰이크 거절(UNAUTHORIZED)", async () => {
      const socket = openWire(app, { token: gone.token, protocol: WIRE_PROTOCOL });
      sockets.push(socket);
      const err = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
        socket.once("connect", () => reject(new Error("접속이 거부되지 않았다")));
        socket.once("connect_error", (e) => resolve(e as Error & { data?: unknown }));
      });
      expect(err.data).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("승인", () => {
    const MINUTE = 60_000;
    const pendingApproval = async () => {
      const { channel, agent } = channelWithAgent();
      const frame: ProviderApproval = {
        providerApprovalId: `plugin:${uuid()}`,
        kind: "plugin",
        sessionKey: adapter.sessionKeyFor(agent.providerAgentId, channel.id),
        providerAgentId: agent.providerAgentId,
        channelId: channel.id,
        toolCallId: `toolu_${++n}`,
        toolName: "Write",
        pluginId: "fs",
        title: "Write 실행",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 2 * MINUTE).toISOString(),
      };
      adapter.emitApproval(frame);
      await vi.waitFor(() =>
        expect(approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId)?.status).toBe(
          "pending",
        ),
      );
      const approval = approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId);
      if (!approval) throw new Error("승인이 저장되지 않았다");
      return { approval, channel };
    };

    it("member 의 approval.resolve 는 ack FORBIDDEN — Gateway 로 안 가고 승인은 pending 그대로", async () => {
      const { approval } = await pendingApproval();
      const socket = await connectWire(app, tokens.member);
      sockets.push(socket);
      const sent = adapter.calls.resolveApproval.length;
      const res = await socket.emitWithAck("approval.resolve", {
        approvalId: approval.id,
        decision: "allow-once",
      });
      expect(res).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
      expect(adapter.calls.resolveApproval.length).toBe(sent);
      expect(approvalStore.getApproval(app.db, approval.id)?.status).toBe("pending");
    });

    it.each(["admin", "owner"] as const)("%s 의 approval.resolve 는 Gateway 로 간다", async (role) => {
      const { approval } = await pendingApproval();
      const socket = await connectWire(app, tokens[role]);
      sockets.push(socket);
      const res = await socket.emitWithAck("approval.resolve", { approvalId: approval.id, decision: "deny" });
      expect(res).toMatchObject({ ok: true });
      expect(adapter.calls.resolveApproval.at(-1)).toMatchObject({ decision: "deny" });
    });

    it("승인 푸시는 워크스페이스의 owner·admin 에게만 — member 가 채널 참여자여도 안 간다", async () => {
      const { approval, channel } = await pendingApproval();
      addMember(app.db, channel.id, { memberType: "user", memberId: ids.member }, app.logger);
      const targets = targetsForApproval(approval, createTriggerLookups(app.db, app.workspaceId));
      expect(targets.map((t) => t.userId).sort()).toEqual([ids.owner, ids.admin].sort());
    });
  });
});
