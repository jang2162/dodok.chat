import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { describe, expect, it } from "vitest";
import { createSessionGenerations, isContinuing } from "../src/session-continuity";

const KEY = "agent:dev:dodok:channel:01a09fc9-d204-7551-89d6-38544d07a102";
const NOW = Date.parse("2026-11-27T12:00:00.000Z");
const entry = { sessionId: "s1", updatedAt: NOW - 60_000, compactionCount: 0 };
const base = {
  remembered: { sessionId: "s1", compactionCount: 0 },
  entry,
  cfg: {} as OpenClawConfig,
  sessionKey: KEY,
  chatKind: "channel" as const,
  now: NOW,
};

describe("isContinuing — 앞 턴을 실은 OpenClaw 세션을 그대로 이어 가는가", () => {
  it("기억한 세대와 같고 리셋 정책이 없으면(코어 기본 mode none) 이어 간다", () => {
    expect(isContinuing(base)).toBe(true);
  });

  it("기억이 없으면(플러그인이 다시 뜬 뒤 첫 턴·앞 전달에 런이 시작되지 않음) 전부", () => {
    expect(isContinuing({ ...base, remembered: undefined })).toBe(false);
  });

  it("세션 항목이 없으면 전부", () => {
    expect(isContinuing({ ...base, entry: undefined })).toBe(false);
  });

  it("sessionId 가 바뀌었으면(/new·/reset) 전부", () => {
    expect(isContinuing({ ...base, entry: { ...entry, sessionId: "s2" } })).toBe(false);
  });

  it("컴팩션 수가 바뀌었으면 전부 — 앞 턴이 요약으로만 남았다", () => {
    expect(isContinuing({ ...base, entry: { ...entry, compactionCount: 1 } })).toBe(false);
  });

  it("일일 리셋 시각을 지났으면(코어가 이번 인바운드에서 새 세션을 연다) 전부", () => {
    const cfg = { session: { reset: { mode: "daily", atHour: 4 } } } as unknown as OpenClawConfig;
    const yesterday = { ...entry, updatedAt: NOW - 30 * 3_600_000, sessionStartedAt: NOW - 30 * 3_600_000 };
    expect(isContinuing({ ...base, cfg, entry: yesterday })).toBe(false);
    expect(isContinuing({ ...base, cfg, entry: { ...entry, sessionStartedAt: NOW - 60_000 } })).toBe(true);
  });

  it("유휴 리셋 — dodok 채널 덮어쓰기(resetByChannel)도 코어처럼 본다", () => {
    const cfg = {
      session: { resetByChannel: { dodok: { mode: "idle", idleMinutes: 10 } } },
    } as unknown as OpenClawConfig;
    expect(isContinuing({ ...base, cfg, entry: { ...entry, lastInteractionAt: NOW - 20 * 60_000 } })).toBe(
      false,
    );
    expect(isContinuing({ ...base, cfg, entry: { ...entry, lastInteractionAt: NOW - 5 * 60_000 } })).toBe(
      true,
    );
  });
});

describe("createSessionGenerations — 최근 limit 개만(LRU)", () => {
  it("넘치면 가장 오래 안 쓴 세션부터 밀어낸다, forget 은 지운다", () => {
    const g = createSessionGenerations(2);
    g.remember("a", { sessionId: "1", compactionCount: 0 });
    g.remember("b", { sessionId: "2", compactionCount: 0 });
    g.remember("a", { sessionId: "3", compactionCount: 0 });
    g.remember("c", { sessionId: "4", compactionCount: 0 });
    expect(g.get("b")).toBeUndefined();
    expect(g.get("a")?.sessionId).toBe("3");
    g.forget("a");
    expect(g.get("a")).toBeUndefined();
    expect(g.size).toBe(1);
  });
});
