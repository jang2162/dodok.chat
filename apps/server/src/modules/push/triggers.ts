/** 버스 이벤트 → 받을 사람·알림(스펙 5.2). 누가·어디·무엇만 싣는다(결정 1) — 본문·승인 내용은 넣지 않는다 */
import type { Approval, Message, PushPayload } from "@dodok/shared";
import { josa } from "../../util/josa";

export type TriggerLookups = {
  channelName(id: string): string | undefined;
  userHandle(id: string): string | undefined;
  agentHandle(id: string): string | undefined;
  /** 자동화 이름 — 지운 자동화면 undefined */
  automationName(id: string): string | undefined;
  /** 채널의 사람 멤버 id */
  humanMembers(channelId: string): string[];
  /** 워크스페이스의 owner·admin id — 승인은 관리 일이라 채널 참여와 무관하게 이들에게만 간다 */
  admins(): string[];
  /** 보관한 채널이면 true — 그 채널을 겨눈 알림은 보내지 않는다(채널 보관 스펙 「보관할 때 서버가 하는 일」 절) */
  channelArchived(id: string): boolean;
};
export type PushTarget = { userId: string; payload: PushPayload };

const TITLE = "dodok";
const channelLabel = (l: TriggerLookups, id: string) => l.channelName(id) ?? "채널";
/** 스레드 안 메시지면 「#채널 스레드」, 누르면 그 스레드(웹 /c/<id>/t/<rootId>) */
const placeOf = (l: TriggerLookups, m: Message) =>
  m.threadRootId === undefined
    ? { label: `#${channelLabel(l, m.channelId)}`, url: `/c/${m.channelId}` }
    : { label: `#${channelLabel(l, m.channelId)} 스레드`, url: `/c/${m.channelId}/t/${m.threadRootId}` };

/** 멘션 알림의 보낸 이 — 사람·에이전트는 「@핸들이」, 자동화는 「자동화 <이름>이」(지웠으면 「자동화가」), 모르면 「누군가가」 */
function whoOf(m: Message, l: TriggerLookups): string {
  if (m.authorType === "automation") {
    const name = m.authorId === undefined ? undefined : l.automationName(m.authorId);
    return name ? `자동화 ${name}${josa(name, "이", "가")}` : "자동화가";
  }
  const author =
    m.authorId === undefined
      ? undefined
      : m.authorType === "agent"
        ? l.agentHandle(m.authorId)
        : l.userHandle(m.authorId);
  return author ? `@${author}${josa(author, "이", "가")}` : "누군가가";
}

export function targetsForMessage(m: Message, l: TriggerLookups): PushTarget[] {
  if (m.kind === "system") {
    if (m.systemMeta?.kind !== "relay_limit") return [];
    const place = placeOf(l, m);
    const body = `${place.label}의 에이전트 대화가 한도에 닿았습니다`;
    return l.humanMembers(m.channelId).map((userId) => ({
      userId,
      payload: {
        kind: "relay_limit",
        channelId: m.channelId,
        title: TITLE,
        body,
        url: place.url,
        tag: `relay:${m.channelId}`,
      },
    }));
  }
  const receivers = [...new Set(m.mentions.users)].filter(
    // 자기 멘션은 없다 — 작성자가 사람일 때만 같은 id 를 뺀다(Review Focus 3)
    (userId) => !(m.authorType === "user" && userId === m.authorId),
  );
  if (receivers.length === 0) return [];
  const place = placeOf(l, m);
  const body = `${whoOf(m, l)} ${place.label}에서 불렀습니다`;
  // 같은 tag 는 푸시 서비스가 바꿔 끼운다 — 스레드마다 따로 둔다(80자 상한이라 채널 id 는 빼고 루트 id 만)
  const tag = m.threadRootId === undefined ? `mention:${m.channelId}` : `mention:t:${m.threadRootId}`;
  return receivers.map((userId) => ({
    userId,
    payload: {
      kind: "mention",
      channelId: m.channelId,
      title: TITLE,
      body,
      url: place.url,
      tag,
    },
  }));
}

export function targetsForApproval(a: Approval, l: TriggerLookups): PushTarget[] {
  const body = `#${channelLabel(l, a.channelId)}에 승인 요청이 있습니다`;
  // 확인 카드(dodok_control)는 그 일을 시킨 사람 본인만 결정한다 — 알림도 그 사람에게만(제어 MCP 스펙 「확인 카드」 장)
  const receivers =
    a.kind === "dodok_control" ? (a.requestedBy === undefined ? [] : [a.requestedBy]) : l.admins();
  return receivers.map((userId) => ({
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
