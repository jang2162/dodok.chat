/**
 * 에이전트 명령 목록 GET(에이전트 명령 스펙 C8·C9·5.2) — OpenClaw 고정 목록, 러너 commands.list 캐시, 끊김·옛 판, 남의 DM.
 * 역할 매트릭스의 전수는 roles.matrix.test.ts
 */
import { type AgentCommandsResponse, OPENCLAW_COMMANDS, RUNNER_PROTOCOL } from "@dodok/shared";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgentCommandsService } from "../src/modules/agents/commands";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { issueRunnerToken } from "../src/modules/runners/tokens";
import { FAKE_RUNNER_COMMANDS, fakeRunnerHello, type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { createDmChannelForTest, createRunnerAgentForTest, seedConversation } from "./helpers/seed";

describe("GET …/agent-commands [에이전트 명령 C8·C9]", () => {
  let app: App;
  let owner: string;
  const mia = { id: "", token: "" };
  const noah = { id: "", token: "" };
  const fakes: FakeRunner[] = [];
  const adapter = new FakeAdapter();
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [adapter], runnerAdapter: true });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = (await login(app)).token;
    Object.assign(mia, await userWithRole(app, "mia", "member"));
    Object.assign(noah, await userWithRole(app, "noah", "member"));
  });
  afterAll(async () => {
    for (const f of fakes.splice(0)) f.close();
    await app.close();
  });

  const get = (token: string, url: string) =>
    app.fastify.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  const listOf = async (token: string, url: string) => {
    const res = await get(token, url);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as AgentCommandsResponse).agents;
  };
  const connect = async (capabilities: string[]) => {
    const issued = issueRunnerToken(app.db, app.workspaceId, `r${++n}`, null);
    const fake = await startFakeRunner({
      url: app.url,
      token: issued.token,
      hello: { capabilities: capabilities as never },
    });
    fakes.push(fake);
    return { tokenId: issued.record.id, fake };
  };
  const channelWith = (agentIds: string[]) => {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `ac${++n}`,
    });
    for (const id of agentIds)
      addMember(app.db, channel.id, { memberType: "agent", memberId: id }, app.logger);
    return { channel, conversationId: seedConversation(app.db, channel.id) };
  };
  const openclawAgent = () =>
    createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: `oc${++n}`,
      handle: `oc${n}`,
      name: `OC${n}`,
    });

  it("OpenClaw 에이전트는 허용 목록을 받는다", async () => {
    const agent = openclawAgent();
    const { conversationId } = channelWith([agent.id]);
    const agents = await listOf(owner, `/api/v1/conversations/${conversationId}/agent-commands`);
    expect(agents).toEqual([
      { agentId: agent.id, supported: true, commands: OPENCLAW_COMMANDS.map((c) => ({ ...c })) },
    ]);
  });

  it("옛 플러그인(commands 없음)이면 supported false·빈 목록", async () => {
    const agent = openclawAgent();
    const { conversationId } = channelWith([agent.id]);
    adapter.setPluginCapabilities(["threads"]);
    try {
      expect(await listOf(owner, `/api/v1/conversations/${conversationId}/agent-commands`)).toEqual([
        { agentId: agent.id, supported: false, commands: [] },
      ]);
    } finally {
      adapter.setPluginCapabilities(["run_id_in_outbound", "config.set", "threads", "commands"]);
    }
  });

  it("러너 목록 캐시 — 두 번 불러도 러너에는 한 번, 프로젝트 자리로 묻는다", async () => {
    const { tokenId, fake } = await connect([...fakeRunnerHello().capabilities, "commands"]);
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: tokenId,
    });
    const { channel, conversationId } = channelWith([agent.id]);
    const first = await listOf(mia.token, `/api/v1/conversations/${conversationId}/agent-commands`);
    expect(first).toEqual([
      { agentId: agent.id, supported: true, commands: FAKE_RUNNER_COMMANDS.map((c) => ({ ...c })) },
    ]);
    await listOf(mia.token, `/api/v1/channels/${channel.id}/agent-commands`);
    expect(fake.commandsRequests).toEqual([{ project: { rootId: "src", relPath: agent.handle } }]);
  });

  it("봇은 봇 폴더로 묻는다 — commands.list { bot: { id } }, 캐시는 봇마다, 능력 bots 가 없으면 supported false [러너 봇 스펙 B13]", async () => {
    const def = { purpose: "리뷰", watches: "", does: "", reports: "" };
    const { tokenId, fake } = await connect([...fakeRunnerHello().capabilities, "commands", "bots"]);
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `bot${++n}`,
      runnerTokenId: tokenId,
      bot: def,
    });
    const { channel, conversationId } = channelWith([agent.id]);
    const first = await listOf(mia.token, `/api/v1/conversations/${conversationId}/agent-commands`);
    expect(first).toEqual([
      { agentId: agent.id, supported: true, commands: FAKE_RUNNER_COMMANDS.map((c) => ({ ...c })) },
    ]);
    await listOf(mia.token, `/api/v1/channels/${channel.id}/agent-commands`);
    expect(fake.commandsRequests).toEqual([{ bot: { id: agent.providerAgentId } }]);

    const old = await connect([...fakeRunnerHello().capabilities, "commands"]);
    const { agent: oldBot } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `bot${++n}`,
      runnerTokenId: old.tokenId,
      bot: def,
    });
    const other = channelWith([oldBot.id]);
    expect(await listOf(mia.token, `/api/v1/conversations/${other.conversationId}/agent-commands`)).toEqual([
      { agentId: oldBot.id, supported: false, commands: [] },
    ]);
    expect(old.fake.commandsRequests).toEqual([]);
  });

  it("러너가 다시 붙으면(hello 시각이 바뀌면) 캐시가 남아 있어도 새로 묻는다", async () => {
    const issued = issueRunnerToken(app.db, app.workspaceId, `r${++n}`, null);
    const hello = { capabilities: [...fakeRunnerHello().capabilities, "commands"] as never };
    const first = await startFakeRunner({ url: app.url, token: issued.token, hello });
    fakes.push(first);
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: issued.record.id,
    });
    const { conversationId } = channelWith([agent.id]);
    const url = `/api/v1/conversations/${conversationId}/agent-commands`;
    expect((await listOf(owner, url))[0]?.supported).toBe(true);
    expect(first.commandsRequests).toHaveLength(1);
    first.close();
    await vi.waitFor(async () => expect((await listOf(owner, url))[0]?.supported).toBe(false));
    // connectedAt 은 시각 글자라 같은 ms 에 다시 붙으면 구분되지 않는다
    await new Promise((r) => setTimeout(r, 5));
    const second = await startFakeRunner({ url: app.url, token: issued.token, hello });
    fakes.push(second);
    await vi.waitFor(async () => expect((await listOf(owner, url))[0]?.supported).toBe(true));
    expect(second.commandsRequests).toHaveLength(1);
  });

  it("러너가 막는 이름을 실어 보내도 서버가 거른다", async () => {
    const { tokenId, fake } = await connect([...fakeRunnerHello().capabilities, "commands"]);
    fake.onCommandsList = () => ({
      ok: true,
      commands: [
        { name: "login", description: "x" },
        { name: "model", description: "x" },
        { name: "insights", description: "x" },
        { name: "nope", description: "x" },
        { name: "compact", description: "x" },
        { name: "user:a", description: "x", aliases: ["a"] },
      ],
    });
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: tokenId,
    });
    const { conversationId } = channelWith([agent.id]);
    const [row] = await listOf(owner, `/api/v1/conversations/${conversationId}/agent-commands`);
    expect(row?.commands.map((c) => c.name)).toEqual(["compact", "user:a"]);
  });

  it("끊김 → supported false, 옛 러너(commands 없음) → supported false", async () => {
    const old = await connect(fakeRunnerHello().capabilities);
    const oldAgent = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: old.tokenId,
    }).agent;
    const gone = await connect([...fakeRunnerHello().capabilities, "commands"]);
    const goneAgent = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: gone.tokenId,
    }).agent;
    const { conversationId } = channelWith([oldAgent.id, goneAgent.id]);
    const url = `/api/v1/conversations/${conversationId}/agent-commands`;
    expect((await listOf(owner, url))[1]?.supported).toBe(true);
    gone.fake.close();
    await vi.waitFor(async () =>
      expect(await listOf(owner, url)).toEqual([
        { agentId: oldAgent.id, supported: false, commands: [] },
        { agentId: goneAgent.id, supported: false, commands: [] },
      ]),
    );
    expect(old.fake.commandsRequests).toEqual([]);
  });

  it("남의 DM 404 — 주인은 200", async () => {
    const agent = openclawAgent();
    const dm = createDmChannelForTest(app.db, {
      workspaceId: app.workspaceId,
      ownerId: mia.id,
      agentId: agent.id,
    });
    const conversationId = seedConversation(app.db, dm.id);
    expect((await get(noah.token, `/api/v1/conversations/${conversationId}/agent-commands`)).statusCode).toBe(
      404,
    );
    expect((await get(noah.token, `/api/v1/channels/${dm.id}/agent-commands`)).statusCode).toBe(404);
    expect(await listOf(mia.token, `/api/v1/conversations/${conversationId}/agent-commands`)).toHaveLength(1);
  });

  it("러너 목록 묻기가 실패하면 listFailed — 지원은 하고 목록은 비어 있다(재리뷰 N3)", async () => {
    const { tokenId, fake } = await connect([...fakeRunnerHello().capabilities, "commands"]);
    fake.onCommandsList = () => ({ ok: false, reason: "root_missing" });
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: tokenId,
    });
    const { conversationId } = channelWith([agent.id]);
    expect(await listOf(owner, `/api/v1/conversations/${conversationId}/agent-commands`)).toEqual([
      { agentId: agent.id, supported: true, listFailed: true, commands: [] },
    ]);
  });

  it("skillAliases 는 기다리지 않는다 — 캐시가 비었으면 undefined 를 돌려주고 묻기만 걸어 둔다(재리뷰 N5)", async () => {
    const issued = issueRunnerToken(app.db, app.workspaceId, `r${++n}`, null);
    const { agent } = createRunnerAgentForTest(app.db, {
      workspaceId: app.workspaceId,
      handle: `rn${++n}`,
      runnerTokenId: issued.record.id,
    });
    let answer!: (r: {
      ok: true;
      commands: { name: string; description: string; aliases?: string[] }[];
    }) => void;
    const commandsList = vi.fn(
      () =>
        new Promise<{ ok: true; commands: { name: string; description: string; aliases?: string[] }[] }>(
          (resolve) => (answer = resolve),
        ),
    );
    const service = createAgentCommandsService({
      registry: { forAgent: () => undefined as never },
      runners: {
        runnerInfo: () => ({ connectedAt: "t0" }) as never,
        hasCapability: () => true,
        commandsList,
      },
      logger: { warn: () => {} },
    });
    // 동기 — 약속이 아니다. 비었으면 모른다, 묻기는 한 번 걸린다
    expect(service.skillAliases(app.db, agent)).toBeUndefined();
    expect(service.skillAliases(app.db, agent)).toBeUndefined();
    expect(commandsList).toHaveBeenCalledTimes(1);
    answer({ ok: true, commands: [{ name: "user:my-skill", description: "", aliases: ["my-skill"] }] });
    await new Promise((r) => setImmediate(r));
    expect([...(service.skillAliases(app.db, agent) ?? [])]).toEqual(["my-skill"]);
    expect(commandsList).toHaveBeenCalledTimes(1);
  });

  it("RUNNER_PROTOCOL 은 그대로다(명령은 선택 능력)", () => {
    expect(RUNNER_PROTOCOL).toBe(2);
  });
});
