import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  permissionModeRank,
  RUNNER_PERMISSION_MODES,
  RUNNER_PROTOCOL,
  RunnerFsListResult,
  RunnerHelloResult,
  RunnerHello,
  RunnerProgram,
  RunnerProjectCheckResult,
  RunnerProjectRef,
  RunnerRelPath,
  RunnerRootId,
  RunnerRunFinal,
  RunnerRunSession,
  RunnerRunStart,
} from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a103";
const SESSION = "5d3c1c2e-7f0a-4b8e-9c1d-2a3b4c5d6e7f";

const HELLO = {
  runnerProtocol: RUNNER_PROTOCOL,
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.283",
  bundleSha256: null,
  capabilities: ["threads", "interrupt", "approvals", "attachments"],
  roots: [{ id: "src", label: "내 저장소들" }],
  browse: true,
  programs: [
    {
      program: "claude",
      available: true,
      version: "2.1.283",
      auth: "unknown",
      capabilities: ["serverSessionIds", "approvals", "images", "interrupt", "mcpTools", "costs"],
      ceiling: { maxPermissionMode: "acceptEdits", allowedToolsCeiling: null },
    },
  ],
};

const AGENT = {
  program: "claude",
  project: { rootId: "src", relPath: "dodok" },
  model: null,
  permissionMode: "default",
  allowedTools: null,
  disallowedTools: [],
};

const START = {
  deliver: {
    deliveryId: ID,
    kind: "message",
    channelId: CH,
    conversationId: CH,
    conversationTitle: "배포 점검",
    agentId: "r-0123456789",
    sessionKey: `agent:r-0123456789:dodok:channel:${CH}`,
    runId: ID,
    message: {
      id: MSG,
      author: { type: "user", handle: "mia", displayName: "Mia" },
      text: "@coder 안녕",
      attachments: [],
      ts: "2026-10-29T00:00:00.000Z",
    },
    context: { recentMessages: [], participants: [], relayRules: "" },
  },
  providerSessionId: SESSION,
  channelRulesAppend: "",
  turnFacts: "",
  sessionTitle: "",
  agent: AGENT,
};

describe("RunnerRelPath — 서버·러너가 같은 스키마로 거른다", () => {
  it.each(["", "a", "a/b", "my repo/x-1", "a/.hidden", "한글/폴더"])("받는다: %j", (p) => {
    expect(RunnerRelPath.safeParse(p).success).toBe(true);
  });

  it.each([
    ["..", "위로"],
    ["a/../b", "가운데 위로"],
    [".", "점 하나"],
    ["a/./b", "가운데 점 하나"],
    ["a//b", "빈 성분"],
    ["a/", "끝 빈 성분"],
    ["/a", "앞 /"],
    ["a\\b", "백슬래시"],
    ["a\u0000b", "NUL"],
    ["x".repeat(513), "513자"],
  ])("거절한다: %j(%s)", (p) => {
    expect(RunnerRelPath.safeParse(p).success).toBe(false);
  });

  it("512자는 받는다", () => {
    expect(RunnerRelPath.safeParse("x".repeat(512)).success).toBe(true);
  });
});

describe("RunnerRootId", () => {
  it("[a-z0-9-]{1,32}", () => {
    expect(RunnerRootId.safeParse("src").success).toBe(true);
    expect(RunnerRootId.safeParse("my-work-2").success).toBe(true);
    expect(RunnerRootId.safeParse("x".repeat(32)).success).toBe(true);
    for (const bad of ["", "Src", "a_b", "a.b", "x".repeat(33), "a b"]) {
      expect(RunnerRootId.safeParse(bad).success).toBe(false);
    }
  });
});

describe("권한 모드 순서 — 묻지 않고 돌 수 있는 것이 많은 순(스펙 2장)", () => {
  it("plan < dontAsk < default < acceptEdits, bypassPermissions 는 없다", () => {
    expect(RUNNER_PERMISSION_MODES).toEqual(["plan", "dontAsk", "default", "acceptEdits"]);
    expect(permissionModeRank("plan")).toBeLessThan(permissionModeRank("dontAsk"));
    expect(permissionModeRank("dontAsk")).toBeLessThan(permissionModeRank("default"));
    expect(permissionModeRank("default")).toBeLessThan(permissionModeRank("acceptEdits"));
    expect(
      RunnerRunStart.safeParse({ ...START, agent: { ...AGENT, permissionMode: "bypassPermissions" } })
        .success,
    ).toBe(false);
  });
});

