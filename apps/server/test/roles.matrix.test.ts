import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Agent,
  type Channel,
  type ControlResult,
  type Message,
  type SearchResult,
  type TeamRole,
  type UnreadSnapshot,
  WIRE_PROTOCOL,
} from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import type { Principal } from "../src/modules/control/principal";
import {
  agents,
  channelMembers,
  channels,
  memberships,
  messageReactions,
  runs,
  users,
} from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { insertAutomation } from "../src/modules/automations/store";
import { issueWebhookToken } from "../src/modules/automations/tokens";
import * as approvalStore from "../src/modules/approvals/store";
import {
  addMember,
  type ChannelRecord,
  createChannel,
  setSessionManager,
} from "../src/modules/channels/service";
import { createGateway } from "../src/modules/gateways/service";
import { createProject } from "../src/modules/runners/projects";
import { issueRunnerToken } from "../src/modules/runners/tokens";
import { createAgentMessage, createUserMessage } from "../src/modules/messages/service";
import { createTriggerLookups } from "../src/modules/push/service";
import { insertRun } from "../src/modules/runs/store";
import { targetsForApproval } from "../src/modules/push/triggers";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { issuePersonalToken, verifyPersonalToken } from "../src/modules/tokens/service";
import { bootTestApp, login, noExternalTransport, userWithRole } from "./helpers/app";
import { expectOk, openRun as openControlRun, pat } from "./helpers/control";
import { type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { makePng } from "./helpers/png";
import { connectWire, openWire, recordEvents, waitFor, type WireClient } from "./helpers/wire";
import { channelConversation, createDmChannelForTest, seedConversation } from "./helpers/seed";

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
  const fakeRunners: FakeRunner[] = [];
  /** 붙은 가짜 러너 둘의 토큰 id — [0] 에 프로젝트를 만들고 [1] 로 옮긴다 */
  const runnerIds: string[] = [];
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp(
      {},
      {
        adapters: [adapter],
        runnerAdapter: true,
        pushTransports: { apns: noExternalTransport("apns"), fcm: noExternalTransport("fcm") },
      },
    );
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    // 「러너」 탭 경로가 붙은 러너에 묻는다 — 프로젝트는 runnerA 에 만들고 옮기기는 runnerB 로
    for (const label of ["matrix-a", "matrix-b"] as const) {
      const issued = issueRunnerToken(app.db, app.workspaceId, label);
      fakeRunners.push(await startFakeRunner({ url: app.url, token: issued.token }));
      runnerIds.push(issued.record.id);
    }
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
    for (const runner of fakeRunners.splice(0)) runner.close();
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
  const runnerA = () => runnerIds[0] ?? "";
  const newRunnerProject = () =>
    createProject(app.db, {
      workspaceId: app.workspaceId,
      runnerTokenId: runnerA(),
      rootId: "src",
      relPath: `matrix-${++n}`,
    });
  /** 붙지 않은 새 러너 토큰 — 폐기·다시 발급이 붙은 러너를 끊지 않게 */
  const newRunnerToken = () => issueRunnerToken(app.db, app.workspaceId, `t${++n}`).record.id;
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
  /** member 역할의 사람 — request() 가 동기라 Better Auth 사용자 없이 우리 행만 넣는다(세션 지우기는 없는 사용자에도 된다) */
  const newMember = (deactivatedAt: Date | null): string => {
    const id = uuid();
    app.db
      .insert(users)
      .values({
        id,
        workspaceId: app.workspaceId,
        handle: `mem${++n}`,
        displayName: `mem${n}`,
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    app.db
      .insert(memberships)
      .values({ id: uuid(), workspaceId: app.workspaceId, userId: id, role: "member", deactivatedAt })
      .run();
    return id;
  };
  /** 새 채널을 겨눈 자동화 — 웹훅이면 토큰 해시도 넣는다 */
  const newAutomation = (kind: "schedule" | "webhook"): string => {
    const token = issueWebhookToken();
    return insertAutomation(app.db, {
      id: uuid(),
      workspaceId: app.workspaceId,
      name: `auto${++n}`,
      channelId: newChannel().id,
      kind,
      bodyMd: "점검",
      enabled: true,
      ...(kind === "schedule"
        ? { scheduleJson: { repeat: "daily" as const, time: "09:00" } }
        : { tokenHash: token.hash, tokenPrefix: token.prefix }),
      createdBy: app.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).id;
  };
  /** owner 가 만든 세션과 그 루트 메시지 */
  const ownerConversation = () => {
    const channel = newChannel();
    const conversationId = seedConversation(app.db, channel.id);
    const root = createUserMessage(app.db, app.bus, {
      conversationId,
      authorId: app.ownerUserId,
      bodyMd: "루트",
      clientMsgId: `root-${++n}`,
    });
    return { channel, conversationId, root };
  };
  const channelRow = (id: string) => app.db.select().from(channels).where(eq(channels.id, id)).get();
  /** 에이전트가 들어간 새 채널의 에이전트 답 하나 */
  const agentAnswer = () => {
    const { channel, agent } = channelWithAgent();
    return createAgentMessage(app.db, app.bus, {
      conversationId: channelConversation(app.db, channel.id),
      agentId: agent.id,
      bodyMd: "답",
      externalId: `answer-${++n}`,
    });
  };
  const reactionsOf = (messageId: string) =>
    app.db
      .select({ userId: messageReactions.userId, emoji: messageReactions.emoji })
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId))
      .all();
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
      name: "DELETE /agents/:id",
      min: "admin",
      ok: 200,
      request: () => ({ method: "DELETE", url: `/api/v1/agents/${newAgent().id}` }),
    },
    {
      name: "POST /agents/:id/restore",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/agents/${newAgent().id}/restore` }),
    },
    {
      name: "GET /agents/discover",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: `/api/v1/agents/discover?gatewayId=${FAKE_GATEWAY_ID}` }),
    },
    {
      name: "POST /agents {provider: runner}",
      min: "admin",
      ok: 201,
      request: () => ({
        method: "POST",
        url: "/api/v1/agents",
        payload: {
          provider: "runner",
          runnerProjectId: newRunnerProject().id,
          program: "claude",
          handle: `run${++n}`,
          name: "러너 에이전트",
          permissionMode: "acceptEdits",
        },
      }),
    },
    {
      name: "PATCH /agents/:id {permissionMode} (러너 에이전트)",
      min: "admin",
      ok: 200,
      request: () => {
        const project = newRunnerProject();
        const agent = createAgent(app.db, {
          workspaceId: app.workspaceId,
          provider: "runner",
          runnerProjectId: project.id,
          program: "claude",
          handle: `rpa${++n}`,
          name: "러너",
        });
        return { method: "PATCH", url: `/api/v1/agents/${agent.id}`, payload: { permissionMode: "plan" } };
      },
    },
    {
      name: "GET /runners",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/runners" }),
    },
    {
      name: "GET /runners/:id/fs",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: `/api/v1/runners/${runnerA()}/fs?rootId=src` }),
    },
    {
      name: "GET /runners/:id/projects",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: `/api/v1/runners/${runnerA()}/projects` }),
    },
    {
      name: "POST /runners/:id/projects",
      min: "admin",
      ok: 201,
      request: () => ({
        method: "POST",
        url: `/api/v1/runners/${runnerA()}/projects`,
        payload: { rootId: "src", relPath: `added-${++n}` },
      }),
    },
    {
      name: "PATCH /runner-projects/:id",
      min: "admin",
      ok: 200,
      request: () => ({
        method: "PATCH",
        url: `/api/v1/runner-projects/${newRunnerProject().id}`,
        payload: { label: "새 라벨" },
      }),
    },
    {
      name: "POST /runner-projects/:id/archive",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/runner-projects/${newRunnerProject().id}/archive` }),
    },
    {
      name: "POST /runner-projects/:id/check",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/runner-projects/${newRunnerProject().id}/check` }),
    },
    {
      name: "POST /runner-projects/:id/move",
      min: "admin",
      ok: 200,
      request: () => ({
        method: "POST",
        url: `/api/v1/runner-projects/${newRunnerProject().id}/move`,
        payload: { runnerId: runnerIds[1] },
      }),
    },
    {
      name: "GET /setup/runner-tokens",
      min: "owner",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/setup/runner-tokens" }),
    },
    {
      name: "POST /setup/runner-tokens",
      min: "owner",
      ok: 201,
      request: () => ({ method: "POST", url: "/api/v1/setup/runner-tokens", payload: { label: `m${++n}` } }),
    },
    {
      name: "POST /setup/runner-tokens/:id/reissue",
      min: "owner",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/setup/runner-tokens/${newRunnerToken()}/reissue` }),
    },
    {
      name: "DELETE /setup/runner-tokens/:id",
      min: "owner",
      ok: 204,
      request: () => ({ method: "DELETE", url: `/api/v1/setup/runner-tokens/${newRunnerToken()}` }),
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
        ["{sessionPolicy}", "admin", { sessionPolicy: { create: "managers" } }],
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
    // 사람 멤버는 누구나 넣는다(authorizeChannelMemberAdd 의 사람 갈래) — 채널은 owner 가 만든 새 것이라 admin 은 아직 멤버가 아니다
    {
      name: "POST /channels/:id/members user",
      min: "member",
      ok: 201,
      request: () => ({
        method: "POST",
        url: `/api/v1/channels/${newChannel().id}/members`,
        payload: { memberType: "user", memberId: ids.admin },
      }),
    },
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
      name: "GET /channels?archived=1",
      min: "member",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/channels?archived=1" }),
    },
    {
      name: "POST /channels/:id/archive",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/channels/${newChannel().id}/archive` }),
    },
    {
      name: "POST /channels/:id/unarchive",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/channels/${newChannel().id}/unarchive` }),
    },
    {
      name: "GET /channels/:id/conversations",
      min: "member",
      ok: 200,
      request: () => ({
        method: "GET",
        url: `/api/v1/channels/${ownerConversation().channel.id}/conversations`,
      }),
    },
    {
      name: "GET /conversations/:id",
      min: "member",
      ok: 200,
      request: () => ({ method: "GET", url: `/api/v1/conversations/${ownerConversation().conversationId}` }),
    },
    {
      name: "GET /conversations/:id/messages",
      min: "member",
      ok: 200,
      request: () => ({
        method: "GET",
        url: `/api/v1/conversations/${ownerConversation().conversationId}/messages`,
      }),
    },
    {
      name: "GET /conversations/:id/threads/:rootId/messages",
      min: "member",
      ok: 200,
      request: () => {
        const { conversationId, root } = ownerConversation();
        return { method: "GET", url: `/api/v1/conversations/${conversationId}/threads/${root.id}/messages` };
      },
    },
    // 남(owner)이 만든 세션 — member 는 만든 사람·세션 관리자가 아니라 거절, 자기 세션은 conversations.routes.test.ts
    ...(
      [
        ["{title} (남의 세션)", { title: "바뀐 제목" }],
        ["{closed} (남의 세션)", { closed: true }],
      ] as const
    ).map(([label, payload]): Case => ({
      name: `PATCH /conversations/:id ${label}`,
      min: "admin",
      ok: 200,
      request: () => ({
        method: "PATCH",
        url: `/api/v1/conversations/${ownerConversation().conversationId}`,
        payload,
      }),
    })),
    {
      name: "PUT /channels/:id/session-managers/:userId",
      min: "admin",
      ok: 200,
      request: () => ({
        method: "PUT",
        url: `/api/v1/channels/${newChannel().id}/session-managers/${newMember(null)}`,
      }),
    },
    {
      name: "DELETE /channels/:id/session-managers/:userId",
      min: "admin",
      ok: 200,
      request: () => {
        const channel = newChannel();
        const userId = newMember(null);
        setSessionManager(app.db, channel.id, userId, true);
        return { method: "DELETE", url: `/api/v1/channels/${channel.id}/session-managers/${userId}` };
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
    // 읽지 않음(읽지 않음 스펙 「권한」 장) — 누구나, 자기 것만. wire conversation.read 는 reads 통합 테스트가 본다
    {
      name: "GET /me/unread",
      min: "member",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/me/unread" }),
    },
    // 개인 토큰(제어 MCP 스펙 「권한」 장) — 누구나, 자기 것만. DELETE 는 아래 「개인 토큰」 묶음이 주인별로 본다
    {
      name: "GET /me/tokens",
      min: "member",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/me/tokens" }),
    },
    {
      name: "POST /me/tokens",
      min: "member",
      ok: 201,
      request: () => ({ method: "POST", url: "/api/v1/me/tokens", payload: { label: `m${++n}` } }),
    },
    // 네이티브 푸시 기기(네이티브 푸시 스펙 5장) — 누구나, 자기 세션
    {
      name: "GET /push/capabilities",
      min: "member",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/push/capabilities" }),
    },
    {
      name: "POST /push/devices",
      min: "member",
      ok: 200,
      request: () => ({
        method: "POST",
        url: "/api/v1/push/devices",
        payload: { platform: "android", token: `matrix-${++n}`, appId: "chat.dodok.android" },
      }),
    },
    {
      name: "DELETE /push/devices",
      min: "member",
      ok: 204,
      request: () => ({ method: "DELETE", url: "/api/v1/push/devices", payload: { token: "matrix-none" } }),
    },
    // 멤버 비활성화·다시 활성화(채널 보관·멤버 비활성화 스펙 「멤버 비활성화」 절) — member 대상은 admin 이상
    {
      name: "POST /members/:userId/deactivate",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/members/${newMember(null)}/deactivate` }),
    },
    {
      name: "POST /members/:userId/reactivate",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/members/${newMember(new Date())}/reactivate` }),
    },
    // 자동화(자동화 스펙 「권한」 장) — 관리 API 여섯은 admin 이상. POST /hooks/<token> 은 세션이 아니라 토큰만 본다(automations.webhook.test.ts)
    {
      name: "GET /automations",
      min: "admin",
      ok: 200,
      request: () => ({ method: "GET", url: "/api/v1/automations" }),
    },
    {
      name: "POST /automations",
      min: "admin",
      ok: 201,
      request: () => ({
        method: "POST",
        url: "/api/v1/automations",
        payload: {
          kind: "schedule",
          name: `auto${++n}`,
          channelId: newChannel().id,
          bodyMd: "점검",
          schedule: { repeat: "daily", time: "09:00" },
        },
      }),
    },
    {
      name: "PATCH /automations/:id",
      min: "admin",
      ok: 200,
      request: () => ({
        method: "PATCH",
        url: `/api/v1/automations/${newAutomation("schedule")}`,
        payload: { enabled: false },
      }),
    },
    {
      name: "DELETE /automations/:id",
      min: "admin",
      ok: 204,
      request: () => ({ method: "DELETE", url: `/api/v1/automations/${newAutomation("schedule")}` }),
    },
    {
      name: "POST /automations/:id/token",
      min: "admin",
      ok: 200,
      request: () => ({ method: "POST", url: `/api/v1/automations/${newAutomation("webhook")}/token` }),
    },
    {
      name: "POST /automations/:id/run",
      min: "admin",
      ok: 202,
      request: () => ({ method: "POST", url: `/api/v1/automations/${newAutomation("schedule")}/run` }),
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

  it.each(ROLES)("POST /channels/:id/agents/:agentId/reset 은 없다 — %s 도 404", async (role) => {
    const { channel, agent } = channelWithAgent();
    const res = await call(tokens[role], {
      method: "POST",
      url: `/api/v1/channels/${channel.id}/agents/${agent.id}/reset`,
    });
    expect(res.statusCode, res.body).toBe(404);
  });

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

    // wire 이벤트는 membership 을 핸드셰이크·connection 에서 본다 — 그 문을 못 지나면 reaction.set 처리기에 닿지 않는다
    it("reaction.set — 핸드셰이크에서 막혀 반응이 생기지 않는다", async () => {
      const answer = agentAnswer();
      const socket = openWire(app, { token: gone.token, protocol: WIRE_PROTOCOL });
      sockets.push(socket);
      const err = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
        socket.once("connect", () => reject(new Error("접속이 거부되지 않았다")));
        socket.once("connect_error", (e) => resolve(e as Error & { data?: unknown }));
      });
      expect(err.data).toMatchObject({ code: "UNAUTHORIZED" });
      expect(reactionsOf(answer.id)).toEqual([]);
    });
  });

  // 반응(리액션 스펙 docs/superpowers/specs/2026-10-05-reactions-design.md 「권한」 절) — 누구나, 사용자 id 는 세션에서만
  describe("반응(wire reaction.set)", () => {
    it.each(ROLES)("%s 는 켜고 끌 수 있다 — 단 사람은 그 세션의 사용자", async (role) => {
      const answer = agentAnswer();
      const socket = await connectWire(app, tokens[role]);
      sockets.push(socket);
      const set = (on: boolean) =>
        socket.emitWithAck("reaction.set", { messageId: answer.id, emoji: "👍", on });

      expect(await set(true)).toEqual({ ok: true, data: null });
      expect(reactionsOf(answer.id)).toEqual([{ userId: ids[role], emoji: "👍" }]);
      expect(await set(false)).toEqual({ ok: true, data: null });
      expect(reactionsOf(answer.id)).toEqual([]);
    });
  });

  // 비활성 membership 은 없는 것과 같다(채널 보관·멤버 비활성화 계획 판정 PC3) — owner 역할이어도 막히는지 보려고 admin 이 아니라 owner 로 둔다
  describe("비활성 membership 의 세션", () => {
    let inactive: { id: string; token: string };
    beforeAll(async () => {
      inactive = await userWithRole(app, "inactive", "owner");
      app.db
        .update(memberships)
        .set({ deactivatedAt: new Date() })
        .where(and(eq(memberships.workspaceId, app.workspaceId), eq(memberships.userId, inactive.id)))
        .run();
    });

    it.each(CASES.map((c) => [c.name, c] as const))("%s — 401", async (_name, c) => {
      const res = await call(inactive.token, c.request());
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("/auth/me 401·wire 핸드셰이크 거절(UNAUTHORIZED)", async () => {
      expect((await call(inactive.token, { method: "GET", url: "/api/v1/auth/me" })).statusCode).toBe(401);
      const socket = openWire(app, { token: inactive.token, protocol: WIRE_PROTOCOL });
      sockets.push(socket);
      const err = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
        socket.once("connect", () => reject(new Error("접속이 거부되지 않았다")));
        socket.once("connect_error", (e) => resolve(e as Error & { data?: unknown }));
      });
      expect(err.data).toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("개인 토큰 — DELETE /me/tokens/:id 는 주인만", () => {
    it.each(ROLES)("%s 는 자기 토큰을 폐기하고(204) 남의 토큰은 404 — 남의 것은 산다", async (role) => {
      const own = issuePersonalToken(app.db, ids[role], "mine");
      const others = ROLES.filter((r) => r !== role).map((r) => issuePersonalToken(app.db, ids[r], "theirs"));
      for (const other of others) {
        const res = await call(tokens[role], {
          method: "DELETE",
          url: `/api/v1/me/tokens/${other.token.id}`,
        });
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
        expect(verifyPersonalToken(app.db, other.raw)).toBeDefined();
      }
      const res = await call(tokens[role], { method: "DELETE", url: `/api/v1/me/tokens/${own.token.id}` });
      expect(res.statusCode, res.body).toBe(204);
      expect(verifyPersonalToken(app.db, own.raw)).toBeUndefined();
    });

    it("세션이 없으면 401", async () => {
      const own = issuePersonalToken(app.db, ids.member, "mine");
      expect(
        (await call(undefined, { method: "DELETE", url: `/api/v1/me/tokens/${own.token.id}` })).statusCode,
      ).toBe(401);
      expect(verifyPersonalToken(app.db, own.raw)).toBeDefined();
    });
  });

  describe("승인", () => {
    const MINUTE = 60_000;
    const pendingApproval = async () => {
      const { channel, agent } = channelWithAgent();
      const frame: ProviderApproval = {
        providerApprovalId: `plugin:${uuid()}`,
        kind: "plugin",
        sessionKey: adapter.sessionKeyFor(agent.providerAgentId, channelConversation(app.db, channel.id)),
        providerAgentId: agent.providerAgentId,
        conversationId: channelConversation(app.db, channel.id),
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

  // 남의 DM(에이전트 DM 스펙 4장) — member mia 가 주인인 DM 을 주인이 아닌 owner·admin·member 가 치면 모든 경로가 없는 것과 같은 404
  // (wire 는 ack NOT_FOUND). 역할 판정(403)보다 먼저다 — admin 만 되는 경로에 member 도 403 이 아니라 404 다. 주인 mia 는 케이스마다
  // 적은 결과(owner)를 정확히 받는다 — 채널 관리 경로는 DM 에 VALIDATION(400), DM 의 PATCH {prompt} 는 역할과 무관하게 주인만(계획 판정 PD9)
  describe("남의 DM — DM_CASES", () => {
    let mia: { id: string; token: string };
    beforeAll(async () => {
      mia = await userWithRole(app, `dm-mia${++n}`, "member");
    });

    type DmFixture = {
      channelId: string;
      agent: Agent;
      conversationId: string;
      rootId: string;
      answer: Message;
      runId: string;
    };
    /** 경로마다·사람마다 새 DM — 주인의 쓰기(보관·멤버 빼기)가 다음 사람의 조건을 바꾸지 않게 */
    const dmFixture = (): DmFixture => {
      // mia(member)가 쓰기까지 하도록 dmAccess everyone — 기본 admins 면 주인의 쓰기가 409 DM_READ_ONLY 다(dms.test.ts)
      const agent = newAgent();
      app.db.update(agents).set({ dmAccess: "everyone" }).where(eq(agents.id, agent.id)).run();
      const dm = createDmChannelForTest(app.db, {
        workspaceId: app.workspaceId,
        ownerId: mia.id,
        agentId: agent.id,
      });
      const conversationId = seedConversation(app.db, dm.id, { createdBy: mia.id });
      const root = createUserMessage(app.db, app.bus, {
        conversationId,
        authorId: mia.id,
        bodyMd: "DM 루트",
        clientMsgId: `dm-root-${++n}`,
      });
      const run = insertRun(app.db, {
        channelId: dm.id,
        conversationId,
        agentId: agent.id,
        triggerKind: "auto_respond",
        triggerMessageId: root.id,
        rootMessageId: root.id,
        relayDepth: 0,
        sessionKey: adapter.sessionKeyFor(agent.providerAgentId, conversationId),
        connectionId: FAKE_GATEWAY_ID,
        requestedBy: mia.id,
        createdAt: new Date(),
      });
      const answer = createAgentMessage(app.db, app.bus, {
        conversationId,
        agentId: agent.id,
        runId: run.id,
        bodyMd: "골라 주세요",
        externalId: `dm-answer-${++n}`,
        components: {
          blocks: [{ type: "actions", id: "row", items: [{ type: "button", id: "go", label: "진행" }] }],
        },
      });
      return { channelId: dm.id, agent, conversationId, rootId: root.id, answer, runId: run.id };
    };
    /** mia 가 DM 에 올리고 자기 글에 묶은 첨부 */
    const dmAttachment = async (fx: DmFixture): Promise<string> => {
      const up = await app.fastify.inject({
        method: "POST",
        url: `/api/v1/attachments?channelId=${fx.channelId}`,
        headers: { authorization: `Bearer ${mia.token}`, "content-type": "image/png" },
        payload: makePng(2, 2),
      });
      expect(up.statusCode, up.body).toBe(200);
      const id = (up.json() as { id: string }).id;
      createUserMessage(app.db, app.bus, {
        conversationId: fx.conversationId,
        authorId: mia.id,
        bodyMd: "그림",
        clientMsgId: `dm-att-${++n}`,
        attachments: [id],
      });
      return id;
    };

    type DmRequest = {
      method: Method;
      url: string;
      payload?: object | Buffer;
      headers?: Record<string, string>;
    };
    type DmCase = {
      name: string;
      /** 주인 mia(member)의 상태 코드 — 400 은 DM 에 맞지 않는 채널 관리 경로의 VALIDATION(역할 정책보다 먼저, 계획 판정 PD9) */
      owner: 200 | 400;
      request: (fx: DmFixture) => DmRequest | Promise<DmRequest>;
    };
    const DM_CASES: DmCase[] = [
      {
        name: "GET /channels/:id",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/channels/${fx.channelId}` }),
      },
      {
        name: "PATCH /channels/:id {name}",
        owner: 400,
        request: (fx) => ({
          method: "PATCH",
          url: `/api/v1/channels/${fx.channelId}`,
          payload: { name: "엿보기" },
        }),
      },
      {
        name: "PATCH /channels/:id {prompt} — 일반 채널은 admin 정책, DM 은 주인",
        owner: 200,
        request: (fx) => ({
          method: "PATCH",
          url: `/api/v1/channels/${fx.channelId}`,
          payload: { prompt: "몰래" },
        }),
      },
      {
        name: "GET /channels/:id/members",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/channels/${fx.channelId}/members` }),
      },
      {
        name: "POST /channels/:id/members",
        owner: 400,
        request: (fx) => ({
          method: "POST",
          url: `/api/v1/channels/${fx.channelId}/members`,
          payload: { memberType: "user", memberId: ids.member },
        }),
      },
      {
        name: "PATCH /channels/:id/members/:memberId {autoRespond} — admin 정책 경로",
        owner: 400,
        request: (fx) => ({
          method: "PATCH",
          url: `/api/v1/channels/${fx.channelId}/members/${fx.agent.id}`,
          payload: { autoRespond: false },
        }),
      },
      {
        name: "DELETE /channels/:id/members/:memberId",
        owner: 400,
        request: (fx) => ({
          method: "DELETE",
          url: `/api/v1/channels/${fx.channelId}/members/${fx.agent.id}`,
        }),
      },
      {
        name: "POST /channels/:id/archive",
        owner: 400,
        request: (fx) => ({ method: "POST", url: `/api/v1/channels/${fx.channelId}/archive` }),
      },
      {
        name: "POST /channels/:id/unarchive",
        owner: 400,
        request: (fx) => ({ method: "POST", url: `/api/v1/channels/${fx.channelId}/unarchive` }),
      },
      {
        name: "PUT /channels/:id/session-managers/:userId",
        owner: 400,
        request: (fx) => ({
          method: "PUT",
          url: `/api/v1/channels/${fx.channelId}/session-managers/${mia.id}`,
        }),
      },
      {
        name: "DELETE /channels/:id/session-managers/:userId",
        owner: 400,
        request: (fx) => ({
          method: "DELETE",
          url: `/api/v1/channels/${fx.channelId}/session-managers/${mia.id}`,
        }),
      },
      {
        name: "GET /channels/:id/conversations",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/channels/${fx.channelId}/conversations` }),
      },
      {
        name: "GET /conversations/:id",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/conversations/${fx.conversationId}` }),
      },
      {
        name: "PATCH /conversations/:id {title}",
        owner: 200,
        request: (fx) => ({
          method: "PATCH",
          url: `/api/v1/conversations/${fx.conversationId}`,
          payload: { title: "엿보기" },
        }),
      },
      {
        name: "PATCH /conversations/:id {closed}",
        owner: 200,
        request: (fx) => ({
          method: "PATCH",
          url: `/api/v1/conversations/${fx.conversationId}`,
          payload: { closed: true },
        }),
      },
      {
        name: "GET /conversations/:id/messages",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/conversations/${fx.conversationId}/messages` }),
      },
      {
        name: "GET /conversations/:id/messages?around",
        owner: 200,
        request: (fx) => ({
          method: "GET",
          url: `/api/v1/conversations/${fx.conversationId}/messages?around=1`,
        }),
      },
      {
        name: "GET /conversations/:id/threads/:rootId/messages",
        owner: 200,
        request: (fx) => ({
          method: "GET",
          url: `/api/v1/conversations/${fx.conversationId}/threads/${fx.rootId}/messages`,
        }),
      },
      {
        name: "GET /channels/:id/runs",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/channels/${fx.channelId}/runs` }),
      },
      {
        name: "GET /runs/:id",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/runs/${fx.runId}` }),
      },
      {
        name: "GET /runs/:id/events",
        owner: 200,
        request: (fx) => ({ method: "GET", url: `/api/v1/runs/${fx.runId}/events` }),
      },
      {
        name: "POST /attachments?channelId=",
        owner: 200,
        request: (fx) => ({
          method: "POST",
          url: `/api/v1/attachments?channelId=${fx.channelId}`,
          headers: { "content-type": "image/png" },
          payload: makePng(2, 2),
        }),
      },
      {
        name: "GET /attachments/:id(DM 메시지에 묶인 첨부)",
        owner: 200,
        request: async (fx) => ({ method: "GET", url: `/api/v1/attachments/${await dmAttachment(fx)}` }),
      },
    ];
    const dmCall = (token: string, req: DmRequest) =>
      app.fastify.inject({
        method: req.method,
        url: req.url,
        headers: { authorization: `Bearer ${token}`, ...req.headers },
        ...(req.payload === undefined ? {} : { payload: req.payload }),
      });

    it.each(DM_CASES.flatMap((c) => ROLES.map((role) => [c.name, role, c] as const)))(
      "%s — 주인 아닌 %s 는 404",
      async (_name, role, c) => {
        const res = await dmCall(tokens[role], await c.request(dmFixture()));
        expect(res.statusCode, res.body).toBe(404);
        expect(res.json()).toMatchObject({ code: "NOT_FOUND" });
      },
    );

    it.each(DM_CASES.map((c) => [c.name, c.owner, c] as const))(
      "%s — 주인 mia 는 %d",
      async (_name, _owner, c) => {
        const res = await dmCall(mia.token, await c.request(dmFixture()));
        expect(res.statusCode, res.body).toBe(c.owner);
        if (c.owner === 400) expect(res.json()).toMatchObject({ code: "VALIDATION" });
      },
    );

    // wire — 주인이 아니면 ack NOT_FOUND, 주인은 owner 결과(ok 또는 오류 코드)
    type WireCase = {
      name: string;
      owner: "ok" | "VALIDATION";
      emit: (socket: WireClient, fx: DmFixture) => Promise<unknown>;
    };
    const WIRE_CASES: WireCase[] = [
      {
        name: "channel.subscribe",
        owner: "ok",
        emit: (socket, fx) => socket.emitWithAck("channel.subscribe", { channelId: fx.channelId }),
      },
      {
        name: "message.send",
        owner: "ok",
        emit: (socket, fx) =>
          socket.emitWithAck("message.send", {
            channelId: fx.channelId,
            conversationId: fx.conversationId,
            clientMsgId: `dm-send-${++n}`,
            bodyMd: "엿보기",
          }),
      },
      {
        name: "message.send {newConversation}",
        owner: "ok",
        emit: (socket, fx) =>
          socket.emitWithAck("message.send", {
            channelId: fx.channelId,
            newConversation: {},
            clientMsgId: `dm-new-${++n}`,
            bodyMd: "엿보기",
          }),
      },
      {
        name: "conversation.read",
        owner: "ok",
        emit: (socket, fx) =>
          socket.emitWithAck("conversation.read", { conversationId: fx.conversationId, seq: 99 }),
      },
      {
        name: "reaction.set",
        owner: "ok",
        emit: (socket, fx) =>
          socket.emitWithAck("reaction.set", { messageId: fx.answer.id, emoji: "👍", on: true }),
      },
      {
        name: "run.abort",
        owner: "ok",
        emit: (socket, fx) => socket.emitWithAck("run.abort", { runId: fx.runId }),
      },
      {
        name: "run.events.replay",
        owner: "ok",
        emit: (socket, fx) => socket.emitWithAck("run.events.replay", { runId: fx.runId, afterSeq: 0 }),
      },
      {
        name: "component.interact",
        owner: "ok",
        emit: (socket, fx) =>
          socket.emitWithAck("component.interact", {
            messageId: fx.answer.id,
            componentId: fx.answer.components?.id ?? "",
            itemId: "go",
            values: {},
          }),
      },
      {
        // 읽을 수 있는 일반 채널 + 남의 DM 의 대화 — 남에게는 없는 대화와 같고, 주인에게는 다른 채널의 세션이라 VALIDATION
        name: "message.send {일반 채널 + DM 대화}",
        owner: "VALIDATION",
        emit: (socket, fx) =>
          socket.emitWithAck("message.send", {
            channelId: newChannel().id,
            conversationId: fx.conversationId,
            clientMsgId: `dm-cross-${++n}`,
            bodyMd: "엿보기",
          }),
      },
    ];

    it.each(WIRE_CASES.flatMap((c) => ROLES.map((role) => [c.name, role, c] as const)))(
      "wire %s — 주인 아닌 %s 는 ack NOT_FOUND",
      async (_name, role, c) => {
        const fx = dmFixture();
        const socket = await connectWire(app, tokens[role]);
        sockets.push(socket);
        expect(await c.emit(socket, fx)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      },
    );

    it.each(WIRE_CASES.map((c) => [c.name, c.owner, c] as const))(
      "wire %s — 주인 mia 는 %s",
      async (_name, _owner, c) => {
        const fx = dmFixture();
        const socket = await connectWire(app, mia.token);
        sockets.push(socket);
        const res = (await c.emit(socket, fx)) as { ok: boolean; error?: { code: string } };
        expect(res.ok ? "ok" : res.error?.code, JSON.stringify(res)).toBe(c.owner);
      },
    );

    it.each(ROLES)(
      "channel.subscribe 를 거절당한 %s 는 그 DM 의 message.created 를 받지 않는다 — 룸에 들지 않았다",
      async (role) => {
        const fx = dmFixture();
        const socket = await connectWire(app, tokens[role]);
        sockets.push(socket);
        const seen = recordEvents(socket, ["message.created"]);
        await socket.emitWithAck("channel.subscribe", { channelId: fx.channelId });
        createUserMessage(app.db, app.bus, {
          conversationId: fx.conversationId,
          authorId: mia.id,
          bodyMd: "구독 뒤 새 글",
          clientMsgId: `dm-after-${++n}`,
        });
        // 같은 연결의 ack 왕복 뒤에 본다 — 팬아웃이 먼저 도착했어야 한다
        await socket.emitWithAck("channel.unsubscribe", { channelId: fx.channelId });
        expect(
          seen.filter((e) => (e.payload as { message: Message }).message.channelId === fx.channelId),
        ).toEqual([]);
      },
    );

    it("주인 mia 는 구독 뒤 그 DM 의 message.created 를 받는다(위 단언의 대조)", async () => {
      const fx = dmFixture();
      const socket = await connectWire(app, mia.token);
      sockets.push(socket);
      await socket.emitWithAck("channel.subscribe", { channelId: fx.channelId });
      const created = waitFor(socket, "message.created", (p) => p.message.channelId === fx.channelId);
      createUserMessage(app.db, app.bus, {
        conversationId: fx.conversationId,
        authorId: mia.id,
        bodyMd: "구독 뒤 새 글",
        clientMsgId: `dm-after-${++n}`,
      });
      await expect(created).resolves.toBeDefined();
    });

    /** DM 런의 도구 승인 — owner·admin 은 지금 「admin 이상이면 결정」 갈래라 404 가 먼저인지가 핵심이다(Review Focus 1) */
    const dmApproval = async () => {
      const fx = dmFixture();
      const frame: ProviderApproval = {
        providerApprovalId: `plugin:${uuid()}`,
        kind: "plugin",
        sessionKey: adapter.sessionKeyFor(fx.agent.providerAgentId, fx.conversationId),
        providerAgentId: fx.agent.providerAgentId,
        conversationId: fx.conversationId,
        toolCallId: `toolu_${++n}`,
        toolName: "Write",
        pluginId: "fs",
        title: "Write 실행",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      };
      adapter.emitApproval(frame);
      await vi.waitFor(() =>
        expect(approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId)?.status).toBe(
          "pending",
        ),
      );
      const approval = approvalStore.getApprovalByProviderId(app.db, frame.providerApprovalId);
      if (!approval) throw new Error("승인이 저장되지 않았다");
      expect(approval.channelId).toBe(fx.channelId);
      return approval;
    };

    it.each(ROLES)(
      "approval.resolve — 주인 아닌 %s 는 ack NOT_FOUND, Gateway 로 안 가고 pending 그대로",
      async (role) => {
        const approval = await dmApproval();
        const socket = await connectWire(app, tokens[role]);
        sockets.push(socket);
        const sent = adapter.calls.resolveApproval.length;
        const res = await socket.emitWithAck("approval.resolve", {
          approvalId: approval.id,
          decision: "allow-once",
        });
        expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
        expect(adapter.calls.resolveApproval.length).toBe(sent);
        expect(approvalStore.getApproval(app.db, approval.id)?.status).toBe("pending");
      },
    );

    it.each(ROLES)(
      "approval.resolve — 없는 승인은 %s 에게도 ack NOT_FOUND(남의 DM 승인과 같은 답 — 승인 서비스와 같은 문구)",
      async (role) => {
        const socket = await connectWire(app, tokens[role]);
        sockets.push(socket);
        expect(
          await socket.emitWithAck("approval.resolve", { approvalId: uuid(), decision: "deny" }),
        ).toEqual({
          ok: false,
          error: { code: "NOT_FOUND", message: "approval not found" },
        });
      },
    );

    it("approval.resolve — member 주인 mia 가 결정한다(DM 의 승인은 역할과 무관하게 주인 — 계획 판정 PD7)", async () => {
      const approval = await dmApproval();
      const socket = await connectWire(app, mia.token);
      sockets.push(socket);
      const res = (await socket.emitWithAck("approval.resolve", {
        approvalId: approval.id,
        decision: "deny",
      })) as { ok: boolean; error?: { code: string } };
      expect(res.ok ? "ok" : res.error?.code, JSON.stringify(res)).toBe("ok");
      expect(approvalStore.getApproval(app.db, approval.id)).toMatchObject({ decidedBy: mia.id });
    });

    // ── 목록 ──
    it("GET /channels 에는 DM 이 없다 — 주인 mia 에게도(DM 은 따로 받는다, 계획 판정 PD3)", async () => {
      const fx = dmFixture();
      for (const token of [...ROLES.map((r) => tokens[r]), mia.token]) {
        const res = await dmCall(token, { method: "GET", url: "/api/v1/channels" });
        expect(res.statusCode).toBe(200);
        const listed = (res.json() as { channels: Channel[] }).channels;
        expect(listed.map((c) => c.id)).not.toContain(fx.channelId);
        expect(listed.every((c) => c.kind === "channel")).toBe(true);
      }
    });

    it("GET /search — DM 본문 단어는 주인에게만 걸린다", async () => {
      const fx = dmFixture();
      const word = `dmsecret${++n}word`;
      createUserMessage(app.db, app.bus, {
        conversationId: fx.conversationId,
        authorId: mia.id,
        bodyMd: `비밀 ${word}`,
        clientMsgId: `dm-word-${n}`,
      });
      const search = (token: string) => dmCall(token, { method: "GET", url: `/api/v1/search?q=${word}` });
      for (const role of ROLES) {
        const res = await search(tokens[role]);
        expect(res.statusCode, res.body).toBe(200);
        expect((res.json() as SearchResult).hits).toEqual([]);
      }
      const own = await search(mia.token);
      expect((own.json() as SearchResult).hits.map((h) => h.channelId)).toEqual([fx.channelId]);
    });

    it("GET /me/unread — 그 DM 의 대화·채널은 주인의 스냅숏에만", async () => {
      const fx = dmFixture();
      for (const role of ROLES) {
        const res = await dmCall(tokens[role], { method: "GET", url: "/api/v1/me/unread" });
        const snap = res.json() as UnreadSnapshot;
        expect(snap.conversations.map((c) => c.conversationId)).not.toContain(fx.conversationId);
        expect(snap.channels).not.toContain(fx.channelId);
      }
      const own = (
        await dmCall(mia.token, { method: "GET", url: "/api/v1/me/unread" })
      ).json() as UnreadSnapshot;
      expect(own.conversations.map((c) => c.conversationId)).toContain(fx.conversationId);
      expect(own.channels).toContain(fx.channelId);
    });

    // ── 제어 도구(개인 토큰 주체) — 같은 서비스를 에이전트 주체도 지난다 ──
    const controlAs = (userId: string, tool: string, args: object) =>
      app.control.call(pat(userId), tool, args);
    /** owner — 주인 mia(member, 개인 토큰)의 결과. 채널 쓰기 도구는 DM 에 VALIDATION(역할 정책보다 먼저 — 계획 판정 PD9) */
    const CONTROL_CASES: Array<{
      tool: string;
      owner: "ok" | "VALIDATION";
      args: (fx: DmFixture) => object;
    }> = [
      { tool: "get_channel", owner: "ok", args: (fx) => ({ channelId: fx.channelId }) },
      { tool: "list_conversations", owner: "ok", args: (fx) => ({ channelId: fx.channelId }) },
      { tool: "read_messages", owner: "ok", args: (fx) => ({ conversationId: fx.conversationId }) },
      { tool: "get_run", owner: "ok", args: (fx) => ({ runId: fx.runId }) },
      {
        tool: "update_channel",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, name: "엿보기" }),
      },
      {
        tool: "set_channel_prompt",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, prompt: "몰래" }),
      },
      {
        tool: "add_channel_agent",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, agentId: newAgent().id }),
      },
      {
        tool: "remove_channel_agent",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, agentId: fx.agent.id }),
      },
      {
        tool: "update_channel_agent",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, agentId: fx.agent.id, autoRespond: false }),
      },
      {
        tool: "set_relay_policy",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, relayPolicy: { maxRelayTurns: 1, allowPairs: "all" } }),
      },
      {
        tool: "set_channel_run_limit",
        owner: "VALIDATION",
        args: (fx) => ({ channelId: fx.channelId, dailyRunLimit: 3 }),
      },
      { tool: "archive_channel", owner: "VALIDATION", args: (fx) => ({ channelId: fx.channelId }) },
      { tool: "unarchive_channel", owner: "VALIDATION", args: (fx) => ({ channelId: fx.channelId }) },
    ];

    it.each(CONTROL_CASES.flatMap((c) => ROLES.map((role) => [c.tool, role, c] as const)))(
      "제어 %s — 주인 아닌 %s 는 NOT_FOUND",
      async (_tool, role, c) => {
        const res = await controlAs(ids[role], c.tool, c.args(dmFixture()));
        expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      },
    );

    it.each(CONTROL_CASES.map((c) => [c.tool, c.owner, c] as const))(
      "제어 %s — 주인 mia 는 %s",
      async (_tool, _owner, c) => {
        const res = await controlAs(mia.id, c.tool, c.args(dmFixture()));
        expect(res.ok ? "ok" : res.error.code, JSON.stringify(res)).toBe(c.owner);
      },
    );

    it("제어 list_channels·search_messages — DM 은 주인에게만 나온다", async () => {
      const fx = dmFixture();
      const word = `dmctl${++n}word`;
      createUserMessage(app.db, app.bus, {
        conversationId: fx.conversationId,
        authorId: mia.id,
        bodyMd: `비밀 ${word}`,
        clientMsgId: `dm-ctl-${n}`,
      });
      const listed = async (userId: string) =>
        (expectOk(await controlAs(userId, "list_channels", {})) as { channels: Channel[] }).channels.map(
          (c) => c.id,
        );
      const found = async (userId: string) =>
        (expectOk(await controlAs(userId, "search_messages", { q: word })) as SearchResult).hits.map(
          (h) => h.channelId,
        );
      for (const role of ROLES) {
        expect(await listed(ids[role])).not.toContain(fx.channelId);
        expect(await found(ids[role])).toEqual([]);
      }
      expect(await listed(mia.id)).toContain(fx.channelId);
      expect(await found(mia.id)).toEqual([fx.channelId]);
    });

    // ── 제어 도구(채널 안 에이전트 주체) — 시킨 사람의 DM 은 그 런의 DM 하나만(계획 판정 PD3, 태스크 1 리뷰 M1) ──
    /** mia 의 DM 에 단어 하나를 남긴다 — 검색이 그 DM 을 거르는지 본다 */
    const secretIn = (fx: DmFixture): string => {
      const word = `dmagent${++n}word`;
      createUserMessage(app.db, app.bus, {
        conversationId: fx.conversationId,
        authorId: mia.id,
        bodyMd: `비밀 ${word}`,
        clientMsgId: `dm-agent-${n}`,
      });
      return word;
    };
    const channelIds = (res: ControlResult) =>
      (expectOk(res) as { channels: Channel[] }).channels.map((c) => c.id);
    const hitChannels = (res: ControlResult) => (expectOk(res) as SearchResult).hits.map((h) => h.channelId);

    it.each(CONTROL_CASES.map((c) => [c.tool, c] as const))(
      "제어 %s — 일반 채널 런의 에이전트는 시킨 사람 mia 의 DM 도 NOT_FOUND",
      async (_tool, c) => {
        // 도구마다 새 런·새 에이전트 — 쓰기 버킷은 주체(에이전트)마다 센다
        const { principal } = openControlRun(app, mia.id);
        const res = await app.control.call(principal, c.tool, c.args(dmFixture()));
        expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      },
    );

    it("제어 list_channels·search_messages — 일반 채널 런의 에이전트에게 시킨 사람 mia 의 DM 은 나오지 않는다", async () => {
      const fx = dmFixture();
      const word = secretIn(fx);
      const { principal, channel } = openControlRun(app, mia.id);
      const listed = channelIds(await app.control.call(principal, "list_channels", {}));
      expect(listed).toContain(channel.id);
      expect(listed).not.toContain(fx.channelId);
      expect(hitChannels(await app.control.call(principal, "search_messages", { q: word }))).toEqual([]);
    });

    it.each(CONTROL_CASES.map((c) => [c.tool, c] as const))(
      "제어 %s — DM 런의 에이전트는 mia 의 다른 DM 이 NOT_FOUND",
      async (_tool, c) => {
        const own = dmFixture();
        const principal: Principal = {
          userId: mia.id,
          via: "agent",
          agentId: own.agent.id,
          runId: own.runId,
        };
        const res = await app.control.call(principal, c.tool, c.args(dmFixture()));
        expect(res).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
      },
    );

    it("제어 — DM 런의 에이전트는 그 DM 을 읽고, 목록·검색에도 그 DM 하나만 나온다", async () => {
      const own = dmFixture();
      const other = dmFixture();
      const ownWord = secretIn(own);
      const otherWord = secretIn(other);
      const principal: Principal = { userId: mia.id, via: "agent", agentId: own.agent.id, runId: own.runId };
      const as = (tool: string, args: object) => app.control.call(principal, tool, args);
      expectOk(await as("get_channel", { channelId: own.channelId }));
      expectOk(await as("list_conversations", { channelId: own.channelId }));
      expect(
        (
          expectOk(await as("read_messages", { conversationId: own.conversationId })) as {
            messages: unknown[];
          }
        ).messages.length,
      ).toBeGreaterThan(0);
      expectOk(await as("get_run", { runId: own.runId }));
      const listed = channelIds(await as("list_channels", {}));
      expect(listed).toContain(own.channelId);
      expect(listed).not.toContain(other.channelId);
      expect(hitChannels(await as("search_messages", { q: ownWord }))).toEqual([own.channelId]);
      expect(hitChannels(await as("search_messages", { q: otherWord }))).toEqual([]);
    });

    // 런의 채널이 DM 이어도 시킨 사람이 그 주인이 아니면 열리지 않는다 — readableChannelSqlFor 의 「dm_owner_id = 시킨 사람」(태스크 1
    // 재리뷰 N1). 지금은 DM 런의 시킨 사람이 늘 주인이라 닿는 길이 없다 — 행을 DB 로 바꿔 심층 방어를 고정한다
    it.each([
      ["다른 사람(admin)", (): string | null => ids.admin],
      ["시킨 사람 없음", (): string | null => null],
    ] as const)(
      "제어 — DM 런을 가리켜도 시킨 사람이 주인이 아니면(%s) 그 DM 은 NOT_FOUND·목록 밖",
      async (_name, who) => {
        const own = dmFixture();
        const word = secretIn(own);
        const userId = who();
        app.db.update(runs).set({ requestedBy: userId }).where(eq(runs.id, own.runId)).run();
        const principal: Principal = { userId, via: "agent", agentId: own.agent.id, runId: own.runId };
        const as = (tool: string, args: object) => app.control.call(principal, tool, args);
        expect(await as("read_messages", { conversationId: own.conversationId })).toMatchObject({
          ok: false,
          error: { code: "NOT_FOUND" },
        });
        expect(await as("get_channel", { channelId: own.channelId })).toMatchObject({
          ok: false,
          error: { code: "NOT_FOUND" },
        });
        expect(channelIds(await as("list_channels", {}))).not.toContain(own.channelId);
        expect(hitChannels(await as("search_messages", { q: word }))).toEqual([]);
      },
    );
  });
});
