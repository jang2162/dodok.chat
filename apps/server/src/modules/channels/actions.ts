import type {
  AddChannelMemberBody,
  ChannelMember,
  CreateChannelBody,
  UpdateChannelMemberBody,
} from "@dodok/shared";
import type { AdapterRegistry } from "../../adapters/registry";
import type { Db } from "../../db/client";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import type { Orchestrator } from "../runs/orchestrator";
import { syncChannelPrompt, syncPromptToGateway } from "./prompt-sync";
import {
  addMember,
  archiveChannel,
  type ChannelPatch,
  type ChannelRecord,
  channelGatewayIds,
  createChannel,
  listMembers,
  removeMember,
  unarchiveChannel,
  updateAgentMember,
  updateChannel,
} from "./service";
import { deleteInvitesForChannelAgent } from "../conversations/invited-agents";
import { emitInvited } from "../conversations/invited-agents.routes";

// 채널 쓰기의 「저장 + 알림」 — REST 라우트와 제어 도구(modules/control/handlers.ts)가 같은 함수를 불러 버스 이벤트·Gateway 반영이
// 갈라지지 않는다(제어 MCP 스펙 결정 6). 역할·보관 검사는 부르는 쪽이 먼저 한다

export type ChannelActionContext = {
  db: Db;
  bus: ServerBus;
  logger: Logger;
  /** 채널 프롬프트 동기화는 OpenClaw 어댑터로 */
  registry: Pick<AdapterRegistry, "forProvider">;
  /** 보관이 그 채널의 열린 런을 멈출 때 */
  orchestrator: Pick<Orchestrator, "activeRuns" | "abort">;
};

/** 만든 사람을 첫 멤버로 넣는다. 채널 룸에는 아직 아무도 없다 — 워크스페이스 룸으로 알려 다른 탭의 목록에 바로 뜨게 한다(계획서 8장 이월) */
export function createChannelAndNotify(
  ctx: ChannelActionContext,
  body: CreateChannelBody,
  workspaceId: string,
  createdBy: string,
): ChannelRecord {
  const channel = createChannel(ctx.db, { ...body, workspaceId, createdBy });
  ctx.bus.emit("channel.created", { channel });
  return channel;
}

/** 채널 변경은 이미 유효하다 — Gateway 반영은 비동기, 실패는 system.notice 로만 알린다(스펙 3.4) */
export function patchChannelAndNotify(
  ctx: ChannelActionContext,
  id: string,
  patch: ChannelPatch,
): ChannelRecord {
  const { channel, promptChanged } = updateChannel(ctx.db, id, patch);
  ctx.bus.emit("channel.updated", { channel });
  if (promptChanged && patch.prompt !== undefined) syncChannelPrompt(ctx, channel);
  return channel;
}

function emitMembers(ctx: ChannelActionContext, channelId: string): ChannelMember[] {
  const members = listMembers(ctx.db, channelId);
  ctx.bus.emit("channel.member.changed", { channelId, members });
  return members;
}

/**
 * 사람 멤버는 promptOverride·autoRespond 를 못 가진다 — 서비스가 400 으로 막는다. 다른 Gateway 의 에이전트가 처음 들어오면 그
 * Gateway 에 이 채널의 프롬프트를 한 번(계획 판정 PG10)
 */
export function addChannelMemberAndNotify(
  ctx: ChannelActionContext,
  channelId: string,
  body: AddChannelMemberBody,
): ChannelMember {
  const gatewaysBefore = body.memberType === "agent" ? channelGatewayIds(ctx.db, channelId) : [];
  const member = addMember(ctx.db, channelId, body, ctx.logger);
  emitMembers(ctx, channelId);
  if (body.memberType === "agent") {
    // 그 채널의 세션에 초대했던 에이전트면 이제 채널 멤버다 — 초대 행을 지우고 그 대화마다 알린다(세션 에이전트 초대 스펙 I12)
    for (const conversationId of deleteInvitesForChannelAgent(ctx.db, { channelId, agentId: body.memberId }))
      emitInvited(ctx, { channelId, conversationId });
    for (const gatewayId of channelGatewayIds(ctx.db, channelId))
      if (!gatewaysBefore.includes(gatewayId)) syncPromptToGateway(ctx, channelId, gatewayId);
  }
  return member;
}

export function updateChannelAgentAndNotify(
  ctx: ChannelActionContext,
  channelId: string,
  memberId: string,
  patch: UpdateChannelMemberBody,
): ChannelMember {
  const { member } = updateAgentMember(ctx.db, channelId, memberId, patch, ctx.logger);
  emitMembers(ctx, channelId);
  return member;
}

/** 남은 멤버를 돌려준다 */
export function removeChannelMemberAndNotify(
  ctx: ChannelActionContext,
  channelId: string,
  memberId: string,
): ChannelMember[] {
  removeMember(ctx.db, channelId, memberId);
  return emitMembers(ctx, channelId);
}

/**
 * 보관(채널 보관 스펙 「채널 보관」 절) — 기록은 남고 열린 런은 멈춘다. 이미 보관했으면 그대로. channel.updated 는 워크스페이스 방으로
 * 간다 — 다른 사람의 사이드바에서 빠지고 열린 화면이 읽기 전용으로 바뀐다
 */
export async function archiveChannelAndNotify(
  ctx: ChannelActionContext,
  id: string,
  workspaceId: string,
): Promise<ChannelRecord> {
  const channel = await archiveChannel(ctx, id, workspaceId);
  ctx.bus.emit("channel.updated", { channel });
  return channel;
}

/** 보관 해제 — 같은 멤버·세션으로 돌아온다. 살아 있으면 그대로 */
export function unarchiveChannelAndNotify(
  ctx: ChannelActionContext,
  id: string,
  workspaceId: string,
): ChannelRecord {
  const channel = unarchiveChannel(ctx.db, id, workspaceId);
  ctx.bus.emit("channel.updated", { channel });
  return channel;
}
