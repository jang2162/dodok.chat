/** 작성기 자리 — 세션 작성기면 `threadRootId` 없이, 스레드 답글 작성기면 그 루트 */
export type ComposerScope = { channelId: string; conversationId: string; threadRootId?: string };

/** 작성기가 바깥 요청을 받는 손잡이 — 작성기 하나가 자기 자리로 등록한다 */
export type ComposerTarget = {
  /** 커서 자리에 `@핸들` 멘션 칩과 공백을 넣는다. 그 자리의 후보가 아니면 넣지 않고 거짓 */
  mention: (handle: string) => boolean;
};

/** 작성기 초안 키와 같은 꼴 — Composer 의 draftKey */
export const scopeKey = (s: ComposerScope): string =>
  s.threadRootId === undefined
    ? `${s.channelId}:${s.conversationId}`
    : `${s.channelId}:${s.conversationId}:${s.threadRootId}`;

// 같은 자리를 둘이 등록하면(전환 중 겹침) 나중 것이 받는다
const targets = new Map<string, ComposerTarget[]>();

export function registerComposer(scope: ComposerScope, target: ComposerTarget): () => void {
  const key = scopeKey(scope);
  const list = targets.get(key) ?? [];
  list.push(target);
  targets.set(key, list);
  return () => {
    const now = targets.get(key);
    if (!now) return;
    const next = now.filter((t) => t !== target);
    if (next.length === 0) targets.delete(key);
    else targets.set(key, next);
  };
}

/**
 * 바깥(참여자 목록의 「멘션」, 메시지 작성자 이름 메뉴)에서 그 자리의 작성기에 멘션을 넣는다. 작성기가 그 자리에 없거나 그 자리의 후보가
 * 아니면 거짓 — 후보 판정은 작성기의 @ 자동완성과 같은 목록이라 서버 규칙과 어긋나지 않는다
 */
export function insertMention(scope: ComposerScope, handle: string): boolean {
  const list = targets.get(scopeKey(scope));
  return list?.at(-1)?.mention(handle) ?? false;
}

type SettingsListener = (agentId: string) => void;
const settingsListeners = new Map<string, Set<SettingsListener>>();

/** 그 자리 작성기의 에이전트 설정 패널을 그 에이전트 줄에 초점을 두고 연다 — 듣는 작성기가 없으면 거짓 */
export function openAgentSettings(scope: ComposerScope, agentId: string): boolean {
  const set = settingsListeners.get(scopeKey(scope));
  if (!set || set.size === 0) return false;
  for (const fn of set) fn(agentId);
  return true;
}

export function onAgentSettingsRequest(scope: ComposerScope, fn: SettingsListener): () => void {
  const key = scopeKey(scope);
  const set = settingsListeners.get(key) ?? new Set();
  set.add(fn);
  settingsListeners.set(key, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) settingsListeners.delete(key);
  };
}
