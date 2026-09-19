import { RelayPolicy } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { uid } from "../../../test/fixtures";
import { type RelayForm, fromForm, toForm } from "./relayPolicyForm";

const A = uid(11);
const B = uid(12);

const form = (over: Partial<RelayForm> = {}): RelayForm => ({
  maxRelayTurns: "4",
  dailyRunLimit: "",
  allowAll: true,
  pairs: [],
  ...over,
});

/** ok 면 정책, 아니면 테스트 실패 */
function policyOf(f: RelayForm): RelayPolicy {
  const r = fromForm(f);
  if (!r.ok) throw new Error(`ok 여야 한다: ${r.error}`);
  // 서버가 받는 계약을 통과해야 한다
  expect(RelayPolicy.parse(r.policy)).toEqual(r.policy);
  return r.policy;
}

function errorOf(f: RelayForm): string {
  const r = fromForm(f);
  if (r.ok) throw new Error("ok 가 아니어야 한다");
  return r.error;
}

describe("toForm", () => {
  it("모두 허용·일일 상한 없음", () => {
    expect(toForm({ maxRelayTurns: 4, allowPairs: "all" })).toEqual({
      maxRelayTurns: "4",
      dailyRunLimit: "",
      allowAll: true,
      pairs: [],
    });
  });

  it("쌍 목록·일일 상한", () => {
    expect(toForm({ maxRelayTurns: 0, allowPairs: [{ from: A, to: B }], dailyRunLimit: 50 })).toEqual({
      maxRelayTurns: "0",
      dailyRunLimit: "50",
      allowAll: false,
      pairs: [{ from: A, to: B }],
    });
  });

  it("되돌리면 같은 정책", () => {
    const policy: RelayPolicy = { maxRelayTurns: 7, allowPairs: [{ from: B, to: A }], dailyRunLimit: 3 };
    expect(policyOf(toForm(policy))).toEqual(policy);
  });
});

describe("fromForm", () => {
  it("턴 상한은 0~32 정수", () => {
    for (const bad of ["33", "-1", "1.5", "", "abc", "1e1"]) {
      expect(errorOf(form({ maxRelayTurns: bad }))).toMatch("턴 상한은 0~32");
    }
    expect(policyOf(form({ maxRelayTurns: "0" })).maxRelayTurns).toBe(0);
    expect(policyOf(form({ maxRelayTurns: " 32 " })).maxRelayTurns).toBe(32);
  });

  it("일일 상한: 빈칸이면 없음, 있으면 1 이상 정수", () => {
    expect(policyOf(form({ dailyRunLimit: "" }))).not.toHaveProperty("dailyRunLimit");
    expect(policyOf(form({ dailyRunLimit: "  " }))).not.toHaveProperty("dailyRunLimit");
    expect(policyOf(form({ dailyRunLimit: "100" })).dailyRunLimit).toBe(100);
    for (const bad of ["0", "-3", "2.5", "x"]) {
      expect(errorOf(form({ dailyRunLimit: bad }))).toMatch("일일 상한");
    }
  });

  it("모두 허용이면 쌍은 무시하고 all", () => {
    expect(policyOf(form({ allowAll: true, pairs: [{ from: A, to: B }] })).allowPairs).toBe("all");
  });

  it("쌍 목록: 자기 자신 금지", () => {
    expect(errorOf(form({ allowAll: false, pairs: [{ from: A, to: A }] }))).toMatch("자기 자신");
  });

  it("쌍 목록: 64개까지", () => {
    const pairs = Array.from({ length: 65 }, (_, i) => ({ from: uid(100 + i), to: B }));
    expect(errorOf(form({ allowAll: false, pairs }))).toMatch("64");
    expect(policyOf(form({ allowAll: false, pairs: pairs.slice(0, 64) })).allowPairs).toHaveLength(64);
  });

  it("쌍 목록 그대로 — 비어 있으면 릴레이 없음", () => {
    expect(policyOf(form({ allowAll: false, pairs: [{ from: A, to: B }] }))).toEqual({
      maxRelayTurns: 4,
      allowPairs: [{ from: A, to: B }],
    });
    expect(policyOf(form({ allowAll: false, pairs: [] })).allowPairs).toEqual([]);
  });
});
