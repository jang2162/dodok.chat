/**
 * 스레드·검색 계획 태스크 5 — 스레드 런(스펙 2.2~2.4·3.5·4.2 푸시). 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway +
 * 가짜 플러그인(hello 에 threads) + wire 클라이언트. 기다림은 wire 이벤트(`WireLog.until`)로 한다.
 */
import { BridgeHello, type Message, PushPayload, type Result, type RunState } from "@dodok/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app";
import { createScenario, type Scenario, type ScenarioAgent } from "../fakes/scenario";
import { FAKE_PLUGIN_HELLO } from "../fakes/fake-plugin";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import {
  openChannelWire,
  type RelayChannel,
  rest,
  sendMessage,
  setupRelayChannel,
  subscribe,
  WAIT_MS,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { channelConversation } from "../helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 3, allowPairs: "all" as const };
/** 스레드를 모르는 옛 플러그인(Review Focus 2) */
const OLD_PLUGIN_HELLO = BridgeHello.parse({
  ...FAKE_PLUGIN_HELLO,
  capabilities: FAKE_PLUGIN_HELLO.capabilities.filter((cap) => cap !== "threads"),
});

describe("통합 — 스레드 런", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function start(
    agents: Record<string, ScenarioAgent>,
    opts: LiveAppOptions = {},
  ): Promise<{ setup: RelayChannel; log: WireLog; scenario: Scenario }> {
    live = await bootLiveApp(opts);
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const scenario = createScenario({ gateway: live.gateway, plugin: live.plugin, agents });
    return { setup, log, scenario };
  }

  const agentMessage = (log: WireLog, agentId: string, n = 0) =>
    log.until(
      () => log.created.filter((m) => m.authorType === "agent" && m.authorId === agentId)[n],
      `에이전트 ${agentId} 메시지 ${n}`,
    );

  const runOf = (log: WireLog, agentId: string, threadRootId: string | undefined, n = 0) =>
    log.until(
      () =>
        log.states
          .filter((s) => s.agentId === agentId && s.threadRootId === threadRootId)
          .filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i)[n],
      `에이전트 ${agentId} 런 ${n}(스레드 ${threadRootId ?? "없음"})`,
    );

  it("스레드 멘션 → 스레드 키·threadId·context.thread(채널 대화 없음) → 정본이 스레드에, 루트 요약 갱신, RunState 에 threadRootId", async () => {
    const { setup, log, scenario } = await start({
      dev: () => ({ deltas: ["스레드 ", "답"], reply: "스레드 답" }),
    });
    const { channel, dev } = setup;
    await sendMessage(log.socket, channel.id, "채널 잡담");
    const root = await sendMessage(log.socket, channel.id, "루트 질문");
    const reply = await sendMessage(log.socket, channel.id, "@dev 이어서 봐줘", { threadRootId: root.id });

    const answer = await agentMessage(log, dev.id);
    expect(answer).toMatchObject({ threadRootId: root.id, bodyMd: "스레드 답" });
    const delivery = scenario.turns[0]?.delivery;
    expect(delivery).toMatchObject({
      sessionKey: `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}:thread:${root.id}`,
      threadId: root.id,
      message: { id: reply.id },
      context: {
        recentMessages: [],
        thread: { root: { text: "루트 질문" }, recentMessages: [] },
      },
    });
    // 어댑터가 스레드 키를 인바운드 전에 구독했다
    expect(
      live.gateway.requests.some(
        (r) =>
          r.method === "sessions.messages.subscribe" &&
          (r.params as { key?: unknown }).key === delivery?.sessionKey,
      ),
    ).toBe(true);

    const run = await runOf(log, dev.id, root.id);
    expect((await log.terminal(run.id)).status).toBe("done");
    // 루트 요약(답글 = 사람 1 + 에이전트 1)
    const summary = await log.until(
      () => log.updated.find((m) => m.id === root.id && m.threadSummary?.count === 2),
      "루트 threadSummary count 2",
    );
    expect(summary.threadSummary?.agentIds).toEqual([dev.id]);

    // R3′ — run.state·run.events.replay·REST 런이 threadRootId 를 싣는다
    expect(log.statesOf(run.id).every((s) => s.threadRootId === root.id)).toBe(true);
    const replay = (await log.socket.emitWithAck("run.events.replay", {
      runId: run.id,
      afterSeq: 0,
    })) as Result<{
      run: RunState;
    }>;
    expect(replay.ok && replay.data.run.threadRootId).toBe(root.id);
    expect(
      (await rest<{ run: { threadRootId?: string } }>(live, "GET", `/runs/${run.id}`)).body.run.threadRootId,
    ).toBe(root.id);
    expect(scenario.errors).toEqual([]);
  });

  it("진행 중 스레드 런은 구독 activeRuns 에 threadRootId 를 싣는다", async () => {
    const { setup, log } = await start({ dev: () => ({ reply: "", holdFinal: true }) });
    const root = await sendMessage(log.socket, setup.channel.id, "루트");
    await sendMessage(log.socket, setup.channel.id, "@dev 멈춰 있어", { threadRootId: root.id });
    const run = await runOf(log, setup.dev.id, root.id);
    await log.until(() => log.statesOf(run.id).some((s) => s.status === "streaming"), "스레드 런 streaming");
    const again = await subscribe(log.socket, setup.channel.id);
    expect(again.activeRuns).toEqual([expect.objectContaining({ id: run.id, threadRootId: root.id })]);
  });

  it("멘션 없는 스레드 답글 — 루트가 에이전트 메시지면 그 에이전트, 사람 루트면 채널 자동 응답", async () => {
    const { setup, log, scenario } = await start({
      dev: ({ index }) => ({ reply: index === 0 ? "dev 루트 답" : "dev 스레드 답" }),
      fin: () => ({ reply: "fin 자동 응답" }),
    });
    const { channel, dev, fin } = setup;
    expect(
      (await rest(live, "PATCH", `/channels/${channel.id}/members/${fin.id}`, { autoRespond: true })).status,
    ).toBe(200);

    await sendMessage(log.socket, channel.id, "@dev 처음");
    const devRoot = await agentMessage(log, dev.id, 0);
    await sendMessage(log.socket, channel.id, "그럼 이건?", { threadRootId: devRoot.id });
    expect(await agentMessage(log, dev.id, 1)).toMatchObject({ threadRootId: devRoot.id });

    const humanRoot = await sendMessage(log.socket, channel.id, "사람 루트");
    const finFirst = await agentMessage(log, fin.id, 0); // 최상위 사람 메시지 → 자동 응답
    expect(finFirst.threadRootId).toBeUndefined();
    await sendMessage(log.socket, channel.id, "스레드에서 아무나", { threadRootId: humanRoot.id });
    expect(await agentMessage(log, fin.id, 1)).toMatchObject({ threadRootId: humanRoot.id });
    await scenario.idle();
    expect(scenario.turns.map((t) => [t.agentId, t.delivery.threadId])).toEqual([
      ["dev", undefined],
      ["dev", devRoot.id],
      ["fin", undefined],
      ["fin", humanRoot.id],
    ]);
  });

  it("채널 런과 스레드 런은 동시에 돌고, 같은 스레드의 두 멘션은 직렬", async () => {
    const { setup, log, scenario } = await start({
      dev: ({ delivery }) =>
        delivery.threadId === undefined ? { reply: "", holdFinal: true } : { reply: "스레드 답" },
    });
    const { channel, dev } = setup;
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@dev 채널 일");
    const channelRun = await runOf(log, dev.id, undefined);
    await log.until(
      () => log.statesOf(channelRun.id).some((s) => s.status === "streaming"),
      "채널 런 streaming",
    );

    // 채널 런이 진행 중인데 스레드 런이 끝까지 돈다(세션 큐가 다르다)
    await sendMessage(log.socket, channel.id, "@dev 스레드 일 1", { threadRootId: root.id });
    await sendMessage(log.socket, channel.id, "@dev 스레드 일 2", { threadRootId: root.id });
    const first = await runOf(log, dev.id, root.id, 0);
    const second = await runOf(log, dev.id, root.id, 1);
    expect((await log.terminal(first.id)).status).toBe("done");
    expect((await log.terminal(second.id)).status).toBe("done");
    expect(log.statesOf(channelRun.id).at(-1)?.status).toBe("streaming");

    // 같은 스레드의 둘째 런은 첫 런이 끝난 뒤에 인바운드를 받았다
    const endedAt = log.statesOf(first.id).find((s) => s.status === "done")?.endedAt ?? "";
    const secondStarted = log.statesOf(second.id).find((s) => s.startedAt !== undefined)?.startedAt ?? "";
    expect(Date.parse(secondStarted)).toBeGreaterThanOrEqual(Date.parse(endedAt));
    expect(scenario.turns.map((t) => t.delivery.runId)).toEqual([channelRun.id, first.id, second.id]);
  });

  it("스레드 릴레이는 같은 스레드 세션에서 돌고, 반복 차단(relay_limit) 알림도 스레드에", async () => {
    const { setup, log, scenario } = await start({
      dev: () => ({ reply: "@fin 넘길게" }),
      fin: () => ({ reply: "@dev 다시" }),
    });
    const { channel, dev, fin } = setup;
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@dev 시작", { threadRootId: root.id });
    const limit = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "relay_limit"),
      "스레드 안 relay_limit",
    );
    expect(limit.threadRootId).toBe(root.id);
    await scenario.idle();
    const keys = scenario.turns.map((t) => [t.agentId, t.delivery.sessionKey, t.delivery.threadId]);
    expect(keys).toEqual([
      [
        "dev",
        `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}:thread:${root.id}`,
        root.id,
      ],
      [
        "fin",
        `agent:fin:dodok:channel:${channelConversation(live.app.db, channel.id)}:thread:${root.id}`,
        root.id,
      ],
      [
        "dev",
        `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}:thread:${root.id}`,
        root.id,
      ],
    ]); // dev 의 둘째 「@fin 넘길게」 는 같은 사슬의 반복이라 막힌다
    expect(log.created.filter((m) => m.authorType === "agent").every((m) => m.threadRootId === root.id)).toBe(
      true,
    );
    expect(log.created.filter((m) => m.authorId === fin.id)).toHaveLength(1);
    expect(log.created.filter((m) => m.authorId === dev.id)).toHaveLength(2);
  });

  it("일일 한도가 스레드 런도 센다 — 스레드 런 하나로 채널 멘션이 막힌다", async () => {
    const { setup, log } = await start({ dev: () => ({ reply: "답" }) });
    const { channel, dev } = setup;
    const patched = await rest(live, "PATCH", `/channels/${channel.id}`, {
      relayPolicy: { ...RELAY_POLICY, dailyRunLimit: 1 },
    });
    expect(patched.status).toBe(200);
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@dev 스레드", { threadRootId: root.id });
    await agentMessage(log, dev.id);
    await sendMessage(log.socket, channel.id, "@dev 채널");
    const channelLimit = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_limit"),
      "채널 run_limit",
    );
    expect(channelLimit.threadRootId).toBeUndefined();
    expect(log.states.filter((s) => s.threadRootId === undefined)).toEqual([]);
  });

  it("옛 플러그인(hello 에 threads 없음) → 스레드 멘션은 PLUGIN_OUTDATED 카드, 채널 런은 정상 → 재설치 뒤 다시 실행하면 스레드에서 답한다", async () => {
    const { setup, log, scenario } = await start(
      { dev: ({ delivery }) => ({ reply: delivery.threadId ? "스레드 답" : "채널 답" }) },
      { pluginHello: OLD_PLUGIN_HELLO },
    );
    const { channel, dev } = setup;
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@dev 스레드", { threadRootId: root.id });
    const card = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_error"),
      "PLUGIN_OUTDATED run_error 카드",
    );
    expect(card).toMatchObject({
      threadRootId: root.id,
      bodyMd: "@dev 가 스레드에서 답하지 못했습니다 — 플러그인을 새로 설치해야 합니다(연결 페이지)",
    });
    const failed = await runOf(log, dev.id, root.id);
    expect(await log.terminal(failed.id)).toMatchObject({
      status: "error",
      error: { code: "PLUGIN_OUTDATED" },
    });
    expect(scenario.turns).toEqual([]); // 플러그인에 가지 않았다

    await sendMessage(log.socket, channel.id, "@dev 채널");
    expect(await agentMessage(log, dev.id, 0)).toMatchObject({ bodyMd: "채널 답" });

    // 플러그인 재설치(스레드를 아는 hello) → 다시 실행
    await live.plugin.reconnect({ hello: FAKE_PLUGIN_HELLO });
    const res = (await log.socket.emitWithAck("component.interact", {
      messageId: card.id,
      componentId: card.components?.id ?? "",
      itemId: "retry_run",
      values: {},
    })) as Result<unknown>;
    expect(res.ok).toBe(true);
    expect(await agentMessage(log, dev.id, 1)).toMatchObject({ bodyMd: "스레드 답", threadRootId: root.id });
    const retried = await runOf(log, dev.id, root.id, 1);
    expect(
      (await rest<{ run: { parentRunId?: string } }>(live, "GET", `/runs/${retried.id}`)).body.run,
    ).toMatchObject({
      parentRunId: failed.id,
    });
  });

  it("정본의 threadId 가 세션 키·런의 스레드와 다르면 거절(저장 없음)", async () => {
    const { setup, log } = await start({ dev: () => ({ reply: "", holdFinal: true }) });
    const { channel, dev } = setup;
    const root = await sendMessage(log.socket, channel.id, "루트");
    const other = await sendMessage(log.socket, channel.id, "다른 루트");
    await sendMessage(log.socket, channel.id, "@dev 스레드", { threadRootId: root.id });
    const run = await runOf(log, dev.id, root.id);
    const threadKey = `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}:thread:${root.id}`;
    const base = {
      conversationId: channelConversation(live.app.db, channel.id),
      agentId: "dev",
      runId: run.id,
      text: "새면 안 된다",
      attachmentIds: [],
    };
    // 어댑터 브리지는 훅이 던진 오류를 코드 없이 INTERNAL ack 로 싣는다 — 사유 문장으로 가른다
    const mismatch = /threadId does not match/;
    await expect(
      live.plugin.sendOutbound({ ...base, sessionKey: threadKey, threadId: other.id }),
    ).rejects.toThrow(mismatch);
    await expect(
      live.plugin.sendOutbound({
        ...base,
        sessionKey: `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}`,
      }),
    ).rejects.toThrow(mismatch);
    expect(log.created.filter((m) => m.authorType === "agent")).toEqual([]);
  });

  it("스레드 안 카드 버튼 → 그 스레드의 interaction 런", async () => {
    const { setup, log, scenario } = await start({
      dev: ({ index }) =>
        index === 0
          ? {
              reply: "골라 주세요",
              components: {
                blocks: [{ type: "actions", items: [{ type: "button", id: "go", label: "진행" }] }],
              },
            }
          : { reply: "진행했습니다" },
    });
    const { channel, dev } = setup;
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@dev 골라줘", { threadRootId: root.id });
    const card: Message = await agentMessage(log, dev.id, 0);
    expect(card.threadRootId).toBe(root.id);
    const res = (await log.socket.emitWithAck("component.interact", {
      messageId: card.id,
      componentId: card.components?.id ?? "",
      itemId: "go",
      values: {},
    })) as Result<unknown>;
    expect(res.ok).toBe(true);
    expect(await agentMessage(log, dev.id, 1)).toMatchObject({ threadRootId: root.id });
    await scenario.idle();
    expect(scenario.turns[1]?.delivery).toMatchObject({
      kind: "interaction",
      threadId: root.id,
      sessionKey: `agent:dev:dodok:channel:${channelConversation(live.app.db, channel.id)}:thread:${root.id}`,
    });
  });

  it("스레드에서 사람을 멘션하면 푸시는 「스레드에서 불렀습니다」, 링크는 그 스레드", async () => {
    const sent: PushPayload[] = [];
    const pushSend: NonNullable<AppDeps["pushSend"]> = async (_sub, body) => {
      sent.push(PushPayload.parse(JSON.parse(body)));
      return { statusCode: 201 };
    };
    const { setup, log } = await start(
      { dev: () => ({ reply: "@owner 확인 부탁" }) },
      { deps: { pushSend } },
    );
    const sub = await live.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: live.auth.headers,
      payload: {
        endpoint: "https://push.invalid/thread",
        keys: {
          p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
          auth: "tBHItJI5svbpez7KI4CCXg",
        },
      },
    });
    expect(sub.statusCode).toBe(204);
    const { channel, dev } = setup;
    const root = await sendMessage(log.socket, channel.id, "루트");
    await sendMessage(log.socket, channel.id, "@dev 봐줘", { threadRootId: root.id });
    await agentMessage(log, dev.id);
    const deadline = Date.now() + WAIT_MS;
    while (sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(sent).toEqual([
      expect.objectContaining({
        kind: "mention",
        body: "@dev가 #relay 스레드에서 불렀습니다",
        url: `/c/${channel.id}/t/${root.id}`,
      }),
    ]);
  });
});
