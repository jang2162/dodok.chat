import {
  AddChannelMemberBody,
  CreateChannelBody,
  Id,
  type TeamRole,
  UpdateChannelBody,
  UpdateChannelMemberBody,
} from "@dodok/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Auth } from "../../auth";
import {
  authorizeChannelAgentPatch,
  authorizeChannelArchive,
  authorizeChannelCreate,
  authorizeChannelMemberAdd,
  authorizeChannelMemberRemove,
  authorizeChannelPatch,
  authorizeChannelUnarchive,
  authorizeRead,
  authorizeSessionManagers,
} from "../../auth/policies";
import { requirePolicy } from "../../auth/roles";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { parseBody, parseParams, parseQuery } from "../../http/validate";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import type { Orchestrator } from "../runs/orchestrator";
import {
  addChannelMemberAndNotify,
  archiveChannelAndNotify,
  createChannelAndNotify,
  patchChannelAndNotify,
  removeChannelMemberAndNotify,
  unarchiveChannelAndNotify,
  updateChannelAgentAndNotify,
} from "./actions";
import {
  assertChannelWritable,
  type ChannelRecord,
  listChannels,
  listMembers,
  loadReadableChannel,
  setSessionManager,
} from "./service";

export type ChannelRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  /** 채널 프롬프트 동기화는 OpenClaw 어댑터로 */
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 보관이 그 채널의 열린 런을 멈출 때 */
  orchestrator: Pick<Orchestrator, "activeRuns" | "abort">;
};

const ChannelParams = z.object({ id: Id });
const MemberParams = z.object({ id: Id, memberId: Id });
const ManagerParams = z.object({ id: Id, userId: Id });
/** 기본은 살아 있는 채널, archived=1 이면 보관한 채널(누구나 — 읽기는 막지 않는다) */
const ListQuery = z.object({ archived: z.literal("1").optional() });

export function registerChannelRoutes(fastify: FastifyInstance, ctx: ChannelRouteContext): void {
  const read = { preHandler: requirePolicy(ctx, authorizeRead) };
  /** 본문을 보는 정책은 파싱 뒤 핸들러가 부른다(authorizeBody) */
  const authed = { preHandler: requireSession(ctx) };
  /** 필드별 역할 검사 — 파싱 뒤, 어떤 쓰기보다 먼저 부른다(403 이면 아무 필드도 안 바뀐다). 모르는 키도 세도록 원래 본문을 넘긴다 */
  const authorizeBody = (request: FastifyRequest, policy: (role: TeamRole, body: unknown) => void) =>
    policy(sessionUser(request).role, request.body);

  /**
   * 요청자 워크스페이스의 채널이고 요청자가 읽을 수 있어야 한다 — 아니면 404(남의 DM 도 없는 채널과 같다). 역할 정책보다 먼저 부른다:
   * 남의 DM 에 403 을 내면 있다는 것이 드러난다(auth/channel-access.ts). 그래서 역할을 보는 경로도 preHandler 는 세션만 보고
   * 정책은 핸들러가 이 다음에 부른다
   */
  const loadChannel = (request: FastifyRequest, id: string): ChannelRecord => {
    const user = sessionUser(request);
    return loadReadableChannel(ctx.db, id, user.workspaceId, user.id);
  };

  /** 쓰기 경로 — 접근 판정 다음, 보관한 채널이면 409 CHANNEL_ARCHIVED(계획 판정 PC1) */
  const loadWritable = (request: FastifyRequest, id: string): ChannelRecord => {
    loadChannel(request, id);
    return assertChannelWritable(ctx.db, id, sessionUser(request).workspaceId);
  };

  /** preHandler 정책을 접근 판정 뒤로 미룬 경로 — 역할만 보는 정책 */
  const authorizeRole = (request: FastifyRequest, policy: (role: TeamRole) => void) =>
    policy(sessionUser(request).role);

  fastify.get("/api/v1/channels", read, async (request) => {
    const { archived } = parseQuery(ListQuery, request.query);
    return {
      channels: listChannels(ctx.db, sessionUser(request).workspaceId, { archived: archived === "1" }),
    };
  });

  fastify.post("/api/v1/channels", authed, async (request, reply) => {
    const user = sessionUser(request);
    const body = parseBody(CreateChannelBody, request.body);
    authorizeBody(request, authorizeChannelCreate);
    const channel = createChannelAndNotify(ctx, body, user.workspaceId, user.id);
    return reply.code(201).send({ channel });
  });

  fastify.get("/api/v1/channels/:id", read, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    return { channel: loadChannel(request, id) };
  });

  fastify.patch("/api/v1/channels/:id", authed, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadWritable(request, id);
    const patch = parseBody(UpdateChannelBody, request.body);
    authorizeBody(request, authorizeChannelPatch);
    return { channel: patchChannelAndNotify(ctx, id, patch) };
  });

  fastify.get("/api/v1/channels/:id/members", read, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadChannel(request, id);
    return { members: listMembers(ctx.db, id) };
  });

  fastify.post("/api/v1/channels/:id/members", authed, async (request, reply) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadWritable(request, id);
    const body = parseBody(AddChannelMemberBody, request.body);
    authorizeBody(request, authorizeChannelMemberAdd);
    const member = addChannelMemberAndNotify(ctx, id, body);
    return reply.code(201).send({ member });
  });

  fastify.patch("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadWritable(request, id);
    const patch = parseBody(UpdateChannelMemberBody, request.body);
    authorizeBody(request, authorizeChannelAgentPatch);
    return { member: updateChannelAgentAndNotify(ctx, id, memberId, patch) };
  });

  fastify.delete("/api/v1/channels/:id/members/:memberId", authed, async (request) => {
    const { id, memberId } = parseParams(MemberParams, request.params);
    loadChannel(request, id);
    authorizeRole(request, authorizeChannelMemberRemove);
    loadWritable(request, id);
    return { members: removeChannelMemberAndNotify(ctx, id, memberId) };
  });

  /** 보관(admin) — 이미 보관했으면 200 그대로 */
  fastify.post("/api/v1/channels/:id/archive", authed, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadChannel(request, id);
    authorizeRole(request, authorizeChannelArchive);
    return { channel: await archiveChannelAndNotify(ctx, id, sessionUser(request).workspaceId) };
  });

  /** 보관 해제(admin) — 살아 있으면 200 그대로 */
  fastify.post("/api/v1/channels/:id/unarchive", authed, async (request) => {
    const { id } = parseParams(ChannelParams, request.params);
    loadChannel(request, id);
    authorizeRole(request, authorizeChannelUnarchive);
    return { channel: unarchiveChannelAndNotify(ctx, id, sessionUser(request).workspaceId) };
  });

  /**
   * 세션 관리자 지정·해제(admin — 채널 세션 계획 판정 PS8). 지정은 채널에 없는 사람이면 참여시킨다, 해제는 역할만 member 로(채널에는
   * 남는다). 보관한 채널이면 409
   */
  for (const [method, on] of [
    ["put", true],
    ["delete", false],
  ] as const) {
    fastify[method]("/api/v1/channels/:id/session-managers/:userId", authed, async (request) => {
      const { id, userId } = parseParams(ManagerParams, request.params);
      loadChannel(request, id);
      authorizeRole(request, authorizeSessionManagers);
      loadWritable(request, id);
      const member = setSessionManager(ctx.db, id, userId, on);
      ctx.bus.emit("channel.member.changed", { channelId: id, members: listMembers(ctx.db, id) });
      return { member };
    });
  }
}
