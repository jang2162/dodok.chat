import { describe, expect, it } from "vitest";
import { USER } from "../../../test/fixtures";
import { canDecideApproval } from "./decider";

const MIA = "0f0f0f0f-0000-4000-8000-00000000a11a";
const meOf = (id: string, role: "owner" | "admin" | "member") => ({ role, user: { id } });

describe("canDecideApproval", () => {
  it("확인 카드는 시킨 사람 본인만 — 역할을 보지 않는다", () => {
    const card = { kind: "dodok_control", requestedBy: MIA } as const;
    expect(canDecideApproval(card, meOf(MIA, "member"))).toBe(true);
    expect(canDecideApproval(card, meOf(USER, "owner"))).toBe(false);
  });

  it("확인 카드의 시킨 사람이 비어 있으면 me 가 없어도 있어도 아무도 못 한다 — undefined 끼리 같다고 보지 않는다", () => {
    const card = { kind: "dodok_control", requestedBy: undefined } as const;
    expect(canDecideApproval(card, undefined)).toBe(false);
    expect(canDecideApproval(card, { role: "owner" })).toBe(false);
    expect(canDecideApproval(card, meOf(USER, "owner"))).toBe(false);
  });

  it("다른 종류는 admin 이상 — 시킨 사람 칸을 보지 않는다", () => {
    const card = { kind: "exec", requestedBy: undefined } as const;
    expect(canDecideApproval(card, meOf(USER, "admin"))).toBe(true);
    expect(canDecideApproval(card, meOf(USER, "member"))).toBe(false);
    expect(canDecideApproval({ kind: "plugin", requestedBy: MIA }, meOf(MIA, "member"))).toBe(false);
    expect(canDecideApproval(card, undefined)).toBe(false);
  });

  it("에이전트 DM 이면 종류·역할과 상관없이 주인만", () => {
    const dm = { kind: "dm", dmOwnerId: MIA } as const;
    expect(canDecideApproval({ kind: "plugin", requestedBy: undefined }, meOf(MIA, "member"), dm)).toBe(true);
    expect(canDecideApproval({ kind: "plugin", requestedBy: undefined }, meOf(USER, "owner"), dm)).toBe(
      false,
    );
  });

  it("사람 DM·그룹 DM 이면 종류·역할과 상관없이 시킨 사람만 — 비었으면 아무도(사람 간 DM 계획 판정 PH7)", () => {
    const direct = { kind: "direct", dmOwnerId: null } as const;
    for (const kind of ["plugin", "exec", "tool", "dodok_control"] as const) {
      expect(canDecideApproval({ kind, requestedBy: MIA }, meOf(MIA, "member"), direct)).toBe(true);
      expect(canDecideApproval({ kind, requestedBy: MIA }, meOf(USER, "owner"), direct)).toBe(false);
      expect(canDecideApproval({ kind, requestedBy: undefined }, meOf(USER, "owner"), direct)).toBe(false);
      expect(canDecideApproval({ kind, requestedBy: undefined }, undefined, direct)).toBe(false);
    }
  });

  it("모르는 채널 종류면 아무도 — 일반 채널 규칙(admin 이상)으로 새지 않는다", () => {
    const odd = { kind: "zzz", dmOwnerId: null } as unknown as { kind: "channel"; dmOwnerId: null };
    expect(canDecideApproval({ kind: "plugin", requestedBy: undefined }, meOf(USER, "owner"), odd)).toBe(
      false,
    );
    // 일반 채널·옛 사본(kind 없음)은 지금 규칙
    expect(
      canDecideApproval({ kind: "plugin", requestedBy: undefined }, meOf(USER, "admin"), {
        kind: "channel",
        dmOwnerId: null,
      }),
    ).toBe(true);
    expect(
      canDecideApproval({ kind: "plugin", requestedBy: undefined }, meOf(USER, "admin"), { dmOwnerId: null }),
    ).toBe(true);
  });
});
