/**
 * 사람 DM·그룹 DM 통합 시나리오 — 실제 서버(실제 OpenClawAdapter) + 가짜 Gateway + 가짜 플러그인 + 사람마다 wire 클라이언트.
 * 사람 간 DM 스펙 「완료 기준」 1~4 를 흐름 하나씩 REST·wire·검색·읽지 않음·푸시·운영 표·제어 도구(`/mcp`)를 지나며 돈다. 기준 5(에이전트
 * DM 의 지금 동작)는 `dms.test.ts` 가 그대로 지킨다.
 * 사람은 owner(로컬 토큰)·admin ada·member mia·kim·jun 다섯, 에이전트는 dev(dmAccess everyone) 하나.
 */
import {
  type Agent,
  type Approval,
  type Channel,
  type Conversation,
  type DirectList,
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

type Person = { id: string; handle: string; token: string; headers: { authorization: string } };
type Sent = { endpoint: string; payload: PushPayload };
type Delivery = { groupDm: boolean; participants: string[]; conversationId: string; sender: string };

describe("사람 DM·그룹 DM 통합 — 완료 기준 1~4", () => {
  let live: LiveApp;
  const sockets: WireClient[] = [];
  let sent: Sent[];
  let scenario: Scenario;
  let deliveries: Delivery[];
  let owner: Person;
  let ada: Person;
  let mia: Person;
  let kim: Person;
  let jun: Person;
  let dev: Agent;

  const pushSend: NonNullable<AppDeps["pushSend"]> = async (sub, body) => {
    sent.push({ endpoint: sub.endpoint, payload: PushPayload.parse(JSON.parse(body)) });
    return { statusCode: 201 };
  };

  async function person(handle: string, role: string): Promise<Person> {
    const { id, token } = await userWithRole(live.app, handle, role);
    return { id, handle, token, headers: { authorization: `Bearer ${token}` } };
  }

  /** 대본 — 기본은 받은 글을 되말하는 답. 테스트가 `next` 로 다음 한 턴만 바꾼다 */
  let next: ScenarioScript | undefined;

  async function boot() {
    sent = [];
    deliveries = [];
    next = undefined;
    live = await bootLiveApp({ deps: { pushSend } });
    owner = { id: live.app.ownerUserId, handle: "owner", token: live.auth.token, headers: live.auth.headers };
    ada = await person("ada", "admin");
    mia = await person("mia", "member");
    kim = await person("kim", "member");
    jun = await person("jun", "member");
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
            groupDm: delivery.groupDm === true,
            participants: delivery.context.participants.map((p) => p.handle),
            conversationId: delivery.conversationId,
            sender: delivery.message.author.handle,
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

  /** 그 사람의 소켓 — 붙은 순간부터 받은 서버 이벤트를 모두 기록한다. 글·런 이벤트는 그 채널을 구독해야 온다(subscribe) */
  async function wireOf(who: Person): Promise<WireLog> {
    const socket = await connectWire(live.app, who.token);
    sockets.push(socket);
    return recordWire(socket);
  }

  async function subscribe(log: WireLog, channelId: string): Promise<void> {
    const res = await log.socket.emitWithAck("channel.subscribe", { channelId });
    expect(res.ok ? "ok" : res.error.code).toBe("ok");
  }

  async function openDirect(
    who: Person,
    body: { userIds?: string[]; agentIds?: string[] },
  ): Promise<{ channel: Channel; created: boolean }> {
    const res = await as<{ channel: Channel; created: boolean }>(who, "POST", "/directs", body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body;
  }

  const conversationsOf = async (who: Person, channelId: string) =>
    (await as<{ conversations: Conversation[] }>(who, "GET", `/channels/${channelId}/conversations`)).body
      .conversations;

  async function sendIn(log: WireLog, channelId: string, conversationId: string, text: string) {
    return log.socket.emitWithAck("message.send", {
      channelId,
      conversationId,
      clientMsgId: randomUUID(),
      bodyMd: text,
    });
  }

  /** 그룹 DM 에 새 세션으로 보낸다 — 그 세션을 돌려준다(답은 기다리지 않는다) */
  async function newSession(log: WireLog, channelId: string, text: string): Promise<Conversation> {
    const res = await log.socket.emitWithAck("message.send", {
      channelId,
      newConversation: {},
      clientMsgId: randomUUID(),
      bodyMd: text,
    });
    if (!res.ok) throw new Error(`message.send → ${res.error.code}`);
    return res.data.conversation as Conversation;
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

  async function subscribePush(who: Person) {
    const res = await as(who, "POST", "/push/subscriptions", {
      endpoint: `https://push.invalid/${who.handle}`,
      keys: KEYS,
    });
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

  it("기준 1 — member 가 1:1·사람만 그룹·에이전트 그룹을 열고, 같은 묶음을 순서를 바꿔 다시 열면(다른 참여자가 열어도) 같은 대화다", async () => {
    await boot();
    const miaLog = await wireOf(mia);
    const kimLog = await wireOf(kim);

    // 1:1 — 한 줄기: 만들 때 대화 하나, 상대가 열어도 같은 채널·같은 대화
    const line = await openDirect(mia, { userIds: [kim.id] });
    expect(line.created).toBe(true);
    expect(line.channel).toMatchObject({ kind: "direct", visibility: "private" });
    const [lineConversation, ...extra] = await conversationsOf(mia, line.channel.id);
    expect(extra).toEqual([]);
    const lineId = lineConversation?.id ?? "";
    await subscribe(kimLog, line.channel.id);
    expect(await openDirect(kim, { userIds: [mia.id] })).toEqual({ channel: line.channel, created: false });
    expect((await sendIn(miaLog, line.channel.id, lineId, "안녕하세요 kim 님")).ok).toBe(true);
    const heard = await kimLog.until(
      () => kimLog.created.find((m) => m.channelId === line.channel.id),
      "kim 이 받은 1:1 글",
    );
    expect(heard).toMatchObject({ conversationId: lineId, bodyMd: "안녕하세요 kim 님" });
    // 한 줄기는 새 세션이 없다 — 열린 대화는 늘 하나(웹의 `/c/<id>` 가 `s/new` 로 가는 일이 생기지 않는다)
    const fresh = await miaLog.socket.emitWithAck("message.send", {
      channelId: line.channel.id,
      newConversation: {},
      clientMsgId: randomUUID(),
      bodyMd: "새 세션?",
    });
    expect(fresh.ok ? "ok" : fresh.error.code).toBe("VALIDATION");
    expect((await conversationsOf(kim, line.channel.id)).map((c) => c.id)).toEqual([lineId]);

    // 사람만 그룹 — 한 줄기, 셋째 사람이 순서를 바꿔 열어도 같은 채널
    const humans = await openDirect(mia, { userIds: [kim.id, jun.id] });
    expect(humans.created).toBe(true);
    expect(await openDirect(jun, { userIds: [kim.id, mia.id] })).toEqual({
      channel: humans.channel,
      created: false,
    });
    expect(await conversationsOf(jun, humans.channel.id)).toHaveLength(1);

    // 에이전트 그룹 — 세션으로 나눈다(처음에는 대화 없음), 사람·에이전트 순서를 바꿔도 같은 채널. 동시에 열어도 하나(Review Focus 5)
    const [a, b] = await Promise.all([
      openDirect(mia, { userIds: [kim.id], agentIds: [dev.id] }),
      openDirect(mia, { agentIds: [dev.id], userIds: [kim.id] }),
    ]);
    expect(a?.channel.id).toBe(b?.channel.id);
    expect([a?.created, b?.created].sort()).toEqual([false, true]);
    const group = a.channel;
    expect(await openDirect(kim, { agentIds: [dev.id], userIds: [mia.id] })).toEqual({
      channel: group,
      created: false,
    });
    expect(await conversationsOf(mia, group.id)).toEqual([]);
    await subscribe(miaLog, group.id);
    await subscribe(kimLog, group.id);
    const session = await newSession(miaLog, group.id, `@dev 그룹에서 처음 부릅니다`);
    await agentReplyIn(miaLog, session.id);
    await agentReplyIn(kimLog, session.id);
    expect(deliveries).toEqual([
      {
        groupDm: true,
        participants: expect.arrayContaining(["mia", "kim", "dev"]) as unknown as string[],
        conversationId: session.id,
        sender: "mia",
      },
    ]);
    expect(deliveries[0]?.participants).toHaveLength(3);

    // 목록 — 셋 다 각자의 /directs 에, 채널 목록·에이전트 DM 목록에는 없다
    for (const [who, expected] of [
      [mia, [line.channel.id, humans.channel.id, group.id]],
      [kim, [line.channel.id, humans.channel.id, group.id]],
      [jun, [humans.channel.id]],
    ] as const) {
      const { directs } = (await as<DirectList>(who, "GET", "/directs")).body;
      expect(directs.map((d) => d.channel.id).sort(), who.handle).toEqual([...expected].sort());
      const channels = (await as<{ channels: Channel[] }>(who, "GET", "/channels")).body.channels;
      expect(
        channels.filter((c) => expected.includes(c.id)),
        who.handle,
      ).toEqual([]);
      expect((await as<DmList>(who, "GET", "/dms")).body.dms, who.handle).toEqual([]);
    }
  });

  it("기준 2 — 참여하지 않은 owner·admin·member 는 그룹 DM 을 REST·wire·검색·읽지 않음·푸시·운영 표·제어 도구 어디에서도 못 본다", async () => {
    await boot();
    const others = { owner, ada, jun };
    for (const who of [owner, ada, jun, mia, kim]) await subscribePush(who);
    const othersLogs = await Promise.all(Object.values(others).map((who) => wireOf(who)));
    // 만들기 전부터 셋이 받은 이벤트를 모두 담는다 — channel.created·conversation.created 도 창 안에 든다
    const heard: Array<{ event: string; text: string }> = [];
    for (const other of othersLogs)
      other.socket.onAny((event: string, payload: unknown) => {
        heard.push({ event, text: JSON.stringify(payload ?? null) });
      });

    const { channel: group } = await openDirect(mia, { userIds: [kim.id], agentIds: [dev.id] });
    const miaLog = await wireOf(mia);
    await subscribe(miaLog, group.id);
    const session = await newSession(miaLog, group.id, "@dev 비밀 프로젝트 오로라 이야기");
    const reply = await agentReplyIn(miaLog, session.id);
    expect(reply.runId).toBeDefined();
    const runId = reply.runId as string;

    // 푸시 — mia 의 사람 글은 kim 에게, dev 의 정본 답은 mia·kim 에게(작성자를 뺀 사람 참여자). 제목·본문에 내용 없음
    await untilSent(3, "그룹 DM 푸시");
    await new Promise((r) => setTimeout(r, 200));
    expect(sent.map((s) => s.endpoint).sort()).toEqual([
      "https://push.invalid/kim",
      "https://push.invalid/kim",
      "https://push.invalid/mia",
    ]);
    for (const s of sent) {
      expect(s.payload.body).toBe("DM");
      expect(s.payload.tag).toBe(`direct:${session.id}`);
      expect(JSON.stringify(s.payload)).not.toContain("오로라");
    }

    for (const [name, who] of Object.entries(others)) {
      const ctx = `${name}:`;
      // REST — 목록에 없고, id 로 닿아도 없는 것과 같은 404
      const channels = await as<{ channels: Channel[] }>(who, "GET", "/channels");
      expect(
        channels.body.channels.map((c) => c.id),
        ctx,
      ).not.toContain(group.id);
      expect((await as<DirectList>(who, "GET", "/directs")).body.directs, ctx).toEqual([]);
      expect((await as<DmList>(who, "GET", "/dms")).body.dms, ctx).toEqual([]);
      for (const url of [
        `/channels/${group.id}`,
        `/channels/${group.id}/conversations`,
        `/channels/${group.id}/members`,
        `/channels/${group.id}/runs`,
        `/conversations/${session.id}`,
        `/conversations/${session.id}/messages`,
        `/runs/${runId}`,
        `/runs/${runId}/events`,
      ]) {
        const res = await as<{ code: string }>(who, "GET", url);
        expect([res.status, res.body.code], `${ctx} GET ${url}`).toEqual([404, "NOT_FOUND"]);
      }
      // 역할 정책이 있는 쓰기도 403·400 이 아니라 404 — 접근 판정이 먼저다
      const patch = await as<{ code: string }>(who, "PATCH", `/channels/${group.id}`, { prompt: "엿보기" });
      expect([patch.status, patch.body.code], `${ctx} PATCH`).toEqual([404, "NOT_FOUND"]);
      // 검색·읽지 않음
      const search = await as<SearchResult>(who, "GET", `/search?q=${encodeURIComponent("오로라")}`);
      expect(search.body.hits, ctx).toEqual([]);
      const unread = await as<UnreadSnapshot>(who, "GET", "/me/unread");
      expect(
        unread.body.conversations.map((c) => c.channelId),
        ctx,
      ).not.toContain(group.id);
      expect(unread.body.channels, ctx).not.toContain(group.id);
      // 제어 도구(바깥 MCP)
      const listed = await mcpTool(who, "list_channels", {});
      expect(listed.isError, `${ctx} list_channels`).toBe(false);
      expect(JSON.stringify(listed.value), ctx).not.toContain(group.id);
      const searched = await mcpTool(who, "search_messages", { q: "오로라" });
      expect(searched.isError, `${ctx} search_messages`).toBe(false);
      expect(JSON.stringify(searched.value), ctx).not.toContain("오로라");
      for (const [tool, args] of [
        ["get_channel", { channelId: group.id }],
        ["list_conversations", { channelId: group.id }],
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

    // wire — 구독·보내기는 NOT_FOUND, 이어지는 대화의 이벤트는 셋 어디에도 닿지 않는다
    for (const other of othersLogs) {
      const sub = await other.socket.emitWithAck("channel.subscribe", { channelId: group.id });
      expect(sub.ok ? "ok" : sub.error.code).toBe("NOT_FOUND");
      const write = await sendIn(other, group.id, session.id, "끼어들기");
      expect(write.ok ? "ok" : write.error.code).toBe("NOT_FOUND");
    }
    expect((await sendIn(miaLog, group.id, session.id, "@dev 오로라 2단계")).ok).toBe(true);
    await agentReplyIn(miaLog, session.id, 1);
    const later = await newSession(miaLog, group.id, "@dev 오로라 후속 회의");
    await agentReplyIn(miaLog, later.id);
    // 대조 — 창 끝에 일반 채널을 만든다. 그 channel.created 는 셋 모두에게 간다
    const control = await as<{ channel: Channel }>(ada, "POST", "/channels", { name: "direct-control" });
    expect(control.status).toBe(201);
    for (const other of othersLogs)
      await other.socket.emitWithAck("channel.subscribe", { channelId: group.id });
    const runIds = [
      ...new Set(
        miaLog.created.filter((m) => m.channelId === group.id && m.runId).map((m) => m.runId as string),
      ),
    ];
    expect(runIds).toHaveLength(3);
    const marks = [group.id, session.id, later.id, ...runIds, "오로라"];
    expect(heard.filter((h) => marks.some((mark) => h.text.includes(mark))).map((h) => h.event)).toEqual([]);
    expect(
      heard.filter((h) => h.event === "channel.created" && h.text.includes(control.body.channel.id)),
    ).toHaveLength(othersLogs.length);
    // 푸시 — 참여하지 않은 셋의 기기에는 한 건도 없다
    for (const who of Object.values(others))
      expect(sent.filter((s) => s.endpoint === `https://push.invalid/${who.handle}`)).toEqual([]);

    // 운영 표 — 그룹 DM 런은 채널 이름·참여자·세션 없이 「DM」 한 줄로만
    for (const who of [owner, ada]) {
      const ops = await as<OpsRunsSummary>(who, "GET", "/ops/runs?days=1");
      expect(ops.status).toBe(200);
      const row = ops.body.byChannel.find((r) => r.id === OPS_DM_ROW_ID);
      expect(row).toMatchObject({ name: "DM", kind: "dm", runs: 3 });
      const text = JSON.stringify(ops.body);
      for (const secret of [group.id, mia.id, kim.id, session.id, later.id, session.title, "오로라"])
        expect(text).not.toContain(secret);
    }

    // 대조 — 참여자 kim 은 같은 검색·제어 도구로 그 글을 찾는다
    const kimSearch = await as<SearchResult>(kim, "GET", `/search?q=${encodeURIComponent("오로라")}`);
    expect(kimSearch.body.hits.some((h) => h.channelId === group.id && h.conversationId === session.id)).toBe(
      true,
    );
    const kimRead = await mcpTool(kim, "read_messages", { conversationId: session.id });
    expect(kimRead.isError).toBe(false);
    expect(JSON.stringify(kimRead.value)).toContain("오로라");
  });

  it("기준 3 — 그룹 dev 는 멘션에만 답하고, 승인은 시킨 사람만 결정한다(참여한 admin 은 FORBIDDEN·참여하지 않은 owner 는 NOT_FOUND), 시킨 사람이 dmAccess 밖이면 런 없이 시스템 메시지", async () => {
    await boot();
    const { channel: group } = await openDirect(mia, { userIds: [ada.id], agentIds: [dev.id] });
    const miaLog = await wireOf(mia);
    const adaLog = await wireOf(ada);
    const ownerLog = await wireOf(owner);
    await subscribe(miaLog, group.id);
    await subscribe(adaLog, group.id);

    // 멘션 없는 글은 런이 없다
    const session = await newSession(miaLog, group.id, "그냥 하는 말이에요");
    await new Promise((r) => setTimeout(r, 200));
    expect(deliveries).toEqual([]);
    expect(miaLog.states.filter((s) => s.channelId === group.id)).toEqual([]);

    // mia 가 @dev — 도구 승인 카드는 참여자에게 가지만 결정은 mia 만
    next = {
      deltas: ["다", "썼어요"],
      reply: "다 썼어요",
      approval: { ttlMs: 20_000, onDecision: "continue" },
    };
    expect((await sendIn(miaLog, group.id, session.id, "@dev 메모 파일 하나 써 줘")).ok).toBe(true);
    const card: Approval = await miaLog.until(() => miaLog.approvals.at(0), "approval.requested(mia)");
    expect(card).toMatchObject({ channelId: group.id, status: "pending", requestedBy: mia.id });
    const adaCard = await adaLog.until(() => adaLog.approvals.at(0), "approval.requested(ada)");
    expect(adaCard.id).toBe(card.id);
    const byAda = await adaLog.socket.emitWithAck("approval.resolve", {
      approvalId: card.id,
      decision: "allow-once",
    });
    expect(byAda.ok ? "ok" : byAda.error.code).toBe("FORBIDDEN");
    const byOwner = await ownerLog.socket.emitWithAck("approval.resolve", {
      approvalId: card.id,
      decision: "allow-once",
    });
    expect(byOwner.ok ? "ok" : byOwner.error.code).toBe("NOT_FOUND");
    expect(ownerLog.approvals).toEqual([]);
    const byMia = await miaLog.socket.emitWithAck("approval.resolve", {
      approvalId: card.id,
      decision: "allow-once",
    });
    expect(byMia.ok).toBe(true);
    const resolved = await miaLog.until(
      () => miaLog.resolvedApprovals.find((a) => a.id === card.id && a.status !== "pending"),
      "approval.resolved",
    );
    expect(resolved).toMatchObject({ decision: "allow-once", decidedBy: mia.id });
    expect((await agentReplyIn(miaLog, session.id)).bodyMd).toBe("다 썼어요");
    expect(deliveries.map((d) => d.sender)).toEqual(["mia"]);
    expect(ownerLog.resolvedApprovals).toEqual([]);

    // dev 의 허용 범위를 admins 로 좁히면 member mia 가 시킨 런은 런 없이 시스템 메시지 — admin ada 가 시키면 돈다
    expect((await as(ada, "PATCH", `/agents/${dev.id}`, { dmAccess: "admins" })).status).toBe(200);
    expect((await sendIn(miaLog, group.id, session.id, "@dev 하나 더요")).ok).toBe(true);
    const notice = await miaLog.until(
      () => miaLog.created.find((m) => m.conversationId === session.id && m.authorType === "system"),
      "시킨 사람 관문 시스템 메시지",
    );
    expect(notice.bodyMd).toBe(
      "@dev 는 이 요청에 답하지 않았습니다 — 시킨 사람이 이 에이전트의 DM 허용 범위 밖입니다",
    );
    expect(deliveries).toHaveLength(1);
    expect((await sendIn(adaLog, group.id, session.id, "@dev 제가 시킬게요")).ok).toBe(true);
    await agentReplyIn(miaLog, session.id, 1);
    expect(deliveries.map((d) => d.sender)).toEqual(["mia", "ada"]);
  });

  it("기준 4 — 1:1 상대가 비활성이 되면 읽기 전용(409 DM_READ_ONLY peer_deactivated), 다시 활성화하면 같은 대화에 이어 쓴다", async () => {
    await boot();
    const { channel: line } = await openDirect(mia, { userIds: [kim.id] });
    const [conversation] = await conversationsOf(mia, line.id);
    const conversationId = conversation?.id ?? "";
    const miaLog = await wireOf(mia);
    expect((await sendIn(miaLog, line.id, conversationId, "첫 글")).ok).toBe(true);
    const { channel: trio } = await openDirect(mia, { userIds: [kim.id, jun.id] });

    expect((await as(ada, "POST", `/members/${kim.id}/deactivate`)).status).toBe(200);
    const { directs } = (await as<DirectList>(mia, "GET", "/directs")).body;
    expect(directs.find((d) => d.channel.id === line.id)?.readOnlyReason).toBe("peer_deactivated");
    const blocked = await sendIn(miaLog, line.id, conversationId, "둘째 글");
    expect(blocked.ok ? "ok" : [blocked.error.code, blocked.error.details]).toEqual([
      "DM_READ_ONLY",
      { reason: "peer_deactivated" },
    ]);
    // 읽기는 그대로
    const history = await as<{ messages: Message[] }>(
      mia,
      "GET",
      `/conversations/${conversationId}/messages`,
    );
    expect(history.body.messages.map((m) => m.bodyMd)).toEqual(["첫 글"]);
    // 그룹은 읽기 전용이 되지 않는다 — 남은 사람끼리 계속
    expect(
      (await as<DirectList>(mia, "GET", "/directs")).body.directs.find((d) => d.channel.id === trio.id),
    ).toMatchObject({ readOnlyReason: null });

    expect((await as(ada, "POST", `/members/${kim.id}/reactivate`)).status).toBe(200);
    expect(
      (await as<DirectList>(mia, "GET", "/directs")).body.directs.find((d) => d.channel.id === line.id)
        ?.readOnlyReason,
    ).toBeNull();
    expect((await sendIn(miaLog, line.id, conversationId, "다시 왔네요")).ok).toBe(true);
    const after = await as<{ messages: Message[] }>(mia, "GET", `/conversations/${conversationId}/messages`);
    expect(after.body.messages.map((m) => m.bodyMd)).toEqual(["첫 글", "다시 왔네요"]);
    expect((await conversationsOf(mia, line.id)).map((c) => c.id)).toEqual([conversationId]);
  });
});
