/**
 * 에이전트 DM 통합 시나리오 — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + 사람마다 wire 클라이언트.
 * 에이전트 DM 스펙 「완료 기준」 1~4 를 흐름 하나씩 REST·wire·검색·읽지 않음·푸시·운영 표·제어 도구(`/mcp`)를 지나며 돈다.
 * 사람은 owner(로컬 토큰)·admin ada·member mia(DM 주인)·member kim 넷, 에이전트는 dev(dmAccess everyone) 하나.
 */
import {
  type Agent,
  type Approval,
  type Channel,
  type Conversation,
  type DmList,
  type Message,
  OPS_DM_ROW_ID,
  type OpsRunsSummary,
  PushPayload,
  type SearchResult,
  type UnreadSnapshot,
} from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppDeps } from "../../src/app";
import { issuePersonalToken } from "../../src/modules/tokens/service";
import { createScenario, type Scenario, type ScenarioScript } from "../fakes/scenario";
import { userWithRole } from "../helpers/app";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { recordWire, WAIT_MS, type WireLog } from "../helpers/scenario-steps";
import { connectWire, type WireClient } from "../helpers/wire";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 20_000 });

const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};
const MCP_ACCEPT = "application/json, text/event-stream";

type Person = { id: string; token: string; headers: { authorization: string } };
type Sent = { endpoint: string; payload: PushPayload };

