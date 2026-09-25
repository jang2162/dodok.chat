// 세션 키는 채널당 에이전트별 하나, 스레드는 그 아래 하위 세션 하나(계획서 10장 #19, ADR 0006).
// 서버·어댑터·플러그인은 키를 이 두 함수로만 만들고 푼다 — 한쪽이 따로 조립·정규식을 두면 모양이 조용히 갈라진다.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// 세대(`:g<N>`) 같은 다른 접미사는 우리 것이 아니다 — 끝까지 맞아야 한다
const SESSION_KEY_RE = new RegExp(`^agent:([^:]+):dodok:channel:(${UUID})(?::thread:(${UUID}))?$`, "i");

/**
 * `agent:<a>:dodok:channel:<c>` 또는 `…:thread:<rootId 소문자>`. rootId 를 소문자로 만드는 것은 OpenClaw 헬퍼
 * `resolveThreadSessionKeys` 와 같은 모양이어야 해서다 — 대소문자가 다르면 Gateway 에서 다른 세션이 된다.
 */
export function dodokSessionKey(providerAgentId: string, channelId: string, threadRootId?: string): string {
  const channelKey = `agent:${providerAgentId}:dodok:channel:${channelId}`;
  return threadRootId === undefined ? channelKey : `${channelKey}:thread:${threadRootId.toLowerCase()}`;
}

export type ParsedDodokSessionKey = { providerAgentId: string; channelId: string; threadRootId?: string };

/** 우리 모양이 아니면 undefined. channelId·threadRootId 는 소문자 UUID 로 돌려준다 */
export function parseDodokSessionKey(key: string | undefined): ParsedDodokSessionKey | undefined {
  const match = key ? SESSION_KEY_RE.exec(key) : null;
  const providerAgentId = match?.[1];
  const channelId = match?.[2];
  if (!providerAgentId || !channelId) return undefined;
  const threadRootId = match[3]?.toLowerCase();
  return threadRootId
    ? { providerAgentId, channelId: channelId.toLowerCase(), threadRootId }
    : { providerAgentId, channelId: channelId.toLowerCase() };
}
