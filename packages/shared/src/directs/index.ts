import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { Agent, Channel, DmReadOnlyReason } from "../domain";
import { Person } from "../members";

// 사람 DM·그룹 DM REST(사람 간 DM 스펙 5장) — kind = 'direct' 채널은 열 때(POST /directs) 만들고, 보내기·세션은 채널의 message.send 그대로다

/** 한 direct 의 참여자 상한 — 연 사람을 포함해 사람과 에이전트를 합친 수(사람 간 DM 스펙 3.2) */
export const DIRECT_MAX_PARTICIPANTS = 9;

/**
 * POST /api/v1/directs — 나를 뺀 상대. 서버가 나를 더해 같은 묶음의 direct 를 찾거나 만든다. 상대 0명·나 포함 9명 초과·중복·나 자신·
 * 에이전트 하나만(그건 POST /dms)은 서버가 VALIDATION 으로 거절한다 — 나 자신·묶음의 모양은 세션을 알아야 판정하므로 여기서는 개수만 본다
 */
export const CreateDirectBody = z.object({
  userIds: z.array(Id).max(DIRECT_MAX_PARTICIPANTS).default([]),
  agentIds: z.array(Id).max(DIRECT_MAX_PARTICIPANTS).default([]),
});
export type CreateDirectBody = z.infer<typeof CreateDirectBody>;

/** POST /api/v1/directs 응답 — created 는 이번에 새로 만들었나 */
export const OpenDirectResult = z.object({ channel: Channel, created: z.boolean() });
export type OpenDirectResult = z.infer<typeof OpenDirectResult>;

/**
 * GET /api/v1/directs 한 줄 — 내가 참여한 direct 하나. users 는 나를 뺀 사람 참여자(비활성도 deactivatedAt 과 함께 — 웹이 흐리게
 * 그린다), agents 는 보관하지 않은 참여 에이전트. sessions 는 세션으로 나누는 direct 인가 — 에이전트 참여자가 있으면(보관한 에이전트도
 * 센다) 참, 없으면 세션 없는 한 줄기(사람 간 DM 스펙 결정 4). agents 로 가르지 않는다: 보관한 에이전트는 agents 에서 빠지므로 그 그룹이
 * 1:1·한 줄기로 읽힌다. lastMessageAt 은 가장 최근 글 시각(없으면 null). readOnlyReason 이 있으면 쓰기가 409 DM_READ_ONLY(details.reason
 * 이 같은 값)
 */
export const DirectSummary = z.object({
  channel: Channel,
  users: z.array(Person),
  agents: z.array(Agent),
  sessions: z.boolean(),
  lastMessageAt: IsoDateTime.nullable(),
  readOnlyReason: DmReadOnlyReason.nullable(),
});
export type DirectSummary = z.infer<typeof DirectSummary>;

/** GET /api/v1/directs — 최근 활동순(lastMessageAt 이 없으면 연 시각으로 센다) */
export const DirectList = z.object({ directs: z.array(DirectSummary) });
export type DirectList = z.infer<typeof DirectList>;
