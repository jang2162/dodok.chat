/**
 * PWA·푸시 계획 시나리오 12a~12h — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + wire 클라이언트 +
 * 가짜 발송기(`AppDeps.pushSend`). 밖으로는 아무것도 보내지 않는다 — endpoint 는 닿지 않는 `push.invalid`.
 *
 * 「보내지 않았다」를 재는 법: 트리거 → 거르기 → 구독 읽기 → `send` 호출은 버스 emit 안에서 동기로 일어난다(발송기의
 * 첫 await 가 `send` 다). 그래서 같은 메시지가 wire 로 클라이언트에 닿았으면 보낼 것은 이미 가짜 발송기에 적혀 있다.
 */
import { type Channel, type Message, PushPayload } from "@dodok/shared";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_CLOSE_TIMEOUT_MS, type AppDeps, PUSH_DRAIN_TIMEOUT_MS } from "../../src/app";
import { listSubscriptions } from "../../src/modules/push/service";
import { createScenario, type Scenario, type ScenarioScript } from "../fakes/scenario";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import {
  openChannelWire,
  type RelayChannel,
  rest,
  sendMessage,
  setupRelayChannel,
  WAIT_MS,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";
import { connectWire } from "../helpers/wire";
import { channelConversation, seedConversation } from "../helpers/seed";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
const EP = "https://push.invalid/owner-1";
const EP2 = "https://push.invalid/owner-2";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type Sent = { endpoint: string; body: string; payload: PushPayload; opts: { urgency: string; TTL: number } };

describe("통합 시나리오 12 — 푸시 트리거·거르기·발송", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  let sent: Sent[];
  let status: (endpoint: string) => number;

  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub, body, opts) => {
    sent.push({ endpoint: sub.endpoint, body, payload: PushPayload.parse(JSON.parse(body)), opts });
    return { statusCode: status(sub.endpoint) };
  };

  async function boot(send: NonNullable<AppDeps["pushSend"]> = pushSend, logger?: AppDeps["logger"]) {
    sent = [];
    status = () => 201;
    live = await bootLiveApp({ deps: { pushSend: send, ...(logger === undefined ? {} : { logger }) } });
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  async function subscribePush(endpoint = EP) {
    const res = await live.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: live.auth.headers,
      payload: { endpoint, keys: KEYS },
    });
    expect(res.statusCode).toBe(204);
  }

  /** 가짜 발송기는 wire 이벤트가 아니다 — 짧게 되풀이해 본다(상한은 실패를 드러내는 용도) */
  async function untilSent(n: number, what: string): Promise<Sent[]> {
    const deadline = Date.now() + WAIT_MS;
    while (sent.length < n) {
      if (Date.now() > deadline) throw new Error(`${what}: 발송 ${n}건을 기다렸는데 ${sent.length}건`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return sent;
  }

  /** dev 한 명이 대본대로 답하는 채널 + 구독한 소켓 */
  async function startChannel(
    dev: (index: number) => ScenarioScript = () => ({ reply: "@owner 확인했습니다" }),
  ): Promise<{ setup: RelayChannel; log: WireLog; scenario: Scenario }> {
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: ({ index }) => dev(index) },
    });
    return { setup, log, scenario };
  }

  /** 사람이 `@dev …` 를 보내고 dev 의 n 번째(0부터) 답이 wire 로 올 때까지 */
  async function devTurn(
    log: WireLog,
    setup: RelayChannel,
    n: number,
    text = "@dev 봐줘",
    conversationId?: string,
  ): Promise<Message> {
    await sendMessage(log.socket, setup.channel.id, text, conversationId ? { conversationId } : {});
    return log.until(
      () => log.created.filter((m) => m.authorType === "agent" && m.authorId === setup.dev.id)[n],
      `dev 답 ${n}`,
    );
  }

  const presence = (
    socket: WireClient,
    p: { visible: boolean; channelId?: string; conversationId?: string },
  ) => socket.emit("presence.update", p);
  /** 보내기가 고르는 그 채널의 세션(seed sendTarget) — 링크·거르기가 이 세션을 가리킨다 */
  const sessionOf = (channelId: string) => channelConversation(live.app.db, channelId);

  it("12a — 구독한 사람을 에이전트가 멘션하면 가짜 발송기가 표 5.2 첫 줄 페이로드를 받는다(josa(dev) = 「가」)", async () => {
    await boot();
    await subscribePush();
    const { setup, log, scenario } = await startChannel();
    const reply = await devTurn(log, setup, 0);
    expect(reply.mentions.users).toEqual([live.app.ownerUserId]);

    const [one] = await untilSent(1, "멘션 푸시");
    expect(sent).toHaveLength(1); // 사람의 `@dev` 메시지는 사람 멘션이 없어 보내지 않는다
    expect(one?.endpoint).toBe(EP);
    const conv = reply.conversationId;
    expect(conv).toBe(sessionOf(setup.channel.id));
    expect(one?.payload).toEqual({
      kind: "mention",
      channelId: setup.channel.id,
      title: "dodok",
      body: "@dev가 #relay에서 불렀습니다",
      url: `/c/${setup.channel.id}/s/${conv}`,
      tag: `mention:${conv}`,
    });
    expect(one?.opts).toMatchObject({ TTL: 3600, urgency: "normal" });
    expect(scenario.errors).toEqual([]);
  });

  it("12b — [Review Focus 3] 그 세션을 보이는 탭으로 보고 있으면 안 보냄, 같은 채널의 다른 세션·다른 채널·보이지 않음이면 보냄", async () => {
    await boot();
    await subscribePush();
    const { setup, log } = await startChannel();
    const conv = sessionOf(setup.channel.id);

    // 같은 소켓의 presence.update → message.send 는 순서대로 처리된다 — 답이 오기 전에 서버가 안다
    presence(log.socket, { visible: true, channelId: setup.channel.id, conversationId: conv });
    await devTurn(log, setup, 0);
    expect(sent).toEqual([]);

    // 판정 PS7 — 같은 채널의 다른 세션을 보고 있으면 이 세션의 멘션은 간다
    const sideSession = seedConversation(live.app.db, setup.channel.id, { title: "곁 세션" });
    presence(log.socket, { visible: true, channelId: setup.channel.id, conversationId: sideSession });
    await devTurn(log, setup, 1, undefined, conv);
    await untilSent(1, "같은 채널의 다른 세션을 보는 중");
    expect(sent.map((s) => s.payload.url)).toEqual([`/c/${setup.channel.id}/s/${conv}`]);

    const other = (await rest<{ channel: Channel }>(live, "POST", "/channels", { name: "other" })).body
      .channel;
    presence(log.socket, { visible: true, channelId: other.id });
    await devTurn(log, setup, 2, undefined, conv);
    await untilSent(2, "다른 채널을 보는 중");
    expect(sent.map((s) => s.payload.channelId)).toEqual([setup.channel.id, setup.channel.id]);

    presence(log.socket, { visible: false, channelId: setup.channel.id, conversationId: conv }); // 백그라운드 탭
    await devTurn(log, setup, 3, undefined, conv);
    await untilSent(3, "보이지 않는 탭");
    expect(sent).toHaveLength(3);
  });

  it("12c — 승인 요청 → 채널의 사람 멤버에게, url 은 활동 탭, urgency high, 같은 승인이 두 번 실려도 한 번", async () => {
    await boot();
    await subscribePush();
    const { setup, log, scenario } = await startChannel(() => ({
      deltas: ["다", "했어요"],
      reply: "다했어요",
      approval: { ttlMs: 20_000, onDecision: "continue" },
    }));
    await sendMessage(log.socket, setup.channel.id, "@dev 파일 써줘");
    const card = await log.until(() => log.approvals.at(0), "approval.requested");
    // 뒤따르는 스냅샷이 같은 승인을 한 번 더 실어 온다(approvals 통합 9a) — 그 뒤에 센다
    await log.until(
      () => log.approvals.find((a) => a.id === card.id && a.urlPath !== undefined),
      "urlPath 가 채워진 같은 승인",
    );
    const approvals = (await untilSent(1, "승인 푸시")).filter((s) => s.payload.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.payload).toEqual({
      kind: "approval",
      channelId: setup.channel.id,
      title: "dodok",
      body: "#relay에 승인 요청이 있습니다",
      url: `/c/${setup.channel.id}/s/${sessionOf(setup.channel.id)}/activity`,
      tag: `approval:${card.id}`,
    });
    expect(approvals[0]?.opts).toMatchObject({ urgency: "high", TTL: 3600 });
    expect(scenario.errors).toEqual([]);
  });

  it("12d — 릴레이 한도 카드 → 채널의 사람 멤버에게", async () => {
    await boot();
    await subscribePush();
    const setup = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, setup.channel.id, sockets);
    createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ index }) => (index === 0 ? { reply: "@fin 부탁해" } : { reply: "@fin 다시" }),
        fin: () => ({ reply: "@dev 확인" }),
      },
    });
    await sendMessage(log.socket, setup.channel.id, "@dev 안녕");
    await log.until(
      () => log.created.find((m) => m.kind === "system" && m.systemMeta?.kind === "relay_limit"),
      "relay_limit 시스템 메시지",
    );
    const limits = (await untilSent(1, "릴레이 한도 푸시")).filter((s) => s.payload.kind === "relay_limit");
    expect(limits.map((s) => s.payload)).toEqual([
      {
        kind: "relay_limit",
        channelId: setup.channel.id,
        title: "dodok",
        body: "#relay의 에이전트 대화가 한도에 닿았습니다",
        url: `/c/${setup.channel.id}/s/${sessionOf(setup.channel.id)}`,
        tag: `relay:${sessionOf(setup.channel.id)}`,
      },
    ]);
    // 이 흐름에는 사람 멘션이 없다 — 한도 카드 말고는 보내지 않았다
    expect(sent).toHaveLength(1);
  });

  it("12e — 발송기가 410 이면 그 구독 행을 지우고, 다른 구독은 남는다", async () => {
    await boot();
    await subscribePush(EP);
    await subscribePush(EP2);
    status = (endpoint) => (endpoint === EP ? 410 : 201);
    const { setup, log } = await startChannel();
    await devTurn(log, setup, 0);
    await untilSent(2, "두 구독");
    const deadline = Date.now() + WAIT_MS;
    while (listSubscriptions(live.app.db, live.app.ownerUserId).length !== 1 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(listSubscriptions(live.app.db, live.app.ownerUserId).map((s) => s.endpoint)).toEqual([EP2]);

    // 지운 뒤에는 남은 구독으로만 간다
    await devTurn(log, setup, 1);
    await untilSent(3, "남은 구독");
    expect(sent.slice(2).map((s) => s.endpoint)).toEqual([EP2]);
  });

  it("12f — [Review Focus 3] 자기 멘션은 보내지 않는다", async () => {
    await boot();
    await subscribePush();
    const { setup, log } = await startChannel();
    // ack 가 오면 message.created 는 이미 버스를 지났다(createUserMessage 가 저장 트랜잭션 뒤 emit)
    const self = await sendMessage(log.socket, setup.channel.id, "@owner 메모: 내일 할 일");
    expect(self.mentions.users).toEqual([live.app.ownerUserId]);
    await log.until(() => log.created.find((m) => m.id === self.id), "자기 멘션 message.created");
    expect(sent).toEqual([]);

    // 대조: 같은 사람을 에이전트가 부르면 간다
    await devTurn(log, setup, 0);
    await untilSent(1, "대조 멘션");
    expect(sent.map((s) => s.payload.kind)).toEqual(["mention"]);
  });

  it("12g — 페이로드 어디에도 메시지 본문·승인 제목이 없다", async () => {
    await boot();
    await subscribePush();
    const AGENT_SECRET = "AGENTSECRET-7f3a";
    const HUMAN_SECRET = "HUMANSECRET-91cc";
    const TITLE_SECRET = "TITLESECRET-2b8e";
    const { setup, log } = await startChannel((index) =>
      index === 0
        ? { reply: `@owner ${AGENT_SECRET} 결과입니다` }
        : { reply: "끝", approval: { ttlMs: 20_000, title: TITLE_SECRET, onDecision: "continue" } },
    );
    await devTurn(log, setup, 0, `@dev ${HUMAN_SECRET} 해줘`);
    await sendMessage(log.socket, setup.channel.id, "@dev 파일 써줘");
    const card = await log.until(() => log.approvals.at(0), "approval.requested");
    expect(card.title).toBe(TITLE_SECRET);
    await untilSent(2, "멘션 + 승인");
    expect(sent.map((s) => s.payload.kind).sort()).toEqual(["approval", "mention"]);
    const everything = JSON.stringify(sent);
    for (const secret of [AGENT_SECRET, HUMAN_SECRET, TITLE_SECRET, "결과입니다", "claude-cli", "Write"])
      expect(everything).not.toContain(secret);
  });

  it("12h — 보고 있던 소켓이 끊기면 거르기가 풀린다(한 사람의 소켓 둘)", async () => {
    await boot();
    await subscribePush();
    const { setup, log } = await startChannel();
    const watcher = await connectWire(live.app, live.auth.token);
    sockets.push(watcher);
    const conv = sessionOf(setup.channel.id);
    presence(watcher, { visible: true, channelId: setup.channel.id, conversationId: conv });
    presence(log.socket, { visible: false, channelId: setup.channel.id, conversationId: conv }); // 보내는 쪽은 백그라운드
    // watcher 의 presence 가 서버에 닿았는지 ack 왕복으로 확인한다(같은 소켓 순서 보장)
    await watcher.emitWithAck("channel.subscribe", { channelId: setup.channel.id });
    await devTurn(log, setup, 0);
    expect(sent).toEqual([]);

    const before = live.app.io.sockets.sockets.size;
    watcher.close();
    const deadline = Date.now() + WAIT_MS;
    while (live.app.io.sockets.sockets.size !== before - 1 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    expect(live.app.io.sockets.sockets.size).toBe(before - 1);

    await devTurn(log, setup, 1);
    await untilSent(1, "끊긴 뒤 멘션");
    expect(sent.map((s) => s.payload.kind)).toEqual(["mention"]);
  });

  it("종료 — 걸린 발송은 PUSH_DRAIN_TIMEOUT_MS 만 기다리고 놓는다, 닫은 뒤 버스 이벤트는 보내지 않는다", async () => {
    const lines: Array<{ msg?: string }> = [];
    const logger = pino({ level: "info" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
    // 응답하지 않는 푸시 서비스
    await boot(async (sub, body, opts) => {
      sent.push({ endpoint: sub.endpoint, body, payload: PushPayload.parse(JSON.parse(body)), opts });
      return new Promise<never>(() => undefined);
    }, logger);
    await subscribePush();
    const { setup, log } = await startChannel();
    const reply = await devTurn(log, setup, 0);
    await untilSent(1, "걸린 발송");

    const t0 = Date.now();
    await live.app.close();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(PUSH_DRAIN_TIMEOUT_MS - 100); // 짧게는 기다린다(404·410 정리가 db 를 닫기 전에)
    expect(elapsed).toBeLessThan(APP_CLOSE_TIMEOUT_MS); // 전체 상한에 걸리지 않는다

    // 트리거를 뗐으니 닫힌 db 를 읽으러 가지도 않는다(떼지 않으면 「push dispatch failed」 가 남는다)
    live.app.bus.emit("message.created", { message: reply });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    // 부팅 때 통로마다 남기는 「push transport <통로>: on|off(…)」 줄은 발송 로그가 아니다
    expect(lines.filter((l) => l.msg?.startsWith("push") && !l.msg.startsWith("push transport"))).toEqual([]);
  });
});
