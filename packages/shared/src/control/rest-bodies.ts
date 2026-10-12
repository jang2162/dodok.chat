import { z } from "zod";
import { Id } from "../common";
import { Agent, Channel, ChannelMember } from "../domain";
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

// OpenClaw 는 그 Gateway 의 agents.list — gatewayId 가 있어야 한다. 러너는 붙은 러너 전부(연결을 고르지 않는다)
export const DiscoverAgentsQuery = z.object({
  provider: z.enum(["openclaw", "claude"]).default("openclaw"),
  gatewayId: Id.optional(),
});
export type DiscoverAgentsQuery = z.infer<typeof DiscoverAgentsQuery>;

export const CreateAgentBody = Agent.pick({
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
  // 판정 P9 — 서버는 목록 검사를 하지 않는다(OpenClaw 와 같다). 웹이 discover?provider= 목록에서 고른다
  provider: z.enum(["openclaw", "claude"]).default("openclaw"),
  enabled: Agent.shape.enabled.default(true),
  // OpenClaw 에이전트의 Gateway — OpenClaw 면 필수(서버 라우트가 400), 러너 에이전트는 무시한다
  gatewayId: Id.optional(),
});
export type CreateAgentBody = z.infer<typeof CreateAgentBody>;

/** avatarUrl·basePrompt 는 null 로 지운다 */
export const UpdateAgentBody = Agent.pick({ handle: true, name: true, enabled: true }).partial().extend({
  avatarUrl: Agent.shape.avatarUrl.unwrap().nullable().optional(),
  basePrompt: Agent.shape.basePrompt.unwrap().nullable().optional(),
});
export type UpdateAgentBody = z.infer<typeof UpdateAgentBody>;
