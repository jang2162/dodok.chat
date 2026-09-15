import { z } from "zod";

// 서버 코어 스펙 6.5 — 세션 키와 세션 메서드 응답 파싱. 응답은 외부 입력이라 읽는 필드만 좁게 파싱하고 던지지 않는다.

/** 계획서 #19: 채널당 에이전트별 1개, 접미사 없음. */
export function sessionKeyFor(providerAgentId: string, channelId: string): string {
  return `agent:${providerAgentId}:dodok:channel:${channelId}`;
}

const SessionsResetResult = z.looseObject({
  entry: z.looseObject({
    sessionStartedAt: z.union([z.number(), z.string()]).optional().catch(undefined),
    lifecycleRevision: z.string().optional().catch(undefined),
  }),
});

/** `sessions.reset` 응답 → 리셋 판별 값(ADR 0003 3.4: `sessionId` 는 리셋 전후 같아서 쓰지 않는다). */
export function parseSessionsReset(response: unknown): {
  sessionStartedAt?: string;
  lifecycleRevision?: string;
} {
  const parsed = SessionsResetResult.safeParse(response);
  if (!parsed.success) return {};
  const { sessionStartedAt, lifecycleRevision } = parsed.data.entry;
  const startedAt = typeof sessionStartedAt === "number" ? msToIso(sessionStartedAt) : sessionStartedAt;
  return {
    ...(startedAt === undefined ? {} : { sessionStartedAt: startedAt }),
    ...(lifecycleRevision === undefined ? {} : { lifecycleRevision }),
  };
}

/** Date 범위 밖(±8.64e15ms)이면 toISOString 이 던지므로 undefined. */
function msToIso(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
