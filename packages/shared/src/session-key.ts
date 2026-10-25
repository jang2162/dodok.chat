// 세션 키는 대화(채널 세션)당 에이전트별 하나, 스레드는 그 아래 하위 세션 하나(계획서 10장 #19, ADR 0006, 채널 세션 스펙 4.3).
// `channel:` 자리에 대화 id 가 들어간다 — 기존 채널의 「이전 대화」는 id 가 채널 id 와 같아 옛 키가 그대로 맞는다.
// 서버·어댑터·플러그인은 키를 이 두 함수로만 만들고 푼다 — 한쪽이 따로 조립·정규식을 두면 모양이 조용히 갈라진다.

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// OpenClaw agentId 규칙(코어 `VALID_ID_RE`, 대소문자 무시) — 코어는 이 밖의 id(`:`·공백 등)를 에이전트로 받지 않는다
const AGENT_ID = "[a-z0-9][a-z0-9_-]{0,63}";
const AGENT_ID_RE = new RegExp(`^${AGENT_ID}$`, "i");
// 세대(`:g<N>`) 같은 다른 접미사는 우리 것이 아니다 — 끝까지 맞아야 한다
const SESSION_KEY_RE = new RegExp(`^agent:(${AGENT_ID}):dodok:channel:(${UUID})(?::thread:(${UUID}))?$`, "i");

/** OpenClaw agentId 규칙 안인가 — 에이전트 등록 경계가 빌더와 같은 규칙으로 거절하게(빌더는 규칙 밖에서 던진다) */
export function isOpenClawAgentId(id: string): boolean {
  return AGENT_ID_RE.test(id);
}

/**
 * 에이전트 등록이 받는 providerAgentId — 규칙 안이면서 소문자. 코어가 세션 키를 소문자로 접으므로 대문자 id 는 키에서 푼 id 와
 * 어긋난다(승인·런 없는 정본의 에이전트 조회). 이미 저장된 대문자 행은 빌더(`/i`)가 그대로 받는다.
 */
export function isRegistrableAgentId(id: string): boolean {
  return isOpenClawAgentId(id) && id === id.toLowerCase();
}

/**
 * `agent:<a>:dodok:channel:<conversationId>` 또는 `…:thread:<rootId>`. conversationId·rootId 를 소문자로 만드는 것은 코어가 dodok 키를
 * 통째로 소문자로 접기 때문이다 — 우리 쪽이 날 문자열로 비교하는 자리(세션 행·플러그인 인바운드 대조)도 Gateway 와
 * 같은 결론을 내게 한다. agentId 는 그대로 둔다(서버가 저장한 providerAgentId 로 에이전트를 찾는다).
 * agentId 가 규칙 밖이거나 rootId 가 빈 문자열이면 던진다 — id 모양(UUID)은 호출처가 `Id` 로 보장한다.
 */
export function dodokSessionKey(
  providerAgentId: string,
  conversationId: string,
  threadRootId?: string,
): string {
  if (!isOpenClawAgentId(providerAgentId)) {
    throw new Error(`dodokSessionKey: not an OpenClaw agentId: ${JSON.stringify(providerAgentId)}`);
  }
  if (threadRootId === "") throw new Error("dodokSessionKey: empty threadRootId");
  const conversationKey = `agent:${providerAgentId}:dodok:channel:${conversationId.toLowerCase()}`;
  return threadRootId === undefined
    ? conversationKey
    : `${conversationKey}:thread:${threadRootId.toLowerCase()}`;
}

export type ParsedDodokSessionKey = {
  providerAgentId: string;
  conversationId: string;
  threadRootId?: string;
};

/** 우리 모양이 아니면 undefined. conversationId·threadRootId 는 소문자 UUID 로 돌려준다 */
export function parseDodokSessionKey(key: string | undefined): ParsedDodokSessionKey | undefined {
  const match = key ? SESSION_KEY_RE.exec(key) : null;
  const providerAgentId = match?.[1];
  const conversationId = match?.[2];
  if (!providerAgentId || !conversationId) return undefined;
  const threadRootId = match[3]?.toLowerCase();
  return threadRootId
    ? { providerAgentId, conversationId: conversationId.toLowerCase(), threadRootId }
    : { providerAgentId, conversationId: conversationId.toLowerCase() };
}
