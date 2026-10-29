/**
 * 제어 도구 통로(제어 MCP 스펙 「통로」 장) 통합 — 실제 서버 + 가짜 러너(`/runner`)·가짜 플러그인(`/bridge`)이 `control.call` 을 보내고
 * ack 로 결과를 받는다. 읽기는 곧바로, 쓰기는 시킨 사람의 확인 카드를 지나 실행된다. 끝난 런의 이름으로 온 늦은 호출은 같은 세션의 다음
 * 런이 열려 있어도 받지 않는다(Review Focus 4). `/mcp` 는 control.mcp.test.ts
 */
import {
  type Agent,
  type Approval,
  BRIDGE_PROTOCOL,
  type Channel,
  type ControlResult,
  dodokSessionKey,
  IssueRunnerTokenResult,
} from "@dodok/shared";
import { afterEach, describe, expect, it } from "vitest";
import { getChannel } from "../../src/modules/channels/service";
import { createScenario } from "../fakes/scenario";
import { FAKE_PLUGIN_HELLO } from "../fakes/fake-plugin";
import { type FakeRunner, type FakeRunnerRun, startFakeRunner } from "../fakes/fake-runner";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { openChannelWire, resolveApproval, rest, sendMessage, type WireLog } from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { channelConversation } from "../helpers/seed";

