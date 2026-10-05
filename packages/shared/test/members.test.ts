import { describe, expect, it } from "vitest";
import { AcceptInviteBody, LocalLoginBody, Person, TeamRole, roleAtLeast } from "../src/members";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";

describe("roleAtLeast", () => {
  it("owner 는 admin 이상, admin 은 member 이상", () => {
    expect(roleAtLeast("owner", "admin")).toBe(true);
    expect(roleAtLeast("admin", "member")).toBe(true);
  });
  it("member 는 admin 이상이 아니다", () => {
    expect(roleAtLeast("member", "admin")).toBe(false);
  });
  it("모르는 값(guest·undefined)은 false", () => {
    expect(roleAtLeast("guest", "member")).toBe(false);
    expect(roleAtLeast(undefined, "member")).toBe(false);
  });
});

describe("LocalLoginBody", () => {
  it("{token} 을 받는다", () => {
    expect(LocalLoginBody.safeParse({ token: "x".repeat(32) }).success).toBe(true);
  });
  it("{email, password} 를 받는다", () => {
    expect(LocalLoginBody.safeParse({ email: "a@example.com", password: "pw" }).success).toBe(true);
  });
  it("섞인 모양·빈 값을 거절한다", () => {
    expect(LocalLoginBody.safeParse({ token: "x".repeat(32), email: "a@example.com" }).success).toBe(false);
    expect(LocalLoginBody.safeParse({}).success).toBe(false);
    expect(LocalLoginBody.safeParse({ token: "" }).success).toBe(false);
    expect(LocalLoginBody.safeParse({ email: "a@example.com", password: "" }).success).toBe(false);
  });
});

describe("AcceptInviteBody", () => {
  const base = {
    token: "t".repeat(10),
    handle: "researcher",
    displayName: "Researcher",
    email: "a@example.com",
    password: "x".repeat(12),
  };

  it("올바른 모양은 통과한다", () => {
    expect(AcceptInviteBody.safeParse(base).success).toBe(true);
  });
  it("핸들 대문자·1자·33자를 거절한다", () => {
    expect(AcceptInviteBody.safeParse({ ...base, handle: "Bob" }).success).toBe(false);
    expect(AcceptInviteBody.safeParse({ ...base, handle: "a" }).success).toBe(false);
    expect(AcceptInviteBody.safeParse({ ...base, handle: "x".repeat(33) }).success).toBe(false);
  });
  it("비밀번호 11자·257자를 거절한다", () => {
    expect(AcceptInviteBody.safeParse({ ...base, password: "x".repeat(11) }).success).toBe(false);
    expect(AcceptInviteBody.safeParse({ ...base, password: "x".repeat(257) }).success).toBe(false);
  });
  it("이메일 아닌 값을 거절한다", () => {
    expect(AcceptInviteBody.safeParse({ ...base, email: "not-an-email" }).success).toBe(false);
  });
});

describe("TeamRole", () => {
  it("owner·admin·member 만 받는다", () => {
    for (const role of ["owner", "admin", "member"]) {
      expect(TeamRole.safeParse(role).success).toBe(true);
    }
    expect(TeamRole.safeParse("guest").success).toBe(false);
  });
});

describe("Person", () => {
  it("role 이 있으면 지금 멤버다", () => {
    const p = {
      id: ID,
      handle: "researcher",
      displayName: "Researcher",
      role: "member",
      deactivatedAt: null,
    };
    expect(Person.parse(p).role).toBe("member");
  });
  it("비활성 멤버는 deactivatedAt 시각을 싣고, deactivatedAt 이 빠지면 거절한다", () => {
    const at = "2026-10-06T00:00:00.000Z";
    const p = { id: ID, handle: "researcher", displayName: "Researcher", role: "member", deactivatedAt: at };
    expect(Person.parse(p).deactivatedAt).toBe(at);
    expect(Person.safeParse({ id: ID, handle: "researcher", displayName: "Researcher" }).success).toBe(false);
  });
  it("옛 leftHandle 은 싣지 않는다 — 모르는 키는 버린다", () => {
    const p = { id: ID, handle: "researcher", displayName: "R", deactivatedAt: null, leftHandle: "old" };
    expect(Person.parse(p)).not.toHaveProperty("leftHandle");
  });
});