describe("에이전트 DM 통합 — 완료 기준 1~4", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  let sent: Sent[];
  let scenario: Scenario;
  let deliveries: Array<{ dm?: { ownerHandle: string }; participants: string[]; conversationId: string }>;
  let owner: Person;
  let ada: Person;
  let mia: Person;
  let kim: Person;
  let dev: Agent;

  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub, body) => {
    sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(body)) });
    return { statusCode: 201 };
  };

  async function person(handle: string, role: string): Promise<Person> {
    const { id, token } = await userWithRole(live.app, handle, role);
    return { id, token, headers: { authorization: `Bearer ${token}` } };
  }

  /** 대본 — 기본은 받은 글을 되말하는 답. 테스트가 `next` 로 다음 한 턴만 바꾼다 */
  let next: ScenarioScript | undefined;

  async function boot() {
    sent = [];
    deliveries = [];
    next = undefined;
    live = await bootLiveApp({ deps: { pushSend } });
    owner = { id: live.app.ownerUserId, token: live.auth.token, headers: live.auth.headers };
    ada = await person("ada", "admin");
    mia = await person("mia", "member");
    kim = await person("kim", "member");
    const registered = await as(owner, "POST", "/agents", {
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
      gatewayId: live.gatewayId,
    });
    expect(registered.status).toBe(201);
    dev = (registered.body as { agent: Agent }).agent;
    expect((await as(ada, "PATCH", `/agents/${dev.id}`, { dmAccess: "everyone" })).status).toBe(200);
    scenario = createScenario({
      gateway: live.gateway,
      plugin: live.plugin,
      agents: {
        dev: ({ delivery }) => {
          deliveries.push({
            ...(delivery.dm ? { dm: delivery.dm } : {}),
            participants: delivery.context.participants.map((p) => p.handle),
            conversationId: delivery.conversationId,
          });
          const script = next ?? { reply: `받았어요: ${delivery.message.text}` };
          next = undefined;
          return script;
        },
      },
    });
  }

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    expect(scenario.errors).toEqual([]);
    await live.close();
  });

  async function as<T = unknown>(
    who: Person,
    method: "GET" | "POST" | "PATCH",
    url: string,
    payload?: object,
  ): Promise<{ status: number; body: T }> {
    const res = await live.app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers: who.headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return { status: res.statusCode, body: (res.body === "" ? undefined : res.json()) as T };
  }

  /** 그 사람의 소켓 — 붙은 순간부터 받은 서버 이벤트를 모두 기록한다 */
  async function wireOf(who: Person): Promise<WireLog> {
    const socket = await connectWire(live.app, who.token);
    sockets.push(socket);
    return recordWire(socket);
  }

  async function openDm(who: Person): Promise<Channel> {
    const res = await as<{ channel: Channel }>(who, "POST", "/dms", { agentId: dev.id });
    expect(res.status).toBe(200);
    return res.body.channel;
  }

  /** 새 세션으로 보내고 dev 의 답까지 — 그 세션을 돌려준다 */
  async function newSession(log: WireLog, dm: Channel, text: string): Promise<Conversation> {
    const res = await log.socket.emitWithAck("message.send", {
      channelId: dm.id,
      newConversation: {},
      clientMsgId: randomUUID(),
      bodyMd: text,
    });
    if (!res.ok) throw new Error(`message.send → ${res.error.code}`);
    const conversation = res.data.conversation as Conversation;
    await agentReplyIn(log, conversation.id);
    return conversation;
  }

  async function sendIn(log: WireLog, dm: Channel, conversationId: string, text: string) {
    return log.socket.emitWithAck("message.send", {
      channelId: dm.id,
      conversationId,
      clientMsgId: randomUUID(),
      bodyMd: text,
    });
  }

  const agentReplyIn = (log: WireLog, conversationId: string, after = 0): Promise<Message> =>
    log.until(
      () => log.created.filter((m) => m.conversationId === conversationId && m.authorType === "agent")[after],
      `dev 답 ${after}(${conversationId})`,
    );

  /** 가짜 발송기는 wire 이벤트가 아니다 — 짧게 되풀이해 본다 */
  async function untilSent(n: number, what: string): Promise<Sent[]> {
    const deadline = Date.now() + WAIT_MS;
    while (sent.length < n) {
      if (Date.now() > deadline) throw new Error(`${what}: 발송 ${n}건을 기다렸는데 ${sent.length}건`);
      await new Promise((r) => setTimeout(r, 10));
    }
    return sent;
  }

  async function subscribePush(who: Person, endpoint: string) {
    const res = await as(who, "POST", "/push/subscriptions", { endpoint, keys: KEYS });
    expect(res.status).toBe(204);
  }

  async function mcpTool(who: Person, name: string, args: object) {
    const raw = issuePersonalToken(live.app.db, who.id, `t-${randomUUID().slice(0, 8)}`).raw;
    const res = await live.app.fastify.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: MCP_ACCEPT, "content-type": "application/json", authorization: `Bearer ${raw}` },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    expect(res.statusCode).toBe(200);
    const result = (res.json() as { result?: { content?: Array<{ text: string }>; isError?: boolean } })
      .result;
    return { isError: result?.isError === true, value: JSON.parse(result?.content?.[0]?.text ?? "null") };
  }

  it("기준 1 — member 가 허용된 에이전트와 DM 을 열고 세션 셋을 만들어, 목록·검색으로 둘째 세션을 다시 연다", async () => {
    await boot();
    const dm = await openDm(mia);
    expect(dm).toMatchObject({ kind: "dm", dmOwnerId: mia.id, dmAgentId: dev.id });
    const log = await wireOf(mia);
    expect((await log.socket.emitWithAck("channel.subscribe", { channelId: dm.id })).ok).toBe(true);

    const first = await newSession(log, dm, "사과 이야기부터 할게요");
    const second = await newSession(log, dm, "바나나 키우는 법이 궁금해요");
    const third = await newSession(log, dm, "체리 수확 시기는요?");

    // 에이전트는 DM 런마다 헤더의 DM 줄 재료(주인 핸들)를 받고, 참여자는 주인과 그 에이전트뿐이다
    expect(deliveries).toHaveLength(3);
    for (const d of deliveries) {
      expect(d.dm).toEqual({ ownerHandle: "mia" });
      expect([...d.participants].sort()).toEqual(["dev", "mia"]);
    }
    expect(deliveries.map((d) => d.conversationId)).toEqual([first.id, second.id, third.id]);

    // 목록 — 최근 활동순, 셋 다
    const listed = await as<{ conversations: Conversation[] }>(
      mia,
      "GET",
      `/channels/${dm.id}/conversations?status=open`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.conversations.map((c) => c.id)).toEqual([third.id, second.id, first.id]);
    const { dms } = (await as<DmList>(mia, "GET", "/dms")).body;
    expect(dms.map((d) => d.channel.id)).toEqual([dm.id]);
    expect(dms[0]?.readOnlyReason).toBeNull();

    // 검색 — 둘째 세션의 글이 걸리고, 결과의 세션으로 그 세션을 다시 연다
    const found = await as<SearchResult>(mia, "GET", `/search?q=${encodeURIComponent("바나나")}`);
    expect(found.status).toBe(200);
    const hit = found.body.hits.find((h) => h.channelId === dm.id && h.conversationId === second.id);
    expect(hit).toBeDefined();
    const reopened = await as<{ messages: Message[] }>(mia, "GET", `/conversations/${second.id}/messages`);
    expect(reopened.status).toBe(200);
    expect(reopened.body.messages.map((m) => [m.authorType, m.bodyMd])).toEqual([
      ["user", "바나나 키우는 법이 궁금해요"],
      ["agent", "받았어요: 바나나 키우는 법이 궁금해요"],
    ]);
    // 제목 검색으로도 — 그 DM 안으로 거른 세션 목록
    const byTitle = await as<{ conversations: Conversation[] }>(
      mia,
      "GET",
      `/channels/${dm.id}/conversations?q=${encodeURIComponent("바나나")}`,
    );
    expect(byTitle.body.conversations.map((c) => c.id)).toEqual([second.id]);

    // 다시 연 세션에 이어 쓰면 그 세션의 에이전트 세션으로 간다
    const more = await sendIn(log, dm, second.id, "물은 얼마나 줘요?");
    expect(more.ok).toBe(true);
    await agentReplyIn(log, second.id, 1);
    expect(deliveries.at(-1)?.conversationId).toBe(second.id);
  });

  it("기준 2 — owner·admin·다른 member 는 mia 의 DM 을 REST·wire·검색·읽지 않음·푸시·운영 표·제어 도구 어디에서도 못 본다", async () => {
    await boot();
    const others = { owner, ada, kim };
    for (const [name, who] of Object.entries({ ...others, mia }))
      await subscribePush(who, `https://push.invalid/${name}`);
    const othersLogs = await Promise.all(Object.values(others).map((who) => wireOf(who)));
    // DM 을 만들기 전부터 셋이 받은 이벤트를 모두 담는다 — channel.created·conversation.created 도 창 안에 든다.
    // 무엇이 DM 것인지는 id 가 정해진 뒤 끝에서 거른다
    const heard: Array<{ event: string; text: string }> = [];
    for (const other of othersLogs)
      other.socket.onAny((event: string, payload: unknown) => {
        heard.push({ event, text: JSON.stringify(payload ?? null) });
      });

    const dm = await openDm(mia);
    const log = await wireOf(mia);
    expect((await log.socket.emitWithAck("channel.subscribe", { channelId: dm.id })).ok).toBe(true);
    const session = await newSession(log, dm, "비밀 프로젝트 오로라 이야기");
    const reply = await agentReplyIn(log, session.id);
    expect(reply.runId).toBeDefined();
    const runId = reply.runId as string;

    // 푸시 — 정본 답은 주인 기기로만(제목·본문에 내용 없음)
    await untilSent(1, "DM 답 푸시");
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.map((s) => s.endpoint)).toEqual(["https://push.invalid/mia"]);
    expect(sent[0]?.payload).toMatchObject({
      title: "@dev가 답했습니다",
      body: "DM",
      tag: `dm:${session.id}`,
    });

    for (const [name, who] of Object.entries(others)) {
      const ctx = `${name}:`;
      // REST — 목록에 없고, id 로 닿아도 없는 것과 같은 404
      const channels = await as<{ channels: Channel[] }>(who, "GET", "/channels");
      expect(
        channels.body.channels.map((c) => c.id),
        ctx,
      ).not.toContain(dm.id);
      expect((await as<DmList>(who, "GET", "/dms")).body.dms, ctx).toEqual([]);
      for (const url of [
        `/channels/${dm.id}`,
        `/channels/${dm.id}/conversations`,
        `/channels/${dm.id}/members`,
        `/channels/${dm.id}/runs`,
        `/conversations/${session.id}`,
        `/conversations/${session.id}/messages`,
        `/runs/${runId}`,
        `/runs/${runId}/events`,
      ]) {
        const res = await as<{ code: string }>(who, "GET", url);
        expect([res.status, res.body.code], `${ctx} GET ${url}`).toEqual([404, "NOT_FOUND"]);
      }
      // 역할 정책이 있는 쓰기도 403 이 아니라 404(Review Focus 1)
      const patch = await as<{ code: string }>(who, "PATCH", `/channels/${dm.id}`, { prompt: "엿보기" });
      expect([patch.status, patch.body.code], `${ctx} PATCH`).toEqual([404, "NOT_FOUND"]);
      // 검색·읽지 않음 — DM 본문이 걸리지 않고 그 대화가 현황에 없다
      const search = await as<SearchResult>(who, "GET", `/search?q=${encodeURIComponent("오로라")}`);
      expect(search.body.hits, ctx).toEqual([]);
      const unread = await as<UnreadSnapshot>(who, "GET", "/me/unread");
      expect(
        unread.body.conversations.map((c) => c.channelId),
        ctx,
      ).not.toContain(dm.id);
      expect(unread.body.channels, ctx).not.toContain(dm.id);
      // 제어 도구(바깥 MCP) — 목록·검색에 없고 id 로 읽으면 NOT_FOUND
      const listed = await mcpTool(who, "list_channels", {});
      expect(listed.isError, `${ctx} list_channels`).toBe(false);
      expect(JSON.stringify(listed.value), ctx).not.toContain(dm.id);
      const searched = await mcpTool(who, "search_messages", { q: "오로라" });
      expect(searched.isError, `${ctx} search_messages`).toBe(false);
      expect(JSON.stringify(searched.value), ctx).not.toContain("오로라");
      for (const [tool, args] of [
        ["get_channel", { channelId: dm.id }],
        ["list_conversations", { channelId: dm.id }],
        ["read_messages", { conversationId: session.id }],
        ["get_run", { runId }],
      ] as const) {
        const res = await mcpTool(who, tool, args);
        expect([res.isError, (res.value as { code?: string }).code], `${ctx} ${tool}`).toEqual([
          true,
          "NOT_FOUND",
        ]);
      }
    }

    // wire — 구독은 NOT_FOUND 이고, 이어지는 DM 대화의 이벤트는 셋 어디에도 닿지 않는다
    for (const other of othersLogs) {
      const sub = await other.socket.emitWithAck("channel.subscribe", { channelId: dm.id });
      expect(sub.ok ? "ok" : sub.error.code).toBe("NOT_FOUND");
    }
    expect((await sendIn(log, dm, session.id, "오로라 2단계")).ok).toBe(true);
    await agentReplyIn(log, session.id, 1);
    // 새 세션을 하나 더 — conversation.created·updated 와 새 런도 창 안에 든다
    const later = await newSession(log, dm, "오로라 후속 회의");
    // 대조 — 창 끝에 일반 채널을 만든다. 그 channel.created 는 셋 모두에게 간다
    const control = await as<{ channel: Channel }>(ada, "POST", "/channels", { name: "dm-control" });
    expect(control.status).toBe(201);
    // 같은 연결의 ack 왕복 뒤에 본다 — 그 사이 온 이벤트는 이미 기록됐다
    for (const other of othersLogs) await other.socket.emitWithAck("channel.subscribe", { channelId: dm.id });
    const runIds = [
      ...new Set(log.created.filter((m) => m.channelId === dm.id && m.runId).map((m) => m.runId as string)),
    ];
    expect(runIds).toHaveLength(3);
    const marks = [dm.id, session.id, later.id, ...runIds, "오로라"];
    expect(heard.filter((h) => marks.some((mark) => h.text.includes(mark))).map((h) => h.event)).toEqual([]);
    expect(
      heard.filter((h) => h.event === "channel.created" && h.text.includes(control.body.channel.id)),
    ).toHaveLength(othersLogs.length);
    for (const other of othersLogs) {
      expect(other.created.filter((m) => m.channelId === dm.id)).toEqual([]);
      expect(other.states.filter((s) => s.channelId === dm.id)).toEqual([]);
    }

    // 운영 표 — DM 런은 채널 이름·주인·세션 없이 「DM」 한 줄로만
    for (const who of [owner, ada]) {
      const ops = await as<OpsRunsSummary>(who, "GET", "/ops/runs?days=1");
      expect(ops.status).toBe(200);
      const row = ops.body.byChannel.find((r) => r.id === OPS_DM_ROW_ID);
      expect(row).toMatchObject({ name: "DM", kind: "dm", runs: 3 });
      const text = JSON.stringify(ops.body);
      for (const secret of [dm.id, mia.id, session.id, later.id, session.title, "오로라"])
        expect(text).not.toContain(secret);
    }

    // 주인은 바깥 MCP 로 자기 DM 을 본다(PD3 — 개인 토큰은 일반 채널 + 주인의 DM)
    const mine = await mcpTool(mia, "list_channels", {});
    expect(JSON.stringify(mine.value)).toContain(dm.id);
    const myRead = await mcpTool(mia, "read_messages", { conversationId: session.id });
    expect(myRead.isError).toBe(false);
    expect(JSON.stringify(myRead.value)).toContain("오로라");
    // 대조 — 남에게 0 건인 같은 검색이 주인에게는 그 DM 의 글을 찾는다
    const mySearch = await as<SearchResult>(mia, "GET", `/search?q=${encodeURIComponent("오로라")}`);
    expect(mySearch.body.hits.some((h) => h.channelId === dm.id && h.conversationId === session.id)).toBe(
      true,
    );
    const myMcpSearch = await mcpTool(mia, "search_messages", { q: "오로라" });
    expect(myMcpSearch.isError).toBe(false);
    expect(JSON.stringify(myMcpSearch.value)).toContain(session.id);
  });

  it("기준 3 — DM 의 도구 승인은 member 주인이 결정한다: owner·admin 은 카드를 못 받고 결정하려 하면 NOT_FOUND", async () => {
    await boot();
    const dm = await openDm(mia);
    const log = await wireOf(mia);
    const ownerLog = await wireOf(owner);
    const adaLog = await wireOf(ada);
    expect((await log.socket.emitWithAck("channel.subscribe", { channelId: dm.id })).ok).toBe(true);

    next = {
      deltas: ["다", "썼어요"],
      reply: "다 썼어요",
      approval: { ttlMs: 20_000, onDecision: "continue" },
    };
    const res = await log.socket.emitWithAck("message.send", {
      channelId: dm.id,
      newConversation: {},
      clientMsgId: randomUUID(),
      bodyMd: "메모 파일 하나 써 줘",
    });
    expect(res.ok).toBe(true);
    const card: Approval = await log.until(() => log.approvals.at(0), "approval.requested(주인)");
    expect(card).toMatchObject({ channelId: dm.id, status: "pending", kind: "plugin" });

    for (const [name, other] of [
      ["owner", ownerLog],
      ["ada", adaLog],
    ] as const) {
      const denied = await other.socket.emitWithAck("approval.resolve", {
        approvalId: card.id,
        decision: "allow-once",
      });
      expect(denied.ok ? "ok" : denied.error.code, name).toBe("NOT_FOUND");
      expect(other.approvals, name).toEqual([]);
    }

    const allowed = await log.socket.emitWithAck("approval.resolve", {
      approvalId: card.id,
      decision: "allow-once",
    });
    expect(allowed.ok).toBe(true);
    const resolved = await log.until(
      () => log.resolvedApprovals.find((a) => a.id === card.id && a.status !== "pending"),
      "approval.resolved",
    );
    expect(resolved).toMatchObject({ decision: "allow-once", decidedBy: mia.id });
    const conversationId = (res.ok ? res.data.conversation?.id : undefined) as string;
    const reply = await agentReplyIn(log, conversationId);
    expect(reply.bodyMd).toBe("다 썼어요");
    // 결정은 owner·admin 의 소켓에 닿지 않는다
    for (const other of [ownerLog, adaLog]) {
      await other.socket.emitWithAck("channel.subscribe", { channelId: dm.id });
      expect(other.resolvedApprovals).toEqual([]);
    }
  });

  it("기준 4 — dmAccess 를 off 로 바꾸면 DM 은 읽기 전용(409 DM_READ_ONLY dm_not_allowed), everyone 으로 되돌리면 같은 세션에 이어 보낸다", async () => {
    await boot();
    const dm = await openDm(mia);
    const log = await wireOf(mia);
    expect((await log.socket.emitWithAck("channel.subscribe", { channelId: dm.id })).ok).toBe(true);
    const session = await newSession(log, dm, "회의록 정리 부탁해요");

    expect((await as(ada, "PATCH", `/agents/${dev.id}`, { dmAccess: "off" })).status).toBe(200);
    const { dms } = (await as<DmList>(mia, "GET", "/dms")).body;
    expect(dms.map((d) => [d.channel.id, d.readOnlyReason])).toEqual([[dm.id, "dm_not_allowed"]]);
    const blocked = await sendIn(log, dm, session.id, "하나 더요");
    expect(blocked.ok ? "ok" : [blocked.error.code, blocked.error.details]).toEqual([
      "DM_READ_ONLY",
      { reason: "dm_not_allowed" },
    ]);
    const fresh = await log.socket.emitWithAck("message.send", {
      channelId: dm.id,
      newConversation: {},
      clientMsgId: randomUUID(),
      bodyMd: "새 세션도 안 되죠?",
    });
    expect(fresh.ok ? "ok" : fresh.error.code).toBe("DM_READ_ONLY");
    // 읽기는 그대로 — 기록은 주인이 계속 읽는다
    const history = await as<{ messages: Message[] }>(mia, "GET", `/conversations/${session.id}/messages`);
    expect(history.status).toBe(200);
    expect(history.body.messages).toHaveLength(2);
    expect(deliveries).toHaveLength(1);

    expect((await as(ada, "PATCH", `/agents/${dev.id}`, { dmAccess: "everyone" })).status).toBe(200);
    expect((await as<DmList>(mia, "GET", "/dms")).body.dms[0]?.readOnlyReason).toBeNull();
    const resumed = await sendIn(log, dm, session.id, "이어서 정리해 주세요");
    expect(resumed.ok).toBe(true);
    const reply = await agentReplyIn(log, session.id, 1);
    expect(reply.bodyMd).toBe("받았어요: 이어서 정리해 주세요");
    expect(deliveries.map((d) => d.conversationId)).toEqual([session.id, session.id]);
    const listed = await as<{ conversations: Conversation[] }>(
      mia,
      "GET",
      `/channels/${dm.id}/conversations`,
    );
    expect(listed.body.conversations.map((c) => c.id)).toEqual([session.id]);
  });
});
