/**
 * 플러그인 모듈 인스턴스를 넘는 상태 — 계정별 브리지 연결과 세션별 인바운드 상관관계 (ADR 0004).
 *
 * 2026.9.5 Gateway 는 번들을 같은 프로세스·realm 에서 두 번 평가한다. startAccount 는 세대 1 에서,
 * 모델 런의 message 툴(handleAction)·sendText 는 세대 2 에서 돈다. 모듈 스코프 Map 이면 세대 2 가 비어 있으므로
 * globalThis 의 Symbol.for 키에 둔다(번들 채널 telegram 도 같은 관행). SDK 의 global-singleton 은 private-local 이라 쓰지 않는다.
 *
 * 키의 v1: 핫 리로드 때 서로 다른 플러그인 버전이 한 Map 을 볼 수 있다 — BridgeClient·OutboundCorrelation 모양을 바꾸면 올린다.
 * SDK 를 import 하지 않는다(단위 테스트 대상).
 */
import type { BridgeClient } from "./bridge-client";
import type { DodokChatKind } from "./inbound";
import type { OutboundCorrelation } from "./outbound";

export const BRIDGES_KEY = Symbol.for("dodok.openclaw-plugin.bridges.v1");
export const CORRELATIONS_KEY = Symbol.for("dodok.openclaw-plugin.correlations.v1");
export const CHAT_KINDS_KEY = Symbol.for("dodok.openclaw-plugin.chat-kinds.v1");

function globalMap<V>(key: symbol): Map<string, V> {
  const g = globalThis as Record<symbol, unknown>;
  const found = g[key];
  if (found === undefined) {
    const map = new Map<string, V>();
    g[key] = map;
    return map;
  }
  // 같은 realm 이라 instanceof 가 통한다(ADR 0004). 조용히 새 Map 으로 덮으면 브리지를 잃고도 증상이 안 보인다
  if (!(found instanceof Map)) throw new Error(`globalThis[${key.toString()}] 가 Map 이 아니다`);
  return found as Map<string, V>;
}

/** 계정별 브리지 연결. message 툴 액션·sendText 는 계정 id 로 연결을 찾는다 */
const bridges = (): Map<string, BridgeClient> => globalMap<BridgeClient>(BRIDGES_KEY);
/** 세션 키 → 마지막 인바운드 상관관계. message 툴 send 를 우리 런에 묶는다. 지우는 자리는 없다(세션 수만큼 남는다) */
const correlations = (): Map<string, OutboundCorrelation> => globalMap<OutboundCorrelation>(CORRELATIONS_KEY);

export function registerBridge(accountId: string, bridge: BridgeClient): void {
  bridges().set(accountId, bridge);
}

export function getBridge(accountId: string): BridgeClient | undefined {
  return bridges().get(accountId);
}

/**
 * 등록된 것이 이 브리지일 때만 지운다. 핫 리로드 때 새 세대 startAccount 가 옛 세대 finally 보다 먼저 돌면
 * 옛 세대가 새 브리지를 지우지 않게 한다. 지웠으면 true.
 */
export function releaseBridge(accountId: string, bridge: BridgeClient): boolean {
  const map = bridges();
  if (map.get(accountId) !== bridge) return false;
  map.delete(accountId);
  return true;
}

export function setCorrelation(sessionKey: string, correlation: OutboundCorrelation): void {
  correlations().set(sessionKey, correlation);
}

export function getCorrelation(sessionKey: string): OutboundCorrelation | undefined {
  return correlations().get(sessionKey);
}

/**
 * 대화 id → 마지막 인바운드의 ChatType. 아웃바운드 경로(resolveOutboundSessionRoute)는 대상(`channel:<id>`)만 받아 DM 인지 모르므로
 * 인바운드 때 적어 둔 것을 쓴다 — 플러그인이 다시 뜬 뒤 첫 인바운드 전에는 없다(그때는 channel).
 *
 * 지우는 자리가 없어 최근 CHAT_KINDS_LIMIT 개만 둔다(쓰고 읽을 때 맨 뒤로 옮기는 LRU — Map 은 넣은 순서를 지킨다). 항목이 쓰이는 것은
 * 인바운드 뒤 그 런의 툴 전송·백그라운드 후속뿐이라 한 Gateway 에서 동시에 살아 있는 대화 수를 넘기면 되는데, 1000 은 그보다 넉넉하고
 * 항목(uuid + 짧은 kind)이 작아 수십 KB 에 그친다. 밀려난 대화의 아웃바운드는 channel 로 떨어지고 세션 키는 그대로다(다음 인바운드가 다시 적는다)
 */
export const CHAT_KINDS_LIMIT = 1000;

const chatKinds = (): Map<string, DodokChatKind> => globalMap<DodokChatKind>(CHAT_KINDS_KEY);

export function setConversationChatType(conversationId: string, kind: DodokChatKind): void {
  const map = chatKinds();
  const key = conversationId.toLowerCase();
  map.delete(key);
  map.set(key, kind);
  while (map.size > CHAT_KINDS_LIMIT) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function getConversationChatType(conversationId: string): DodokChatKind | undefined {
  const map = chatKinds();
  const key = conversationId.toLowerCase();
  const kind = map.get(key);
  if (kind !== undefined) {
    map.delete(key);
    map.set(key, kind);
  }
  return kind;
}
