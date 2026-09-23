/** 버스 이벤트 → 받을 사람·알림(스펙 5.2). 누가·어디·무엇만 싣는다(결정 1) — 본문·승인 내용은 넣지 않는다 */
import type { Approval, Message, PushPayload } from "@dodok/shared";
import { josa } from "../../util/josa";

export type TriggerLookups = {
  channelName(id: string): string | undefined;
  userHandle(id: string): string | undefined;
  agentHandle(id: string): string | undefined;
  /** 채널의 사람 멤버 id */
  humanMembers(channelId: string): string[];
};
export type PushTarget = { userId: string; payload: PushPayload };

const TITLE = "dodok";
const channelLabel = (l: TriggerLookups, id: string) => l.channelName(id) ?? "채널";

export function targetsForMessage(m: Message, l: TriggerLookups): PushTarget[] {
  if (m.kind === "system") {
    if (m.systemMeta?.kind !== "relay_limit") return [];
    const body = `#${channelLabel(l, m.channelId)}의 에이전트 대화가 한도에 닿았습니다`;
    return l.humanMembers(m.channelId).map((userId) => ({
      userId,
      payload: {
        kind: "relay_limit",
        channelId: m.channelId,
        title: TITLE,
        body,
        url: `/c/${m.channelId}`,
        tag: `relay:${m.channelId}`,
      },
    }));
  }
  const receivers = [...new Set(m.mentions.users)].filter(
    // 자기 멘션은 없다 — 작성자가 사람일 때만 같은 id 를 뺀다(Review Focus 3)
    (userId) => !(m.authorType === "user" && userId === m.authorId),
  );
  if (receivers.length === 0) return [];
  const author =
    m.authorId === undefined
      ? undefined
      : m.authorType === "agent"
        ? l.agentHandle(m.authorId)
        : l.userHandle(m.authorId);
  const who = author ? `@${author}${josa(author, "이", "가")}` : "누군가가";
  const body = `${who} #${channelLabel(l, m.channelId)}에서 불렀습니다`;
  return receivers.map((userId) => ({
    userId,
    payload: {
      kind: "mention",
      channelId: m.channelId,
      title: TITLE,
      body,
      url: `/c/${m.channelId}`,
      tag: `mention:${m.channelId}`,
    },
  }));
}

export function targetsForApproval(a: Approval, l: TriggerLookups): PushTarget[] {
  const body = `#${channelLabel(l, a.channelId)}에 승인 요청이 있습니다`;
  return l.humanMembers(a.channelId).map((userId) => ({
    userId,
    payload: {
      kind: "approval",
      channelId: a.channelId,
      title: TITLE,
      body,
      url: `/c/${a.channelId}/activity`,
      tag: `approval:${a.id}`,
    },
  }));
}
