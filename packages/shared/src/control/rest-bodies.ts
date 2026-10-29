import { z } from "zod";
import { Id } from "../common";
import { Agent, Channel, ChannelMember, RunnerProgram, SessionPolicy } from "../domain";
import { RunnerRunAgent } from "../runner";
import { isRegistrableAgentId } from "../session-key";

// 채널·에이전트 REST 본문 — 서버 라우트와 제어 도구(`./tools`)가 같은 스키마로 파싱한다. 한쪽에만 필드를 더하면 웹에서 되는 일이
// 도구로 안 되거나 그 반대가 된다

export const CreateChannelBody = Channel.pick({
  name: true,
  topic: true,
  prompt: true,
  relayPolicy: true,
  visibility: true,
}).partial({ relayPolicy: true, visibility: true });
export type CreateChannelBody = z.infer<typeof CreateChannelBody>;

/** topic·prompt 는 null 로 지운다. relayPolicy 는 통째로 바꾼다(빠진 필드는 기본값). */
export const UpdateChannelBody = Channel.pick({ name: true, relayPolicy: true, visibility: true })
  .partial()
  .extend({
    topic: Channel.shape.topic.unwrap().nullable().optional(),
    prompt: Channel.shape.prompt.unwrap().nullable().optional(),
    sessionPolicy: SessionPolicy.optional(),
  });
export type UpdateChannelBody = z.infer<typeof UpdateChannelBody>;

export const AddChannelMemberBody = ChannelMember.pick({
  memberType: true,
  memberId: true,
  promptOverride: true,
  autoRespond: true,
  aliases: true,
});
export type AddChannelMemberBody = z.infer<typeof AddChannelMemberBody>;

/** 기본값이 붙은 필드는 unwrap — partial 만 쓰면 빠진 필드가 기본값으로 덮인다 */
export const UpdateChannelMemberBody = z.object({
  promptOverride: ChannelMember.shape.promptOverride.unwrap().nullable().optional(),
  autoRespond: ChannelMember.shape.autoRespond.unwrap().optional(),
  aliases: ChannelMember.shape.aliases.unwrap().optional(),
});
export type UpdateChannelMemberBody = z.infer<typeof UpdateChannelMemberBody>;

/** GET /channels/:id/conversations 쿼리 — q 는 제목 부분 일치, cursor 는 앞 쪽의 nextCursor */
export const ListConversationsQuery = z.object({
  status: z.enum(["open", "closed", "all"]).default("open"),
  q: z.string().max(80).optional(),
  cursor: z.string().max(64).optional(),
});
export type ListConversationsQuery = z.infer<typeof ListConversationsQuery>;

/**
 * 등록 후보 — OpenClaw 는 그 Gateway 의 agents.list(gatewayId 가 있어야 한다). 러너 에이전트는 알린 목록이 없고 러너 프로젝트에서
 * 만든다(러너 일반화 계획 판정 PR9) — provider runner 는 VALIDATION
 */
export const DiscoverAgentsQuery = z.object({
  provider: z.literal("openclaw").default("openclaw"),
  gatewayId: Id.optional(),
});
export type DiscoverAgentsQuery = z.infer<typeof DiscoverAgentsQuery>;

/** OpenClaw 에이전트 등록 — 제어 도구 register_agent 의 입력이기도 하다(러너 에이전트는 제어 도구로 만들지 않는다 — 러너 일반화 스펙 6장) */
export const CreateOpenClawAgentBody = Agent.pick({
  providerAgentId: true,
  handle: true,
  name: true,
  avatarUrl: true,
  basePrompt: true,
}).extend({
  // 세션 키 빌더(dodokSessionKey) 규칙에 소문자까지 — 밖의 id 는 키를 못 만들고, 대문자는 코어가 접은 키와 어긋난다
  providerAgentId: Agent.shape.providerAgentId.refine(isRegistrableAgentId, {
    message:
      "providerAgentId 는 OpenClaw 에이전트 id(영문 소문자·숫자로 시작, 영문 소문자·숫자·_·-, 64자 이하)여야 한다",
  }),
  // 판정 P9 — 서버는 목록 검사를 하지 않는다. 웹이 discover 목록에서 고른다
  provider: z.literal("openclaw").default("openclaw"),
  enabled: Agent.shape.enabled.default(true),
  // OpenClaw 에이전트의 Gateway — 서버 라우트가 없으면 400
  gatewayId: Id.optional(),
});
export type CreateOpenClawAgentBody = z.infer<typeof CreateOpenClawAgentBody>;