describe("RunnerHello", () => {
  it("roots·browse·programs 를 받는다", () => {
    expect(RunnerHello.parse(HELLO)).toEqual(HELLO);
    expect(RunnerProgram.options).toEqual(["claude", "codex", "opencode"]);
  });

  it("옛 키(agents·claudeCodeVersion)가 있으면 거절한다 — strict", () => {
    expect(RunnerHello.safeParse({ ...HELLO, agents: [] }).success).toBe(false);
    expect(RunnerHello.safeParse({ ...HELLO, claudeCodeVersion: "2.1.283" }).success).toBe(false);
  });

  it("루트는 id·label 뿐 — path 를 실으면 거절, 17개도 거절", () => {
    expect(
      RunnerHello.safeParse({ ...HELLO, roots: [{ id: "src", label: "x", path: "/home/u/src" }] }).success,
    ).toBe(false);
    const roots = Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, label: `r${i}` }));
    expect(RunnerHello.safeParse({ ...HELLO, roots }).success).toBe(false);
  });

  it("프로그램 능력은 문자열이면 받는다 — 모르는 값은 서버가 버린다", () => {
    const programs = [{ ...HELLO.programs[0], capabilities: ["future-cap"] }];
    expect(RunnerHello.safeParse({ ...HELLO, programs }).success).toBe(true);
  });

  it("hello 프로그램 상태 — login 은 default·dedicated 를 받고 없어도 받는다", () => {
    for (const login of ["default", "dedicated"] as const) {
      const programs = [{ ...HELLO.programs[0], login }];
      expect(RunnerHello.parse({ ...HELLO, programs }).programs[0]?.login).toBe(login);
    }
    expect(RunnerHello.parse(HELLO).programs[0]?.login).toBeUndefined();
  });

  it("hello 프로그램 상태 — cli 는 installed·bundled 를 받고 없어도(옛 러너) 받는다, 모르는 값은 거절", () => {
    for (const cli of ["installed", "bundled"] as const) {
      const programs = [{ ...HELLO.programs[0], cli }];
      expect(RunnerHello.parse({ ...HELLO, programs }).programs[0]?.cli).toBe(cli);
    }
    expect(RunnerHello.parse(HELLO).programs[0]?.cli).toBeUndefined();
    expect(
      RunnerHello.safeParse({ ...HELLO, programs: [{ ...HELLO.programs[0], cli: "npm" }] }).success,
    ).toBe(false);
  });

  it("hello 프로그램 상태 — 모르는 login 값은 거절", () => {
    const programs = [{ ...HELLO.programs[0], login: "shared" }];
    expect(RunnerHello.safeParse({ ...HELLO, programs }).success).toBe(false);
  });

  it("상한 권한 모드에 bypassPermissions 는 없다", () => {
    const programs = [
      {
        ...HELLO.programs[0],
        ceiling: { maxPermissionMode: "bypassPermissions", allowedToolsCeiling: null },
      },
    ];
    expect(RunnerHello.safeParse({ ...HELLO, programs }).success).toBe(false);
  });

  it("hello 결과 — 받음·판본 불일치", () => {
    expect(RunnerHelloResult.parse({ ok: true, serverVersion: "x" })).toEqual({
      ok: true,
      serverVersion: "x",
    });
    expect(RunnerHelloResult.safeParse({ ok: false, code: "PROTOCOL_MISMATCH", message: "m" }).success).toBe(
      true,
    );
    expect(RunnerHelloResult.safeParse({ ok: false, code: "RATE_LIMITED", message: "m" }).success).toBe(
      false,
    );
  });
});

