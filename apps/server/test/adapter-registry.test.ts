import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  AdapterError,
  type AdapterStatus,
  type Agent,
  type AgentProvider,
  type ProviderApproval,
} from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry";
import type { App } from "../src/app";
import { agents } from "../src/db/schema.sqlite";
import * as approvalStore from "../src/modules/approvals/store";
import { createAgent } from "../src/modules/agents/service";
import { addMember, type ChannelRecord, createChannel } from "../src/modules/channels/service";
import { listMessages } from "../src/modules/messages/service";
import { getRun } from "../src/modules/runs/store";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID, fakeGatewayStatus } from "./helpers/gateways";
import { connectWire, type WireClient } from "./helpers/wire";
import { channelConversation } from "./helpers/seed";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("createAdapterRegistry", () => {
  it("provider 로 고르고, 에이전트 행의 provider 로 고른다 — 없으면 ADAPTER_UNAVAILABLE", () => {
    const openclaw = new FakeAdapter();
    const claude = new FakeAdapter({ provider: "claude" });
    const registry = createAdapterRegistry([openclaw, claude]);

    expect(registry.all()).toEqual([openclaw, claude]);
    expect(registry.forProvider("openclaw")).toBe(openclaw);
    expect(registry.forProvider("claude")).toBe(claude);
    expect(registry.forAgent({ provider: "claude" })).toBe(claude);
    expect(registry.forAgent({ provider: "openclaw" })).toBe(openclaw);
    expect(() => registry.forAgent({ provider: "codex" })).toThrow(AdapterError);
    try {
      registry.forAgent({ provider: "codex" });
    } catch (err) {
      expect((err as AdapterError).code).toBe("ADAPTER_UNAVAILABLE");
    }
    expect(createAdapterRegistry([openclaw]).forProvider("claude")).toBeUndefined();
  });

  it("같은 provider 가 둘이면 만들지 않는다", () => {
    expect(() => createAdapterRegistry([new FakeAdapter(), new FakeAdapter()])).toThrow(/openclaw/);
  });

  it("onEvent 는 모든 어댑터의 이벤트를 어느 어댑터에서 왔는지와 함께 넘기고, 해제하면 전부 끊는다", () => {
    const openclaw = new FakeAdapter();
    const claude = new FakeAdapter({ provider: "claude" });
    const registry = createAdapterRegistry([openclaw, claude]);
    const seen: Array<[string, string]> = [];
    const off = registry.onEvent((e, from) => seen.push([e.kind, from.provider]));

    openclaw.emit({ kind: "setup" });
    claude.emit({ kind: "setup" });
    off();
    openclaw.emit({ kind: "setup" });
    claude.emit({ kind: "setup" });

    expect(seen).toEqual([
      ["setup", "openclaw"],
      ["setup", "claude"],
    ]);
  });
});

