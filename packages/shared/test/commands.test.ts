import { describe, expect, it } from "vitest";
import {
  AgentCommand,
  BridgeCapability,
  BridgeHello,
  CLAUDE_BUILTIN_ALLOWED,
  checkCommand,
  InboundDeliver,
  OPENCLAW_COMMANDS,
  parseAgentCommand,
  RunnerCapability,
  RunnerCommandsList,
  RunnerCommandsListResult,
  RunTriggerKind,
  skillAliasesOf,
} from "../src";

const A = "01a09fc9-d204-7551-89d6-38544d07a101";
const B = "01a09fc9-d204-7551-89d6-38544d07a102";
const U = "01a09fc9-d204-7551-89d6-38544d07a103";
const chip = (id = A) => `<@a:${id}>`;

describe("parseAgentCommand", () => {
  it("멘션 하나 + 공백 + /이름 은 명령이다", () => {
    expect(parseAgentCommand(`${chip()} /compact`, {})).toEqual({ agentId: A, name: "compact", args: "" });
  });

  it("인자 안의 공백은 그대로 둔다(plugin:name 이름 포함)", () => {
    expect(parseAgentCommand(`${chip()} /user:review src/a.ts  x`, {})).toEqual({
      agentId: A,
      name: "user:review",
      args: "src/a.ts  x",
    });
  });

  it("칩 뒤 nbsp 도 공백이다", () => {
    expect(parseAgentCommand(`${chip()} /status`, {})).toEqual({ agentId: A, name: "status", args: "" });
  });

  it("이름 뒤가 / 로 이어지면(경로) 명령이 아니다", () => {
    expect(parseAgentCommand(`${chip()} /usr/bin 이 뭐야`, {})).toBeNull();
  });

  it("URL 은 명령이 아니다", () => {
    expect(parseAgentCommand(`${chip()} https://x`, {})).toBeNull();
  });

  it("글 중간의 /compact 는 명령이 아니다", () => {
    expect(parseAgentCommand(`hi ${chip()} /compact`, {})).toBeNull();
    expect(parseAgentCommand(`${chip()} 이거 /compact 해 줘`, {})).toBeNull();
  });

  it("멘션이 둘이면 명령이 아니다 — 인자 속 멘션도(평범한 글로 흘러 둘 다 부른다)", () => {
    expect(parseAgentCommand(`${chip()} ${chip(B)} /compact`, {})).toBeNull();
    expect(parseAgentCommand(`${chip()} /compact ${chip(B)}`, {})).toBeNull();
    expect(parseAgentCommand(`${chip()} /compact 요약 <@u:${U}> 에게`, {})).toBeNull();
    expect(parseAgentCommand(`/compact ${chip(B)}`, { directAgentId: A })).toBeNull();
  });

  it("사람 멘션은 명령이 아니다", () => {
    expect(parseAgentCommand(`<@u:${U}> /compact`, {})).toBeNull();
  });

  it("1:1 에이전트 DM 은 맨 앞 /이름", () => {
    expect(parseAgentCommand("/status", { directAgentId: A })).toEqual({
      agentId: A,
      name: "status",
      args: "",
    });
    expect(parseAgentCommand("/think high", { directAgentId: A })).toEqual({
      agentId: A,
      name: "think",
      args: "high",
    });
  });

  it("directAgentId 없이 맨 앞 /status 는 명령이 아니다", () => {
    expect(parseAgentCommand("/status", {})).toBeNull();
  });

  it("맨 앞 /stop 은 이 함수와 무관하다(작성기가 중지로 처리한다)", () => {
    expect(parseAgentCommand("/stop", {})).toBeNull();
    expect(parseAgentCommand("/stop", { directAgentId: A })).toBeNull();
  });

  it("이름이 65자면 명령이 아니다", () => {
    const name64 = "a".repeat(64);
    expect(parseAgentCommand(`${chip()} /${name64}`, {})?.name).toBe(name64);
    expect(parseAgentCommand(`${chip()} /${"a".repeat(65)}`, {})).toBeNull();
  });

  it("대소문자는 그대로 둔다", () => {
    expect(parseAgentCommand(`${chip()} /Compact`, {})?.name).toBe("Compact");
  });

  it("앞뒤 공백·줄바꿈은 무시하고 여러 줄 인자를 받는다", () => {
    expect(parseAgentCommand(`  ${chip()} /skill a\nb\n`, {})).toEqual({
      agentId: A,
      name: "skill",
      args: "a\nb",
    });
  });
});

