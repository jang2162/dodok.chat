import { SEARCH_SNIPPET_CLOSE, SEARCH_SNIPPET_OPEN, SearchResult } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import type { App } from "../src/app";
import { opsEvents } from "../src/db/schema.sqlite";
import { LIMITS } from "../src/modules/ops/limits";
import { createAutomationMessage, createUserMessage } from "../src/modules/messages/service";
import { bootTestApp, login } from "./helpers/app";
import { channelConversation } from "./helpers/seed";

describe("GET /api/v1/search (스펙 5.2)", () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function boot(clock?: { t: number }) {
    app = await bootTestApp({}, clock ? { limitClock: () => clock.t } : {});
    const { headers } = await login(app);
    const res = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/channels",
      headers,
      payload: { name: "search" },
    });
    const channelId = res.json().channel.id as string;
    let n = 0;
    const say = (bodyMd: string) =>
      createUserMessage((app as App).db, (app as App).bus, {
        conversationId: channelConversation((app as App).db, channelId),
        authorId: (app as App).ownerUserId,
        bodyMd,
        clientMsgId: `s${n++}`,
      });
    const search = (query: string, h: Record<string, string> = headers) =>
      (app as App).fastify.inject({ method: "GET", url: `/api/v1/search?${query}`, headers: h });
    return { app, headers, channelId, say, search };
  }

  it("찾은 것을 SearchResult 로 돌려준다", async () => {
    const t = await boot();
    const m = t.say("배포를 마쳤다");
    const res = await t.search(`q=${encodeURIComponent("마쳤다")}&channelId=${t.channelId}`);
    expect(res.statusCode).toBe(200);
    const body = SearchResult.parse(res.json());
    expect(body).toEqual({
      hits: [
        expect.objectContaining({
          messageId: m.id,
          channelId: t.channelId,
          authorType: "user",
          snippet: `배포를 ${SEARCH_SNIPPET_OPEN}마쳤다${SEARCH_SNIPPET_CLOSE}`,
        }),
      ],
      limited: false,
    });
  });

  it("authorType=automation 이면 자동화 글만 나온다", async () => {
    const t = await boot();
    const mine = t.say("점검 알림 사람");
    const auto = createAutomationMessage(t.app.db, t.app.bus, {
      conversationId: channelConversation(t.app.db, t.channelId),
      automationId: "01a09fc9-d204-7551-89d6-38544d07a1f1",
      bodyMd: "점검 알림 자동화",
    });
    const ids = async (query: string) =>
      SearchResult.parse((await t.search(query)).json()).hits.map((h) => h.messageId);
    const q = `q=${encodeURIComponent("점검 알림")}`;
    expect(await ids(`${q}&authorType=automation`)).toEqual([auto.id]);
    expect(await ids(`${q}&authorType=user`)).toEqual([mine.id]);
    const all = await ids(q);
    expect(all).toHaveLength(2);
    expect(new Set(all)).toEqual(new Set([mine.id, auto.id]));
  });

  it("q 앞뒤 공백은 걷는다", async () => {
    const t = await boot();
    const m = t.say("앞뒤공백검사");
    const res = await t.search(`q=${encodeURIComponent("  공백검사  ")}`);
    expect(res.json().hits.map((h: { messageId: string }) => h.messageId)).toEqual([m.id]);
  });

  it("2글자는 limited: true", async () => {
    const t = await boot();
    t.say("배포 완료");
    const res = await t.search(`q=${encodeURIComponent("배포")}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ limited: true, hits: [expect.any(Object)] });
  });

  it.each([
    ["1글자", "가"],
    ["이모지 하나", "😀"],
    ["공백만 남는 2글자", "  a  "],
    ["201자", "가".repeat(201)],
    ["NUL 이 든 것", "ab\u0000c"],
  ])("q %s → 400 VALIDATION", async (_label, q) => {
    const t = await boot();
    const res = await t.search(`q=${encodeURIComponent(q)}`);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "VALIDATION" });
  });

  it("q 200자는 통과한다", async () => {
    const t = await boot();
    expect((await t.search(`q=${encodeURIComponent("가".repeat(200))}`)).statusCode).toBe(200);
  });

  it("q 없음·잘못된 authorType·날짜·커서 → 400", async () => {
    const t = await boot();
    for (const query of [
      "",
      "q=abc&authorType=system",
      "q=abc&from=2026-13-01",
      `q=abc&cursor=${encodeURIComponent("망가진")}`,
    ]) {
      const res = await t.search(query);
      expect([query, res.statusCode]).toEqual([query, 400]);
    }
  });

  it.each(['"', "%", "_", "*", "OR", "NEAR(", "body:", "abc OR def", 'NEAR("a" "b")', "col:x*"])(
    "연산자·특수 문자 %s 로 500 이 나지 않는다",
    async (q) => {
      const t = await boot();
      t.say(`앞 ${q} 뒤`);
      const res = await t.search(`q=${encodeURIComponent(q.length < 2 ? `${q}${q}` : q)}`);
      expect(res.statusCode).toBe(200);
      SearchResult.parse(res.json());
    },
  );

  it("익명은 401", async () => {
    const t = await boot();
    const res = await t.search("q=abc", {});
    expect(res.statusCode).toBe(401);
  });

  it(`사용자당 분당 ${LIMITS.searchPerMin} — 넘으면 429, 1분 뒤 다시 된다, REST 는 막히지 않는다`, async () => {
    const clock = { t: 1_000_000 };
    const t = await boot(clock);
    for (let i = 0; i < LIMITS.searchPerMin; i++) expect((await t.search("q=abc")).statusCode).toBe(200);
    const limited = await t.search("q=abc");
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ code: "RATE_LIMITED" });
    const channels = await t.app.fastify.inject({
      method: "GET",
      url: "/api/v1/channels",
      headers: t.headers,
    });
    expect(channels.statusCode).toBe(200);
    const rows = t.app.db.select().from(opsEvents).where(eq(opsEvents.kind, "ratelimit")).all();
    expect(rows.map((r) => r.key)).toEqual(["rest:/api/v1/search"]);
    clock.t += 60_000;
    expect((await t.search("q=abc")).statusCode).toBe(200);
  });
});
