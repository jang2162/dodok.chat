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
  /** DM 이면 그 주인 id, 일반 채널·없는 채널이면 null — DM 의 알림은 주인에게만 간다(에이전트 DM 계획 판정 PD7) */
  dmOwner(channelId: string): string | null;
  /** DM 이면 그 에이전트 id, 일반 채널·없는 채널이면 null — run_error 알림의 「누가」 */
  dmAgent(channelId: string): string | null;
};
/**
 * `conversationId` 는 거르기(「그 세션을 보고 있으면 안 보냄」 — 채널 세션 계획 판정 PS7)에만 쓰고 페이로드에는 싣지 않는다 — 같은 채널의
 * 다른 세션을 보고 있는 사람에게는 간다
 */
export type PushTarget = { userId: string; conversationId: string; payload: PushPayload };

const TITLE = "dodok";
/** 알림 본문의 자리 — 일반 채널은 「#이름」, DM 은 「DM」(이름은 내부용이다) */
const channelLabel = (l: TriggerLookups, id: string) =>
  l.dmOwner(id) === null ? `#${l.channelName(id) ?? "채널"}` : "DM";
/** 누르면 그 세션(웹 /c/<채널>/s/<세션>) — 꼴을 바꾸면 서비스 워커의 허용 꼴(apps/web/src/pwa/sw-logic.ts SAFE_URL)도 함께 바꾼다 */
const sessionUrl = (channelId: string, conversationId: string) => `/c/${channelId}/s/${conversationId}`;
/** 스레드 안 메시지면 「#채널 스레드」, 누르면 그 세션의 그 스레드(…/t/<rootId>) */
const placeOf = (l: TriggerLookups, m: Message) => {
  const session = sessionUrl(m.channelId, m.conversationId);
  return m.threadRootId === undefined
    ? { label: channelLabel(l, m.channelId), url: session }
    : { label: `${channelLabel(l, m.channelId)} 스레드`, url: `${session}/t/${m.threadRootId}` };
};

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

/**
 * DM 의 알림 — 에이전트의 최상위 보통 메시지(정본)와 run_error 만, 주인에게(에이전트 DM 계획 판정 PD11). DM 메시지에는 멘션이 없다
 * (messages/service.ts plainInDm). 제목이 「누가」(`@<핸들>이 답했습니다`), 본문이 「어디」(「DM」) — 본문은 싣지 않는다. tag 는 세션마다
 */
function targetsForDm(m: Message, l: TriggerLookups, owner: string): PushTarget[] {
  if (m.threadRootId !== undefined) return [];
  const reply = m.kind === "normal" && m.authorType === "agent";
  const failed = m.kind === "system" && m.systemMeta?.kind === "run_error";
  if (!reply && !failed) return [];
  const agentId = reply ? m.authorId : (l.dmAgent(m.channelId) ?? undefined);
  const handle = agentId === undefined ? undefined : l.agentHandle(agentId);
  const title = handle ? `@${handle}${josa(handle, "이", "가")} 답했습니다` : "에이전트가 답했습니다";
  return [
    {
      userId: owner,
      conversationId: m.conversationId,
      payload: {
        kind: "mention",
        channelId: m.channelId,
        title,
        body: channelLabel(l, m.channelId),
        url: sessionUrl(m.channelId, m.conversationId),
        tag: `dm:${m.conversationId}`,
      },
    },
  ];
}

export function targetsForMessage(m: Message, l: TriggerLookups): PushTarget[] {
  const dmOwner = l.dmOwner(m.channelId);
  if (dmOwner !== null) return targetsForDm(m, l, dmOwner);
  if (m.kind === "system") {
    if (m.systemMeta?.kind !== "relay_limit") return [];
    const place = placeOf(l, m);
    const body = `${place.label}의 에이전트 대화가 한도에 닿았습니다`;
    // 릴레이 사슬은 세션 안에서만 이어진다 — 세션마다 따로 바꿔 끼운다(uuid 라 80자 안)
    return l.humanMembers(m.channelId).map((userId) => ({
      userId,
      conversationId: m.conversationId,
      payload: {
        kind: "relay_limit",
        channelId: m.channelId,
        title: TITLE,
        body,
        url: place.url,
        tag: `relay:${m.conversationId}`,
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
  // 같은 tag 는 푸시 서비스가 바꿔 끼운다 — 세션·스레드마다 따로 둔다(80자 상한이라 채널 id 는 빼고 세션 id·루트 id 만)
  const tag = m.threadRootId === undefined ? `mention:${m.conversationId}` : `mention:t:${m.threadRootId}`;
  return receivers.map((userId) => ({
    userId,
    conversationId: m.conversationId,
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
  const body = `${channelLabel(l, a.channelId)}에 승인 요청이 있습니다`;
  // 확인 카드(dodok_control)는 그 일을 시킨 사람 본인만 결정한다 — 알림도 그 사람에게만(제어 MCP 스펙 「확인 카드」 장).
  // DM 의 승인은 종류와 무관하게 주인만 결정한다 — owner·admin 은 그 DM 을 볼 수 없다(에이전트 DM 계획 판정 PD7)
  const dmOwner = l.dmOwner(a.channelId);
  const receivers =
    dmOwner !== null
      ? [dmOwner]
      : a.kind === "dodok_control"
        ? a.requestedBy === undefined
          ? []
          : [a.requestedBy]
        : l.admins();
  return receivers.map((userId) => ({
    userId,
    conversationId: a.conversationId,
    payload: {
      kind: "approval",
      channelId: a.channelId,
      title: TITLE,
      body,
      url: `${sessionUrl(a.channelId, a.conversationId)}/activity`,
      tag: `approval:${a.id}`,
    },
  }));
}
