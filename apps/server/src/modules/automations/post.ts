/** 자동화 게시(자동화 스펙 「게시」 절) — 예약 틱·웹훅·「지금 실행」이 모두 여기로 게시한다 */
import type { Message } from "@dodok/shared";
import { eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../../db/client";
import { automations } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { assertChannelWritable } from "../channels/service";
import { createConversation, getConversation } from "../conversations/store";
import { createAutomationMessage, type PickConversation } from "../messages/service";
import { type AutomationRow, setAutomationConversation } from "./store";

export type PostDeps = {
  db: Db;
  bus: ServerBus;
  /** 라우터의 routeMessage — 문구의 멘션이 런이 된다(런 관문이 막아도 메시지는 남고 한도 알림은 관문이 낸다) */
  route: (message: Message) => Promise<void>;
  logger: Logger;
};

/**
 * 세션 제목 상한(shared ConversationTitle `max(80)`) — UTF-16 단위로 센다. string.max 는 zod 판본마다 세는 법이 달라(reactions
 * EXCERPT_MAX 주석) UTF-16 으로 80 이내여야 어느 쪽으로도 넘지 않는다. 자동화 이름(AutomationName, 1~40자 — 핀한 zod 는 코드
 * 포인트로 센다)이 이모지 40개면 「⚙ 」를 붙여 82 단위라 자르기에 닿는다. 넘으면 그 세션의 모든 런에서 InboundDeliver 파싱이 던진다
 */
const TITLE_MAX = 80;

/** UTF-16 으로 max 이내가 되게 앞에서부터 글자(코드 포인트) 단위로 채운다 — 서로게이트 쌍을 가르지 않는다 */
function clipUtf16(text: string, max: number): string {
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

/**
 * 자동화의 자기 세션(채널 세션 스펙 「자동화」 절) — automations.conversation_id 가 그 채널의 열린 대화면 거기, 아니면(첫 게시·닫힘·
 * 채널을 바꾼 자동화) 「⚙ <이름>」 세션을 새로 만들어 바꿔 단다. 세션 정책은 걸지 않는다(자동화를 만든 것이 이미 admin 이상).
 * 게시와 같은 트랜잭션에서 돈다 — 보관 검사를 먼저 하고, 게시가 실패하면 만든 세션·바꿔 단 id 도 함께 걷힌다(보관 채널에 빈 세션이
 * 남지 않게). 행은 트랜잭션 안에서 다시 읽는다 — 거의 같은 때의 두 게시(예약 틱·「지금 실행」)가 세션을 둘 만들지 않게
 */
function ownSession(automation: AutomationRow): PickConversation {
  return (tx: DbOrTx) => {
    const current =
      tx
        .select({ channelId: automations.channelId, conversationId: automations.conversationId })
        .from(automations)
        .where(eq(automations.id, automation.id))
        .get() ?? automation;
    // 일반 채널에만 게시한다(DM·direct 는 아니다) — 만들기·바꾸기가 막으므로 여기는 방어선이다(에이전트 DM 계획 판정 PD5). 아무것도
    // 남기지 않고 던진다
    if (assertChannelWritable(tx, current.channelId).kind !== "channel")
      throw apiError("VALIDATION", "자동화는 DM 에 게시할 수 없다");
    const own = current.conversationId === null ? undefined : getConversation(tx, current.conversationId);
    if (own && own.channelId === current.channelId && own.closedAt === undefined) {
      return { conversationId: own.id };
    }
    const created = createConversation(tx, {
      channelId: current.channelId,
      title: clipUtf16(`⚙ ${automation.name}`, TITLE_MAX),
      titleSource: "user",
      createdBy: { type: "automation", id: automation.id },
      createdAt: new Date(),
    });
    setAutomationConversation(tx, automation.id, created.id);
    return { conversationId: created.id, created };
  };
}

/**
 * 자동화 문구(웹훅이면 아래에 원문 블록)를 자기 세션 최상위에 저장만 한다 — 라우터에는 넘기지 않는다. 보관한 채널이면
 * CHANNEL_ARCHIVED 로 던지고 아무것도 남기지 않는다. 저장과 라우팅의 실패를 갈라 다뤄야 하는 웹훅이 쓴다
 */
export function storeAutomationMessage(
  deps: Pick<PostDeps, "db" | "bus">,
  automation: AutomationRow,
  extraMd?: string,
): Message {
  return createAutomationMessage(deps.db, deps.bus, {
    conversationId: ownSession(automation),
    automationId: automation.id,
    bodyMd: automation.bodyMd,
    ...(extraMd === undefined ? {} : { extraMd }),
  });
}

/**
 * 자동화 문구를 저장하고(storeAutomationMessage) 라우터에 넘긴다. 라우터가 던지면 메시지는 이미 저장된 채로 그 오류를 다시
 * 던진다 — 부르는 쪽이 결과를 error 로 남긴다
 */
export async function postAutomationMessage(
  deps: PostDeps,
  automation: AutomationRow,
  extraMd?: string,
): Promise<Message> {
  const message = storeAutomationMessage(deps, automation, extraMd);
  await deps.route(message);
  return message;
}
