import { describe, expect, it } from "vitest";
import { applyClaudeConfigDirEnv, resolveClaudeConfigDir } from "../src/drivers/claude/config-dir";

const DEDICATED = { configDir: "/home/u/.dodok-runner/claude" };

describe("resolveClaudeConfigDir", () => {
  it("configDir 이 있으면 전용 — 셸 값과 무관하게 그 자리", () => {
    expect(resolveClaudeConfigDir(DEDICATED, { CLAUDE_CONFIG_DIR: "/x" })).toEqual({
      login: "dedicated",
      dir: "/home/u/.dodok-runner/claude",
    });
  });

  it("configDir 이 없고 env 에도 없으면 평소 — dir 없음(~/.claude)", () => {
    expect(resolveClaudeConfigDir({}, {})).toEqual({ login: "default", dir: undefined });
  });

  it("configDir 이 없고 셸에 CLAUDE_CONFIG_DIR 이 있으면 평소 — 그 값", () => {
    expect(resolveClaudeConfigDir({}, { CLAUDE_CONFIG_DIR: "/x" })).toEqual({ login: "default", dir: "/x" });
  });

  it("셸의 빈 CLAUDE_CONFIG_DIR 은 없는 것으로 친다", () => {
    expect(resolveClaudeConfigDir({}, { CLAUDE_CONFIG_DIR: "" })).toEqual({
      login: "default",
      dir: undefined,
    });
  });
});

describe("applyClaudeConfigDirEnv — 러너 프로세스 env 를 CLI 와 같은 자리로", () => {
  it("전용이면 셸 값을 configDir 로 덮는다", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/x" };
    applyClaudeConfigDirEnv(env, DEDICATED);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/home/u/.dodok-runner/claude");
  });

  it("평소 + 빈 값이면 키를 지운다", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "" };
    applyClaudeConfigDirEnv(env, {});
    expect("CLAUDE_CONFIG_DIR" in env).toBe(false);
  });

  it("평소 + 값이 있으면 그대로 둔다", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "/x" };
    applyClaudeConfigDirEnv(env, {});
    expect(env.CLAUDE_CONFIG_DIR).toBe("/x");
  });

  it("claude 프로그램을 켜지 않았으면(ceiling 없음) env 를 건드리지 않는다", () => {
    const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: "" };
    applyClaudeConfigDirEnv(env, undefined);
    expect(env).toEqual({ CLAUDE_CONFIG_DIR: "" });
  });
});
