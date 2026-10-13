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
});