describe("checkCommand", () => {
  const aliases = new Set(["my-skill"]);
  it("claude 내장은 허용 목록 — 그 밖의 내장은 막는다", () => {
    expect([...CLAUDE_BUILTIN_ALLOWED].sort()).toEqual(["compact", "context", "cost", "usage"]);
    for (const name of ["compact", "context", "usage", "cost", "Compact"]) {
      expect(checkCommand("claude", name, "", { skillAliases: aliases })).toEqual({ ok: true });
    }
    // help 는 핀한 CLI 판에 없다, stats 는 usage 의 별칭이지만 넘기지 않는다(재리뷰 N6)
    for (const name of [
      "login",
      "logout",
      "config",
      "insights",
      "heapdump",
      "recap",
      "nope",
      "help",
      "stats",
    ]) {
      expect(checkCommand("claude", name, "", { skillAliases: aliases })).toEqual({
        ok: false,
        reason: "blocked",
        message: "이 명령은 dodok 에서 쓸 수 없습니다",
      });
    }
  });

  it("claude 사람 명령(`:`)과 스킬 별칭은 넘긴다", () => {
    expect(checkCommand("claude", "user:x", "", { skillAliases: new Set() })).toEqual({ ok: true });
    expect(checkCommand("claude", "project:review", "a", { skillAliases: new Set() })).toEqual({ ok: true });
    expect(checkCommand("claude", "my-skill", "", { skillAliases: aliases })).toEqual({ ok: true });
    expect(checkCommand("claude", "My-Skill", "", { skillAliases: aliases })).toEqual({ ok: true });
    expect(checkCommand("claude", "my-skill", "", { skillAliases: new Set() })).toMatchObject({
      ok: false,
      reason: "blocked",
    });
  });

  it("claude 별칭 목록을 모르면 넘긴다 — 러너가 그 런의 목록으로 다시 본다", () => {
    expect(checkCommand("claude", "my-skill", "")).toEqual({ ok: true });
    expect(checkCommand("claude", "nope", "")).toEqual({ ok: true });
    // 로그인·설정·다른 세션 기록·메모리를 건드리는 내장은 목록을 몰라도 막는다
    for (const name of ["login", "logout", "config", "insights", "heapdump", "recap"]) {
      expect(checkCommand("claude", name, "")).toMatchObject({ ok: false, reason: "blocked" });
    }
  });

  it("skillAliasesOf 는 `:` 이 있는 줄의 별칭만", () => {
    expect([
      ...skillAliasesOf([
        { name: "user:my-skill", description: "", aliases: ["my-skill"] },
        { name: "help", description: "", aliases: ["h"] },
        { name: "project:x", description: "" },
      ]),
    ]).toEqual(["my-skill"]);
  });

  it("claude 안내", () => {
    expect(checkCommand("claude", "model", "opus")).toEqual({
      ok: false,
      reason: "use_chips",
      message: "모델은 작성기 칩에서 바꾸세요",
    });
    expect(checkCommand("claude", "clear", "")).toEqual({
      ok: false,
      reason: "new_session",
      message: "새 세션을 여세요",
    });
    expect(checkCommand("claude", "model", "opus", { skillAliases: new Set(["model"]) })).toMatchObject({
      reason: "use_chips",
    });
  });

  it("openclaw 는 허용 목록", () => {
    expect(checkCommand("openclaw", "status", "")).toEqual({ ok: true });
    expect(checkCommand("openclaw", "restart", "")).toEqual({
      ok: false,
      reason: "blocked",
      message: "이 명령은 dodok 에서 쓸 수 없습니다",
    });
    expect(checkCommand("openclaw", "pair", "")).toMatchObject({ ok: false, reason: "blocked" });
    expect(checkCommand("openclaw", "new", "")).toMatchObject({ ok: false, reason: "new_session" });
    expect(checkCommand("openclaw", "reset", "")).toMatchObject({ ok: false, reason: "new_session" });
    expect(checkCommand("openclaw", "model", "-g opus")).toMatchObject({ ok: false, reason: "blocked" });
    expect(checkCommand("openclaw", "model", "opus -a")).toMatchObject({ ok: false, reason: "blocked" });
    expect(checkCommand("openclaw", "model", "opus --global")).toMatchObject({
      ok: false,
      reason: "blocked",
    });
    expect(checkCommand("openclaw", "model", "opus")).toEqual({ ok: true });
    expect(checkCommand("openclaw", "model", "opus -s")).toEqual({ ok: true });
  });

  it("openclaw 인자 속 `/` 토큰·줄바꿈은 막는다 — Gateway 가 본문 어디서든 지시어를 뽑는다", () => {
    const nested = { ok: false, reason: "blocked", message: "명령 인자에 다른 `/` 명령을 넣을 수 없습니다" };
    expect(checkCommand("openclaw", "think", "high /elevated full")).toEqual(nested);
    expect(checkCommand("openclaw", "verbose", "on /model x -g")).toEqual(nested);
    expect(checkCommand("openclaw", "fast", "on /exec host=gateway")).toEqual(nested);
    expect(checkCommand("openclaw", "skill", "x /usr/bin")).toEqual(nested);
    expect(checkCommand("openclaw", "skill", "/x")).toEqual(nested);
    expect(checkCommand("openclaw", "think", "high\tx\n")).toEqual(nested);
    expect(checkCommand("openclaw", "skill", "x\ny")).toEqual(nested);
    expect(checkCommand("openclaw", "compact", "a\r\nb")).toEqual(nested);
    // JS \s 의 공백 부류 뒤 `/` 도 지시어다 — 탭·nbsp·U+3000·U+2028(재리뷰 N4)
    for (const space of ["\t", "\u00A0", "\u3000", "\u2028"]) {
      expect(checkCommand("openclaw", "think", `high${space}/elevated full`)).toEqual(nested);
    }
    // OpenClaw 도 지시어로 읽지 않는 것 — 넘긴다
    expect(checkCommand("openclaw", "think", "high\u200B/elevated")).toEqual({ ok: true });
    expect(checkCommand("openclaw", "skill", "review x/elevated")).toEqual({ ok: true });
    expect(checkCommand("openclaw", "skill", "review src/a.ts")).toEqual({ ok: true });
    expect(checkCommand("openclaw", "skill", "review https://x.y/z")).toEqual({ ok: true });
    expect(checkCommand("openclaw", "model", "opus")).toEqual({ ok: true });
  });

  it("양쪽 stop 은 use_stop", () => {
    for (const program of ["claude", "openclaw"] as const) {
      expect(checkCommand(program, "stop", "")).toEqual({
        ok: false,
        reason: "use_stop",
        message: "중지는 `/stop` 만 쓰세요",
      });
    }
  });

  it("OPENCLAW_COMMANDS 는 모두 통과한다", () => {
    expect(OPENCLAW_COMMANDS.map((c) => c.name)).toContain("status");
    for (const c of OPENCLAW_COMMANDS) {
      expect(checkCommand("openclaw", c.name, "")).toEqual({ ok: true });
      expect(AgentCommand.safeParse(c).success).toBe(true);
    }
  });
});

