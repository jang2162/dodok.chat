import type { Agent, Channel, DmSummary } from "@dodok/shared";
import { agentOf } from "./settingsServer";
import { channelOf } from "./shellApi";

/** DM 채널(REST 응답 모양) — 주인 `ownerId`, 에이전트 `agentId`. 이름은 서버처럼 내부용 `dm` */
export const dmChannelOf = (
  id: string,
  ownerId: string,
  agentId: string,
  over: Partial<Channel> = {},
): Channel =>
  channelOf(id, {
    name: "dm",
    visibility: "private",
    createdBy: ownerId,
    kind: "dm",
    dmOwnerId: ownerId,
    dmAgentId: agentId,
    ...over,
  });

/** `GET /dms` 한 줄 — 따로 주지 않으면 글이 있는(lastMessageAt) 쓸 수 있는 DM */
export const dmOf = (
  channel: Channel,
  agent: Agent = agentOf(channel.dmAgentId ?? "a", "dev"),
  over: Partial<DmSummary> = {},
): DmSummary => ({
  channel,
  agent,
  lastMessageAt: "2026-10-26T01:00:00.000Z",
  readOnlyReason: null,
  ...over,
});
