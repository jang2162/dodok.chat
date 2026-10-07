/**
 * 자동화 통합(자동화 스펙 「테스트·검증·완료 기준」 장의 서버 통합 줄) — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway·플러그인 +
 * wire 클라이언트 + 가짜 푸시 발송기. 자동화는 REST 로 만들고, 예약은 앱의 주기 틱(automationTickMs)이, 웹훅은 /hooks/<token> 이 게시한다.
 * 「보내지 않았다」는 푸시 통합(push.test.ts 머리)과 같은 근거로 잰다 — 발송기 호출은 버스 emit 안에서 동기로 일어나므로 202 가 오면
 * 보낼 것은 이미 적혀 있다
 */
import {
  type AutomationCreated,
  type Channel,
  type Message,
  type ChannelMember,
  PushPayload,
} from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app";
import { channelMembers, runs } from "../../src/db/schema.sqlite";
import { updateAutomation } from "../../src/modules/automations/store";
import { createScenario, type Scenario } from "../fakes/scenario";
import { userWithRole } from "../helpers/app";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import {
  openChannelWire,
  rest,
  sendMessage,
  setupRelayChannel,
  type WireLog,
} from "../helpers/scenario-steps";
import type { WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const RELAY_POLICY = { maxRelayTurns: 2, allowPairs: "all" as const };
const MIA_ENDPOINT = "https://push.invalid/mia";
const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

type Sent = { endpoint: string; payload: PushPayload };
type Started = { channel: Channel; devId: string; log: WireLog; scenario: Scenario };

describe("통합 — 자동화", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  let sent: Sent[];

  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub, body) => {
    sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(body)) });
    return { statusCode: 201 };
  };

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await live.close();
  });

  /** dev·fin 이 든 채널 + 구독한 owner 소켓, dev 는 「확인했습니다」 로 답한다 */
  async function start(deps: Omit<AppDeps, "adapter"> = {}): Promise<Started> {
    sent = [];
    live = await bootLiveApp({ deps: { pushSend, automationTickMs: 50, ...deps } });
    const { channel, dev } = await setupRelayChannel(live, RELAY_POLICY);
    const log = await openChannelWire(live, channel.id, sockets);
    const scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: { dev: () => ({ reply: "확인했습니다" }) },
    });
    return { channel, devId: dev.id, log, scenario };
  }

  const createAutomation = async (payload: object): Promise<AutomationCreated> => {
    const res = await rest<AutomationCreated>(live, "POST", "/automations", payload);
    if (res.status !== 201) throw new Error(`POST /automations → ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  /** 만들기 응답의 URL 경로 그대로 보낸다 — 오리진은 서버 공개 주소(이 앱에서는 APP_ORIGIN 에서 나온다) */
  const hook = (webhookUrl: string | undefined, payload?: string, contentType = "text/plain") =>
    live.app.fastify.inject({
      method: "POST",
      url: new URL(webhookUrl ?? "").pathname,
      headers: { "content-type": contentType },
      ...(payload === undefined ? {} : { payload }),
    });
  const automationPost = (t: Started, automationId: string, nth = 0) =>
    t.log.until(
      () => t.log.created.filter((m) => m.authorType === "automation" && m.authorId === automationId)[nth],
      `자동화 ${automationId} 게시 ${nth}`,
    );
  /** 그 메시지가 만든 런 하나를 끝까지 — 그 런의 인바운드와 답 */
  async function runOf(t: Started, message: Message) {
    // run.state 에는 트리거 메시지가 없다 — 런 행으로 찾고, 그 뒤 wire 로 끝을 기다린다
    const started = await t.log.until(() => runsFor(message.id)[0], "자동화 글의 런");
    const run = await t.log.terminal(started.id);
    const answer = await t.log.until(
      () => t.log.created.find((m) => m.authorType === "agent" && m.runId === run.id),
      "dev 답",
    );
    return { run, answer, delivery: live.plugin.received.find((d) => d.runId === run.id) };
  }
  const runsFor = (messageId: string) =>
    live.app.db.select().from(runs).where(eq(runs.triggerMessageId, messageId)).all();
  const memberIds = (channelId: string) =>
    live.app.db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channelId))
      .all()
      .map((m) => m.memberId);

  it("예약 틱 → 게시 → @dev 멘션 런 — 인바운드 보낸 사람은 system:automation 「자동화 <이름>」", async () => {
    const t = await start();
    const { automation } = await createAutomation({
      kind: "schedule",
      name: "아침 점검",
      channelId: t.channel.id,
      bodyMd: "@dev 점검해 줘",
      schedule: { repeat: "daily", time: "09:00" },
    });
    // 기한이 된 회차로 — 다음 주기 틱이 가져간다
    updateAutomation(live.app.db, live.app.workspaceId, automation.id, {
      nextRunAt: new Date(Date.now() - 1000),
    });

    const posted = await automationPost(t, automation.id);
    expect(posted.mentions).toEqual({ agents: [t.devId], users: [] });
    const { run, delivery } = await runOf(t, posted);
    expect(run).toMatchObject({ status: "done", agentId: t.devId });
    expect(delivery?.message.author).toEqual({
      type: "system",
      handle: "automation",
      displayName: "자동화 아침 점검",
    });
    expect(delivery?.message.text).toBe("@dev 점검해 줘");
    expect(t.scenario.errors).toEqual([]);
  });

  it("웹훅 → 202 → 게시 → @dev 멘션 런 — 원문은 다시 들여 쓴 json 블록으로 에이전트에게 간다", async () => {
    const t = await start();
    const { automation, webhookUrl } = await createAutomation({
      kind: "webhook",
      name: "배포 알림",
      channelId: t.channel.id,
      bodyMd: "@dev 배포 결과 봐 줘",
    });
    const res = await hook(webhookUrl, '{"ok":false}', "application/json");
    expect(res.statusCode, res.body).toBe(202);
    const posted = await automationPost(t, automation.id);
    expect(posted.id).toBe((res.json() as { messageId: string }).messageId);
    const { run, delivery } = await runOf(t, posted);
    expect(run.status).toBe("done");
    expect(delivery?.message.text).toBe('@dev 배포 결과 봐 줘\n\n```json\n{\n  "ok": false\n}\n```');
  });

  it("런 한도에 막혀도 게시한다 — 한도 알림, 런 없음", async () => {
    const t = await start();
    // 사람 멘션 하나로 오늘 런 1 을 만들고 한도를 1 로
    await sendMessage(t.log.socket, t.channel.id, "@dev 먼저");
    await t.log.until(() => t.log.created.find((m) => m.authorType === "agent"), "사람 멘션의 답");
    const limit = await rest(live, "PATCH", "/ops/settings", { dailyRunLimit: 1 });
    expect(limit.status).toBe(200);

    const { automation, webhookUrl } = await createAutomation({
      kind: "webhook",
      name: "한도 확인",
      channelId: t.channel.id,
      bodyMd: "@dev 한도 넘었나",
    });
    const res = await hook(webhookUrl, "ping");
    expect(res.statusCode, res.body).toBe(202);
    const posted = await automationPost(t, automation.id);
    await t.log.until(() => t.log.created.find((m) => m.systemMeta?.kind === "run_limit"), "한도 알림");
    expect(runsFor(posted.id)).toEqual([]);
  });

  it("멘션 없는 문구 + 자동 응답 에이전트 → 게시는 되고 런 없음", async () => {
    const t = await start();
    const auto = await rest<{ member: ChannelMember }>(
      live,
      "PATCH",
      `/channels/${t.channel.id}/members/${t.devId}`,
      {
        autoRespond: true,
      },
    );
    expect(auto.status, JSON.stringify(auto.body)).toBe(200);
    const { automation, webhookUrl } = await createAutomation({
      kind: "webhook",
      name: "조용한 알림",
      channelId: t.channel.id,
      bodyMd: "새 이슈가 열렸습니다",
    });
    const res = await hook(webhookUrl, "issue #7");
    expect(res.statusCode, res.body).toBe(202);
    const posted = await automationPost(t, automation.id);
    expect(runsFor(posted.id)).toEqual([]);
    expect(live.plugin.received.some((d) => d.message.id === posted.id)).toBe(false);
  });

  it("[필수] 웹훅 원문은 멘션을 만들지 않는다 — 늘린 펜스·8,000자 자르기 뒤에도 런·푸시·참여 0(같은 문구의 사람 멘션은 푸시·참여)", async () => {
    const t = await start();
    const mia = await userWithRole(live.app, "mia", "member");
    const subscribed = await live.app.fastify.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers: { authorization: `Bearer ${mia.token}` },
      payload: { endpoint: MIA_ENDPOINT, keys: KEYS },
    });
    expect(subscribed.statusCode).toBe(204);
    const { automation, webhookUrl } = await createAutomation({
      kind: "webhook",
      name: "원문 확인",
      channelId: t.channel.id,
      bodyMd: "원문이 왔습니다",
    });
    const devToken = `<@a:${t.devId}>`;
    const miaToken = `<@u:${mia.id}>`;
    // ① 원문 속 ``` 로 펜스가 늘어난 블록 — 안쪽 펜스 뒤의 평문 @dev @mia
    const fenced = `log \`\`\` then @dev @mia please\n${devToken} ${miaToken}\n\`\`\`\n@dev`;
    // ② 8,000자 자르기 — devToken 은 블록 안에 온전히, miaToken 은 자르는 자리에 걸친다
    const head = "x ``` @dev @mia ".padEnd(7940, "x");
    const truncated = `${head}${devToken} ${miaToken}${"z".repeat(100)} @mia`;
    expect(head.length + devToken.length + 1).toBeLessThan(8000);
    expect(head.length + devToken.length + 1 + miaToken.length).toBeGreaterThan(8000);

    const ids: string[] = [];
    for (const [payload, contentType] of [
      [fenced, "text/plain"],
      [truncated, "text/plain"],
      [`{"comment":${JSON.stringify(fenced)}}`, "application/json"],
    ] as const) {
      const res = await hook(webhookUrl, payload, contentType);
      expect(res.statusCode, res.body).toBe(202);
      ids.push((res.json() as { messageId: string }).messageId);
    }
    for (const [nth, id] of ids.entries()) {
      const posted = await automationPost(t, automation.id, nth);
      expect(posted.id).toBe(id);
      expect(posted.mentions).toEqual({ agents: [], users: [] });
      expect(runsFor(id)).toEqual([]);
    }
    expect((await automationPost(t, automation.id, 1)).bodyMd).toContain("…(잘림)");
    expect(live.plugin.received.filter((d) => ids.includes(d.message.id))).toEqual([]);
    expect(sent.filter((s) => s.endpoint === MIA_ENDPOINT)).toEqual([]);
    expect(memberIds(t.channel.id)).not.toContain(mia.id);

    // 같은 경로의 대조군 — 문구의 @mia 는 멘션이다(푸시·참여)
    const control = await createAutomation({
      kind: "webhook",
      name: "사람 부르기",
      channelId: t.channel.id,
      bodyMd: "@mia 확인 부탁드립니다",
    });
    expect((await hook(control.webhookUrl, "ping")).statusCode).toBe(202);
    const pushed = sent.filter((s) => s.endpoint === MIA_ENDPOINT);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.payload).toMatchObject({ kind: "mention", channelId: t.channel.id });
    expect(memberIds(t.channel.id)).toContain(mia.id);
  });

  it("재발급 뒤 옛 URL·꺼진 자동화는 404, 토큰마다 분당 상한을 넘으면 429", async () => {
    const t = await start({ limits: { webhookPerMin: 2 } });
    const { automation, webhookUrl } = await createAutomation({
      kind: "webhook",
      name: "수명 확인",
      channelId: t.channel.id,
      bodyMd: "핑",
    });
    const reissued = await rest<AutomationCreated>(live, "POST", `/automations/${automation.id}/token`);
    expect(reissued.status).toBe(200);
    expect((await hook(webhookUrl, "old")).statusCode).toBe(404);
    expect((await hook(reissued.body.webhookUrl, "1")).statusCode).toBe(202);
    expect((await hook(reissued.body.webhookUrl, "2")).statusCode).toBe(202);
    expect((await hook(reissued.body.webhookUrl, "3")).statusCode).toBe(429);

    // 꺼짐은 상한보다 먼저 본다 — 상한을 넘긴 토큰이어도 404
    const off = await rest(live, "PATCH", `/automations/${automation.id}`, { enabled: false });
    expect(off.status).toBe(200);
    expect((await hook(reissued.body.webhookUrl, "4")).statusCode).toBe(404);
    const disabled = await createAutomation({
      kind: "webhook",
      name: "꺼짐 확인",
      channelId: t.channel.id,
      bodyMd: "핑",
      enabled: false,
    });
    expect((await hook(disabled.webhookUrl, "x")).statusCode).toBe(404);
  });
});
