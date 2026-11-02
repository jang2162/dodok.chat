import { describe, expect, it } from "vitest";
import { agentPresence, userPresence } from "../src/modules/presence/compute";

// 유효 상태(프로필 스펙 3.2 사람 여섯 줄·3.4 에이전트 다섯 줄) — 위에서부터 먼저 맞는 것

const UNTIL = "2026-11-02T15:00:00.000Z";
const base = {
  deactivated: false,
  mode: "auto" as const,
  modeUntil: null,
  sockets: 1,
  anyVisible: true,
  inGrace: false,
};

describe("userPresence", () => {
  it("1. 비활성 멤버 → 점 없음(수동 모드·소켓과 상관없이)", () => {
    expect(userPresence({ ...base, deactivated: true, mode: "dnd", modeUntil: UNTIL })).toEqual({
      state: null,
    });
  });
  it("2. invisible → offline — 소켓이 보여도, 만료·dnd 키 없음", () => {
    const e = userPresence({ ...base, mode: "invisible", modeUntil: UNTIL });
    expect(e).toEqual({ state: "offline" });
    expect(Object.keys(e)).toEqual(["state"]);
  });
  it("3. 소켓 없음(유예 밖) → offline", () => {
    expect(userPresence({ ...base, sockets: 0, anyVisible: false })).toEqual({ state: "offline" });
  });
  it("3'. 유예 안이면 소켓 0 이어도 오프라인을 내지 않는다", () => {
    expect(userPresence({ ...base, sockets: 0, anyVisible: true, inGrace: true })).toEqual({
      state: "online",
    });
  });
  it("4. away·busy·dnd → 그 값과 만료", () => {
    expect(userPresence({ ...base, mode: "away", modeUntil: UNTIL })).toEqual({
      state: "away",
      until: UNTIL,
    });
    expect(userPresence({ ...base, mode: "busy", modeUntil: null })).toEqual({ state: "busy" });
    expect(userPresence({ ...base, mode: "dnd", modeUntil: UNTIL })).toEqual({
      state: "dnd",
      until: UNTIL,
      dnd: { until: UNTIL },
    });
  });
  it("4'. 방해 금지는 오프라인이어도 dnd 표지와 만료를 싣는다(만료는 dnd 표지 안에만)", () => {
    expect(userPresence({ ...base, mode: "dnd", modeUntil: UNTIL, sockets: 0, anyVisible: false })).toEqual({
      state: "offline",
      dnd: { until: UNTIL },
    });
    expect(userPresence({ ...base, mode: "busy", modeUntil: UNTIL, sockets: 0, anyVisible: false })).toEqual({
      state: "offline",
    });
  });
  it("5. 보이는 탭이 하나라도 → online", () => {
    expect(userPresence(base)).toEqual({ state: "online" });
  });
  it("6. 소켓은 있으나 모두 숨김 → away", () => {
    expect(userPresence({ ...base, anyVisible: false })).toEqual({ state: "away" });
  });
});

describe("agentPresence", () => {
  const a = { archived: false, enabled: true, connected: true, working: false };
  it("1. 보관 → 점 없음", () => {
    expect(agentPresence({ ...a, archived: true, enabled: false })).toBeNull();
  });
  it("2. 꺼짐 → off", () => {
    expect(agentPresence({ ...a, enabled: false, working: true })).toBe("off");
  });
  it("3. 연결 없음 → disconnected", () => {
    expect(agentPresence({ ...a, connected: false, working: true })).toBe("disconnected");
  });
  it("4. 끝나지 않은 런 → working", () => {
    expect(agentPresence({ ...a, working: true })).toBe("working");
  });
  it("5. 그 밖 → available", () => {
    expect(agentPresence(a)).toBe("available");
  });
});