/**
 * 러너 에이전트의 정의 필드 — run.start.agent(shared RunnerRunAgent)의 필드 스키마 그대로다. 서버 쪽 상한이 넓으면 러너가 형식
 * 오류로 런을 소리 없이 버린다(러너 일반화 계획 Task 3 Step 2). 러너 천장(권한·도구 상한·프로그램)과의 대조는 서버 라우트가 붙은
 * 러너의 hello 로 한다
 */
const RunnerAgentFields = RunnerRunAgent.pick({
  model: true,
  permissionMode: true,
  allowedTools: true,
  disallowedTools: true,
});

/**
 * 러너 에이전트 만들기(POST /agents { provider: "runner" }) — 러너 프로젝트 안에서, 그 프로젝트의 러너 토큰에 묶인다.
 * providerAgentId 는 서버가 짓는다. permissionMode 를 빼면 default, allowedTools 를 빼면 null(상한 안에서 프로그램 기본)
 */
export const CreateRunnerAgentBody = Agent.pick({
  handle: true,
  name: true,
  avatarUrl: true,
  basePrompt: true,
}).extend({
  provider: z.literal("runner"),
  runnerProjectId: Id,
  program: RunnerProgram,
  enabled: Agent.shape.enabled.default(true),
  dmAccess: Agent.shape.dmAccess.unwrap().optional(),
  model: RunnerAgentFields.shape.model.optional(),
  permissionMode: RunnerAgentFields.shape.permissionMode.optional(),
  allowedTools: RunnerAgentFields.shape.allowedTools.optional(),
  disallowedTools: RunnerAgentFields.shape.disallowedTools.optional(),
});
export type CreateRunnerAgentBody = z.infer<typeof CreateRunnerAgentBody>;

/** POST /agents — 서버 라우트는 provider 를 보고 둘 중 하나로 파싱한다(오류가 그 갈래의 필드를 가리키게) */
export const CreateAgentBody = z.union([CreateOpenClawAgentBody, CreateRunnerAgentBody]);
export type CreateAgentBody = z.infer<typeof CreateAgentBody>;

/**
 * avatarUrl·basePrompt 는 null 로 지운다. dmAccess 는 REST 에만 — 제어 도구 update_agent 는 뺀다(에이전트 DM 계획 판정 PD13: 채널 안
 * 에이전트가 확인 카드 하나로 DM 범위를 넓히지 못하게). model·permissionMode·allowedTools·disallowedTools 는 러너 에이전트만(OpenClaw
 * 에이전트면 VALIDATION), 역시 REST 에만 — 제어 도구는 러너 구성을 바꾸지 못한다(러너 일반화 스펙 6장)
 */
export const UpdateAgentBody = Agent.pick({ handle: true, name: true, enabled: true }).partial().extend({
  avatarUrl: Agent.shape.avatarUrl.unwrap().nullable().optional(),
  basePrompt: Agent.shape.basePrompt.unwrap().nullable().optional(),
  dmAccess: Agent.shape.dmAccess.unwrap().optional(),
  model: RunnerAgentFields.shape.model.optional(),
  permissionMode: RunnerAgentFields.shape.permissionMode.optional(),
  allowedTools: RunnerAgentFields.shape.allowedTools.optional(),
  disallowedTools: RunnerAgentFields.shape.disallowedTools.optional(),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBody>;

/** 러너 에이전트 정의 필드의 이름 — 제어 도구가 받지 않는 키를 가를 때 쓴다 */
export const RUNNER_AGENT_FIELDS = ["model", "permissionMode", "allowedTools", "disallowedTools"] as const;
