/**
 * 웹훅 수신(자동화 스펙 「웹훅」 장) — POST /hooks/<token> 은 세션 없이 토큰만 본다. 틀린 토큰·꺼짐·예약 종류는 모두 같은 404(틀린 토큰만
 * 실패 카운터 — 웹훅 전용 BridgeAuthGuard, 막힌 주소에서도 맞는 토큰은 통과), 토큰마다 분당 상한, 본문 64 KiB. 파서·본문 상한은 이 경로에만
 * 걸린다(계획 판정 PA5). 앱 로그는 모아 두고 토큰 원문이 없는지 본다(리뷰 I1)
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Message } from "@dodok/shared";
import { and, eq } from "drizzle-orm";
import { Readable } from "node:stream";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, type MockInstance, vi } from "vitest";
import type { App } from "../src/app";
import { channelMembers, channels, messages, opsEvents, runs } from "../src/db/schema.sqlite";
import { createLogger } from "../src/logger";
import { createAgent } from "../src/modules/agents/service";
import {
  deleteAutomation,
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
  /** 앱 로그 줄(trace 까지) — 사례는 자기가 보낸 요청 뒤의 줄만 본다 */
  const logLines: string[] = [];

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp(
      {},
      {
        logger: createLogger("trace", { write: (line: string) => void logLines.push(line) }),
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

    it("틀린 토큰만 실패 카운터 — 막힌 주소는 모르는 토큰·꺼진 토큰이 같은 429(bridge_auth_blocked, path webhook), 맞는 토큰은 통과", async () => {
      const record = vi.spyOn(app.ops, "record");
      const { row, token } = addWebhook();
      const disabled = addWebhook({ enabled: false });
      const from = newAddress();
      for (let i = 0; i < MAX_FAILURES; i++) {
        expect((await hook(issueWebhookToken().raw, { from })).statusCode).toBe(404);
      }
      expect(recorded(record, "bridge_auth_blocked")).toEqual([
        expect.objectContaining({ detail: expect.objectContaining({ path: "webhook" }) }),
      ]);
      const unknown = await hook(issueWebhookToken().raw, { from });
      const off = await hook(disabled.token, { from });
      expect([unknown.statusCode, off.statusCode]).toEqual([429, 429]);
      expect(unknown.json()).toMatchObject({ code: "RATE_LIMITED" });
      expect(off.body).toBe(unknown.body);
      // GitHub 같은 서비스는 발신 주소를 여러 고객이 나눠 쓴다 — 남의 틀린 토큰이 이 워크스페이스의 정상 웹훅을 막지 않는다
      const res = await hook(token, { from, payload: "x", contentType: "text/plain" });
      expect(res.statusCode, res.body).toBe(202);
      expect(postsOf(row.id)).toEqual(["새 이벤트\n\n```\nx\n```"]);
    });

    it("웹훅 실패 카운터는 웹훅 전용 — 웹훅에서 막힌 주소도 첨부 HTTP 는 막히지 않는다(429 가 아니라 틀린 토큰의 401)", async () => {
      const from = newAddress();
      for (let i = 0; i < MAX_FAILURES; i++) {
        expect((await hook(issueWebhookToken().raw, { from })).statusCode).toBe(404);
      }
      expect((await hook(issueWebhookToken().raw, { from })).statusCode).toBe(429);
      const attachment = await app.fastify.inject({
        method: "GET",
        url: `/bridge/attachments/${uuid()}`,
        remoteAddress: from,
        headers: { authorization: "Bearer dbt_x" },
      });
      expect(attachment.statusCode).toBe(401);
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

  it("GET 은 서버의 404 JSON — scripts/check-deploy.sh 가 /hooks/* 가 서버까지 가는지 이것으로 본다", async () => {
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

  describe("[M2] 본문을 받는 동안 바뀐 자동화 — 게시 직전에 다시 읽는다", () => {
    /** 토큰 확인(onRequest) 뒤 Fastify 가 본문을 읽기 시작할 때 change() 를 부르고 나서야 본문을 보내는 스트림 */
    const lateBody = (payload: string, change: () => void) => {
      let sent = false;
      return new Readable({
        read() {
          if (sent) return;
          sent = true;
          change();
          this.push(payload);
          this.push(null);
        },
      });
    };
    const hookLate = (token: string, change: () => void) =>
      app.fastify.inject({
        method: "POST",
        url: `/hooks/${token}`,
        remoteAddress: newAddress(),
        headers: { "content-type": "text/plain" },
        payload: lateBody("late", change),
      });

    it.each<[string, (id: string) => void]>([
      ["끄기", (id) => void updateAutomation(app.db, app.workspaceId, id, { enabled: false })],
      [
        "토큰 재발급(유출 대응)",
        (id) => {
          const next = issueWebhookToken();
          updateAutomation(app.db, app.workspaceId, id, { tokenHash: next.hash, tokenPrefix: next.prefix });
        },
      ],
      ["삭제", (id) => deleteAutomation(app.db, app.workspaceId, id)],
    ])("%s → 모르는 토큰과 같은 404, 게시 없음", async (_label, change) => {
      const { row, token } = addWebhook();
      const unknown = await hook(issueWebhookToken().raw);
      const res = await hookLate(token, () => change(row.id));
      expect(res.statusCode, res.body).toBe(404);
      expect(res.body).toBe(unknown.body);
      expect(postsOf(row.id)).toEqual([]);
    });

    it("게시하는 동안(라우터를 기다리는 사이) 지워지면 게시는 남고 202 — 결과를 남길 행이 없어도 던지지 않는다", async () => {
      const { row, token } = addWebhook();
      const route = app.services.router.routeMessage.bind(app.services.router);
      vi.spyOn(app.services.router, "routeMessage").mockImplementationOnce(async (message) => {
        deleteAutomation(app.db, app.workspaceId, row.id);
        await route(message);
      });
      const res = await hook(token, { payload: "x", contentType: "text/plain" });
      expect(res.statusCode, res.body).toBe(202);
      expect(postsOf(row.id)).toHaveLength(1);
    });

    it("게시하는 동안 지워지고 라우터가 던져도 202 — 결과 쓰기의 NOT_FOUND 로도, 500 으로도 바뀌지 않는다", async () => {
      const { row, token } = addWebhook();
      vi.spyOn(app.services.router, "routeMessage").mockImplementationOnce(async () => {
        deleteAutomation(app.db, app.workspaceId, row.id);
        throw new Error("route failed");
      });
      const res = await hook(token, { payload: "x", contentType: "text/plain" });
      expect(res.statusCode, res.body).toBe(202);
      expect(postsOf(row.id)).toHaveLength(1);
    });

    it("라우터가 던지면(글은 저장된 뒤) 202 {messageId} 와 결과 error·사건 — 보낸 쪽이 다시 보내 같은 글이 두 번 오르지 않게", async () => {
      const record = vi.spyOn(app.ops, "record");
      const { row, token } = addWebhook();
      vi.spyOn(app.services.router, "routeMessage").mockImplementationOnce(async () => {
        throw new Error("route failed");
      });
      const res = await hook(token, { payload: "x", contentType: "text/plain" });
      expect(res.statusCode, res.body).toBe(202);
      const { messageId } = res.json() as { messageId: string };
      expect(app.db.select().from(messages).where(eq(messages.id, messageId)).get()?.authorId).toBe(row.id);
      expect(postsOf(row.id)).toHaveLength(1);
      expect(getAutomation(app.db, app.workspaceId, row.id)?.lastStatus).toBe("error");
      expect(recorded(record, "automation_failed")).toEqual([
        expect.objectContaining({ key: `automation:${row.id}`, detail: { automationId: row.id } }),
      ]);
    });

    it("바뀐 것이 없으면 그대로 게시한다", async () => {
      const { row, token } = addWebhook();
      let changed = 0;
      const res = await hookLate(token, () => void changed++);
      expect(res.statusCode, res.body).toBe(202);
      expect(changed).toBe(1);
      expect(postsOf(row.id)).toEqual(["새 이벤트\n\n```\nlate\n```"]);
    });
  });

  describe("[L1] 본문 바이트", () => {
    const hookBytes = (token: string, payload: Buffer, contentType?: string) =>
      app.fastify.inject({
        method: "POST",
        url: `/hooks/${token}`,
        remoteAddress: newAddress(),
        headers: contentType === undefined ? {} : { "content-type": contentType },
        payload,
      });

    it("UTF-8 이 아닌 바이트는 U+FFFD 로 바꿔 받는다 — 타입과 무관(Latin-1 텍스트·바이너리·타입 없음)", async () => {
      const { row, token } = addWebhook();
      const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // Latin-1 의 "café"
      for (const contentType of ["text/plain; charset=iso-8859-1", "application/octet-stream", undefined]) {
        const res = await hookBytes(token, latin1, contentType);
        expect(res.statusCode, `${contentType}: ${res.body}`).toBe(202);
      }
      expect(postsOf(row.id)).toEqual(Array(3).fill("새 이벤트\n\n```\ncaf\uFFFD\n```"));
    });

    it("상한은 받은 바이트로 잰다 — 잘못된 바이트 22,000개(바꾸면 66 KB)도 202, 블록은 8,000자에서 자른다", async () => {
      const { row, token } = addWebhook();
      const res = await hookBytes(token, Buffer.alloc(22_000, 0xff), "text/plain");
      expect(res.statusCode, res.body).toBe(202);
      expect(postsOf(row.id)).toEqual([`새 이벤트\n\n\`\`\`\n${"\uFFFD".repeat(8000)}…(잘림)\n\`\`\``]);
    });

    it("앞의 UTF-8 BOM 은 뗀다 — BOM 이 붙은 JSON 도 다시 들여 쓴 json 블록", async () => {
      const { row, token } = addWebhook();
      const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
      expect((await hookBytes(token, withBom, "application/json")).statusCode).toBe(202);
      expect(postsOf(row.id)).toEqual(['새 이벤트\n\n```json\n{\n  "a": 1\n}\n```']);
    });

    it("틀린 꼴의 media type 은 Fastify 의 415 — 토큰 확인 뒤라 모르는 토큰은 그대로 404", async () => {
      const { row, token } = addWebhook();
      for (const contentType of [";;;", "garbage"]) {
        expect((await hook(token, { payload: "x", contentType })).statusCode, contentType).toBe(415);
        expect((await hook(issueWebhookToken().raw, { payload: "x", contentType })).statusCode).toBe(404);
      }
      expect(postsOf(row.id)).toEqual([]);
    });
  });

  it("[I1] 토큰 원문은 어떤 로그 줄·운영 사건에도 없다 — 202·404·409·413·415·429·막힘, 쿼리, 라우트 없는 꼴(GET·끝 슬래시·대문자·인코딩한 슬래시)", async () => {
    const from = logLines.length;
    const tokens: string[] = [];
    const add = (over: Partial<NewAutomationRow> = {}) => {
      const webhook = addWebhook(over);
      tokens.push(webhook.token);
      return webhook;
    };
    const unknownToken = () => {
      const raw = issueWebhookToken().raw;
      tokens.push(raw);
      return raw;
    };
    const status = async (res: Promise<{ statusCode: number }>) => (await res).statusCode;
    const live = add();
    const archivedChannel = newChannel();
    const archived = add({ channelId: archivedChannel.id });
    app.db.update(channels).set({ archivedAt: new Date() }).where(eq(channels.id, archivedChannel.id)).run();
    const limited = add();

    expect(await status(hook(live.token, { payload: '{"a":1}', contentType: "application/json" }))).toBe(202);
    const withQuery = app.fastify.inject({
      method: "POST",
      url: `/hooks/${live.token}?delivery=1`,
      remoteAddress: newAddress(),
    });
    expect(await status(withQuery)).toBe(202);
    expect(await status(hook(add({ enabled: false }).token))).toBe(404);
    expect(await status(hook(unknownToken()))).toBe(404);
    expect(await status(hook(archived.token, { payload: "x", contentType: "text/plain" }))).toBe(409);
    expect(
      await status(hook(add().token, { payload: "a".repeat(KIB64 + 1), contentType: "text/plain" })),
    ).toBe(413);
    expect(await status(hook(add().token, { payload: "x", contentType: ";;;" }))).toBe(415);
    for (let i = 0; i < PER_MIN; i++) await hook(limited.token);
    expect(await status(hook(limited.token))).toBe(429);
    const blocked = newAddress();
    for (let i = 0; i < MAX_FAILURES; i++) await hook(unknownToken(), { from: blocked });
    expect(await status(hook(unknownToken(), { from: blocked }))).toBe(429);
    for (const [method, url] of [
      ["GET", `/hooks/${live.token}`],
      ["POST", `/hooks/${live.token}/`],
      ["POST", `/HOOKS/${live.token}`],
      ["POST", `/hooks%2F${live.token}`],
    ] as const) {
      expect(await status(app.fastify.inject({ method, url, remoteAddress: newAddress() })), url).toBe(404);
    }
    // 다른 경로의 url 은 그대로 남는다
    await app.fastify.inject({ method: "GET", url: "/api/v1/channels?probe=1", remoteAddress: newAddress() });

    const logged = logLines.slice(from).join("\n");
    const events = JSON.stringify(app.db.select().from(opsEvents).all());
    // 보이는 앞 10자(whk_ + 6자) 뒤가 원문에서만 나오는 부분이다
    for (const raw of tokens) {
      expect(logged.split(raw.slice(10)).length - 1, raw).toBe(0);
      expect(events.includes(raw.slice(10)), raw).toBe(false);
    }
    // 줄이 없어서 0 번이 아니다 — 가린 꼴이 실제 줄에 있다
    const shown = `${live.token.slice(0, 10)}…`;
    expect(logged).toContain(`"url":"/hooks/${shown}"`);
    expect(logged).toContain(`"url":"/hooks/${shown}?delivery=1"`);
    expect(logged).toContain(`Route GET:/hooks/${shown} not found`);
    expect(logged).toContain(`Route POST:/hooks%2F${shown} not found`);
    expect(logged).toContain('"msg":"request completed"');
    expect(logged).toContain('"msg":"automation post failed"');
    expect(logged).toContain('"url":"/api/v1/channels?probe=1"');
  });
});
