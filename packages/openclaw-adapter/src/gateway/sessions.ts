import { dodokSessionKey } from "@dodok/shared";
import { z } from "zod";

// 서버 코어 스펙 6.5 — 세션 키와 세션 메서드 응답 파싱. 응답은 외부 입력이라 읽는 필드만 좁게 파싱하고 던지지 않는다.

/** 채널당 에이전트별 1개, 스레드면 그 아래 하위 세션 1개 — 모양은 shared `dodokSessionKey` 가 정본이다 */
export function sessionKeyFor(
  providerAgentId: string,
  conversationId: string,
  threadRootId?: string,
): string {
  return dodokSessionKey(providerAgentId, conversationId, threadRootId);
}

const ChatHistoryResult = z.looseObject({
  kind: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
  deltaCursor: z.string().min(1).optional(),
});

/** `chat.history` 응답(일반·`kind:"delta"`·`kind:"reset"`)에서 복구에 필요한 것만. 본문은 쓰지 않는다. */
export function parseChatHistory(response: unknown): {
  reset: boolean;
  messageCount: number;
  deltaCursor?: string;
} {
  const parsed = ChatHistoryResult.safeParse(response);
  if (!parsed.success) return { reset: false, messageCount: 0 };
  const { kind, messages, deltaCursor } = parsed.data;
  return {
    reset: kind === "reset",
    messageCount: messages?.length ?? 0,
    ...(deltaCursor === undefined ? {} : { deltaCursor }),
  };
}
