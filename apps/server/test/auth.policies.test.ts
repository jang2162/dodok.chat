import type { TeamRole } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  authorizeAgentArchive,
  authorizeAgentDiscover,
  authorizeAgentPatch,
  authorizeAgentRegister,
  authorizeChannelAgentPatch,
  authorizeChannelArchive,
  authorizeChannelCreate,
  authorizeChannelMemberAdd,
  authorizeChannelMemberRemove,
  authorizeChannelPatch,
  authorizeChannelUnarchive,
  authorizeOpsRead,
  authorizeRead,
} from "../src/auth/policies";
import { HttpError } from "../src/http/errors";

// 정책 함수 × 역할(팀 스펙 「역할과 권한」 표) — REST 경로는 roles.matrix.test.ts 가, 순수 판정은 여기서 본다.
// undefined 는 멤버 아님·비활성(roleOf) — 어떤 정책도 통과하지 않는다

const ROLES: Array<TeamRole | undefined> = [undefined, "member", "admin", "owner"];
const RANK = { member: 0, admin: 1, owner: 2 } as const;

type Case = { name: string; min: TeamRole; check: (role: TeamRole | undefined) => void };

const CASES: Case[] = [
  { name: "authorizeRead", min: "member", check: (r) => authorizeRead(r) },
  { name: "authorizeOpsRead", min: "admin", check: (r) => authorizeOpsRead(r) },
  ...(
    [
      ["{name}", "member", { name: "c" }],
      ["{name, topic}", "member", { name: "c", topic: "t" }],
      ["{name, prompt}", "admin", { name: "c", prompt: "p" }],
      ["{name, relayPolicy}", "admin", { name: "c", relayPolicy: { maxRelayTurns: 2, allowPairs: "all" } }],
      ["{name, visibility}", "admin", { name: "c", visibility: "private" }],
      ["{name, 모르는 키}", "admin", { name: "c", surprise: 1 }],
    ] as const
  ).map(([label, min, body]): Case => ({
    name: `authorizeChannelCreate ${label}`,
    min,
    check: (r) => authorizeChannelCreate(r, body),
  })),
  ...(
    [
      ["{name}", "member", { name: "c" }],
      ["{topic: null}", "member", { topic: null }],
      ["{}", "member", {}],
      ["{prompt}", "admin", { prompt: "p" }],
      ["{name, prompt}", "admin", { name: "c", prompt: "p" }],
      ["{relayPolicy}", "admin", { relayPolicy: { maxRelayTurns: 2, allowPairs: "all", dailyRunLimit: 3 } }],
      ["{visibility}", "admin", { visibility: "private" }],
      ["{name, dailyRunLimit}", "admin", { name: "c", dailyRunLimit: 3 }],
    ] as const
  ).map(([label, min, body]): Case => ({
    name: `authorizeChannelPatch ${label}`,
    min,
    check: (r) => authorizeChannelPatch(r, body),
  })),
  ...(
    [
      ["agent {}", "member", { memberType: "agent", memberId: "a" }],
      ["agent {aliases}", "member", { memberType: "agent", memberId: "a", aliases: ["bot"] }],
      ["agent {promptOverride}", "admin", { memberType: "agent", memberId: "a", promptOverride: "p" }],
      ["agent {autoRespond}", "admin", { memberType: "agent", memberId: "a", autoRespond: true }],
      [
        "agent {aliases, promptOverride}",
        "admin",
        { memberType: "agent", memberId: "a", aliases: [], promptOverride: "p" },
      ],
      ["user", "member", { memberType: "user", memberId: "u" }],
    ] as const
  ).map(([label, min, body]): Case => ({
    name: `authorizeChannelMemberAdd ${label}`,
    min,
    check: (r) => authorizeChannelMemberAdd(r, body),
  })),
  ...(
    [
      ["{aliases}", "member", { aliases: ["bot"] }],
      ["{promptOverride}", "admin", { promptOverride: null }],
      ["{autoRespond}", "admin", { autoRespond: false }],
      ["{aliases, autoRespond}", "admin", { aliases: ["bot"], autoRespond: true }],
    ] as const
  ).map(([label, min, body]): Case => ({
    name: `authorizeChannelAgentPatch ${label}`,
    min,
    check: (r) => authorizeChannelAgentPatch(r, body),
  })),
  { name: "authorizeChannelMemberRemove", min: "member", check: (r) => authorizeChannelMemberRemove(r) },
  { name: "authorizeChannelArchive", min: "admin", check: (r) => authorizeChannelArchive(r) },
  { name: "authorizeChannelUnarchive", min: "admin", check: (r) => authorizeChannelUnarchive(r) },
  { name: "authorizeAgentDiscover", min: "admin", check: (r) => authorizeAgentDiscover(r) },
  { name: "authorizeAgentRegister", min: "admin", check: (r) => authorizeAgentRegister(r) },
  { name: "authorizeAgentPatch", min: "admin", check: (r) => authorizeAgentPatch(r) },
  { name: "authorizeAgentArchive", min: "admin", check: (r) => authorizeAgentArchive(r) },
];

describe("역할 정책(auth/policies.ts)", () => {
  it.each(CASES.flatMap((c) => ROLES.map((role) => [c.name, role ?? "(멤버 아님)", role, c] as const)))(
    "%s — %s",
    (_name, _label, role, c) => {
      if (role !== undefined && RANK[role] >= RANK[c.min]) {
        expect(() => c.check(role)).not.toThrow();
        return;
      }
      let thrown: unknown;
      try {
        c.check(role);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(HttpError);
      expect(thrown).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    },
  );

  it("거절 문구는 REST requireRole 과 같다", () => {
    expect(() => authorizeChannelArchive("member")).toThrow("admin 이상만 쓸 수 있다");
    expect(() => authorizeRead(undefined)).toThrow("member 이상만 쓸 수 있다");
  });
});
