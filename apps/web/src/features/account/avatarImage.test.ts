import { describe, expect, it } from "vitest";
import { expiryOf, squareCrop } from "./avatarImage";

// 상태 만료 고르기(프로필 스펙 3.2)·아바타 자르기(3.6)

describe("expiryOf", () => {
  // 로컬 시각으로 만든다 — 「오늘」의 경계는 브라우저 시간대의 자정이다
  const now = new Date(2026, 10, 2, 15, 0, 0);

  it("「오늘」은 같은 날 24:00(다음 날 0시) 로컬의 ISO", () => {
    expect(expiryOf("today", now)).toBe(new Date(2026, 10, 3, 0, 0, 0).toISOString());
  });
  it("「안 지움」은 null", () => {
    expect(expiryOf("never", now)).toBeNull();
  });
  it("30분·1시간·4시간은 지금부터", () => {
    expect(expiryOf("30m", now)).toBe(new Date(now.getTime() + 30 * 60_000).toISOString());
    expect(expiryOf("1h", now)).toBe(new Date(now.getTime() + 3_600_000).toISOString());
    expect(expiryOf("4h", now)).toBe(new Date(now.getTime() + 4 * 3_600_000).toISOString());
  });
  it("직접 고른 시각은 그대로", () => {
    const at = new Date(2026, 10, 5, 9, 30);
    expect(expiryOf({ at }, now)).toBe(at.toISOString());
  });
});

describe("squareCrop", () => {
  it("가로가 길면 가운데 정사각형", () => {
    expect(squareCrop(300, 200)).toEqual({ sx: 50, sy: 0, side: 200 });
  });
  it("세로가 길면 가운데 정사각형", () => {
    expect(squareCrop(100, 160)).toEqual({ sx: 0, sy: 30, side: 100 });
  });
  it("정사각형은 그대로", () => {
    expect(squareCrop(64, 64)).toEqual({ sx: 0, sy: 0, side: 64 });
  });
});
