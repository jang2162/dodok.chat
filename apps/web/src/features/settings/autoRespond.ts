import type { ChannelMember } from "@dodok/shared";

/** 자동 응답 PATCH 한 걸음. memberId 는 에이전트 id(`PATCH /channels/:id/members/:memberId`) */
export type AutoRespondStep = { memberId: string; autoRespond: boolean };

/**
 * 자동 응답은 채널당 하나(스펙 6.4) — 서버는 막지 않으므로 웹이 보장한다. 켤 때는 켜져 있는 다른 에이전트를
 * 먼저 모두 끄고 마지막에 대상을 켠다(이 순서대로 하나씩 보내야 어느 순간에도 둘이 켜지지 않는다). 끌 때는 대상만
 */
export function autoRespondPlan(
  members: ChannelMember[],
  targetAgentId: string,
  on: boolean,
): AutoRespondStep[] {
  if (!on) return [{ memberId: targetAgentId, autoRespond: false }];
  const others = members.filter(
    (m) => m.memberType === "agent" && m.autoRespond && m.memberId !== targetAgentId,
  );
  return [
    ...others.map((m) => ({ memberId: m.memberId, autoRespond: false })),
    { memberId: targetAgentId, autoRespond: true },
  ];
}
