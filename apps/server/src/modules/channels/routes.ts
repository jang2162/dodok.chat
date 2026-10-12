import {
  AddChannelMemberBody,
  CreateChannelBody,
  Id,
  UpdateChannelBody,
  UpdateChannelMemberBody,
} from "@dodok/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Auth } from "../../auth";
import {
  assertRole,
  hasFieldOutside,
  MEMBER_EDITABLE_AGENT_MEMBER_FIELDS,
  MEMBER_EDITABLE_CHANNEL_FIELDS,
  requireRole,
} from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import type { Orchestrator } from "../runs/orchestrator";
import { syncChannelPrompt, syncPromptToGateway } from "./prompt-sync";
import {
  addMember,
  archiveChannel,
  assertChannelWritable,
  type ChannelRecord,
  channelGatewayIds,
  createChannel,
  getChannel,
  listChannels,
  listMembers,
  removeMember,
  resetAgentSession,
  unarchiveChannel,
  updateAgentMember,
  updateChannel,
} from "./service";

export type ChannelRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  /** 「새 대화」는 그 에이전트의 어댑터로, 채널 프롬프트 동기화는 OpenClaw 어댑터로 */
  registry: Pick<AdapterRegistry, "forAgent" | "forProvider">;
  /** 「새 대화」가 그 세션의 진행 런을 멈출 때 */
  orchestrator: Pick<Orchestrator, "activeRuns" | "abort">;
};

const ChannelParams = z.object({ id: Id });
const MemberParams = z.object({ id: Id, memberId: Id });
const AgentParams = z.object({ id: Id, agentId: Id });
/** 기본은 살아 있는 채널, archived=1 이면 보관한 채널(누구나 — 읽기는 막지 않는다) */
const ListQuery = z.object({ archived: z.literal("1").optional() });
/** 「새 대화」 — 스레드 루트를 주면 그 스레드 세션만(스펙 2.4) */
const ResetQuery = z.object({ threadRootId: Id.optional() });

