/** 자동화 게시(자동화 스펙 「게시」 절) — 예약 틱·웹훅·「지금 실행」이 모두 여기로 게시한다 */
import type { Message } from "@dodok/shared";
import type { Db } from "../../db/client";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import { createConversation, latestOpenConversation } from "../conversations/store";
import { createAutomationMessage } from "../messages/service";
import type { AutomationRow } from "./store";

export type PostDeps = {
  db: Db;
  bus: ServerBus;
  /** 라우터의 routeMessage — 문구의 멘션이 런이 된다(런 관문이 막아도 메시지는 남고 한도 알림은 관문이 낸다) */
  route: (message: Message) => Promise<void>;
  logger: Logger;
};

/**
 * 자동화 문구(웹훅이면 아래에 원문 블록)를 그 채널 최상위에 게시하고 라우터에 넘긴다. 보관한 채널이면 CHANNEL_ARCHIVED 로 던지고
 * 아무것도 남기지 않는다. 라우터가 던지면 메시지는 이미 저장된 채로 그 오류를 다시 던진다 — 부르는 쪽이 결과를 error 로 남긴다
 */
export async function postAutomationMessage(
  deps: PostDeps,
  automation: AutomationRow,
  extraMd?: string,
): Promise<Message> {
  // 채널의 최근 열린 대화, 없으면 「⚙ <이름>」 새 대화(세션 정책은 걸지 않는다 — 자동화를 만든 것이 이미 admin 이상, 채널 세션 스펙
  // 「자동화」 절). 자동화마다 자기 세션에 이어 쓰는 것은 채널 세션 계획 태스크 4 가 automations.conversation_id 로 한다
  const conversationId =
    latestOpenConversation(deps.db, automation.channelId) ??
    createConversation(deps.db, {
      channelId: automation.channelId,
      title: `⚙ ${automation.name}`.slice(0, 80),
      titleSource: "user",
      createdBy: { type: "automation", id: automation.id },
      createdAt: new Date(),
    }).id;
  const message = createAutomationMessage(deps.db, deps.bus, {
    conversationId,
    automationId: automation.id,
    bodyMd: automation.bodyMd,
    ...(extraMd === undefined ? {} : { extraMd }),
  });
  await deps.route(message);
  return message;
}
