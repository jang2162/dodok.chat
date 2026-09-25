import { AdapterError } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { Agent, Channel, ChannelMember, Message } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { channels } from "../src/db/schema.sqlite";
import { createUserMessage } from "../src/modules/messages/service";
import type { BusEvents } from "../src/realtime/bus";
import { bootTestApp, login } from "./helpers/app";

type Method = "GET" | "POST" | "PATCH" | "DELETE";

/** 앱당 login 은 한 번만 — /auth/local 은 5회/분 레이트리밋 */
async function authed(app: App) {
  const { headers } = await login(app);
  return (method: Method, url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
}

function nextBusEvent<K extends keyof BusEvents>(app: App, event: K): Promise<BusEvents[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bus ${event} 타임아웃`)), 1000);
    const off = app.bus.on(event, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
  });
}

describe("REST /api/v1 (FakeAdapter)", () => {
  let app: App;
  let adapter: FakeAdapter;
  let api: Awaited<ReturnType<typeof authed>>;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapter });
    api = await authed(app);
  });
  afterAll(async () => {
    await app.close();
  });

  const newChannel = async (name = "general") => {
    const res = await api("POST", "/channels", { name });
    expect(res.statusCode).toBe(201);
    return res.json().channel as Channel & { promptRevision: number };
  };
  const newAgent = async (handle: string) => {
    const res = await api("POST", "/agents", { providerAgentId: handle, handle, name: handle });
    expect(res.statusCode).toBe(201);
    return res.json().agent as Agent;
  };

  it("인증 없으면 401 UNAUTHORIZED", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/channels" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("POST /channels 201 → GET /channels/:id·GET /channels", async () => {
    const channel = await newChannel("rest-a");
    expect(Channel.parse(channel)).toMatchObject({
      name: "rest-a",
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
      visibility: "public",
    });
    expect(channel.promptRevision).toBe(1);

    const got = await api("GET", `/channels/${channel.id}`);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({ channel });

    const list = await api("GET", "/channels");
    expect(list.statusCode).toBe(200);
    expect(list.json().channels).toContainEqual(channel);
  });

  it("POST /channels 는 channel.created 를 낸다", async () => {
    const created = nextBusEvent(app, "channel.created");
    const channel = await newChannel("rest-created");
    expect((await created).channel).toMatchObject({ id: channel.id, name: "rest-created" });
  });

  it("잘못된 본문·id 는 400 VALIDATION, 없는 채널은 404 NOT_FOUND", async () => {
    const bad = await api("POST", "/channels", { name: "" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: "VALIDATION", message: expect.stringContaining("name") });

    expect((await api("GET", "/channels/not-a-uuid")).json()).toMatchObject({ code: "VALIDATION" });
    const missing = await api("GET", `/channels/${uuid()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: "NOT_FOUND" });
    expect((await api("PATCH", `/channels/${uuid()}`, { name: "x" })).statusCode).toBe(404);
    expect((await api("GET", `/channels/${uuid()}/members`)).statusCode).toBe(404);
    expect((await api("GET", `/channels/${uuid()}/messages`)).statusCode).toBe(404);
  });

  it("DB 행이 도메인 계약을 어기면 500 INTERNAL (본문에 원인을 싣지 않는다)", async () => {
    const id = uuid();
    app.db
      .insert(channels)
      .values({
        id,
        workspaceId: app.workspaceId,
        name: "corrupt",
        relayPolicy: { maxRelayTurns: 4, allowPairs: "all" },
        visibility: "secret",
        createdBy: app.ownerUserId,
        createdAt: new Date(),
      })
      .run();
    const res = await api("GET", `/channels/${id}`);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ code: "INTERNAL", message: "stored channel violates contract" });
    app.db.delete(channels).where(eq(channels.id, id)).run();
  });

  it("PATCH /channels/:id { prompt } 는 리비전 2 와 syncChannelConfig 1건, channel.updated 를 낸다", async () => {
    const channel = await newChannel("rest-prompt");
    const before = adapter.calls.syncChannelConfig.length;
    const updated = nextBusEvent(app, "channel.updated");

    const res = await api("PATCH", `/channels/${channel.id}`, { prompt: "짧게 답해" });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel).toMatchObject({ id: channel.id, prompt: "짧게 답해", promptRevision: 2 });
    expect(adapter.calls.syncChannelConfig.slice(before)).toEqual([
      { channelId: channel.id, config: { systemPrompt: "짧게 답해" } },
    ]);
    expect((await updated).channel).toMatchObject({ id: channel.id, prompt: "짧게 답해" });

    // 이름만 바꾸면 리비전·동기화 없음
    const renamed = await api("PATCH", `/channels/${channel.id}`, { name: "renamed" });
    expect(renamed.json().channel).toMatchObject({ name: "renamed", promptRevision: 2 });
    // 프롬프트를 지우면 빈 systemPrompt 로 동기화
    await api("PATCH", `/channels/${channel.id}`, { prompt: null });
    expect(adapter.calls.syncChannelConfig.slice(before)).toEqual([
      { channelId: channel.id, config: { systemPrompt: "짧게 답해" } },
      { channelId: channel.id, config: { systemPrompt: "" } },
    ]);
  });

  it("syncChannelConfig 가 실패해도 PATCH 는 200 이고 system.notice warn 이 나간다", async () => {
    const channel = await newChannel("rest-sync-fail");
    const spy = vi.spyOn(adapter, "syncChannelConfig").mockRejectedValueOnce(new Error("gateway down"));
    const notice = nextBusEvent(app, "system.notice");
    const res = await api("PATCH", `/channels/${channel.id}`, { prompt: "p" });
    expect(res.statusCode).toBe(200);
    expect(res.json().channel.promptRevision).toBe(2);
    expect(await notice).toEqual({ level: "warn", message: expect.stringContaining("gateway down") });
    spy.mockRestore();
  });

  it("POST /agents 201·중복 handle 409 CONFLICT·GET /agents·PATCH /agents/:id", async () => {
    const agent = await newAgent("rest-dev");
    expect(Agent.parse(agent)).toMatchObject({ handle: "rest-dev", provider: "openclaw", enabled: true });

    const dup = await api("POST", "/agents", { providerAgentId: "other", handle: "rest-dev", name: "x" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: "CONFLICT" });

    const list = await api("GET", "/agents");
    expect(list.statusCode).toBe(200);
    expect(list.json().agents).toContainEqual(agent);

    const patched = await api("PATCH", `/agents/${agent.id}`, { enabled: false, name: "Dev" });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toEqual({ agent: { ...agent, enabled: false, name: "Dev" } });
    expect((await api("PATCH", `/agents/${uuid()}`, { name: "x" })).statusCode).toBe(404);
    expect(
      (await api("POST", "/agents", { handle: "Bad Handle", providerAgentId: "x", name: "x" })).statusCode,
    ).toBe(400);
  });

  it("POST /agents 는 providerAgentId 를 세션 키 규칙(OpenClaw agentId)으로 검증한다 — 밖이면 400 VALIDATION", async () => {
    // 대문자는 소문자로 접힌 세션 키와 어긋나므로 받지 않는다
    for (const providerAgentId of [
      "dev:main",
      "dev main",
      "-dev",
      "개발",
      "a".repeat(65),
      "Dev",
      "DEV-MAIN",
    ]) {
      const res = await api("POST", "/agents", { providerAgentId, handle: "rest-badid", name: "x" });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "VALIDATION",
        message: expect.stringContaining(
          "providerAgentId 는 OpenClaw 에이전트 id(영문 소문자·숫자로 시작, 영문 소문자·숫자·_·-, 64자 이하)여야 한다",
        ),
      });
    }
    const ok = await api("POST", "/agents", {
      providerAgentId: "dev_main-2",
      handle: "rest-goodid",
      name: "x",
    });
    expect(ok.statusCode).toBe(201);
  });

  it("핸들 충돌과 providerAgentId 충돌은 CONFLICT details.field 로 갈린다", async () => {
    const agent = await newAgent("rest-field");
    const dupHandle = await api("POST", "/agents", {
      providerAgentId: "rest-field-other",
      handle: agent.handle,
      name: "x",
    });
    expect(dupHandle.statusCode).toBe(409);
    expect(dupHandle.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });

    const dupProvider = await api("POST", "/agents", {
      providerAgentId: agent.providerAgentId,
      handle: "rest-field-2",
      name: "x",
    });
    expect(dupProvider.statusCode).toBe(409);
    expect(dupProvider.json()).toMatchObject({ code: "CONFLICT", details: { field: "providerAgentId" } });

    // PATCH 로 남의 핸들을 가져가도 같은 field
    const other = await newAgent("rest-field-3");
    const patched = await api("PATCH", `/agents/${other.id}`, { handle: agent.handle });
    expect(patched.statusCode).toBe(409);
    expect(patched.json()).toMatchObject({ code: "CONFLICT", details: { field: "handle" } });
  });

  it("GET /agents/discover 는 어댑터 listAgents 결과", async () => {
    const res = await api("GET", "/agents/discover");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ agents: await adapter.listAgents() });
  });

  it("멤버 POST 201·GET·PATCH·DELETE 와 channel.member.changed", async () => {
    const channel = await newChannel("rest-members");
    const agent = await newAgent("rest-member");
    const changed = nextBusEvent(app, "channel.member.changed");

    const added = await api("POST", `/channels/${channel.id}/members`, {
      memberType: "agent",
      memberId: agent.id,
    });
    expect(added.statusCode).toBe(201);
    const { member } = added.json() as { member: ChannelMember };
    expect(ChannelMember.parse(member)).toMatchObject({
      channelId: channel.id,
      memberType: "agent",
      memberId: agent.id,
    });
    expect(await changed).toMatchObject({ channelId: channel.id, members: expect.arrayContaining([member]) });

    const dup = await api("POST", `/channels/${channel.id}/members`, {
      memberType: "agent",
      memberId: agent.id,
    });
    expect(dup.statusCode).toBe(409);
    const unknown = await api("POST", `/channels/${channel.id}/members`, {
      memberType: "agent",
      memberId: uuid(),
    });
    expect(unknown.statusCode).toBe(404);

    const list = await api("GET", `/channels/${channel.id}/members`);
    expect(list.statusCode).toBe(200);
    expect(list.json().members.map((m: ChannelMember) => m.memberId)).toEqual([app.ownerUserId, agent.id]);

    const patched = await api("PATCH", `/channels/${channel.id}/members/${agent.id}`, {
      aliases: ["helper"],
      promptOverride: "너는 도우미",
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().member).toMatchObject({ aliases: ["helper"], promptOverride: "너는 도우미" });
    expect((await api("GET", `/channels/${channel.id}`)).json().channel.promptRevision).toBe(2);

    const removed = await api("DELETE", `/channels/${channel.id}/members/${agent.id}`);
    expect(removed.statusCode).toBe(200);
    expect(removed.json().members.map((m: ChannelMember) => m.memberId)).toEqual([app.ownerUserId]);
    expect((await api("DELETE", `/channels/${channel.id}/members/${agent.id}`)).statusCode).toBe(404);
  });

  it("GET /channels/:id/messages?limit=50 은 { messages, hasMore }", async () => {
    const channel = await newChannel("rest-messages");
    for (let i = 1; i <= 3; i++) {
      createUserMessage(app.db, app.bus, {
        channelId: channel.id,
        authorId: app.ownerUserId,
        bodyMd: `m${i}`,
        clientMsgId: `rest-${i}`,
      });
    }
    const res = await api("GET", `/channels/${channel.id}/messages?limit=50`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messages: Message[]; hasMore: boolean };
    expect(body.hasMore).toBe(false);
    expect(body.messages.map((m) => Message.parse(m).seq)).toEqual([1, 2, 3]);

    const page = await api("GET", `/channels/${channel.id}/messages?beforeSeq=3&limit=1`);
    expect(page.json()).toMatchObject({ hasMore: true, messages: [{ seq: 2 }] });
    expect((await api("GET", `/channels/${channel.id}/messages?afterSeq=1`)).json().messages).toHaveLength(2);
    expect((await api("GET", `/channels/${channel.id}/messages?limit=201`)).statusCode).toBe(400);
  });
});

describe("REST /api/v1 (Gateway 미연결 어댑터)", () => {
  it("GET /agents/discover 는 503 ADAPTER_UNAVAILABLE, 채널 프롬프트 변경은 그대로 된다", async () => {
    const adapter = new FakeAdapter();
    adapter.setStatus({ provider: "openclaw", gateway: "reconnecting", bridge: "down" });
    vi.spyOn(adapter, "listAgents").mockRejectedValue(
      new AdapterError("ADAPTER_UNAVAILABLE", "agents.list: gateway not connected"),
    );
    vi.spyOn(adapter, "syncChannelConfig").mockRejectedValue(
      new AdapterError("ADAPTER_UNAVAILABLE", "plugin not connected"),
    );
    const app = await bootTestApp({}, { adapter });
    try {
      const api = await authed(app);
      const res = await api("GET", "/agents/discover");
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: "ADAPTER_UNAVAILABLE" });

      const created = await api("POST", "/channels", { name: "no-adapter" });
      const patched = await api("PATCH", `/channels/${created.json().channel.id}`, { prompt: "p" });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().channel.promptRevision).toBe(2);
    } finally {
      await app.close();
    }
  });
});