describe("어댑터 레지스트리 배선 (앱 부팅, OpenClaw·Claude 가짜 둘)", () => {
  let app: App;
  let openclaw: FakeAdapter;
  let claude: FakeAdapter<"claude">;
  let token: string;
  let headers: { authorization: string };
  let dev: Agent;
  let coder: Agent;
  let codexer: Agent;
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    openclaw = new FakeAdapter();
    claude = new FakeAdapter({ provider: "claude" });
    app = await bootTestApp({}, { adapters: [openclaw, claude] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ token, headers } = await login(app));
    dev = agentOf("openclaw", "dev");
    coder = agentOf("claude", "coder");
    codexer = agentOf("codex", "codexer");
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  /** 에이전트 등록은 아직 openclaw 만 받는다(태스크 4) — 행을 만든 뒤 provider 를 바꾼다 */
  function agentOf(provider: AgentProvider, providerAgentId: string): Agent {
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId,
      handle: providerAgentId,
      name: providerAgentId,
      ...(provider === "openclaw" ? { gatewayId: FAKE_GATEWAY_ID } : {}),
    });
    app.db.update(agents).set({ provider }).where(eq(agents.id, agent.id)).run();
    return { ...agent, provider };
  }

  function channelWith(members: Agent[], prompt?: string): ChannelRecord {
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: `registry-${++n}`,
      ...(prompt === undefined ? {} : { prompt }),
    });
    for (const m of members)
      addMember(app.db, channel.id, { memberType: "agent", memberId: m.id }, app.logger);
    return channel;
  }

  async function connect(channelId: string): Promise<WireClient> {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const res = await socket.emitWithAck("channel.subscribe", { channelId });
    if (!res.ok) throw new Error(res.error.code);
    return socket;
  }

  async function say(socket: WireClient, channelId: string, bodyMd: string): Promise<void> {
    const sent = await socket.emitWithAck("message.send", { channelId, clientMsgId: `m-${++n}`, bodyMd });
    if (!sent.ok) throw new Error(sent.error.code);
  }

  /** 말하고 그 어댑터에 새로 보낸 런 하나를 기다린다 — 센 수는 말하기 전에 잡는다(ack 전에 보낼 수 있다) */
  async function mention(
    adapter: FakeAdapter<"openclaw" | "claude">,
    socket: WireClient,
    channelId: string,
    bodyMd: string,
  ) {
    const before = adapter.calls.send.length;
    await say(socket, channelId, bodyMd);
    return nextSend(adapter, before);
  }

  /** 그 어댑터에 새로 보낸 런 하나를 기다려 send 인자·옵션을 돌려준다 */
  async function nextSend(adapter: FakeAdapter<"openclaw" | "claude">, before: number) {
    await vi.waitFor(() => expect(adapter.calls.send.length).toBe(before + 1));
    const input = adapter.calls.send[before];
    if (!input) throw new Error("no send");
    return { input, opts: adapter.calls.sendOpts[before] };
  }

  /** 런을 끝내 세션 큐의 다음 런이 나가게 한다 */
  async function finish(runId: string): Promise<void> {
    await app.orchestrator.abort(runId);
    await vi.waitFor(() => expect(getRun(app.db, runId)?.status).toBe("aborted"));
  }

  it("claude 에이전트 멘션은 claude 어댑터로만 — 서버가 정한 세션 UUID 를 이어 쓴다", async () => {
    const channel = channelWith([dev, coder]);
    const socket = await connect(channel.id);
    const openclawBefore = openclaw.calls.send.length;

    const first = await mention(claude, socket, channel.id, "@coder 첫 부탁");
    expect(first.input).toMatchObject({ kind: "message", agentId: "coder", channelId: channel.id });
    const sessionId = first.opts?.providerSessionId;
    expect(sessionId).toMatch(UUID);
    expect(openclaw.calls.send.length).toBe(openclawBefore);
    await finish(first.input.runId);

    const second = await mention(claude, socket, channel.id, "@coder 둘째 부탁");
    expect(second.opts?.providerSessionId).toBe(sessionId);
    await finish(second.input.runId);

    expect(openclaw.calls.send.length).toBe(openclawBefore);
  });

  it("OpenClaw 에이전트에는 세션 id 를 넘기지 않는다 — 두 번째 인자 없이 보낸다", async () => {
    const channel = channelWith([dev]);
    const socket = await connect(channel.id);
    const before = openclaw.calls.send.length;
    await say(socket, channel.id, "@dev 부탁");
    const sent = await nextSend(openclaw, before);
    expect(sent.opts).toBeUndefined();
    await finish(sent.input.runId);
  });

  it("promptEveryRun 어댑터는 채널 프롬프트를 매 런 싣고, 바뀐 뒤에는 새 값만 — OpenClaw 는 지금처럼 리비전이 오를 때만", async () => {
    const channel = channelWith([dev, coder], "규칙 A");
    const socket = await connect(channel.id);

    for (const body of ["@coder 하나", "@coder 둘"]) {
      const sent = await mention(claude, socket, channel.id, body);
      expect(sent.input.context.channelPrompt).toBe("규칙 A");
      await finish(sent.input.runId);
    }
    for (const body of ["@dev 하나", "@dev 둘"]) {
      const sent = await mention(openclaw, socket, channel.id, body);
      expect(sent.input.context.channelPrompt).toBeUndefined();
      await finish(sent.input.runId);
    }

    const patched = await app.fastify.inject({
      method: "PATCH",
      url: `/api/v1/channels/${channel.id}`,
      headers,
      payload: { prompt: "규칙 B" },
    });
    expect(patched.statusCode).toBe(200);

    const after = await mention(claude, socket, channel.id, "@coder 셋");
    expect(after.input.context.channelPrompt).toBe("규칙 B");
    expect(JSON.stringify(after.input)).not.toContain("규칙 A");
    await finish(after.input.runId);

    const devAfter = await mention(openclaw, socket, channel.id, "@dev 셋");
    expect(devAfter.input.context.channelPrompt).toBe("규칙 B");
    await finish(devAfter.input.runId);
  });

  it("릴레이는 받는 에이전트의 provider 로 — dev 의 @coder 는 claude 로, coder 의 @dev 는 OpenClaw 로", async () => {
    const channel = channelWith([dev, coder]);
    const socket = await connect(channel.id);

    const devSend = await mention(openclaw, socket, channel.id, "@dev 시작");
    const claudeBefore = claude.calls.send.length;
    await app.orchestrator.onCanonical(
      {
        outboundId: `out-${uuid()}`,
        conversationId: channelConversation(app.db, channel.id),
        agentId: "dev",
        sessionKey: devSend.input.sessionKey,
        runId: devSend.input.runId,
        text: "@coder 이어서 부탁",
        attachmentIds: [],
        ts: new Date().toISOString(),
      },
      "openclaw",
      FAKE_GATEWAY_ID,
    );
    const relay = await nextSend(claude, claudeBefore);
    expect(relay.input).toMatchObject({ kind: "message", agentId: "coder" });
    expect(getRun(app.db, relay.input.runId)).toMatchObject({
      agentId: coder.id,
      triggerKind: "relay",
      relayDepth: 1,
    });

    // dev 의 첫 런이 세션 큐 맨 앞에 남아 있으면 되돌아온 릴레이가 그 뒤에서 기다린다
    if (getRun(app.db, devSend.input.runId)?.status !== "done") await finish(devSend.input.runId);
    const openclawBefore = openclaw.calls.send.length;
    await app.orchestrator.onCanonical(
      {
        outboundId: `out-${uuid()}`,
        conversationId: channelConversation(app.db, channel.id),
        agentId: "coder",
        sessionKey: relay.input.sessionKey,
        runId: relay.input.runId,
        text: "@dev 다 됐어요",
        attachmentIds: [],
        ts: new Date().toISOString(),
      },
      "claude",
      "fake-runner",
    );
    const back = await nextSend(openclaw, openclawBefore);
    expect(back.input).toMatchObject({ kind: "message", agentId: "dev" });
    expect(getRun(app.db, back.input.runId)).toMatchObject({
      agentId: dev.id,
      triggerKind: "relay",
      relayDepth: 2,
    });
    await finish(back.input.runId);
  });

  it("정본은 보낸 어댑터의 provider 로 에이전트를 푼다 — replyTo 로 닫힌 런에 잇고, 런이 없어도 그 에이전트의 메시지로", async () => {
    const channel = channelWith([coder]);
    const socket = await connect(channel.id);
    const sent = await mention(claude, socket, channel.id, "@coder 부탁");
    await finish(sent.input.runId);

    const late = await app.orchestrator.onCanonical(
      {
        outboundId: `out-${uuid()}`,
        conversationId: channelConversation(app.db, channel.id),
        agentId: "coder",
        sessionKey: sent.input.sessionKey,
        replyToInboundId: sent.input.message.id,
        text: "늦은 답",
        attachmentIds: [],
        ts: new Date().toISOString(),
      },
      "claude",
      "fake-runner",
    );
    const orphan = await app.orchestrator.onCanonical(
      {
        outboundId: `out-${uuid()}`,
        conversationId: channelConversation(app.db, channel.id),
        agentId: "coder",
        sessionKey: sent.input.sessionKey,
        text: "혼잣말",
        attachmentIds: [],
        ts: new Date().toISOString(),
      },
      "claude",
      "fake-runner",
    );

    const stored = listMessages(app.db, channel.id, { limit: 50 }).messages;
    expect(stored.find((m) => m.id === late.messageId)).toMatchObject({
      authorId: coder.id,
      runId: sent.input.runId,
    });
    const alone = stored.find((m) => m.id === orphan.messageId);
    expect(alone).toMatchObject({ authorId: coder.id, bodyMd: "혼잣말" });
    expect(alone?.runId).toBeUndefined();
  });

  it("claude 어댑터의 승인은 claude 에이전트로 — resolveApproval 이 ADAPTER_UNAVAILABLE 을 던지면 ack 도 그 코드, 승인은 pending", async () => {
    const channel = channelWith([coder]);
    const socket = await connect(channel.id);
    const sent = await mention(claude, socket, channel.id, "@coder 파일 써줘");
    const createdAt = new Date();
    const approval: ProviderApproval = {
      providerApprovalId: `runner:${uuid()}`,
      kind: "tool",
      sessionKey: sent.input.sessionKey,
      providerAgentId: "coder",
      conversationId: channelConversation(app.db, channel.id),
      toolCallId: "toolu_registry",
      toolName: "Write",
      title: "Write 실행",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      status: "pending",
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 600_000).toISOString(),
    };
    claude.emitApproval(approval);
    await vi.waitFor(() =>
      expect(approvalStore.getApprovalByProviderId(app.db, approval.providerApprovalId)).toMatchObject({
        status: "pending",
        agentId: coder.id,
        runId: sent.input.runId,
      }),
    );
    const stored = approvalStore.getApprovalByProviderId(app.db, approval.providerApprovalId);

    claude.scriptResolveApproval(() => {
      throw new AdapterError("ADAPTER_UNAVAILABLE", "no runner for this agent");
    });
    const openclawResolves = openclaw.calls.resolveApproval.length;
    expect(
      await socket.emitWithAck("approval.resolve", { approvalId: stored?.id ?? "", decision: "allow-once" }),
    ).toMatchObject({ ok: false, error: { code: "ADAPTER_UNAVAILABLE" } });
    expect(claude.calls.resolveApproval).toContainEqual({
      providerApprovalId: approval.providerApprovalId,
      kind: "tool",
      decision: "allow-once",
    });
    expect(openclaw.calls.resolveApproval.length).toBe(openclawResolves);
    expect(approvalStore.getApprovalByProviderId(app.db, approval.providerApprovalId)?.status).toBe(
      "pending",
    );
    await finish(sent.input.runId);
  });

  it("dodok.usage 를 runs.usage 에 담고, 운영 요약은 믿는 제공자(claude)의 런만 토큰·비용을 합친다", async () => {
    const channel = channelWith([dev, coder]);
    const socket = await connect(channel.id);

    const claudeRun = await mention(claude, socket, channel.id, "@coder 계산");
    claude.emit({
      kind: "run_event",
      runId: claudeRun.input.runId,
      event: {
        type: "CUSTOM",
        runId: claudeRun.input.runId,
        name: "dodok.usage",
        value: { inputTokens: 100, outputTokens: 20, costUsd: 0.25, costKind: "subscription_estimate" },
      },
    });
    await vi.waitFor(() =>
      expect(getRun(app.db, claudeRun.input.runId)?.usage).toEqual({
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.25,
        costKind: "subscription_estimate",
      }),
    );
    await finish(claudeRun.input.runId);

    const devRun = await mention(openclaw, socket, channel.id, "@dev 계산");
    openclaw.emit({
      kind: "run_event",
      runId: devRun.input.runId,
      event: {
        type: "CUSTOM",
        runId: devRun.input.runId,
        name: "openclaw.usage",
        value: { inputTokens: 1000, outputTokens: 1000, costUsd: 9 },
      },
    });
    await vi.waitFor(() => expect(getRun(app.db, devRun.input.runId)?.usage?.costUsd).toBe(9));
    await finish(devRun.input.runId);

    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/ops/runs?days=1", headers });
    expect(res.statusCode).toBe(200);
    const summary = res.json() as {
      usageTrustedProviders: string[];
      byChannel: Array<{ id: string; tokens?: number; costUsd?: number }>;
      byAgent: Array<{ id: string; tokens?: number; costUsd?: number }>;
    };
    expect(summary.usageTrustedProviders).toEqual(["claude"]);
    expect(summary.byChannel.find((r) => r.id === channel.id)).toMatchObject({ tokens: 120, costUsd: 0.25 });
    expect(summary.byAgent.find((r) => r.id === coder.id)).toMatchObject({ tokens: 120, costUsd: 0.25 });
    const devRow = summary.byAgent.find((r) => r.id === dev.id);
    expect(devRow).toBeDefined();
    expect(devRow).not.toHaveProperty("tokens");
    expect(devRow).not.toHaveProperty("costUsd");
  });

  it("어댑터가 없는 provider(codex) 에이전트 멘션은 ADAPTER_UNAVAILABLE run_error 카드로 닫힌다", async () => {
    const channel = channelWith([codexer]);
    const socket = await connect(channel.id);
    const sends = openclaw.calls.send.length + claude.calls.send.length;

    await say(socket, channel.id, "@codexer 부탁");

    await vi.waitFor(() => {
      const card = listMessages(app.db, channel.id, { limit: 50 }).messages.find(
        (m) => m.systemMeta?.kind === "run_error",
      );
      expect(card?.bodyMd).toContain("ADAPTER_UNAVAILABLE");
    });
    expect(openclaw.calls.send.length + claude.calls.send.length).toBe(sends);
  });

  it("GET /adapter/status 는 어댑터마다 상태와 capabilities 를 싣는다", async () => {
    const res = await app.fastify.inject({ method: "GET", url: "/api/v1/adapter/status", headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      statuses: [
        { provider: "openclaw", gateways: [fakeGatewayStatus()] },
        { provider: "claude", runners: { connected: 1, tokens: 1 } },
      ],
      capabilities: {
        openclaw: openclaw.capabilities(),
        claude: {
          agentsList: true,
          configSet: true,
          promptEveryRun: true,
          serverSessionIds: true,
        },
      },
    });
  });

  it("wire adapter.status 는 어댑터마다 자기 상태로 나간다", async () => {
    const channel = channelWith([]);
    const socket = await connect(channel.id);
    const seen: unknown[] = [];
    socket.on("adapter.status", (s) => seen.push(s));
    const openclawStatus: AdapterStatus = {
      provider: "openclaw",
      gateways: [fakeGatewayStatus({ gateway: "reconnecting" })],
    };
    const claudeStatus = { provider: "claude", runners: { connected: 0, tokens: 1 } } as const;
    openclaw.emit({ kind: "status", status: openclawStatus, capabilities: openclaw.capabilities() });
    claude.emit({ kind: "status", status: claudeStatus, capabilities: claude.capabilities() });
    await vi.waitFor(() => expect(seen).toEqual([openclawStatus, claudeStatus]));
  });
});
