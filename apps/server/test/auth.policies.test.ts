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
  authorizeConnectionCreate,
  authorizeConnectionManage,
  authorizeConnectionRead,
  authorizeGatewayApprove,
  authorizeAgentMoveGateway,
  authorizeOpsRead,
  authorizeProjectMove,
  authorizeRead,
  authorizeRunnerManage,
  canApproveGateway,
  type ConnectionActor,
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
  // 연결 정책 — 남의 연결(주인 아님)이면 admin 이상(연결 탭 통합 스펙 5.2 「남의 연결 관리」)
  ...(
    [
      ["authorizeAgentDiscover", authorizeAgentDiscover],
      ["authorizeAgentRegister", authorizeAgentRegister],
      ["authorizeAgentPatch", authorizeAgentPatch],
      ["authorizeAgentArchive", authorizeAgentArchive],
      ["authorizeRunnerManage", authorizeRunnerManage],
      ["authorizeConnectionManage", authorizeConnectionManage],
      ["authorizeConnectionRead", authorizeConnectionRead],
    ] as const
  ).map(([name, policy]): Case => ({
    name: `${name} (남의 연결)`,
    min: "admin",
    check: (r) => policy({ role: r, ownsConnection: false }),
  })),
  // 자기 연결이면 member 도(스펙 5.2 「자기 연결 관리」·「연결의 주소·토큰 목록·설치 명령 보기」)
  ...(
    [
      ["authorizeAgentDiscover", authorizeAgentDiscover],
      ["authorizeAgentRegister", authorizeAgentRegister],
      ["authorizeAgentPatch", authorizeAgentPatch],
      ["authorizeAgentArchive", authorizeAgentArchive],
      ["authorizeRunnerManage", authorizeRunnerManage],
      ["authorizeConnectionManage", authorizeConnectionManage],
      ["authorizeConnectionRead", authorizeConnectionRead],
    ] as const
  ).map(([name, policy]): Case => ({
    name: `${name} (자기 연결)`,
    min: "member",
    check: (r) => policy({ role: r, ownsConnection: true }),
  })),
  { name: "authorizeConnectionCreate", min: "member", check: (r) => authorizeConnectionCreate(r) },
  { name: "authorizeGatewayApprove", min: "admin", check: (r) => authorizeGatewayApprove(r) },
  {
    name: "authorizeAgentMoveGateway (한쪽이 남의 것)",
    min: "admin",
    check: (r) => authorizeAgentMoveGateway(r, false),
  },
  {
    name: "authorizeAgentMoveGateway (둘 다 자기 것)",
    min: "member",
    check: (r) => authorizeAgentMoveGateway(r, true),
  },
  {
    name: "authorizeProjectMove (한쪽이 남의 것)",
    min: "admin",
    check: (r) => authorizeProjectMove(r, false),
  },
  {
    name: "authorizeProjectMove (둘 다 자기 것)",
    min: "member",
    check: (r) => authorizeProjectMove(r, true),
  },
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

  it("주인이어도 멤버가 아니면(비활성·membership 없음) 통과하지 않는다", () => {
    const actor: ConnectionActor = { role: undefined, ownsConnection: true };
    expect(() => authorizeConnectionManage(actor)).toThrow(HttpError);
    expect(() => authorizeAgentPatch(actor)).toThrow(HttpError);
    expect(() => authorizeAgentMoveGateway(undefined, true)).toThrow(HttpError);
  });

  it("canApproveGateway 는 admin 이상만 참 — 승인 단추(authorizeGatewayApprove)와 같은 판정(서비스의 자동 승인·승인 유지도 이것)", () => {
    for (const role of ROLES) {
      const expected = role === "admin" || role === "owner";
      expect(canApproveGateway(role), role ?? "(멤버 아님)").toBe(expected);
      let passed = true;
      try {
        authorizeGatewayApprove(role);
      } catch {
        passed = false;
      }
      expect(passed, role ?? "(멤버 아님)").toBe(expected);
    }
  });

  it("남의 연결 거절 문구는 주인을 함께 말한다", () => {
    expect(() => authorizeConnectionManage({ role: "member", ownsConnection: false })).toThrow(
      "그 연결의 주인·admin 이상만 쓸 수 있다",
    );
  });

  it("거절 문구는 REST requireRole 과 같다", () => {
    expect(() => authorizeChannelArchive("member")).toThrow("admin 이상만 쓸 수 있다");
    expect(() => authorizeRead(undefined)).toThrow("member 이상만 쓸 수 있다");
  });
});
