import type { AgentPresenceState, PresenceEntry, StatusMode } from "@dodok/shared";

// 유효 상태 계산(프로필 스펙 3.2·3.4) — 순수 함수. 위에서부터 먼저 맞는 것

type UserEntry = Extract<PresenceEntry, { kind: "user" }>;

/**
 * 사람의 점. invisible 은 다른 오프라인과 구별되지 않게 state 하나만 — 만료·dnd 표지를 싣지 않는다. 방해 금지는 오프라인이어도
 * dnd 표지(만료 포함)를 싣는다. inGrace 는 마지막 소켓이 끊긴 뒤 유예 안 — 그동안은 소켓이 없어도 오프라인을 내지 않는다
 * (anyVisible 은 부르는 쪽이 마지막으로 안 값을 준다)
 */
export function userPresence(f: {
  deactivated: boolean;
  mode: StatusMode;
  modeUntil: string | null;
  sockets: number;
  anyVisible: boolean;
  inGrace: boolean;
}): Omit<UserEntry, "kind" | "id"> {
  if (f.deactivated) return { state: null };
  if (f.mode === "invisible") return { state: "offline" };
  const dnd = f.mode === "dnd" ? { dnd: { until: f.modeUntil } } : {};
  if (f.sockets === 0 && !f.inGrace) return { state: "offline", ...dnd };
  if (f.mode === "away" || f.mode === "busy" || f.mode === "dnd")
    return { state: f.mode, ...(f.modeUntil === null ? {} : { until: f.modeUntil }), ...dnd };
  return { state: f.anyVisible ? "online" : "away" };
}

/** 에이전트의 점 — null 은 점 없음(보관) */
export function agentPresence(f: {
  archived: boolean;
  enabled: boolean;
  connected: boolean;
  working: boolean;
}): AgentPresenceState | null {
  if (f.archived) return null;
  if (!f.enabled) return "off";
  if (!f.connected) return "disconnected";
  return f.working ? "working" : "available";
}
