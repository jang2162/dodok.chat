import { Channel, ChannelMember, Id } from "@dodok/shared";
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
import {
  addMember,
  type ChannelRecord,
  channelGatewayIds,
  createChannel,
  getChannel,
  listChannels,
  listMembers,
  removeMember,
  resetAgentSession,
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
/** 「새 대화」 — 스레드 루트를 주면 그 스레드 세션만(스펙 2.4) */
const ResetQuery = z.object({ threadRootId: Id.optional() });

const CreateChannelBody = Channel.pick({
  name: true,
  topic: true,
  prompt: true,
  relayPolicy: true,
  visibility: true,
}).partial({ relayPolicy: true, visibility: true });

/** topic·prompt 는 null 로 지운다. relayPolicy 는 통째로 바꾼다(빠진 필드는 기본값). */
const UpdateChannelBody = Channel.pick({ name: true, relayPolicy: true, visibility: true }).partial().extend({
  topic: Channel.shape.topic.unwrap().nullable().optional(),
  prompt: Channel.shape.prompt.unwrap().nullable().optional(),
});

const AddMemberBody = ChannelMember.pick({
  memberType: true,
  memberId: true,
  promptOverride: true,
  autoRespond: true,
  aliases: true,
});

/** 기본값이 붙은 필드는 unwrap — partial 만 쓰면 빠진 필드가 기본값으로 덮인다 */
const UpdateMemberBody = z.object({
  promptOverride: ChannelMember.shape.promptOverride.unwrap().nullable().optional(),
  autoRespond: ChannelMember.shape.autoRespond.unwrap().optional(),
  aliases: ChannelMember.shape.aliases.unwrap().optional(),
});

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

  const emitMembers = (channelId: string) =>
    ctx.bus.emit("channel.member.changed", { channelId, members: listMembers(ctx.db, channelId) });

  fastify.get("/api/v1/channels", authed, async (request) => ({
    channels: listChannels(ctx.db, sessionUser(request).workspaceId),
  }));

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
    loadChannel(sessionUser(request).workspaceId, id);
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
    loadChannel(sessionUser(request).workspaceId, id);
    const body = parseBody(AddMemberBody, request.body);
    // 사람 멤버는 promptOverride·autoRespond 를 못 가진다 — 서비스가 400 으로 막는다
    if (body.memberType === "agent") assertFields(request, MEMBER_EDITABLE_AGENT_MEMBER_FIELDS);
    const member = addMember(ctx.db, id, body, ctx.logger);
    emitMembers(id);
    return reply.code(201).send({ member });
  });

  fastify.patch("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadChannel(sessionUser(request).workspaceId, id);
    const patch = parseBody(UpdateMemberBody, request.body);
    assertFields(request, MEMBER_EDITABLE_AGENT_MEMBER_FIELDS);
    const { member } = updateAgentMember(ctx.db, id, memberId, patch, ctx.logger);
    emitMembers(id);
    return { member };
  });

  fastify.delete("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadChannel(sessionUser(request).workspaceId, id);
    removeMember(ctx.db, id, memberId);
    const members = listMembers(ctx.db, id);
    ctx.bus.emit("channel.member.changed", { channelId: id, members });
    return { members };
  });

  /** 「새 대화」(스펙 3.4) — 409 CONFLICT(ADAPTER_CAPABILITY_MISSING)·503 ADAPTER_UNAVAILABLE 등은 서비스가 정한다 */
  fastify.post("/api/v1/channels/:id/agents/:agentId/reset", admin, async (request) => {
    const { id, agentId } = parseParams(AgentParams, request.params);
    const { threadRootId } = parseQuery(ResetQuery, request.query);
    loadChannel(sessionUser(request).workspaceId, id);
    await resetAgentSession(ctx, { channelId: id, agentId, threadRootId });
    return { ok: true };
  });
}

/**
 * Gateway 설정 경로(config.patch)는 OpenClaw 몫이다 — 러너 어댑터는 채널 프롬프트를 매 런 싣는다(판정 P3). 보낼 곳은 그 채널의
 * 에이전트 멤버가 속한 Gateway 들이다(멀티 Gateway 계획 판정 PG10) — OpenClaw 에이전트가 없는 채널은 보내지 않는다
 */
function syncChannelPrompt(ctx: ChannelRouteContext, channel: ChannelRecord): void {
  const openclaw = ctx.registry.forProvider("openclaw");
  if (!openclaw) return;
  for (const gatewayId of channelGatewayIds(ctx.db, channel.id)) {
    void openclaw
      .syncChannelConfig(channel.id, { systemPrompt: channel.prompt ?? "" }, gatewayId)
      .catch((err: unknown) => {
        ctx.logger.warn({ err, channelId: channel.id, gatewayId }, "syncChannelConfig failed");
        const reason = err instanceof Error ? err.message : String(err);
        ctx.bus.emit("system.notice", {
          level: "warn",
          message: `#${channel.name} 채널 프롬프트를 Gateway 에 반영하지 못했다: ${reason}`,
        });
      });
  }
}
