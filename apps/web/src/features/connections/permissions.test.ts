import { describe, expect, it } from "vitest";
import { canManageConnection, canMoveBetween } from "./permissions";

// 연결 탭 통합 스펙 5.2 권한 표 — 서버 정책(auth/policies.ts)과 같은 표. 화면은 숨김 편의, 정본은 서버다
const ME = "u-me";
const OTHER = "u-other";

describe("canManageConnection — 자기 연결 관리·남의 연결 관리", () => {
  it.each([
    ["member, 자기 연결", "member", ME, true],
    ["member, 남의 연결", "member", OTHER, false],
    ["member, 주인 없는 연결", "member", null, false],
    ["admin, 남의 연결", "admin", OTHER, true],
    ["admin, 주인 없는 연결", "admin", null, true],
    ["owner, 남의 연결", "owner", OTHER, true],
    ["멤버 아님, 자기 연결이어도", undefined, ME, false],
  ] as const)("%s", (_label, role, owner, expected) => {
    expect(canManageConnection(role, ME, owner)).toBe(expected);
  });

  it("나를 모르면(로그인 정보 없음) 주인일 수 없다", () => {
    expect(canManageConnection("member", null, null)).toBe(false);
  });
});

describe("canMoveBetween — Gateway·프로젝트 옮기기", () => {
  it.each([
    ["member, 둘 다 자기 것", "member", ME, ME, true],
    ["member, 원래 곳이 남의 것", "member", OTHER, ME, false],
    ["member, 옮길 곳이 남의 것", "member", ME, OTHER, false],
    ["member, 원래 곳이 없음(Gateway 삭제됨)", "member", null, ME, false],
    ["admin, 남의 것 사이", "admin", OTHER, null, true],
    ["owner", "owner", null, null, true],
  ] as const)("%s", (_label, role, from, to, expected) => {
    expect(canMoveBetween(role, ME, from, to)).toBe(expected);
  });
});
