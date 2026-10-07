/**
 * 웹훅 수신(자동화 스펙 「웹훅」 장) — POST /hooks/<token> 은 세션 없이 토큰만 본다. 틀린 토큰·꺼짐·예약 종류는 모두 같은 404(틀린 토큰만
 * 실패 카운터 — 브리지·러너와 같은 BridgeAuthGuard), 토큰마다 분당 상한, 본문 64 KiB. 파서·본문 상한은 이 경로에만 걸린다(계획 판정 PA5)
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Message } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import type { App } from "../src/app";
import { channelMembers, channels, messages, runs } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import {
  getAutomation,
  insertAutomation,
  type NewAutomationRow,
  updateAutomation,
} from "../src/modules/automations/store";
import { issueWebhookToken } from "../src/modules/automations/tokens";
import { addMember, createChannel } from "../src/modules/channels/service";
import type { OpsService } from "../src/modules/ops/service";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";

const PER_MIN = 3;
const MAX_FAILURES = 3;
const KIB64 = 64 * 1024;

describe("웹훅 POST /hooks/<token>", () => {
  let app: App;
  let adapter: FakeAdapter;
  let clock = 1_000_000;
  let n = 0;
  let address = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp(
      {},
      {
        adapters: [adapter],
        limitClock: () => clock,
        limits: {
          webhookPerMin: PER_MIN,
          bridgeFail: { maxFailures: MAX_FAILURES, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 },
        },
      },
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await app.close();
  });

  /** 사례마다 새 주소 — 실패 카운터가 사례 사이에 새지 않게 */
  const newAddress = () => `10.0.${Math.floor(++address / 250)}.${address % 250}`;
  const newChannel = () =>
    createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name: `hook-${++n}` });
  const addWebhook = (over: Partial<NewAutomationRow> = {}) => {
    const token = issueWebhookToken();
    const row = insertAutomation(app.db, {
      id: uuid(),
      workspaceId: app.workspaceId,
      name: `웹훅 ${++n}`,
      channelId: over.channelId ?? newChannel().id,
      kind: "webhook",
      bodyMd: "새 이벤트",
      enabled: true,
      tokenHash: token.hash,
      tokenPrefix: token.prefix,
      createdBy: app.ownerUserId,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    });
    return { row, token: token.raw };
  };
  const hook = (
    token: string,
    opts: { payload?: string; contentType?: string; from?: string; headers?: Record<string, string> } = {},
  ) =>
    app.fastify.inject({
      method: "POST",
      url: `/hooks/${token}`,
      remoteAddress: opts.from ?? newAddress(),
      headers: {
        ...(opts.contentType === undefined ? {} : { "content-type": opts.contentType }),
        ...opts.headers,
      },
      ...(opts.payload === undefined ? {} : { payload: opts.payload }),
    });
  const postsOf = (automationId: string): Message["bodyMd"][] =>
    app.db
      .select()
      .from(messages)
      .where(and(eq(messages.authorType, "automation"), eq(messages.authorId, automationId)))
      .all()
      .map((m) => m.bodyMd);
  const recorded = (spy: MockInstance<OpsService["record"]>, kind: string) =>
    spy.mock.calls.map(([input]) => input).filter((input) => input.kind === kind);

  it("맞는 토큰 → 202 {messageId} — 세션 없이, 문구 아래 원문 블록, 마지막 결과 ok", async () => {
    const { row, token } = addWebhook();
    const res = await hook(token, { payload: "build #12 ok", contentType: "text/plain" });
    expect(res.statusCode, res.body).toBe(202);
    const { messageId } = res.json() as { messageId: string };
    const stored = app.db.select().from(messages).where(eq(messages.id, messageId)).get();
    expect(stored).toMatchObject({
      channelId: row.channelId,
      authorType: "automation",
      authorId: row.id,
      kind: "normal",
      bodyMd: "새 이벤트\n\n```\nbuild #12 ok\n```",
    });
    expect(getAutomation(app.db, app.workspaceId, row.id)).toMatchObject({
      lastStatus: "ok",
      lastRunAt: expect.any(Date),
    });
  });

  it("[Review Focus 2] JSON 타입은 다시 들여 쓴 json 블록, 같은 JSON 이 text/plain·Content-Type 없음으로 오면 원문 그대로", async () => {
    const { row, token } = addWebhook();
    const raw = '{"action":"opened","n":1}';
    for (const contentType of ["application/json; charset=utf-8", "text/plain", undefined]) {
      const res = await hook(token, { payload: raw, ...(contentType === undefined ? {} : { contentType }) });
      expect(res.statusCode, `${contentType}: ${res.body}`).toBe(202);
    }
    expect(postsOf(row.id)).toEqual([
      '새 이벤트\n\n```json\n{\n  "action": "opened",\n  "n": 1\n}\n```',
      `새 이벤트\n\n\`\`\`\n${raw}\n\`\`\``,
      `새 이벤트\n\n\`\`\`\n${raw}\n\`\`\``,
    ]);
  });

  it("[Review Focus 2] 원문에 ``` 가 든 로그 — 펜스가 늘어난 블록 하나", async () => {
    const { row, token } = addWebhook();
    const log = "step 1\n```\nnpm ERR!\n```\nstep 2";
    expect((await hook(token, { payload: log, contentType: "text/plain" })).statusCode).toBe(202);
    expect(postsOf(row.id)).toEqual([`새 이벤트\n\n\`\`\`\`\n${log}\n\`\`\`\``]);
  });

  it("본문이 없으면 문구만", async () => {
    const { row, token } = addWebhook();
    expect((await hook(token)).statusCode).toBe(202);
    expect(postsOf(row.id)).toEqual(["새 이벤트"]);
  });

  it("[필수] 원문은 멘션을 만들지 않는다 — 블록 안의 리터럴 토큰·늘린 펜스 안의 평문 @핸들 모두: 멘션 0·런 0·참여 0", async () => {
    const channel = newChannel();
    const dev = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: `dev${++n}`,
      handle: `dev${n}`,
      name: "Dev",
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: dev.id }, app.logger);
    const mia = await userWithRole(app, `mia${n}`, "member");
    const { token } = addWebhook({ channelId: channel.id, bodyMd: "알림 왔어요" });
    const raw = `log \`\`\` then @${dev.handle} @mia${n} please\n<@a:${dev.id}> <@u:${mia.id}>`;
    const res = await hook(token, { payload: raw, contentType: "text/plain" });
    expect(res.statusCode, res.body).toBe(202);
    const { messageId } = res.json() as { messageId: string };
    const stored = app.db.select().from(messages).where(eq(messages.id, messageId)).get();
    expect(stored?.mentions).toEqual({ agents: [], users: [] });
    expect(app.db.select().from(runs).where(eq(runs.triggerMessageId, messageId)).all()).toEqual([]);
    expect(adapter.calls.send.some((s) => s.message.id === messageId)).toBe(false);
    const members = app.db
      .select()
      .from(channelMembers)
      .where(eq(channelMembers.channelId, channel.id))
      .all();
    expect(members.map((m) => m.memberId)).not.toContain(mia.id);
  });

  describe("404 — 어느 경우인지 드러내지 않는다", () => {
    it("모르는 토큰·한 글자 다른 토큰·꺼짐·예약 종류·재발급 전 옛 토큰은 모두 같은 404 본문, 게시 없음", async () => {
      const live = addWebhook();
      const disabled = addWebhook({ enabled: false });
      const scheduleToken = issueWebhookToken();
      const schedule = addWebhook({
        kind: "schedule",
        scheduleJson: { repeat: "daily", time: "09:00" },
        tokenHash: scheduleToken.hash,
        tokenPrefix: scheduleToken.prefix,
      });
      const rotated = addWebhook();
      const next = issueWebhookToken();
      updateAutomation(app.db, app.workspaceId, rotated.row.id, {
        tokenHash: next.hash,
        tokenPrefix: next.prefix,
      });
      const last = live.token.at(-1) === "A" ? "B" : "A";
      const tokens = [
        issueWebhookToken().raw,
        `${live.token.slice(0, -1)}${last}`,
        live.token.toUpperCase(),
        disabled.token,
        scheduleToken.raw,
        rotated.token,
      ];
      const bodies: string[] = [];
      for (const token of tokens) {
        const res = await hook(token, { payload: "x", contentType: "text/plain" });
        expect(res.statusCode, token).toBe(404);
        bodies.push(res.body);
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0] as string)).toMatchObject({ code: "NOT_FOUND" });
      for (const row of [live.row, disabled.row, schedule.row, rotated.row])
        expect(postsOf(row.id)).toEqual([]);
      expect(getAutomation(app.db, app.workspaceId, disabled.row.id)?.lastStatus).toBeNull();
      // 재발급한 새 토큰은 통한다
      expect((await hook(next.raw)).statusCode).toBe(202);
    });

    it("틀린 토큰만 실패 카운터 — 막힌 주소는 맞는 토큰도 429(bridge_auth_blocked, path webhook), 다른 주소는 통과, 첨부 HTTP 도 같은 카운터", async () => {
      const record = vi.spyOn(app.ops, "record");
      const { row, token } = addWebhook();
      const from = newAddress();
      for (let i = 0; i < MAX_FAILURES; i++) {
        expect((await hook(issueWebhookToken().raw, { from })).statusCode).toBe(404);
      }
      expect(recorded(record, "bridge_auth_blocked")).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ path: "webhook" }) }),
      ]);
      const blocked = await hook(token, { from, payload: "x", contentType: "text/plain" });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(postsOf(row.id)).toEqual([]);
      // 같은 카운터 — 첨부 HTTP 도 그 주소를 막는다
      const attachment = await app.fastify.inject({
        method: "GET",
        url: `/bridge/attachments/${uuid()}`,
        remoteAddress: from,
        headers: { authorization: "Bearer dbt_x" },
      });
      expect(attachment.statusCode).toBe(429);
      expect((await hook(token, { payload: "x", contentType: "text/plain" })).statusCode).toBe(202);
    });

    it("꺼짐·예약 종류의 404 는 실패로 세지 않는다 — 몇 번이어도 그 주소의 맞는 토큰은 통한다", async () => {
      const disabled = addWebhook({ enabled: false });
      const scheduleToken = issueWebhookToken();
      addWebhook({
        kind: "schedule",
        scheduleJson: { repeat: "daily", time: "09:00" },
        tokenHash: scheduleToken.hash,
        tokenPrefix: scheduleToken.prefix,
      });
      const { token } = addWebhook();
      const from = newAddress();
      for (let i = 0; i < MAX_FAILURES * 2; i++) {
        expect((await hook(disabled.token, { from })).statusCode).toBe(404);
        expect((await hook(scheduleToken.raw, { from })).statusCode).toBe(404);
      }
      expect((await hook(token, { from })).statusCode).toBe(202);
    });
  });

  it("토큰마다 분당 상한 — 넘으면 429·사건 ratelimit, 다른 토큰은 통과, 1분 뒤 다시 통과", async () => {
    const record = vi.spyOn(app.ops, "record");
    const first = addWebhook();
    const second = addWebhook();
    for (let i = 0; i < PER_MIN; i++) expect((await hook(first.token)).statusCode).toBe(202);
    const limited = await hook(first.token, { payload: "x", contentType: "text/plain" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(postsOf(first.row.id)).toHaveLength(PER_MIN);
    expect(recorded(record, "ratelimit")).toEqual([
      expect.objectContaining({ key: "rest:/hooks/:token", severity: "info" }),
    ]);
    expect((await hook(second.token)).statusCode).toBe(202);
    clock += 60_000;
    expect((await hook(first.token)).statusCode).toBe(202);
  });

  it("[Review Focus 5] 보관한 채널 → 409 CHANNEL_ARCHIVED — 게시 없음, 마지막 결과 error·사건 automation_failed(code)", async () => {
    const record = vi.spyOn(app.ops, "record");
    const channel = newChannel();
    const { row, token } = addWebhook({ channelId: channel.id });
    app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, channel.id)).run();
    const res = await hook(token, { payload: "x", contentType: "text/plain" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "CHANNEL_ARCHIVED" });
    expect(postsOf(row.id)).toEqual([]);
    expect(getAutomation(app.db, app.workspaceId, row.id)?.lastStatus).toBe("error");
    expect(recorded(record, "automation_failed")).toEqual([
      expect.objectContaining({
        key: `automation:${row.id}`,
        detail: { automationId: row.id, code: "CHANNEL_ARCHIVED" },
      }),
    ]);
  });

  it("GET 은 서버의 404 JSON — infra/check-caddy.sh 가 /hooks/* 가 서버까지 가는지 이것으로 본다", async () => {
    const { token } = addWebhook();
    for (const path of ["/hooks/whk_nope", `/hooks/${token}`]) {
      const res = await app.fastify.inject({ method: "GET", url: path, remoteAddress: newAddress() });
      expect(res.statusCode, path).toBe(404);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
    }
  });

  describe("본문 64 KiB", () => {
    it("64 KiB 는 받고 1바이트 넘으면 413 — 게시 없음", async () => {
      const { row, token } = addWebhook();
      expect((await hook(token, { payload: "a".repeat(KIB64), contentType: "text/plain" })).statusCode).toBe(
        202,
      );
      const over = await hook(token, { payload: "a".repeat(KIB64 + 1), contentType: "text/plain" });
      expect(over.statusCode).toBe(413);
      expect(postsOf(row.id)).toHaveLength(1);
    });

    it("틀린 토큰은 본문 크기보다 먼저 404 — 큰 본문으로 토큰 유무를 가늠하지 못한다", async () => {
      const res = await hook(issueWebhookToken().raw, {
        payload: "a".repeat(KIB64 + 1),
        contentType: "application/json",
      });
      expect(res.statusCode).toBe(404);
    });

    it("[PA5] 파서·상한은 이 경로에만 — /api 의 JSON 은 객체로 파싱되고 64 KiB 를 넘어도 413 이 아니다", async () => {
      const { headers } = await login(app);
      const big = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/automations",
        headers,
        payload: {
          kind: "webhook",
          name: "큰 문구",
          channelId: newChannel().id,
          bodyMd: "a".repeat(100 * 1024),
        },
      });
      expect(big.statusCode, big.body).toBe(400);
      expect(big.json()).toMatchObject({ code: "VALIDATION" });
      expect(big.body).toContain("bodyMd");
      const ok = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers,
        payload: { name: `json-${++n}` },
      });
      expect(ok.statusCode, ok.body).toBe(201);
    });
  });
});