describe("RunnerRunStart", () => {
  it("지금 것 + agent, providerSessionId 는 선택", () => {
    expect(RunnerRunStart.parse(START).agent).toEqual(AGENT);
    const { providerSessionId: _, ...noSession } = START;
    expect(RunnerRunStart.safeParse(noSession).success).toBe(true);
  });

  it("agent 의 relPath·rootId 는 같은 스키마로 거른다", () => {
    const bad = (project: object) =>
      RunnerRunStart.safeParse({ ...START, agent: { ...AGENT, project } }).success;
    expect(bad({ rootId: "src", relPath: "../etc" })).toBe(false);
    expect(bad({ rootId: "Src", relPath: "a" })).toBe(false);
    expect(bad({ rootId: "src", relPath: "" })).toBe(true);
  });

  it("agent 가 없으면 거절 — 서버가 에이전트 정의를 통째로 싣는다", () => {
    const { agent: _, ...v1 } = START;
    expect(RunnerRunStart.safeParse(v1).success).toBe(false);
  });
});

describe("세션 설정 — effort·컨텍스트 사용량", () => {
  it("effort 없는 옛 run.start.agent 도 받고, 있으면 다섯 값만", () => {
    expect(RunnerRunStart.parse(START).agent.effort).toBeUndefined();
    expect(RunnerRunStart.parse({ ...START, agent: { ...AGENT, effort: "high" } }).agent.effort).toBe("high");
    expect(RunnerRunStart.parse({ ...START, agent: { ...AGENT, effort: null } }).agent.effort).toBeNull();
    expect(RunnerRunStart.safeParse({ ...START, agent: { ...AGENT, effort: "extreme" } }).success).toBe(
      false,
    );
  });

  it("run.final usage 의 contextTokens·contextWindow — 선택, 창 크기 0 은 거절", () => {
    const final = { runId: ID, text: "끝", stopReason: "end_turn", costKind: "api" };
    const usage = { inputTokens: 10, outputTokens: 3, contextTokens: 32100, contextWindow: 200000 };
    expect(RunnerRunFinal.parse({ ...final, usage }).usage).toEqual(usage);
    expect(RunnerRunFinal.safeParse({ ...final, usage: { inputTokens: 1 } }).success).toBe(true);
    expect(RunnerRunFinal.safeParse({ ...final, usage: { ...usage, contextWindow: 0 } }).success).toBe(false);
    expect(RunnerRunFinal.safeParse({ ...final, usage: { ...usage, contextTokens: -1 } }).success).toBe(
      false,
    );
  });
});

describe("둘러보기·프로젝트 확인·세션 프레임", () => {
  it("fs.list 요청·결과", () => {
    expect(RunnerProjectRef.safeParse({ rootId: "src", relPath: "a/b" }).success).toBe(true);
    expect(RunnerProjectRef.safeParse({ rootId: "src", relPath: "a/../b" }).success).toBe(false);
    const ok = { ok: true, entries: [{ name: "dodok", isGitRepo: true }], truncated: false };
    expect(RunnerFsListResult.parse(ok)).toEqual(ok);
    expect(RunnerFsListResult.safeParse({ ok: false, code: "FORBIDDEN" }).success).toBe(true);
    expect(RunnerFsListResult.safeParse({ ok: false, code: "NOT_FOUND" }).success).toBe(true);
    expect(RunnerFsListResult.safeParse({ ok: false, code: "INTERNAL" }).success).toBe(false);
    const many = {
      ok: true,
      entries: Array.from({ length: 501 }, (_, i) => ({ name: `d${i}`, isGitRepo: false })),
      truncated: true,
    };
    expect(RunnerFsListResult.safeParse(many).success).toBe(false);
  });

  it("project.check 결과 — 사유 넷", () => {
    expect(RunnerProjectCheckResult.safeParse({ ok: true, isGitRepo: false }).success).toBe(true);
    for (const reason of ["root_missing", "not_found", "not_directory", "outside_root"]) {
      expect(RunnerProjectCheckResult.safeParse({ ok: false, reason }).success).toBe(true);
    }
    expect(RunnerProjectCheckResult.safeParse({ ok: false, reason: "nope" }).success).toBe(false);
  });

  it("run.session", () => {
    expect(RunnerRunSession.safeParse({ runId: ID, providerSessionId: "thread_abc" }).success).toBe(true);
    expect(RunnerRunSession.safeParse({ runId: ID, providerSessionId: "" }).success).toBe(false);
  });

  it("ErrorCode 에 RUNNER_CEILING", () => {
    expect(ErrorCode.safeParse("RUNNER_CEILING").success).toBe(true);
  });
});
