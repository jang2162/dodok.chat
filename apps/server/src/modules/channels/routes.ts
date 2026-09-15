import { Channel, ChannelMember, Id } from "@dodok/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AgentAdapter } from "../../adapters/types";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseBody, parseParams } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import {
  addMember,
  type ChannelRecord,
  createChannel,
  getChannel,
  listChannels,
  listMembers,
  removeMember,
  updateAgentMember,
  updateChannel,
} from "./service";

export type ChannelRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  adapter: AgentAdapter | undefined;
};

const ChannelParams = z.object({ id: Id });
const MemberParams = z.object({ id: Id, memberId: Id });

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
    const channel = createChannel(ctx.db, { ...body, workspaceId: user.workspaceId, createdBy: user.id });
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
    const member = addMember(ctx.db, id, body, ctx.logger);
    emitMembers(id);
    return reply.code(201).send({ member });
  });

  fastify.patch("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadChannel(sessionUser(request).workspaceId, id);
    const patch = parseBody(UpdateMemberBody, request.body);
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
}

function syncChannelPrompt(ctx: ChannelRouteContext, channel: ChannelRecord): void {
  if (!ctx.adapter) return;
  void ctx.adapter
    .syncChannelConfig(channel.id, { systemPrompt: channel.prompt ?? "" })
    .catch((err: unknown) => {
      ctx.logger.warn({ err, channelId: channel.id }, "syncChannelConfig failed");
      const reason = err instanceof Error ? err.message : String(err);
      ctx.bus.emit("system.notice", {
        level: "warn",
        message: `#${channel.name} 채널 프롬프트를 Gateway 에 반영하지 못했다: ${reason}`,
      });
    });
}