describe("명령 계약", () => {
  it("RunTriggerKind 에 command", () => {
    expect(RunTriggerKind.parse("command")).toBe("command");
  });

  it("능력 enum 에 commands", () => {
    expect(BridgeCapability.parse("commands")).toBe("commands");
    expect(RunnerCapability.parse("commands")).toBe("commands");
    expect(
      BridgeHello.parse({
        pluginId: "dodok",
        version: "1",
        sdkVersion: "2026.9.4",
        capabilities: ["commands"],
      }).capabilities,
    ).toEqual(["commands"]);
  });

  it("InboundDeliver.command 를 파싱한다", () => {
    const base = {
      deliveryId: A,
      kind: "message",
      channelId: A,
      conversationId: A,
      conversationTitle: "대화",
      agentId: "dev",
      sessionKey: "k",
      runId: A,
      message: {
        id: A,
        author: { type: "user", handle: "owner", displayName: "Owner" },
        text: "@dev /status",
        attachments: [],
        ts: "2026-11-21T00:00:00.000Z",
      },
      context: { recentMessages: [], participants: [], relayRules: "" },
    };
    expect(InboundDeliver.parse({ ...base, command: { name: "status", args: "" } }).command).toEqual({
      name: "status",
      args: "",
    });
    expect(InboundDeliver.parse(base).command).toBeUndefined();
    expect(
      InboundDeliver.safeParse({ ...base, command: { name: "status", args: "x".repeat(4001) } }).success,
    ).toBe(false);
  });

  it("commands.list 요청·응답", () => {
    expect(RunnerCommandsList.parse({ project: { rootId: "src", relPath: "a" } })).toEqual({
      project: { rootId: "src", relPath: "a" },
    });
    const one = { name: "user:review", description: "(user) 리뷰", aliases: ["review"] };
    expect(RunnerCommandsListResult.parse({ ok: true, commands: [one] })).toEqual({
      ok: true,
      commands: [one],
    });
    expect(RunnerCommandsListResult.parse({ ok: false, reason: "root_missing" })).toEqual({
      ok: false,
      reason: "root_missing",
    });
    const many = Array.from({ length: 201 }, (_, i) => ({ name: `c${i}`, description: "" }));
    expect(RunnerCommandsListResult.safeParse({ ok: true, commands: many }).success).toBe(false);
    expect(RunnerCommandsListResult.safeParse({ ok: true, commands: many.slice(0, 200) }).success).toBe(true);
    expect(AgentCommand.safeParse({ name: "x".repeat(65), description: "" }).success).toBe(false);
    expect(AgentCommand.safeParse({ name: "x", description: "d".repeat(201) }).success).toBe(false);
  });
});
