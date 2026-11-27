import { Agent } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { MCP_SECRET_MASK, renderBotSoul } from "@dodok/shared";
import { agents, runnerTokens } from "../src/db/schema.sqlite";
import {
  agentForRole,
  archiveAgent,
  createAgent,
  getAgent,
  listAgents,
  RUNNER_AGENT_WITHOUT_PROJECT,
  restoreAgent,
  updateAgent,
} from "../src/modules/agents/service";
import { runnerAgentDefinition } from "../src/modules/runners/definition";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { createRunnerAgentForTest, insertRunnerToken, seedWorkspace } from "./helpers/seed";

/** 워크스페이스 하나와 그 Gateway 하나 — OpenClaw 에이전트는 Gateway 에 묶여 등록된다 */
function setup() {
  const db = newTestDb();
  const { workspaceId } = seedWorkspace(db);
  const gatewayId = insertGateway(db, workspaceId, { id: uuid(), name: "사무실" }).id;
  return { db, workspaceId, gatewayId };
}

describe("agents service", () => {
  it("createAgent 는 만든 사람(createdBy)을 남기고, 주지 않으면 null(기록 없음)", () => {
    const { db, workspaceId, gatewayId } = setup();
    const ownerId = seedWorkspace(db, { userHandle: "boss" }).userId;
    const made = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId,
      createdBy: ownerId,
    });
    expect(made.createdBy).toBe(ownerId);
    expect(getAgent(db, made.id)?.createdBy).toBe(ownerId);
    const legacy = createAgent(db, {
      workspaceId,
      providerAgentId: "fin",
      handle: "fin",
      name: "Fin",
      gatewayId,
    });
    expect(legacy.createdBy).toBeNull();
    // OpenClaw 에이전트에는 새 세션 시작값이 없다(러너만 — 세션 설정 스펙 S1)
    expect(made.sessionDefaults).toBeUndefined();
  });

  it("러너 에이전트의 새 세션 시작값은 member 에게도 실리고 정의(runnerAgent)는 admin 이상에게만 [세션 설정 스펙 S10·S11]", () => {
    const { db, workspaceId } = setup();
    const { agent } = createRunnerAgentForTest(db, {
      workspaceId,
      handle: "coder",
      model: "claude-sonnet-5-5",
    });
    const forMember = agentForRole(agent, "member");
    expect(forMember.sessionDefaults).toEqual({
      model: "claude-sonnet-5-5",
      effort: null,
      permissionMode: null,
    });
    expect(forMember.runnerAgent).toBeUndefined();
    expect(agentForRole(agent, "admin").runnerAgent).toBeDefined();
    const plain = createRunnerAgentForTest(db, { workspaceId, handle: "plain" }).agent;
    expect(agentForRole(plain, "member").sessionDefaults).toEqual({
      model: null,
      effort: null,
      permissionMode: null,
    });
  });

  it("작업 디렉터리 밖 허용은 member 에게도 runner.outsideWorkdir 로 실린다 — 켰을 때만 키가 있다(결정 3 의 예외)", () => {
    const { db, workspaceId } = setup();
    const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "coder" });
    const shown = () =>
      agentForRole(
        listAgents(db, workspaceId).find((a) => a.id === agent.id)!,
        "member",
      );
    expect(shown().runner).toBeDefined();
    expect(shown().runner).not.toHaveProperty("outsideWorkdir");
    db.update(agents).set({ allowOutsideWorkdir: true }).where(eq(agents.id, agent.id)).run();
    expect(shown().runner?.outsideWorkdir).toBe(true);
    expect(shown().runnerAgent).toBeUndefined();
    expect(Agent.parse(shown())).toEqual(shown());
  });

  it("기본 프롬프트(basePrompt)는 admin 이상에게만 — member 에게는 OpenClaw·러너 에이전트 모두 키가 없다", () => {
    const { db, workspaceId, gatewayId } = setup();
    const oc = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId,
      basePrompt: "SECRET-PROMPT",
    });
    expect(agentForRole(oc, "member")).not.toHaveProperty("basePrompt");
    expect(agentForRole(oc, undefined)).not.toHaveProperty("basePrompt");
    expect(agentForRole(oc, "admin").basePrompt).toBe("SECRET-PROMPT");
    const runner = createRunnerAgentForTest(db, { workspaceId, handle: "coder" }).agent;
    const withPrompt = updateAgent(db, runner.id, { basePrompt: "지시" });
    expect(agentForRole(withPrompt, "member")).not.toHaveProperty("basePrompt");
    expect(agentForRole(withPrompt, "owner").basePrompt).toBe("지시");
  });

  it("계약(AvatarUrl)에 안 맞는 옛 아바타 주소(http·data·공백)는 읽기를 깨지 않고 avatarUrl 없이 실린다", () => {
    const { db, workspaceId, gatewayId } = setup();
    const made = [
      "http://example.com/a.png",
      "data:image/png;base64,AAAA",
      "https://example.com/a b.png",
    ].map((url, i) => {
      const agent = createAgent(db, {
        workspaceId,
        providerAgentId: `old${i}`,
        handle: `old${i}`,
        name: `Old${i}`,
        gatewayId,
      });
      // 옛 z.url() 이 받던 값 — 지금 쓰기 길은 거절하므로 행에 바로 넣는다
      db.update(agents).set({ avatarUrl: url }).where(eq(agents.id, agent.id)).run();
      return agent.id;
    });
    const good = createAgent(db, {
      workspaceId,
      providerAgentId: "good",
      handle: "good",
      name: "Good",
      gatewayId,
      avatarUrl: "https://example.com/good.png",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const listed = listAgents(db, workspaceId);
      for (const id of made) {
        expect(listed.find((a) => a.id === id)).not.toHaveProperty("avatarUrl");
        expect(getAgent(db, id)).not.toHaveProperty("avatarUrl");
      }
      expect(listed.find((a) => a.id === good.id)?.avatarUrl).toBe("https://example.com/good.png");
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("createAgent 는 provider openclaw·enabled true 로 만들고 워크스페이스별로 나열한다", () => {
    const { db, workspaceId, gatewayId } = setup();
    const agent = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId,
    });
    expect(Agent.parse(agent)).toEqual(agent);
    expect(agent).toMatchObject({ workspaceId, provider: "openclaw", providerAgentId: "dev", enabled: true });
    expect(agent.basePrompt).toBeUndefined();
    // REST 응답에만 Gateway 요약이 붙는다
    expect(agent.gateway).toEqual({ id: gatewayId, name: "사무실" });
    const { gateway: _gateway, ...plain } = agent;
    expect(getAgent(db, agent.id)).toEqual(plain);
    expect(getAgent(db, agent.id, workspaceId)).toEqual(plain);
    expect(listAgents(db, workspaceId)).toEqual([agent]);

    const other = seedWorkspace(db, { userHandle: "other" });
    expect(listAgents(db, other.workspaceId)).toEqual([]);
    expect(getAgent(db, agent.id, other.workspaceId)).toBeUndefined();
  });

  it("같은 워크스페이스에서 handle 이, 같은 Gateway 에서 providerAgentId 가 겹치면 CONFLICT", () => {
    const { db, workspaceId, gatewayId } = setup();
    createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev", name: "Dev", gatewayId });
    expect(() =>
      createAgent(db, { workspaceId, providerAgentId: "dev2", handle: "dev", name: "x", gatewayId }),
    ).toThrow(expect.objectContaining({ status: 409, body: expect.objectContaining({ code: "CONFLICT" }) }));
    expect(() =>
      createAgent(db, { workspaceId, providerAgentId: "dev", handle: "dev2", name: "x", gatewayId }),
    ).toThrow(expect.objectContaining({ status: 409 }));
    // 다른 워크스페이스는 겹쳐도 된다
    const other = seedWorkspace(db, { userHandle: "other" });
    expect(
      createAgent(db, { workspaceId: other.workspaceId, providerAgentId: "dev", handle: "dev", name: "x" }),
    ).toMatchObject({ handle: "dev" });
  });

  it("updateAgent 는 필드를 바꾸고, handle 충돌은 CONFLICT, 없는 id 는 NOT_FOUND", () => {
    const { db, workspaceId, gatewayId } = setup();
    const dev = createAgent(db, {
      workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      basePrompt: "p",
      gatewayId,
    });
    createAgent(db, { workspaceId, providerAgentId: "fin", handle: "fin", name: "Fin", gatewayId });

    const updated = updateAgent(db, dev.id, { name: "Developer", enabled: false, basePrompt: null });
    expect(updated).toMatchObject({ id: dev.id, name: "Developer", enabled: false, handle: "dev" });
    expect(updated.basePrompt).toBeUndefined();
    expect(updated.gateway).toEqual({ id: gatewayId, name: "사무실" });
    const { gateway: _gateway, ...plain } = updated;
    expect(getAgent(db, dev.id)).toEqual(plain);

    // 자기 handle 로 다시 저장하는 건 충돌이 아니다
    expect(updateAgent(db, dev.id, { handle: "dev" }).handle).toBe("dev");
    expect(() => updateAgent(db, dev.id, { handle: "fin" })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
    expect(() => updateAgent(db, uuid(), { name: "x" })).toThrow(expect.objectContaining({ status: 404 }));
  });
});

describe("러너 봇(러너 봇 스펙 B2·B3·B10·B11)", () => {
  const DEF = { purpose: "리뷰 봇", watches: "PR", does: "위험을 짚는다", reports: "요약 한 줄" };
  const noop = { orchestrator: { abort: async () => {} } };
  const revision = (db: ReturnType<typeof setup>["db"], id: string) =>
    db.select({ r: agents.instructionsRevision }).from(agents).where(eq(agents.id, id)).get()?.r;
  const errorOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return e as { status: number; body: { code: string; message: string; details?: { field?: string } } };
    }
    throw new Error("던지지 않았다");
  };

  it("프로젝트 없이 러너 토큰에 묶인다 — runner.bot true, 정의는 runnerAgent.bot, 기본 지시는 저장하지 않는다", () => {
    const { db, workspaceId } = setup();
    const runnerTokenId = insertRunnerToken(db, workspaceId);
    const bot = createAgent(db, {
      workspaceId,
      provider: "runner",
      runnerTokenId,
      bot: DEF,
      program: "claude",
      handle: "rev",
      name: "Rev",
      basePrompt: "무시된다",
    });
    expect(bot.providerAgentId).toMatch(/^r-[0-9a-f]{10}$/);
    expect(bot.runner).toMatchObject({ tokenId: runnerTokenId, bot: true });
    expect(bot.runner).not.toHaveProperty("projectLabel");
    expect(bot.runnerAgent).toEqual({
      projectId: null,
      disallowedTools: [],
      allowOutsideWorkdir: false,
      bot: DEF,
    });
    expect(bot.basePrompt).toBeUndefined();
    // 프로젝트 에이전트에는 bot 표시가 없다
    const plain = createRunnerAgentForTest(db, { workspaceId, handle: "plain", runnerTokenId }).agent;
    expect(plain.runner).not.toHaveProperty("bot");
    expect(plain.runnerAgent).not.toHaveProperty("bot");
  });

  it("member 는 봇임(runner.bot)을 알되 정의 내용은 받지 않는다 — admin·연결 주인은 받는다 [Review Focus 5]", () => {
    const { db, workspaceId } = setup();
    const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: DEF });
    const forMember = agentForRole(agent, "member");
    expect(forMember.runner?.bot).toBe(true);
    expect(forMember.runnerAgent).toBeUndefined();
    expect(JSON.stringify(forMember)).not.toContain("위험을 짚는다");
    expect(agentForRole(agent, "admin").runnerAgent?.bot).toEqual(DEF);
    expect(agentForRole(agent, "member", true).runnerAgent?.bot).toEqual(DEF);
  });

  it("없는·다른 워크스페이스·폐기한 러너 토큰이면 VALIDATION(runnerTokenId)", () => {
    const { db, workspaceId } = setup();
    const otherWs = seedWorkspace(db, { userHandle: "other" }).workspaceId;
    const foreign = insertRunnerToken(db, otherWs);
    const revoked = insertRunnerToken(db, workspaceId);
    db.update(runnerTokens).set({ revokedAt: new Date() }).where(eq(runnerTokens.id, revoked)).run();
    for (const runnerTokenId of [uuid(), foreign, revoked]) {
      const e = errorOf(() =>
        createAgent(db, {
          workspaceId,
          provider: "runner",
          runnerTokenId,
          bot: DEF,
          program: "claude",
          handle: "x",
          name: "x",
        }),
      );
      expect(e.body).toMatchObject({ code: "VALIDATION", details: { field: "runnerTokenId" } });
    }
  });

  it("정의를 고치면 지시 리비전 +1 — 같은 정의·이름만은 그대로, 봇에 기본 지시·봇 아닌 에이전트에 정의는 VALIDATION [Review Focus 3]", () => {
    const { db, workspaceId } = setup();
    const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: DEF });
    updateAgent(db, agent.id, { bot: { ...DEF } });
    updateAgent(db, agent.id, { name: "새 이름" });
    expect(revision(db, agent.id)).toBe(0);
    for (const key of ["purpose", "watches", "does", "reports"] as const) {
      const before = revision(db, agent.id)!;
      const changed = updateAgent(db, agent.id, { bot: { ...DEF, [key]: `${key} 바뀜` } });
      expect(changed.runnerAgent?.bot?.[key]).toBe(`${key} 바뀜`);
      expect(revision(db, agent.id)).toBe(before + 1);
    }
    expect(errorOf(() => updateAgent(db, agent.id, { basePrompt: "지시" })).body).toMatchObject({
      code: "VALIDATION",
      details: { field: "basePrompt" },
    });
    const plain = createRunnerAgentForTest(db, { workspaceId, handle: "plain" }).agent;
    expect(errorOf(() => updateAgent(db, plain.id, { bot: DEF })).body).toMatchObject({
      code: "VALIDATION",
      details: { field: "bot" },
    });
  });

  it("런 정의 — project 대신 bot(id = providerAgentId, soul = renderBotSoul), 지시 대신 봇 정의. 다른 토큰이면 null", () => {
    const { db, workspaceId } = setup();
    const { agent, runnerTokenId } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: DEF });
    const def = runnerAgentDefinition(db, workspaceId, agent.providerAgentId, runnerTokenId);
    expect(def).toMatchObject({ instructions: null, botDefinition: DEF });
    expect(def?.agent.bot).toEqual({ id: agent.providerAgentId, soul: renderBotSoul(DEF) });
    expect(def?.agent).not.toHaveProperty("project");
    expect(
      runnerAgentDefinition(db, workspaceId, agent.providerAgentId, insertRunnerToken(db, workspaceId)),
    ).toBeNull();
  });

  describe("봇 도구(러너 봇 2부 스펙 T1·T4·T7·T11·T15)", () => {
    const GH = {
      type: "http" as const,
      url: "https://api.example.com/mcp",
      headers: { Authorization: "Bearer RAW_GH" },
    };
    const LIN = { command: "npx", args: ["-y", "lin"], env: { LINEAR_TOKEN: "RAW_LIN" } };
    const TOOLS = {
      ...DEF,
      mcpServers: { gh: GH, lin: LIN },
      mcpAutoAllow: { gh: { mode: "tools" as const, tools: ["search"] } },
      builtinTools: ["runnerControl" as const],
    };
    const stored = (db: ReturnType<typeof setup>["db"], id: string) =>
      db.select({ bot: agents.runnerBot }).from(agents).where(eq(agents.id, id)).get()?.bot;

    it("응답에는 키 이름과 가림 글자만 — DB 에는 원문, admin·주인 응답·member 응답 어디에도 원문이 없다 [Review Focus 2]", () => {
      const { db, workspaceId } = setup();
      const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: TOOLS });
      expect(agent.runnerAgent?.bot?.mcpServers).toEqual({
        gh: { ...GH, headers: { Authorization: MCP_SECRET_MASK } },
        lin: { ...LIN, env: { LINEAR_TOKEN: MCP_SECRET_MASK } },
      });
      expect(agent.runnerAgent?.bot?.mcpAutoAllow).toEqual(TOOLS.mcpAutoAllow);
      expect(agent.runnerAgent?.bot?.builtinTools).toEqual(["runnerControl"]);
      for (const shown of [
        agent,
        agentForRole(agent, "admin"),
        agentForRole(agent, "member", true),
        agentForRole(agent, "member"),
      ])
        expect(JSON.stringify(shown)).not.toMatch(/RAW_GH|RAW_LIN/);
      expect(agentForRole(agent, "member").runnerAgent).toBeUndefined();
      expect(JSON.stringify(listAgents(db, workspaceId))).not.toMatch(/RAW_GH|RAW_LIN/);
      expect(stored(db, agent.id)?.mcpServers).toEqual({ gh: GH, lin: LIN });
    });

    it("받은 응답(가림 글자) 그대로 다시 저장하면 원문 유지·리비전 그대로, 헤더 값을 바꾸면 +1 [Review Focus 5]", () => {
      const { db, workspaceId } = setup();
      const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: TOOLS });
      const echoed = agent.runnerAgent!.bot!;
      updateAgent(db, agent.id, { bot: echoed });
      // 네 칸만 보낸 옛 클라이언트 저장 — MCP·자동 허용·내장 도구는 저장된 것 그대로
      updateAgent(db, agent.id, { bot: { ...DEF } });
      expect(stored(db, agent.id)).toEqual({ ...DEF, ...TOOLS });
      expect(revision(db, agent.id)).toBe(0);
      updateAgent(db, agent.id, {
        bot: {
          ...echoed,
          mcpServers: { ...echoed.mcpServers, gh: { ...GH, headers: { Authorization: "Bearer NEW" } } },
        },
      });
      expect(revision(db, agent.id)).toBe(1);
      expect(stored(db, agent.id)?.mcpServers?.gh).toEqual({
        ...GH,
        headers: { Authorization: "Bearer NEW" },
      });
      expect(stored(db, agent.id)?.mcpServers?.lin).toEqual(LIN);
    });

    it("자동 허용·내장 도구·서버 이름만 바꿔도 +1, 서버 이름만 바꾼 편집은 원래 값을 지킨다", () => {
      const { db, workspaceId } = setup();
      const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: TOOLS });
      const echoed = agent.runnerAgent!.bot!;
      updateAgent(db, agent.id, { bot: { ...echoed, mcpAutoAllow: { gh: { mode: "all" } } } });
      expect(revision(db, agent.id)).toBe(1);
      updateAgent(db, agent.id, { bot: { ...echoed, builtinTools: [] } });
      expect(revision(db, agent.id)).toBe(2);
      const { gh, lin } = echoed.mcpServers!;
      updateAgent(db, agent.id, {
        bot: { ...echoed, mcpServers: { github: gh!, lin: lin! }, mcpAutoAllow: {} },
      });
      expect(revision(db, agent.id)).toBe(3);
      expect(stored(db, agent.id)?.mcpServers).toEqual({ github: GH, lin: LIN });
    });

    it("저장 값이 없는 가림 글자는 VALIDATION — 가림 글자를 값으로 저장하지 않는다", () => {
      const { db, workspaceId } = setup();
      const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: TOOLS });
      const e = errorOf(() =>
        updateAgent(db, agent.id, {
          bot: { ...DEF, mcpServers: { gh: { ...GH, headers: { Other: MCP_SECRET_MASK } } } },
        }),
      );
      expect(e.body).toMatchObject({ code: "VALIDATION", details: { field: "bot" } });
      expect(stored(db, agent.id)?.mcpServers?.gh).toEqual(GH);
    });

    it("같은 이름이라도 주소·명령을 바꾸고 가림 글자를 두면 VALIDATION — 비밀값이 새 곳으로 따라가지 않는다", () => {
      const { db, workspaceId } = setup();
      const { agent } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: TOOLS });
      const { gh, lin } = agent.runnerAgent!.bot!.mcpServers!;
      for (const moved of [
        { gh: { ...gh!, url: "https://attacker.example/x" }, lin: lin! },
        { gh: gh!, lin: { ...lin!, command: "bash" } },
      ]) {
        const e = errorOf(() => updateAgent(db, agent.id, { bot: { ...DEF, mcpServers: moved } }));
        expect(e.body).toMatchObject({ code: "VALIDATION", details: { field: "bot" } });
        expect(String((e.body as { message?: unknown }).message)).toContain(
          "주소나 명령을 바꾸면 비밀값을 다시 적으세요",
        );
      }
      expect(stored(db, agent.id)?.mcpServers).toEqual({ gh: GH, lin: LIN });
      expect(revision(db, agent.id)).toBe(0);
    });

    it("런 정의에는 원문 MCP(러너로는 원문이 가야 한다)·자동 허용·내장 도구, 지시 틀 자리에는 네 칸만", () => {
      const { db, workspaceId } = setup();
      const { agent, runnerTokenId } = createRunnerAgentForTest(db, {
        workspaceId,
        handle: "rev",
        bot: TOOLS,
      });
      const def = runnerAgentDefinition(db, workspaceId, agent.providerAgentId, runnerTokenId);
      expect(def?.agent.bot).toEqual({
        id: agent.providerAgentId,
        soul: renderBotSoul(DEF),
        mcpServers: { gh: GH, lin: LIN },
        mcpAutoAllow: TOOLS.mcpAutoAllow,
        builtinTools: ["runnerControl"],
      });
      expect(def?.botDefinition).toEqual(DEF);
    });

    it("옛 봇(네 칸만 저장된 행)의 런 정의에는 MCP 키가 없다", () => {
      const { db, workspaceId } = setup();
      const { agent, runnerTokenId } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: DEF });
      expect(runnerAgentDefinition(db, workspaceId, agent.providerAgentId, runnerTokenId)?.agent.bot).toEqual(
        {
          id: agent.providerAgentId,
          soul: renderBotSoul(DEF),
        },
      );
    });
  });

  it("봇은 되살린다 — 프로젝트 없는 옛 러너 에이전트는 그대로 거절 [Review Focus 2]", async () => {
    const { db, workspaceId } = setup();
    const { agent: bot } = createRunnerAgentForTest(db, { workspaceId, handle: "rev", bot: DEF });
    await archiveAgent(db, noop, bot.id, workspaceId);
    expect(restoreAgent(db, bot.id, workspaceId).agent.archivedAt).toBeNull();

    const { agent: legacy } = createRunnerAgentForTest(db, { workspaceId, handle: "legacy" });
    await archiveAgent(db, noop, legacy.id, workspaceId);
    db.update(agents).set({ runnerProjectId: null }).where(eq(agents.id, legacy.id)).run();
    expect(errorOf(() => restoreAgent(db, legacy.id, workspaceId)).body).toMatchObject({
      code: "VALIDATION",
      message: RUNNER_AGENT_WITHOUT_PROJECT,
    });
    // 옛 것은 봇으로 읽히지 않는다
    expect(getAgent(db, legacy.id, workspaceId)?.runner?.bot).toBeUndefined();
  });
});
