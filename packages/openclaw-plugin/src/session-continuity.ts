/**
 * 「이 턴이 앞 턴을 실은 OpenClaw 세션을 그대로 이어 가는가」 — 이어 갈 때만 헤더가 지난 턴 뒤 새 글만 싣는다(shared
 * formatConversationBlock). 앞 턴의 헤더와 에이전트 자신의 답은 그 세션 전사에 이미 있다.
 *
 * 리셋은 서버가 다 알지 못한다(OpenClaw 쪽 `/new`·`/reset`·일일·유휴 리셋·컴팩션). 그래서 플러그인이 판정한다:
 * - 런이 시작될 때(onAgentRunStart — 코어가 세션을 이미 골랐다) 그 세션 항목의 `sessionId`·`compactionCount` 를 기억한다.
 * - 다음 전달에서 지금 항목의 둘이 기억과 같고, 코어의 리셋 정책(evaluateSessionFreshness)으로 이번 턴에 리셋되지 않을 때만 이어 간다.
 *   `/new`·`/reset` 은 `sessionId` 를, 컴팩션은 `compactionCount` 를 바꾼다. 리셋 정책은 코어가 인바운드 때 보는 것과 같은 함수다.
 * - 전달마다 먼저 기억을 지운다 — 런이 시작되지 않은 전달(drop·오류) 뒤에는 전사에 그 턴이 없으므로 다음 턴은 전부 싣는다.
 * - 플러그인이 다시 뜬 뒤 첫 턴은 기억이 없어 전부 싣는다.
 * 틀리는 방향은 늘 「전부 싣기」(중복)다 — 리셋을 놓쳐 새 세션에 글을 빼는 쪽으로는 틀리지 않게.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import {
  evaluateSessionFreshness,
  resolveChannelResetConfig,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import type { DodokChatKind } from "./inbound";

/** channel.ts 의 DODOK_CHANNEL_ID 와 같다 — 그 모듈을 부르면 순환이 생긴다 */
const CHANNEL = "dodok";

/** 기억하는 세션 세대 — 같은 세션 키에서 이 둘이 바뀌면 전사가 이어지지 않는다 */
export type SessionGeneration = { sessionId: string; compactionCount: number };

type EntryFacts = Pick<
  SessionEntry,
  "sessionId" | "updatedAt" | "sessionStartedAt" | "lastInteractionAt" | "compactionCount"
>;

export function generationOf(entry: Pick<SessionEntry, "sessionId" | "compactionCount">): SessionGeneration {
  return { sessionId: entry.sessionId, compactionCount: entry.compactionCount ?? 0 };
}

/**
 * 순수 판정 — 기억한 세대와 지금 항목이 같고, 지금 설정의 리셋 정책으로 이번 인바운드에 리셋되지 않을 때만 true.
 * 정책은 코어 resolveSessionResetPolicy·resolveSessionResetType·resolveChannelResetConfig(설치본
 * `dist/reset-*.mjs`) — 기본 mode 가 `none` 이라 설정이 없으면 늘 신선하다
 */
export function isContinuing(input: {
  remembered: SessionGeneration | undefined;
  entry: EntryFacts | undefined;
  cfg: OpenClawConfig;
  sessionKey: string;
  chatKind: DodokChatKind;
  threadId?: string | undefined;
  now: number;
}): boolean {
  const { remembered, entry } = input;
  if (remembered === undefined || entry === undefined) return false;
  const now = generationOf(entry);
  if (now.sessionId !== remembered.sessionId || now.compactionCount !== remembered.compactionCount)
    return false;
  const sessionCfg = input.cfg.session;
  const policy = resolveSessionResetPolicy({
    sessionCfg,
    resetType: resolveSessionResetType({
      sessionKey: input.sessionKey,
      isGroup: input.chatKind !== "direct",
      isThread: input.threadId !== undefined,
    }),
    resetOverride: resolveChannelResetConfig({ sessionCfg, channel: CHANNEL }),
  });
  return evaluateSessionFreshness({
    updatedAt: entry.updatedAt,
    ...(entry.sessionStartedAt === undefined ? {} : { sessionStartedAt: entry.sessionStartedAt }),
    ...(entry.lastInteractionAt === undefined ? {} : { lastInteractionAt: entry.lastInteractionAt }),
    now: input.now,
    policy,
  }).fresh;
}

/**
 * 세션 키 → 마지막으로 런이 시작된 세대. 지우는 자리가 전달마다 있지만 끊긴 세션은 남으므로 최근 GENERATIONS_LIMIT 개만 둔다(LRU).
 * 밀려난 세션의 다음 턴은 전부 싣는다. 인바운드는 startAccount 세대에서만 돌아 모듈 스코프로 충분하다(bridge-registry 의 globalThis 와
 * 다르다) — 핫 리로드로 비면 다음 턴이 전부 싣는다
 */
export const GENERATIONS_LIMIT = 1000;

export function createSessionGenerations(limit = GENERATIONS_LIMIT) {
  const map = new Map<string, SessionGeneration>();
  return {
    get: (sessionKey: string) => map.get(sessionKey),
    forget: (sessionKey: string) => void map.delete(sessionKey),
    remember(sessionKey: string, generation: SessionGeneration): void {
      map.delete(sessionKey);
      map.set(sessionKey, generation);
      while (map.size > limit) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    get size() {
      return map.size;
    },
  };
}

export const sessionGenerations = createSessionGenerations();
