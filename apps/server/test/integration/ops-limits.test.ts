/**
 * Phase 3 ③ 계획 태스크 2 — 런 관문(일일 런 한도)과 「다시 실행」. 실제 서버 + 가짜 Gateway·플러그인 + wire 클라이언트.
 *
 * 다시 실행은 run_error 시스템 메시지의 1회용 버튼(`retry_run`)이다 — `component.interact` 의 소비 트랜잭션이
 * 「한 번만·두 탭 동시」를 맡고, 한도에 막히면 상호작용을 저장·소비하지 않고 `RUN_LIMIT` 으로 거절한다(Review Focus 5).
 */
import type { Message, Result } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { componentInteractions, opsEvents, runs } from "../../src/db/schema.sqlite";
import { getMessage } from "../../src/modules/messages/service";
import { patchOpsSettings } from "../../src/modules/ops/settings";
import { createScenario, type ScenarioAgent } from "../fakes/scenario";
import { bootLiveApp, type LiveApp, type LiveAppOptions } from "../helpers/live-app";
import {
  getRunRest,
  listRunsRest,
  openChannelWire,
  type RelayChannel,
  sendMessage,
  setupRelayChannel,
  subscribe,
  type WireLog,
} from "../helpers/scenario-steps";
import { connectWire, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
const SHORT_TIMEOUTS = { queuedMs: 500, runMs: 5_000, finalizingMs: 300 };
const RETRY_COMPONENTS = {
  blocks: [
    { type: "actions", items: [{ type: "button", id: "retry_run", label: "다시 실행", style: "primary" }] },
  ],
};
/** 버튼이 붙는 실패 — bot-loop-protection 은 다시 보내도 같은 사유로 떨어지므로 버튼이 없다 */
const TEST_DROP = "test-drop";
const WORKSPACE_LIMIT_BODY = (n: number) => `오늘 런 한도(${n})에 도달했습니다 — 내일 0시에 풀립니다`;

describe("런 관문·다시 실행", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function start(
    agents: Record<string, ScenarioAgent>,
    opts: LiveAppOptions = {},
    policy = RELAY_POLICY,
  ) {
    live = await bootLiveApp(opts);
    const setup = await setupRelayChannel(live, policy);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const scenario = createScenario({ gateway: live.gateway, plugin: live.plugin, agents });
    return { setup, log, scenario };
  }

  /** `@dev …` 를 보내고 그 런이 실패해 남긴 run_error 시스템 메시지까지 기다린다 */
  async function failedMention(setup: RelayChannel, log: WireLog, body = "@dev 해줘") {
    const trigger = await sendMessage(log.socket, setup.channel.id, body);
    const queued = await log.until(
      () => log.states.find((s) => s.agentId === setup.dev.id && s.status === "queued"),
      "dev 런",
    );
    const final = await log.terminal(queued.id);
    const notice = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_error" && m.systemMeta.runId === queued.id),
      "run_error 시스템 메시지",
    );
    return { trigger, runId: queued.id, final, notice };
  }

  function pressRetry(socket: WireClient, notice: Message) {
    const componentId = notice.components?.id;
    if (componentId === undefined) throw new Error("run_error 메시지에 버튼이 없다");
    return socket.emitWithAck("component.interact", {
      messageId: notice.id,
      componentId,
      itemId: "retry_run",
      values: {},
    });
  }

  const childrenOf = (runId: string) =>
    live.app.db.select().from(runs).where(eq(runs.parentRunId, runId)).all();
  const interactionsOf = (messageId: string) =>
    live.app.db
      .select()
      .from(componentInteractions)
      .where(eq(componentInteractions.messageId, messageId))
      .all();
  const runLimitEvents = () =>
    live.app.db.select().from(opsEvents).where(eq(opsEvents.kind, "run_limit")).all();

  function expectOk(res: Result<{ interactionId: string }>) {
    if (!res.ok) throw new Error(`component.interact 실패: ${res.error.code} ${res.error.message}`);
  }

  it("플러그인이 없어 실패한 멘션 런 → run_error 의 「다시 실행」 → 새 런 parentRunId = 원래, 같은 트리거 메시지", async () => {
    const { setup, log, scenario } = await start(
      { dev: () => ({ reply: "다시 했어요" }) },
      { timeouts: SHORT_TIMEOUTS },
    );
    live.plugin.disconnect();
    await log.until(() => log.adapterStatus.find((s) => s.bridge === "down"), "bridge down");
    const { trigger, runId, final, notice } = await failedMention(setup, log);
    expect(final).toMatchObject({ status: "error", error: { code: "ADAPTER_UNAVAILABLE" } });
    expect(notice.components).toMatchObject(RETRY_COMPONENTS);
    expect(notice.components?.reusable).toBe(false);
    // 한도에 막혀 남긴 버튼을 한도가 풀린 뒤에도 누를 수 있게 계약 상한(24시간)까지 산다
    expect(Date.parse(notice.componentState?.expiresAt as string) - Date.parse(notice.createdAt)).toBe(
      86_400_000,
    );

    await live.plugin.reconnect();
    await log.until(() => log.adapterStatus.find((s) => s.bridge === "connected"), "bridge connected");
    expectOk(await pressRetry(log.socket, notice));

    const reply = await log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.bodyMd === "다시 했어요"),
      "다시 실행 런의 정본",
    );
    const retried = await getRunRest(live, reply.runId as string);
    expect(retried).toMatchObject({
      status: "done",
      agentId: setup.dev.id,
      triggerKind: "mention",
      triggerMessageId: trigger.id,
      rootMessageId: trigger.id,
      relayDepth: 0,
      parentRunId: runId,
    });
    expect(retried.triggerInteractionId).toBeUndefined();
    // 에이전트는 원래 사람 메시지를 다시 받는다 — 상호작용 글이 아니다
    expect(scenario.turns.map((t) => t.delivery.message.text)).toEqual(["@dev 해줘"]);
    expect(scenario.errors).toEqual([]);
  });

  it("같은 버튼 두 번째는 CONSUMED, 두 소켓이 동시에 눌러도 새 런은 하나", async () => {
    const { setup, log } = await start({
      dev: ({ index }) => (index === 0 ? { reply: "안 보냄", drop: TEST_DROP } : { reply: "했어요" }),
    });
    const { runId, notice } = await failedMention(setup, log);
    const other = await connectWire(live.app, live.auth.token);
    sockets.push(other);

    const results = await Promise.all([pressRetry(log.socket, notice), pressRetry(other, notice)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ ok: false, error: { code: "CONSUMED" } });
    expect(await pressRetry(log.socket, notice)).toMatchObject({ ok: false, error: { code: "CONSUMED" } });

    await log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.bodyMd === "했어요"),
      "다시 실행 런의 정본",
    );
    expect(childrenOf(runId)).toHaveLength(1);
    expect(interactionsOf(notice.id)).toHaveLength(1);
  });

  it("워크스페이스 한도에 걸린 채 누르면 RUN_LIMIT — 상호작용 0·버튼 미소비, 한도를 올리면 다시 눌러 통과", async () => {
    const { setup, log } = await start({
      dev: ({ index }) => (index === 0 ? { reply: "안 보냄", drop: TEST_DROP } : { reply: "했어요" }),
    });
    const { runId, notice } = await failedMention(setup, log);
    patchOpsSettings(live.app.db, live.app.workspaceId, { dailyRunLimit: 1 }); // 오늘 런 1개 — 이미 찼다

    expect(await pressRetry(log.socket, notice)).toMatchObject({ ok: false, error: { code: "RUN_LIMIT" } });
    expect(interactionsOf(notice.id)).toEqual([]);
    expect(getMessage(live.app.db, notice.id)?.componentState?.consumed).toEqual([]);
    expect(childrenOf(runId)).toEqual([]);
    const limitNotice = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_limit"),
      "run_limit 시스템 메시지",
    );
    expect(limitNotice.bodyMd).toBe(WORKSPACE_LIMIT_BODY(1));

    patchOpsSettings(live.app.db, live.app.workspaceId, { dailyRunLimit: 2 });
    expectOk(await pressRetry(log.socket, notice));
    await log.until(
      () => log.created.find((m) => m.authorType === "agent" && m.bodyMd === "했어요"),
      "다시 실행 런의 정본",
    );
    expect(childrenOf(runId)).toHaveLength(1);
  });

  it("다시 실행 대상 런이 error 가 아니면(되돌려진 상태) VALIDATION — 버튼은 남는다", async () => {
    const { setup, log } = await start({
      dev: () => ({ reply: "안 보냄", drop: TEST_DROP }),
    });
    const { runId, notice } = await failedMention(setup, log);
    live.app.db.update(runs).set({ status: "done" }).where(eq(runs.id, runId)).run();

    expect(await pressRetry(log.socket, notice)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(getMessage(live.app.db, notice.id)?.componentState?.consumed).toEqual([]);
    expect(childrenOf(runId)).toEqual([]);
  });

  it("bot-loop-protection 으로 떨어진 런은 트리거 메시지가 있어도 run_error 에 버튼이 없다", async () => {
    const { setup, log, scenario } = await start({
      dev: () => ({ reply: "안 보냄", drop: "bot-loop-protection" }),
    });
    const { trigger, runId, final, notice } = await failedMention(setup, log);
    expect(final).toMatchObject({ status: "error", error: { code: "DROPPED:bot-loop-protection" } });
    expect((await getRunRest(live, runId)).triggerMessageId).toBe(trigger.id);
    expect(notice.bodyMd).toBe("@dev 가 봇 루프 보호로 메시지를 받지 않았습니다");
    expect(notice.components).toBeUndefined();
    expect(notice.componentState).toBeUndefined();
    expect(scenario.turns).toHaveLength(1);
  });

  it("트리거 메시지가 없는 이어가기 런이 실패하면 run_error 에 버튼이 없다", async () => {
    const { setup, log } = await start(
      {
        dev: () => ({ reply: "@fin 넘길게" }),
        fin: () => ({ reply: "안 보냄", drop: TEST_DROP }),
      },
      {},
      { maxRelayTurns: 0, allowPairs: "all" },
    );
    await sendMessage(log.socket, setup.channel.id, "@dev 시작");
    const card = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "relay_limit"),
      "relay_limit 카드",
    );
    const res = await log.socket.emitWithAck("component.interact", {
      messageId: card.id,
      componentId: card.components?.id as string,
      itemId: "continue_relay",
      values: {},
    });
    expectOk(res);
    const continued = await log.until(
      () => log.states.find((s) => s.agentId === setup.fin.id), // fin 은 릴레이가 막혀 이어가기 런만 받는다
      "fin continue 런",
    );
    await log.terminal(continued.id);
    const notice = await log.until(
      () =>
        log.created.find((m) => m.systemMeta?.kind === "run_error" && m.systemMeta.runId === continued.id),
      "continue 런의 run_error",
    );
    expect(notice.components).toBeUndefined();
    expect(notice.componentState).toBeUndefined();
  });

  it("워크스페이스 한도에 닿은 뒤 사람 멘션 → 런 0 · 메시지 저장 · 시스템 메시지 1 · 사건 1줄", async () => {
    const { setup, log, scenario } = await start({ dev: () => ({ reply: "안 옴" }) });
    patchOpsSettings(live.app.db, live.app.workspaceId, { dailyRunLimit: 1 });
    // 한도를 채울 런 하나 — 관문을 지난 첫 멘션
    await sendMessage(log.socket, setup.channel.id, "@dev 첫 번째");
    const first = await log.until(() => log.states.find((s) => s.agentId === setup.dev.id), "첫 런");
    await log.terminal(first.id);

    const blocked = await sendMessage(log.socket, setup.channel.id, "@dev 두 번째");
    const notice = await log.until(
      () => log.created.find((m) => m.systemMeta?.kind === "run_limit"),
      "run_limit 시스템 메시지",
    );
    const again = await sendMessage(log.socket, setup.channel.id, "@dev 세 번째");
    await subscribe(log.socket, setup.channel.id, again.seq); // ack 왕복 — 뒤따르는 이벤트가 더 없다

    expect(notice).toMatchObject({
      kind: "system",
      bodyMd: WORKSPACE_LIMIT_BODY(1),
      systemMeta: { kind: "run_limit", limit: { scope: "workspace", limit: 1 } },
    });
    expect(log.created.filter((m) => m.systemMeta?.kind === "run_limit")).toHaveLength(1);
    expect((await listRunsRest(live, setup.channel.id)).map((r) => r.id)).toEqual([first.id]);
    const page = await subscribe(log.socket, setup.channel.id, 0);
    expect(page.messages.map((m) => m.id)).toEqual(expect.arrayContaining([blocked.id, again.id]));
    expect(runLimitEvents().map((e) => [e.key, e.count, e.detail])).toEqual([["workspace", 2, { limit: 1 }]]);
    expect(scenario.turns).toHaveLength(1);
  });
});
