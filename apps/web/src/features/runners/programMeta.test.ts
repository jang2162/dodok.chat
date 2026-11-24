import type { RunnerProgramStatus } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { PROGRAM_META, programRows } from "./programMeta";

function status(over: Partial<RunnerProgramStatus> = {}): RunnerProgramStatus {
  return {
    program: "claude",
    available: true,
    version: "2.1.0",
    auth: "ok",
    capabilities: [],
    ceiling: { maxPermissionMode: "acceptEdits", allowedToolsCeiling: null },
    ...over,
  };
}

describe("PROGRAM_META", () => {
  it("이름은 shared 이름표, 배지는 글자 둘", () => {
    expect(PROGRAM_META.claude).toEqual({ name: "Claude Code", short: "CC", tone: "clay" });
    expect(PROGRAM_META.codex).toEqual({ name: "Codex", short: "CX", tone: "blue" });
    expect(PROGRAM_META.opencode).toEqual({ name: "OpenCode", short: "OC", tone: "violet" });
  });
});

describe("programRows", () => {
  it("끊긴 러너는 programs 가 있어도 disconnected", () => {
    expect(programRows([status()], false)).toEqual({ kind: "disconnected" });
    expect(programRows([], false)).toEqual({ kind: "disconnected" });
  });

  it("enum 순서로 줄 셋 — 알리지 않은 프로그램은 unsupported", () => {
    const claude = status();
    expect(programRows([claude], true)).toEqual({
      kind: "rows",
      rows: [
        { program: "claude", state: "available", status: claude },
        { program: "codex", state: "unsupported" },
        { program: "opencode", state: "unsupported" },
      ],
    });
  });

  it("enum 순서는 hello 의 순서와 상관없다", () => {
    const res = programRows([status({ program: "codex", available: false }), status()], true);
    expect(res.kind === "rows" && res.rows.map((r) => r.program)).toEqual(["claude", "codex", "opencode"]);
  });

  it("상태 가르기 — 설치 안 됨·로그인 필요·로그인 확인 안 됨", () => {
    const rowOf = (s: RunnerProgramStatus) => {
      const res = programRows([s], true);
      return res.kind === "rows" ? res.rows[0]?.state : undefined;
    };
    expect(rowOf(status({ available: false, reason: "설치되지 않음" }))).toBe("not-installed");
    expect(rowOf(status({ auth: "missing" }))).toBe("login");
    expect(rowOf(status({ auth: "unknown" }))).toBe("unknown-auth");
    // 못 쓰는 것이 먼저 — 설치가 안 됐으면 로그인은 따지지 않는다
    expect(rowOf(status({ available: false, auth: "missing" }))).toBe("not-installed");
  });

  it("같은 프로그램이 두 번 오면 앞의 것", () => {
    const first = status({ version: "1" });
    const res = programRows([first, status({ version: "2", auth: "missing" })], true);
    expect(res.kind === "rows" && res.rows[0]).toEqual({
      program: "claude",
      state: "available",
      status: first,
    });
  });
});
