/**
 * 서버 코어 스펙 9.2 시나리오 6·7 — 드롭·플러그인 끊김·wire 재접속·서버 재시작.
 * 실제 시계. 상한은 `bootLiveApp({ timeouts })` 로만 줄인다(가짜 시계는 Gateway tick 감시를 건드려 쓰지 않는다).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { opsEvents } from "../../src/db/schema.sqlite";
import { createScenario } from "../fakes/scenario";
import { bootLiveApp, type LiveAppOptions, type LiveApp } from "../helpers/live-app";
import {
  getRunRest,
  openChannelWire,
  recordWire,
  sendMessage,
  setupRelayChannel,
  subscribe,
} from "../helpers/scenario-steps";
import { connectWire, reconnectWire, type WireClient } from "../helpers/wire";
import { openclawOf } from "../helpers/openclaw";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
const SHORT_TIMEOUTS = { queuedMs: 500, runMs: 5_000, finalizingMs: 300 };

describe("통합 시나리오 6·7 — 드롭·끊김·재접속·재시작", () => {
  const sockets: WireClient[] = [];
  /** 이 테스트가 띄운 앱 — 띄운 역순으로 닫는다 */
  const boots: LiveApp[] = [];
  const dirs: string[] = [];

  async function boot(opts: LiveAppOptions = {}): Promise<LiveApp> {
    const live = await bootLiveApp(opts);
    boots.push(live);
    return live;
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const live of boots.splice(0).reverse()) await live.close();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe("시나리오 6 — queuedMs 500 · runMs 5s · finalizingMs 300", () => {
    let live: LiveApp;

    beforeEach(async () => {
      live = await boot({ timeouts: SHORT_TIMEOUTS });
    });

    it("6(a) — 플러그인이 bot-loop-protection 으로 drop ack → error(DROPPED:bot-loop-protection) + run_error 시스템 메시지", async () => {
      const { channel, dev } = await setupRelayChannel(live, RELAY_POLICY);
      const log = await openChannelWire(live, channel.id, sockets);
      const scenario = createScenario({
        gateway: live.gateway,
        plugin: live.plugin,
        agents: { dev: () => ({ reply: "안 보냄", drop: "bot-loop-protection" }) },
      });

      await sendMessage(log.socket, channel.id, "@dev 안녕");
      const queued = await log.until(() => log.states.find((s) => s.agentId === dev.id), "dev 런");
      const final = await log.terminal(queued.id);
      const notice = await log.until(
        () => log.created.find((m) => m.kind === "system" && m.systemMeta?.runId === queued.id),
        "run_error 시스템 메시지",
      );
      await subscribe(log.socket, channel.id, notice.seq); // ack 왕복 — 이 런의 run.state 가 더 오지 않는다

      const states = log.statesOf(queued.id);
      expect(states[0]?.status).toBe("queued");
      expect(states.at(-1)?.status).toBe("error");
      expect(final.error).toEqual({ code: "DROPPED:bot-loop-protection", message: "bot-loop-protection" });
      expect(states.map((s) => s.status)).not.toContain("streaming");
      expect(notice).toMatchObject({
        kind: "system",
        authorType: "system",
        systemMeta: { kind: "run_error", runId: queued.id },
      });
      expect(notice.bodyMd).toContain("봇 루프 보호");
      expect(notice.bodyMd).toBe("@dev 가 봇 루프 보호로 메시지를 받지 않았습니다");
      expect(scenario.turns.map((t) => t.delivery.runId)).toEqual([queued.id]);
      expect(log.eventsOf(queued.id).find((e) => e.type === "RUN_ERROR")).toMatchObject({
        code: "DROPPED:bot-loop-protection",
      });
      // Gateway 로는 아무것도 흐르지 않았다
      expect(log.eventsOf(queued.id).map((e) => e.type)).not.toContain("RUN_STARTED");
    });

    it("6(b) — 플러그인 disconnect 뒤 @dev → queuedMs 안에 플러그인이 없어 error(ADAPTER_UNAVAILABLE) + run_error", async () => {
      const { channel, dev } = await setupRelayChannel(live, RELAY_POLICY);
      const log = await openChannelWire(live, channel.id, sockets);
      createScenario({
        gateway: live.gateway,
        plugin: live.plugin,
        agents: { dev: () => ({ reply: "안 옴" }) },
      });

      live.plugin.disconnect();
      await log.until(() => log.adapterStatus.find((s) => s.bridge === "down"), "adapter.status bridge down");
      expect(openclawOf(live.app).status()).toMatchObject({ gateway: "connected", bridge: "down" });

      const sentAt = Date.now();
      await sendMessage(log.socket, channel.id, "@dev 안녕");
      const queued = await log.until(() => log.states.find((s) => s.agentId === dev.id), "dev 런");
      const final = await log.terminal(queued.id);
      const elapsedMs = Date.now() - sentAt;
      const notice = await log.until(
        () => log.created.find((m) => m.kind === "system" && m.systemMeta?.runId === queued.id),
        "run_error 시스템 메시지",
      );

      expect(final.status).toBe("error");
      expect(final.error?.code).toBe("ADAPTER_UNAVAILABLE");
      expect(log.statesOf(queued.id).map((s) => s.status)).toEqual(["queued", "error"]);
      // 오케스트레이터 queued 상한(500ms)이 닫았다 — 어댑터의 플러그인 대기(120s)가 아니다
      expect(elapsedMs).toBeGreaterThanOrEqual(450);
      expect(elapsedMs).toBeLessThan(5_000);
      expect(notice).toMatchObject({
        kind: "system",
        bodyMd: "@dev 실행이 실패했습니다: ADAPTER_UNAVAILABLE",
        systemMeta: { kind: "run_error", runId: queued.id },
      });
      expect(await getRunRest(live, queued.id)).toMatchObject({
        status: "error",
        error: { code: "ADAPTER_UNAVAILABLE" },
      });
      expect(live.plugin.received).toEqual([]);
    });

    it("6(c) — Gateway 이벤트 없이 정본만 온다(구독 누락·WS 단절) → finalizing 을 거쳐 done(plugin), 시스템 메시지 없음", async () => {
      const { channel, dev } = await setupRelayChannel(live, RELAY_POLICY);
      const log = await openChannelWire(live, channel.id, sockets);
      const scenario = createScenario({
        gateway: live.gateway,
        plugin: live.plugin,
        agents: { dev: () => ({ reply: "정본만 왔어요", silentGateway: true }) },
      });

      await sendMessage(log.socket, channel.id, "@dev 안녕");
      const queued = await log.until(() => log.states.find((s) => s.agentId === dev.id), "dev 런");
      const final = await log.terminal(queued.id);
      const reply = await log.until(
        () => log.created.find((m) => m.authorType === "agent" && m.runId === queued.id),
        "dev 정본 message.created",
      );
      // queuedMs(500) 가 지나도록 기다린 뒤 ack 왕복 — 늦은 TIMEOUT·run_error 가 붙지 않는다
      await new Promise((resolve) => setTimeout(resolve, SHORT_TIMEOUTS.queuedMs + 100));
      await subscribe(log.socket, channel.id, reply.seq);

      const states = log.statesOf(queued.id);
      expect(states.map((s) => s.status)).toEqual(["queued", "finalizing", "done"]);
      expect(states.at(-1)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(final).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(final.error).toBeUndefined();
      expect(reply.bodyMd).toBe("정본만 왔어요");
      expect(log.created.filter((m) => m.kind === "system")).toEqual([]);
      expect(log.eventsOf(queued.id).map((e) => e.type)).toEqual([
        "RUN_QUEUED",
        "RUN_STARTED",
        "STATE_SNAPSHOT",
        "STATE_SNAPSHOT",
        "RUN_FINISHED",
      ]);
      expect(log.eventsOf(queued.id).at(-1)).toMatchObject({ type: "RUN_FINISHED", messageIds: [reply.id] });
      expect(await getRunRest(live, queued.id)).toMatchObject({ status: "done", finalSource: "plugin" });
      expect(scenario.errors).toEqual([]);
    });
  });

  describe("시나리오 7(a) — wire 재접속", () => {
    let live: LiveApp;

    beforeEach(async () => {
      live = await boot();
    });

    it("소켓 A 가 seq 1·2 를 본 뒤 끊기고 seq 3 이 생긴 뒤, 재접속해 channel.subscribe { lastSeq: 2 } → seq 3 만", async () => {
      const { channel } = await setupRelayChannel(live, RELAY_POLICY);
      const a = await openChannelWire(live, channel.id, sockets);
      await sendMessage(a.socket, channel.id, "첫째");
      await sendMessage(a.socket, channel.id, "둘째");
      await a.until(() => a.created.length === 2, "A 가 seq 1·2 message.created");
      expect(a.created.map((m) => m.seq)).toEqual([1, 2]);
      const lastSeq = Math.max(...a.created.map((m) => m.seq));

      a.socket.disconnect();
      const b = await connectWire(live.app, live.auth.token);
      sockets.push(b);
      const bLog = recordWire(b);
      await subscribe(b, channel.id);
      const third = await sendMessage(b, channel.id, "셋째");
      await bLog.until(() => bLog.created.find((m) => m.id === third.id), "B 가 seq 3 message.created");
      expect(third.seq).toBe(3);

      await reconnectWire(a.socket);
      const page = await subscribe(a.socket, channel.id, lastSeq);
      expect(page.messages.map((m) => [m.seq, m.bodyMd])).toEqual([[3, "셋째"]]);
      expect(page.hasMore).toBe(false);
      expect(page.activeRuns).toEqual([]);
      // 끊겨 있던 동안의 message.created 는 A 에 오지 않았다 — 빈틈은 subscribe 페이지로만 메웠다
      expect(a.created.map((m) => m.seq)).toEqual([1, 2]);

      // 다시 룸에 들어갔다 — 이후 메시지는 실시간으로 받는다
      const fourth = await sendMessage(b, channel.id, "넷째");
      await a.until(() => a.created.find((m) => m.id === fourth.id), "재구독 뒤 A 가 seq 4 message.created");
    });
  });

  describe("시나리오 7(b) — 파일 DB 로 재시작", () => {
    let live: LiveApp;
    let dbPath: string;

    beforeEach(async () => {
      const dir = mkdtempSync(join(tmpdir(), "dodok-restart-"));
      dirs.push(dir);
      dbPath = join(dir, "dodok.db");
      live = await boot({ env: { DB_PATH: dbPath } });
    });

    it("streaming 인 런을 두고 app.close() → 같은 DB 로 다시 createApp → GET /runs/:id 가 error(SERVER_RESTART)", async () => {
      const { channel, dev } = await setupRelayChannel(live, RELAY_POLICY);
      const log = await openChannelWire(live, channel.id, sockets);
      const scenario = createScenario({
        gateway: live.gateway,
        plugin: live.plugin,
        agents: { dev: () => ({ deltas: ["생각", " 중"], reply: "끝나지 않음", holdFinal: true }) },
      });

      await sendMessage(log.socket, channel.id, "@dev 오래 걸리는 일");
      const queued = await log.until(() => log.states.find((s) => s.agentId === dev.id), "dev 런");
      await log.until(
        () => log.statesOf(queued.id).find((s) => s.status === "streaming"),
        "dev 런 streaming",
      );
      await log.until(
        () =>
          log
            .eventsOf(queued.id)
            .flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? [e.delta] : []))
            .join("") === "생각 중",
        "델타 두 조각 저장·팬아웃",
      );
      expect(scenario.errors).toEqual([]);
      expect(await getRunRest(live, queued.id)).toMatchObject({ status: "streaming" });

      for (const socket of sockets.splice(0)) socket.close();
      await live.app.close();

      const restarted = await boot({ env: { DB_PATH: dbPath } });
      const run = await getRunRest(restarted, queued.id);
      expect(run).toMatchObject({
        id: queued.id,
        channelId: channel.id,
        agentId: dev.id,
        status: "error",
        error: { code: "SERVER_RESTART" },
      });
      expect(run.endedAt).toEqual(expect.any(String));
      expect(restarted.app.orchestrator.activeRuns(channel.id)).toEqual([]);
      const events = await restarted.app.fastify.inject({
        method: "GET",
        url: `/api/v1/runs/${queued.id}/events`,
        headers: restarted.auth.headers,
      });
      expect(events.statusCode).toBe(200);
      const types = (events.json() as { events: Array<{ type: string }> }).events.map((e) => e.type);
      expect(types.slice(-2)).toEqual(["STATE_SNAPSHOT", "RUN_ERROR"]);
      expect(types).toContain("TEXT_MESSAGE_CONTENT");
      // 부팅 정리가 닫은 런도 실패한 런이다 — 감시가 recoverOnBoot 보다 먼저 걸려 run_failed 가 한 번 남는다
      expect(restarted.app.db.select().from(opsEvents).where(eq(opsEvents.kind, "run_failed")).all()).toEqual(
        [
          expect.objectContaining({
            key: `agent:${dev.id}`,
            severity: "warn",
            count: 1,
            detail: { code: "SERVER_RESTART" },
          }),
        ],
      );
    });
  });
});
