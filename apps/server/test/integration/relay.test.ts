/**
 * 서버 코어 스펙 9.2 시나리오 1~5 — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트.
 * 실제 시계. 기다림은 전부 wire 이벤트(WireLog.until)로 한다.
 */
import type { Message, RunState } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScenario, type Scenario } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import {
  getRunRest,
  listRunsRest,
  openChannelWire,
  type RelayChannel,
  rest,
  sendMessage,
  setupRelayChannel,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { channelConversation } from "../helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };

describe("통합 시나리오 1~5 — 릴레이·상한·이어가기·차단", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  beforeEach(async () => {
    live = await bootLiveApp();
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /** 대본 재생 중 오류(정본 거절·플러그인 끊김)는 scenario.errors 에 모인다 — 조용히 묻히지 않게 끝에서 비어 있음을 본다 */
  function expectNoScenarioErrors(scenario: Scenario) {
    expect(scenario.errors).toEqual([]);
  }

  /** 사람 `@dev 안녕` → dev 가 `@fin` → fin 이 `@dev` → dev 가 `@fin`(상한) 까지 돌리고 세 런과 relay_limit 카드를 돌려준다 */
  async function relayUntilLimit(setup: RelayChannel, log: WireLog) {
    const { dev, fin, channel } = setup;
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ index }) =>
          index === 0 ? { deltas: ["@fin ", "부탁해"], reply: "@fin 부탁해" } : { reply: "@fin 다시" },
        fin: ({ index }) => (index === 0 ? { reply: "@dev 확인" } : { reply: "이어서 확인했습니다" }),
      },
    });
    const human = await sendMessage(log.socket, channel.id, "@dev 안녕");

    const devFirst = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.relayDepth === 0),
      "dev 첫 런",
    );
    const finRun = await log.until(
      () => log.states.find((s) => s.agentId === fin.id && s.relayDepth === 1),
      "fin 릴레이 런(relayDepth 1)",
    );
    const devSecond = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.relayDepth === 2),
      "dev 릴레이 런(relayDepth 2)",
    );
    const limit = await log.until(
      () => log.created.find((m) => m.kind === "system" && m.systemMeta?.kind === "relay_limit"),
      "relay_limit 시스템 메시지",
    );
    for (const run of [devFirst, finRun, devSecond]) expect((await log.terminal(run.id)).status).toBe("done");
    return { scenario, human, devFirst, finRun, devSecond, limit };
  }

  it("시나리오 1 — 로그인 → 채널 → 에이전트 dev·fin 등록 → 멤버 추가 → relayPolicy.maxRelayTurns 2", async () => {
    // 로그인은 bootLiveApp 이 했다 — 세션으로 인증된 요청이 통한다
    expect((await rest(live, "GET", "/channels")).status).toBe(200);

    const setup = await setupRelayChannel(live, RELAY_POLICY);
    expect(setup.statuses).toEqual({
      channel: 201,
      dev: 201,
      fin: 201,
      devMember: 201,
      finMember: 201,
      relayPolicy: 200,
    });
    expect(setup.channel.relayPolicy).toEqual({ maxRelayTurns: 2, allowPairs: "all" });
    expect(setup.dev).toMatchObject({
      providerAgentId: "dev",
      handle: "dev",
      provider: "openclaw",
      enabled: true,
    });
    expect(setup.fin).toMatchObject({
      providerAgentId: "fin",
      handle: "fin",
      provider: "openclaw",
      enabled: true,
    });

    const members = await rest<{ members: Array<{ memberType: string; memberId: string }> }>(
      live,
      "GET",
      `/channels/${setup.channel.id}/members`,
    );
    expect(members.status).toBe(200);
    expect(members.body.members.map((m) => [m.memberType, m.memberId])).toEqual([
      ["user", live.app.ownerUserId],
      ["agent", setup.dev.id],
      ["agent", setup.fin.id],
    ]);
  });

  it("시나리오 2 — @dev 멘션 → run.state queued…streaming…done · run.event · 에이전트 message.created(runId, 정본 본문)", async () => {
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const { channel, dev } = setup;
    const log = await openChannelWire(live, channel.id, sockets);
    const reply = "@owner 안녕하세요";
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ deltas: ["@owner ", "안녕하세요"], reply }) },
    });

    const human = await sendMessage(log.socket, channel.id, "@dev 안녕");
    expect(human.mentions.agents).toEqual([dev.id]);

    const queued = await log.until(() => log.states.find((s) => s.agentId === dev.id), "dev 런 run.state");
    const final = await log.terminal(queued.id);
    const agentMessage = await log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.runId === queued.id),
      "에이전트 message.created",
    );
    // 같은 연결의 ack 왕복 — 이 뒤로 이 런의 run.state·run.event 가 더 오지 않는다
    const replay = await log.socket.emitWithAck("run.events.replay", { runId: queued.id, afterSeq: 0 });
    if (!replay.ok) throw new Error(replay.error.code);

    const states = log.statesOf(queued.id).map((s) => s.status);
    expect(states[0]).toBe("queued");
    expect(states).toContain("streaming");
    expect(states.at(-1)).toBe("done");
    expect(final).toMatchObject({ status: "done", hasCanonical: true, finalSource: "plugin" });

    const types = log.eventsOf(queued.id).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["RUN_STARTED", "TEXT_MESSAGE_CONTENT", "RUN_FINISHED"]));
    expect(types.indexOf("RUN_STARTED")).toBeLessThan(types.indexOf("RUN_FINISHED"));
    expect(types.at(-1)).toBe("RUN_FINISHED");
    const deltas = log
      .eventsOf(queued.id)
      .flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? [e.delta] : []))
      .join("");
    expect(deltas).toBe(reply);
    expect(log.eventsOf(queued.id).find((e) => e.type === "RUN_FINISHED")).toMatchObject({
      messageIds: [agentMessage.id],
    });

    expect(agentMessage).toMatchObject({
      kind: "normal",
      authorType: "agent",
      authorId: dev.id,
      runId: queued.id,
      bodyMd: `<@u:${live.app.ownerUserId}> 안녕하세요`,
      mentions: { agents: [], users: [live.app.ownerUserId] },
      replyTo: human.id,
    });

    // 인바운드는 사람 메시지를 평문 멘션으로 싣고 온 한 번뿐
    expect(live.plugin.received).toHaveLength(1);
    expect(live.plugin.received[0]).toMatchObject({
      kind: "message",
      agentId: "dev",
      runId: queued.id,
      sessionKey: `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}`,
      message: { id: human.id, text: "@dev 안녕" },
    });
    expect(await getRunRest(live, queued.id)).toMatchObject({
      triggerKind: "mention",
      relayDepth: 0,
      rootMessageId: human.id,
      providerRunId: queued.id,
      status: "done",
      finalSource: "plugin",
    });
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 3 — dev→fin relayDepth 1 → fin→dev relayDepth 2 → dev→fin 은 런 없이 relay_limit + continue_relay", async () => {
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const { channel, dev, fin } = setup;
    const log = await openChannelWire(live, channel.id, sockets);
    const { scenario, human, devFirst, finRun, devSecond, limit } = await relayUntilLimit(setup, log);

    expect(await getRunRest(live, devFirst.id)).toMatchObject({
      triggerKind: "mention",
      relayDepth: 0,
      rootMessageId: human.id,
    });
    expect(await getRunRest(live, finRun.id)).toMatchObject({
      agentId: fin.id,
      triggerKind: "relay",
      relayDepth: 1,
      rootMessageId: human.id,
    });
    expect(await getRunRest(live, devSecond.id)).toMatchObject({
      agentId: dev.id,
      triggerKind: "relay",
      relayDepth: 2,
      rootMessageId: human.id,
    });

    // dev 의 `@fin 다시` 는 런이 되지 않았다 — 채널 런은 셋, 인바운드도 셋
    const runs = await listRunsRest(live, channel.id);
    expect(runs.map((r) => r.id).sort()).toEqual([devFirst.id, finRun.id, devSecond.id].sort());
    expect(live.plugin.received.map((d) => [d.agentId, d.runId])).toEqual([
      ["dev", devFirst.id],
      ["fin", finRun.id],
      ["dev", devSecond.id],
    ]);

    const devSecondMessage = log.created.find((m) => m.runId === devSecond.id) as Message;
    expect(devSecondMessage.bodyMd).toBe(`<@a:${fin.id}> 다시`);
    expect(limit.seq).toBeGreaterThan(devSecondMessage.seq);
    expect(limit).toMatchObject({
      kind: "system",
      authorType: "system",
      bodyMd: "릴레이 한도(2턴)에 도달했습니다. 계속하려면 사람이 멘션하거나 이어가기를 누르세요.",
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: dev.id, toAgentId: fin.id, sourceRunId: devSecond.id, rootMessageId: human.id },
      },
    });
    expect(limit.components?.blocks[0]).toMatchObject({
      type: "actions",
      items: [{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }],
    });
    expect(limit.components?.id).toMatch(/^cmp_/);
    expect(limit.componentState?.consumed).toEqual([]);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 4 — relay_limit 카드의 continue_relay 클릭 → fin 에 continue 런(relayDepth 0, root = 시스템 메시지)", async () => {
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const { channel, fin } = setup;
    const log = await openChannelWire(live, channel.id, sockets);
    const { scenario, finRun, limit } = await relayUntilLimit(setup, log);
    const componentId = limit.components?.id as string;

    const ack = await log.socket.emitWithAck("component.interact", {
      messageId: limit.id,
      componentId,
      itemId: "continue_relay",
      values: {},
    });
    if (!ack.ok) throw new Error(`component.interact 실패: ${ack.error.code} ${ack.error.message}`);
    const { interactionId } = ack.data;
    expect(interactionId).toEqual(expect.any(String));

    const continued = await log.until(
      () => log.states.find((s) => s.agentId === fin.id && s.id !== finRun.id),
      "fin continue 런",
    );
    expect((await log.terminal(continued.id)).status).toBe("done");
    expect(await getRunRest(live, continued.id)).toMatchObject({
      agentId: fin.id,
      triggerKind: "continue",
      relayDepth: 0,
      rootMessageId: limit.id,
      triggerInteractionId: interactionId,
    });

    const consumed = await log.until(
      () => log.updated.find((m) => m.id === limit.id),
      "relay_limit 카드 message.updated",
    );
    expect(consumed.componentState?.consumed).toEqual(["continue_relay"]);

    const delivery = live.plugin.received.find((d) => d.runId === continued.id);
    expect(delivery).toMatchObject({ kind: "continue", agentId: "fin", message: { id: limit.id } });
    const reply = await log.until(
      () => log.created.find((m) => m.runId === continued.id),
      "continue 런의 에이전트 메시지",
    );
    expect(reply.bodyMd).toBe("이어서 확인했습니다");

    // 같은 버튼을 다시 누르면 소비됨
    const again = await log.socket.emitWithAck("component.interact", {
      messageId: limit.id,
      componentId,
      itemId: "continue_relay",
      values: {},
    });
    expect(again).toMatchObject({ ok: false, error: { code: "CONSUMED" } });
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 5(a) — 같은 본문을 되풀이하는 릴레이 → repeat 로 막혀 relay_limit(반복 문구 + continue_relay)", async () => {
    // repeat 는 같은 (from, to) 쌍이 한 체인에서 두 번 나와야 한다 — 에이전트 둘이면 세 번째 홉(relayDepth 3)이다.
    // max_turns 가 먼저 막지 않게 상한을 3 으로 둔다(decideRuns 는 pair → max_turns → repeat 순서로 잰다).
    const setup = await setupRelayChannel(live, { maxRelayTurns: 3, allowPairs: "all" });
    const { channel, dev, fin } = setup;
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "@fin 같은 말" }), fin: () => ({ reply: "@dev 같은 말" }) },
    });

    const human = await sendMessage(log.socket, channel.id, "@dev 시작");
    const limit = await log.until(() => log.created.find((m) => m.kind === "system"), "repeat 시스템 메시지");
    const devSecond = await log.until(
      () => log.states.find((s) => s.agentId === dev.id && s.relayDepth === 2),
      "dev relayDepth 2 런",
    );
    await log.terminal(devSecond.id);

    expect(limit).toMatchObject({
      kind: "system",
      bodyMd: "같은 내용의 릴레이가 반복되어 멈췄습니다. 계속하려면 사람이 멘션하거나 이어가기를 누르세요.",
      systemMeta: {
        kind: "relay_limit",
        relay: { fromAgentId: dev.id, toAgentId: fin.id, sourceRunId: devSecond.id, rootMessageId: human.id },
      },
    });
    expect(limit.components?.blocks[0]).toMatchObject({
      type: "actions",
      items: [{ type: "button", id: "continue_relay" }],
    });
    // 세 번째 dev→fin 은 런이 아니다: dev(0) · fin(1) · dev(2)
    const runs = await listRunsRest(live, channel.id);
    expect(runs.map((r) => [r.agentId, r.relayDepth]).sort()).toEqual(
      [
        [dev.id, 0],
        [fin.id, 1],
        [dev.id, 2],
      ].sort(),
    );
    expect(live.plugin.received).toHaveLength(3);
    expect(log.created.filter((m) => m.kind === "system")).toHaveLength(1);
    expectNoScenarioErrors(scenario);
  });

  it("시나리오 5(b) — allowPairs [dev→fin] 에서 fin 이 @dev 를 부르면 relay_denied(pair_not_allowed)", async () => {
    const setup = await setupRelayChannel(live, ({ dev, fin }) => ({
      maxRelayTurns: 2,
      allowPairs: [{ from: dev.id, to: fin.id }],
    }));
    const { channel, dev, fin } = setup;
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "@fin 부탁해" }), fin: () => ({ reply: "@dev 확인" }) },
    });

    const human = await sendMessage(log.socket, channel.id, "@dev 시작");
    const finRun = await log.until(
      () => log.states.find((s) => s.agentId === fin.id && s.relayDepth === 1),
      "fin 릴레이 런(허용 쌍 dev→fin)",
    );
    const denied = await log.until(
      () => log.created.find((m) => m.kind === "system"),
      "relay_denied 시스템 메시지",
    );
    const finState: RunState = await log.terminal(finRun.id);
    expect(finState.status).toBe("done");

    expect(denied).toMatchObject({
      kind: "system",
      bodyMd: "@fin 은 @dev 를 부를 수 없습니다(허용 목록 밖)",
      systemMeta: {
        kind: "relay_denied",
        relay: { fromAgentId: fin.id, toAgentId: dev.id, sourceRunId: finRun.id, rootMessageId: human.id },
      },
    });
    expect(denied.components).toBeUndefined();
    const runs = await listRunsRest(live, channel.id);
    expect(runs.map((r) => [r.agentId, r.relayDepth]).sort()).toEqual(
      [
        [dev.id, 0],
        [fin.id, 1],
      ].sort(),
    );
    expect(live.plugin.received.map((d) => d.agentId)).toEqual(["dev", "fin"]);
    expectNoScenarioErrors(scenario);
  });
});