export function registerChannelRoutes(fastify: FastifyInstance, ctx: ChannelRouteContext): void {
  const authed = { preHandler: requireSession(ctx) };
  const admin = { preHandler: requireRole(ctx, "admin") };
  /** 필드별 역할 검사 — 파싱 뒤, 어떤 쓰기보다 먼저 부른다(403 이면 아무 필드도 안 바뀐다) */
  const assertFields = (request: FastifyRequest, allowed: ReadonlySet<string>) => {
    if (!hasFieldOutside(request.body, allowed)) return;
    const user = sessionUser(request);
    assertRole(ctx.db, user.workspaceId, user.id, "admin");
  };

  /** 요청자 워크스페이스의 채널만 — 아니면 404 */
  const loadChannel = (workspaceId: string, id: string): ChannelRecord => {
    const channel = getChannel(ctx.db, id, workspaceId);
    if (!channel) throw apiError("NOT_FOUND", "channel not found");
    return channel;
  };

  /** 쓰기 경로 — 보관한 채널이면 409 CHANNEL_ARCHIVED(계획 판정 PC1) */
  const loadWritable = (workspaceId: string, id: string): ChannelRecord =>
    assertChannelWritable(ctx.db, id, workspaceId);

  const emitMembers = (channelId: string) =>
    ctx.bus.emit("channel.member.changed", { channelId, members: listMembers(ctx.db, channelId) });

  fastify.get("/api/v1/channels", authed, async (request) => {
    const { archived } = parseQuery(ListQuery, request.query);
    return {
      channels: listChannels(ctx.db, sessionUser(request).workspaceId, { archived: archived === "1" }),
    };
  });

  fastify.post("/api/v1/channels", authed, async (request, reply) => {
    const user = sessionUser(request);
    const body = parseBody(CreateChannelBody, request.body);
    // 만들 때 name·topic 밖의 필드(프롬프트·릴레이 정책·공개 범위)를 실으면 PATCH 와 같이 admin 몫
    assertFields(request, MEMBER_EDITABLE_CHANNEL_FIELDS);
    const channel = createChannel(ctx.db, { ...body, workspaceId: user.workspaceId, createdBy: user.id });
    // 채널 룸에는 아직 아무도 없다 — 워크스페이스 룸으로 알려 다른 탭의 목록에 바로 뜨게 한다(계획서 8장 이월)
    ctx.bus.emit("channel.created", { channel });
    return reply.code(201).send({ channel });
  });

  fastify.get("/api/v1/channels/:id", authed, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    return { channel: loadChannel(sessionUser(request).workspaceId, id) };
  });

  fastify.patch("/api/v1/channels/:id", authed, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadWritable(sessionUser(request).workspaceId, id);
    const patch = parseBody(UpdateChannelBody, request.body);
    assertFields(request, MEMBER_EDITABLE_CHANNEL_FIELDS);
    const { channel, promptChanged } = updateChannel(ctx.db, id, patch);
    ctx.bus.emit("channel.updated", { channel });
    // 채널 변경은 이미 유효하다 — Gateway 반영은 비동기, 실패는 system.notice 로만 알린다(스펙 3.4)
    if (promptChanged && patch.prompt !== undefined) syncChannelPrompt(ctx, channel);
    return { channel };
  });

  fastify.get("/api/v1/channels/:id/members", authed, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadChannel(sessionUser(request).workspaceId, id);
    return { members: listMembers(ctx.db, id) };
  });

  fastify.post("/api/v1/channels/:id/members", authed, async (request, reply) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadWritable(sessionUser(request).workspaceId, id);
    const body = parseBody(AddChannelMemberBody, request.body);
    // 사람 멤버는 promptOverride·autoRespond 를 못 가진다 — 서비스가 400 으로 막는다
    if (body.memberType === "agent") assertFields(request, MEMBER_EDITABLE_AGENT_MEMBER_FIELDS);
    const gatewaysBefore = body.memberType === "agent" ? channelGatewayIds(ctx.db, id) : [];
    const member = addMember(ctx.db, id, body, ctx.logger);
    emitMembers(id);
    // 다른 Gateway 의 에이전트가 처음 들어오면 그 Gateway 에 이 채널의 프롬프트를 한 번(계획 판정 PG10)
    if (body.memberType === "agent") {
      for (const gatewayId of channelGatewayIds(ctx.db, id))
        if (!gatewaysBefore.includes(gatewayId)) syncPromptToGateway(ctx, id, gatewayId);
    }
    return reply.code(201).send({ member });
  });

  fastify.patch("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadWritable(sessionUser(request).workspaceId, id);
    const patch = parseBody(UpdateChannelMemberBody, request.body);
    assertFields(request, MEMBER_EDITABLE_AGENT_MEMBER_FIELDS);
    const { member } = updateAgentMember(ctx.db, id, memberId, patch, ctx.logger);
    emitMembers(id);
    return { member };
  });

  fastify.delete("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadWritable(sessionUser(request).workspaceId, id);
    removeMember(ctx.db, id, memberId);
    const members = listMembers(ctx.db, id);
    ctx.bus.emit("channel.member.changed", { channelId: id, members });
    return { members };
  });

  /**
   * 보관(채널 보관 스펙 「채널 보관」 절, admin) — 기록은 남고 열린 런은 멈춘다. 이미 보관했으면 200 그대로. channel.updated 는
   * 워크스페이스 방으로 간다 — 다른 사람의 사이드바에서 빠지고 열린 화면이 읽기 전용으로 바뀐다
   */
  fastify.post("/api/v1/channels/:id/archive", admin, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    const channel = await archiveChannel(ctx, id, sessionUser(request).workspaceId);
    ctx.bus.emit("channel.updated", { channel });
    return { channel };
  });

  /** 보관 해제(admin) — 같은 멤버·세션으로 돌아온다. 살아 있으면 200 그대로 */
  fastify.post("/api/v1/channels/:id/unarchive", admin, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    const channel = unarchiveChannel(ctx.db, id, sessionUser(request).workspaceId);
    ctx.bus.emit("channel.updated", { channel });
    return { channel };
  });

  /** 「새 대화」(스펙 3.4) — 409 CONFLICT(ADAPTER_CAPABILITY_MISSING)·503 ADAPTER_UNAVAILABLE 등은 서비스가 정한다 */
  fastify.post("/api/v1/channels/:id/agents/:agentId/reset", admin, async (request) => {
    const { id, agentId } = parseParams(AgentParams, request.params);
    const { threadRootId } = parseQuery(ResetQuery, request.query);
    loadWritable(sessionUser(request).workspaceId, id);
    await resetAgentSession(ctx, { channelId: id, agentId, threadRootId });
    return { ok: true };
  });
}
