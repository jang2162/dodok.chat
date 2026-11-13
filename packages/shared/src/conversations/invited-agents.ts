import { z } from "zod";
import { Id, IsoDateTime } from "../common";

// 세션에 초대한 에이전트(세션 에이전트 초대 스펙 5.1·5.3) — 채널 멤버가 아닌 에이전트를 일반 채널의 세션 하나(와 그 스레드)에만 부른다

/** 세션 하나에 초대할 수 있는 에이전트 수(I8) */
export const MAX_INVITED_AGENTS = 8;

/** GET·POST·DELETE /conversations/:id/agents 의 한 줄. invitedBy 는 초대한 사람 — 그 사람을 지웠으면 null */
export const InvitedAgent = z.object({
  agentId: Id,
  invitedBy: Id.nullable(),
  invitedAt: IsoDateTime,
});
export type InvitedAgent = z.infer<typeof InvitedAgent>;

/** POST /conversations/:id/agents */
export const InviteAgentBody = z.object({ agentId: Id });
export type InviteAgentBody = z.infer<typeof InviteAgentBody>;