describe("제어 도구 통로", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  const runners: FakeRunner[] = [];

  afterEach(async () => {
    for (const runner of runners.splice(0)) runner.close();
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  function ok<T>(what: string, res: { status: number; body: T }): T {
    if (res.status >= 300) throw new Error(`${what} → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  }

  async function channelWith(agent: Agent): Promise<Channel> {
    const { channel } = ok(
      "POST /channels",
      await rest<{ channel: Channel }>(live, "POST", "/channels", { name: `ctl-${Date.now()}` }),
    );
    ok(
      "POST members",
      await rest(live, "POST", `/channels/${channel.id}/members`, {
        memberType: "agent",
        memberId: agent.id,
      }),
    );
    return channel;
  }

  const runOf = (log: WireLog, agentId: string, n = 0) =>
    log.until(
      () =>
        log.states
          .filter((s) => s.agentId === agentId)
          .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i)[n],
      `에이전트 ${agentId} 런 ${n}`,
    );

  /** 확인 카드를 기다려 시킨 사람(owner — 이 wire 소켓의 주인)이 허용한다 */
  async function allowCard(log: WireLog, runId: string): Promise<Approval> {
    const card = await log.until(
      () => log.approvals.find((a) => a.kind === "dodok_control" && a.runId === runId),
      "확인 카드",
    );
    expect(card.requestedBy).toBe(live.app.ownerUserId);
    await resolveApproval(log.socket, card.id, "allow-once");
    return card;
  }

  const infoNotice = (log: WireLog, channelId: string, needle: string) =>
    log.until(
      () =>
        log.created.find(
          (m) => m.channelId === channelId && m.systemMeta?.kind === "info" && m.bodyMd.includes(needle),
        ),
      `시스템 메시지 「${needle}」`,
    );

  it("러너 — 열린 런의 읽기는 곧바로, 쓰기는 확인 카드 → 허용 → 채널이 바뀌고 시스템 메시지·ack 성공, 끝난 런의 늦은 호출은 NOT_FOUND", async () => {
    live = await bootLiveApp();
    const issued = IssueRunnerTokenResult.parse(
      ok("POST runner-tokens", await rest(live, "POST", "/setup/runner-tokens", { label: "macbook" })),
    );
    const results: ControlResult[] = [];
    let current: FakeRunnerRun | undefined;
    let channelId = "";
    const runner = await startFakeRunner({
      url: live.app.url,
      token: issued.token,
      script: async (run) => {
        current = run;
        results.push(await run.control("get_channel", { channelId }));
        results.push(await run.control("update_channel", { channelId, name: "renamed-by-runner" }));
        run.final("바꿨습니다");
      },
    });
    runners.push(runner);
    const { agent: coder } = ok(
      "POST /agents coder",
      await rest<{ agent: Agent }>(live, "POST", "/agents", {
        provider: "runner",
        providerAgentId: "coder",
        handle: "coder",
        name: "Coder",
      }),
    );
    const channel = await channelWith(coder);
    channelId = channel.id;
    const log = await openChannelWire(live, channel.id, sockets);

    await sendMessage(log.socket, channel.id, "@coder 채널 이름 바꿔 줘");
    const run = await runOf(log, coder.id);
    await allowCard(log, run.id);
    expect((await log.terminal(run.id)).status).toBe("done");

    expect(results[0]).toMatchObject({ ok: true, data: { channel: { id: channel.id } } });
    expect(results[1]).toMatchObject({ ok: true });
    expect(getChannel(live.app.db, channel.id, live.app.workspaceId)?.name).toBe("renamed-by-runner");
    await infoNotice(log, channel.id, "@coder");

    // Review Focus 4 — 끝난 런의 이름으로는 읽기도 받지 않는다
    expect(await current?.control("get_channel", { channelId })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("플러그인 — 세션 키 + 상관관계 runId 로 같은 흐름, 끝난 런의 runId 는 같은 세션의 다음 런이 열려 있어도 NOT_FOUND [Review Focus 4]", async () => {
    live = await bootLiveApp({
      pluginHello: { ...FAKE_PLUGIN_HELLO, capabilities: [...FAKE_PLUGIN_HELLO.capabilities, "control"] },
    });
    expect(live.plugin.helloResult?.protocol).toBe(BRIDGE_PROTOCOL);
    // 대본은 정본·final 을 보내지 않는다 — 런이 열린 채로 남아 그 사이에 도구를 부른다
    createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "작업 중", holdFinal: true }) },
    });
    const { agent: dev } = ok(
      "POST /agents dev",
      await rest<{ agent: Agent }>(live, "POST", "/agents", {
        providerAgentId: "dev",
        handle: "dev",
        name: "Dev",
        gatewayId: live.gatewayId,
      }),
    );
    const channel = await channelWith(dev);
    const sessionKey = dodokSessionKey("dev", channelConversation(live.app.db, channel.id));
    const log = await openChannelWire(live, channel.id, sockets);

    await sendMessage(log.socket, channel.id, "@dev 채널 이름 바꿔 줘");
    const first = await runOf(log, dev.id);
    await log.until(() => live.plugin.received.some((d) => d.runId === first.id), "인바운드");
    expect(
      await live.plugin.control({
        sessionKey,
        runId: first.id,
        tool: "get_channel",
        args: { channelId: channel.id },
      }),
    ).toMatchObject({ ok: true, data: { channel: { id: channel.id } } });

    const write = live.plugin.control({
      sessionKey,
      runId: first.id,
      tool: "update_channel",
      args: { channelId: channel.id, name: "renamed-by-plugin" },
    });
    await allowCard(log, first.id);
    expect(await write).toMatchObject({ ok: true });
    expect(getChannel(live.app.db, channel.id, live.app.workspaceId)?.name).toBe("renamed-by-plugin");
    await infoNotice(log, channel.id, "@dev");

    // 다른 세션 키·다른 Gateway 의 이름으로는 같은 runId 도 받지 않는다
    expect(
      await live.plugin.control({
        sessionKey: dodokSessionKey("fin", channelConversation(live.app.db, channel.id)),
        runId: first.id,
        tool: "get_channel",
        args: { channelId: channel.id },
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });

    expect(await log.socket.emitWithAck("run.abort", { runId: first.id })).toMatchObject({ ok: true });
    await log.terminal(first.id);
    await sendMessage(log.socket, channel.id, "@dev 한 번 더");
    const second = await runOf(log, dev.id, 1);
    await log.until(() => live.plugin.received.some((d) => d.runId === second.id), "두 번째 인바운드");
    expect(second.id).not.toBe(first.id);

    const late = (runId: string) =>
      live.plugin.control({ sessionKey, runId, tool: "get_channel", args: { channelId: channel.id } });
    expect(await late(first.id)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await late(second.id)).toMatchObject({ ok: true });
  });
});
