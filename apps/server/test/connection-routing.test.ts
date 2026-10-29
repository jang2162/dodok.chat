import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { Message, OutboundMessage, ProviderApproval } from "@dodok/shared";
import { eq } from "drizzle-orm";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdapterRegistry } from "../src/adapters/registry";
import {
  agents,
  agentSessions,
  approvals,
  gateways,
  messages,
  runnerTokens,
  runs,
} from "../src/db/schema.sqlite";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { getRun } from "../src/modules/runs/store";
import { ServerBus } from "../src/realtime/bus";
import { createServices, sessionRecoverTargets } from "../src/wiring";
import { newTestDb } from "./helpers/db";
import { channelConversation, seedAgentSession, seedWorkspace } from "./helpers/seed";

// 멀티 Gateway 계획 태스크 1 — 런·정본·승인·대기열을 「연결 id + 세션 키」로 가른다. 두 Gateway 의 main 은 세션 키가 같다

function setup() {
  const db = newTestDb();
  const bus = new ServerBus();
  const openclaw = new FakeAdapter();
  const claude = new FakeAdapter({ provider: "runner" });
  const { workspaceId, userId } = seedWorkspace(db);
  const now = new Date();
  for (const [id, name] of [
    ["g1", "사무실"],
    ["g2", "집"],
    ["g3", "작업실"],
  ] as const) {
    db.insert(gateways)
      .values({
        id,
        workspaceId,
        name,
        url: `wss://${id}.example`,
        token: "t",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
  const agent = (handle: string, provider: string, providerAgentId: string, gatewayId: string | null) => {
    const id = uuid();
    db.insert(agents)
      .values({ id, workspaceId, provider, providerAgentId, handle, name: handle, createdAt: now, gatewayId })
      .run();
    return id;
  };
  const office = agent("main-office", "openclaw", "main", "g1");
  const home = agent("main-home", "openclaw", "main", "g2");
  const coder = agent("coder", "runner", "coder", null);
  const logger = pino({ level: "silent" });
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  for (const memberId of [office, home, coder])
    addMember(db, channel.id, { memberType: "agent", memberId }, logger);
  const services = createServices({
    db,
    bus,
    logger,
    registry: createAdapterRegistry([openclaw, claude]),
    workspaceId,
  });

  let n = 0;
  const say = (): Message =>
    createUserMessage(db, bus, {
      conversationId: channelConversation(db, channel.id),
      authorId: userId,
      bodyMd: "안녕",
      clientMsgId: `c${++n}`,
    });
  const mention = (agentId: string) => {
    const message = say();
    return services.orchestrator.enqueueRun(
      {
        agentId,
        channelId: channel.id,
        conversationId: channelConversation(db, channel.id),
        triggerKind: "mention",
        rootMessageId: message.id,
        relayDepth: 0,
      },
      { message },
    );
  };
  const connectionOf = (runId: string) =>
    db.select({ c: runs.connectionId }).from(runs).where(eq(runs.id, runId)).get()?.c;
  const sessionKey = `agent:main:dodok:channel:${channelConversation(db, channel.id)}`;
  const outbound = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
    outboundId: `out-${++n}`,
    conversationId: channelConversation(db, channel.id),
    agentId: "main",
    sessionKey,
    text: "답입니다",
    attachmentIds: [],
    ts: new Date().toISOString(),
    ...over,
  });
  const approval = (over: Partial<ProviderApproval> = {}): ProviderApproval => ({
    providerApprovalId: "plugin:same",
    kind: "plugin",
    sessionKey,
    providerAgentId: "main",
    conversationId: channelConversation(db, channel.id),
    title: "Write 실행",
    severity: "warning",
    allowedDecisions: ["allow-once", "deny"],
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    ...over,
  });
  const flush = () => vi.advanceTimersByTimeAsync(0);
  // 묶임 없던 러너 에이전트를 그 토큰에 묶는다 — 런 라우팅만 재는 행(프로젝트 없음)이라 러너 정의와는 상관없다
  const bindCoder = (tokenId: string) => {
    db.insert(runnerTokens)
      .values({
        id: tokenId,
        workspaceId,
        label: tokenId,
        hash: tokenId.padEnd(64, "0"),
        prefix: "AAAAAA",
        createdAt: now,
      })
      .run();
    db.update(agents).set({ runnerTokenId: tokenId }).where(eq(agents.id, coder)).run();
  };
  return {
    db,
    openclaw,
    claude,
    services,
    channelId: channel.id,
    conversationId: channelConversation(db, channel.id),
    userId,
    office,
    home,
    coder,
    mention,
    connectionOf,
    sessionKey,
    outbound,
    approval,
    flush,
    bindCoder,
  };
}

describe("연결 단위 대조", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    vi.useFakeTimers();
    t = setup();
  });
  afterEach(() => {
    t.services.orchestrator.stop();
    vi.useRealTimers();
  });

  it("두 Gateway 의 main 을 각각 멘션하면 런의 연결이 g1·g2 로 갈리고 세션 키는 같다", async () => {
    const a = await t.mention(t.office);
    const b = await t.mention(t.home);
    await t.flush();
    expect(a.sessionKey).toBe(t.sessionKey);
    expect(b.sessionKey).toBe(t.sessionKey);
    expect(t.openclaw.calls.connections.send).toEqual(["g1", "g2"]);
    expect(t.connectionOf(a.id)).toBe("g1");
    expect(t.connectionOf(b.id)).toBe("g2");
  });

  it("g1 의 런이 진행 중이어도 같은 세션 키의 g2 런은 대기열에서 기다리지 않는다", async () => {
    const a = await t.mention(t.office);
    await t.flush();
    t.openclaw.emit({
      kind: "run_signal",
      runId: a.id,
      connectionId: "g1",
      signal: { kind: "gateway_started" },
    });
    expect(getRun(t.db, a.id)?.status).toBe("streaming");
    const b = await t.mention(t.home);
    await t.flush();
    expect(t.openclaw.calls.send.map((s) => s.runId)).toEqual([a.id, b.id]);
  });

  it("g2 연결의 정본은 main-home 의 메시지가 되고 g1 의 런은 열린 채다", async () => {
    const a = await t.mention(t.office);
    const b = await t.mention(t.home);
    await t.flush();
    const { messageId } = await t.services.orchestrator.onCanonical(t.outbound(), "openclaw", "g2");
    const stored = t.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId ?? ""))
      .get();
    expect(stored?.authorId).toBe(t.home);
    expect(stored?.runId).toBe(b.id);
    expect(getRun(t.db, a.id)?.status).toBe("queued");
  });

  it("다른 연결의 런 id 를 실은 정본은 그 런에 붙지 않는다 — 자기 연결의 열린 런으로 간다", async () => {
    const a = await t.mention(t.office);
    const b = await t.mention(t.home);
    await t.flush();
    const { messageId } = await t.services.orchestrator.onCanonical(
      t.outbound({ runId: a.id }),
      "openclaw",
      "g2",
    );
    const stored = t.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId ?? ""))
      .get();
    expect(stored?.runId).toBe(b.id);
    expect(stored?.authorId).toBe(t.home);
  });

  it("다른 연결이 낸 런 이벤트·신호는 그 런에 반영하지 않는다", async () => {
    const a = await t.mention(t.office);
    await t.flush();
    t.openclaw.emit({
      kind: "run_signal",
      runId: a.id,
      connectionId: "g2",
      signal: { kind: "gateway_started" },
    });
    await t.flush();
    expect(getRun(t.db, a.id)?.status).toBe("queued");
    t.openclaw.emit({
      kind: "run_signal",
      runId: a.id,
      connectionId: "g1",
      signal: { kind: "gateway_started" },
    });
    await t.flush();
    expect(getRun(t.db, a.id)?.status).toBe("streaming");
  });

  it("두 연결이 같은 providerApprovalId 로 승인을 내도 각자 맞는 런·에이전트에 붙는다", async () => {
    const a = await t.mention(t.office);
    const b = await t.mention(t.home);
    await t.flush();
    t.openclaw.emitApproval(t.approval(), "g1");
    t.openclaw.emitApproval(t.approval(), "g2");
    await t.flush();
    const rows = t.db
      .select({ connectionId: approvals.connectionId, agentId: approvals.agentId, runId: approvals.runId })
      .from(approvals)
      .where(eq(approvals.providerApprovalId, "plugin:same"))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { connectionId: "g1", agentId: t.office, runId: a.id },
        { connectionId: "g2", agentId: t.home, runId: b.id },
      ]),
    );
  });

  it("승인 결정은 그 승인이 온 연결로 보낸다 — 그 사이 에이전트를 다른 Gateway 로 옮겨도", async () => {
    await t.mention(t.office);
    await t.mention(t.home);
    await t.flush();
    t.openclaw.emitApproval(t.approval(), "g2");
    await t.flush();
    const row = t.db.select().from(approvals).where(eq(approvals.connectionId, "g2")).get();
    expect(row?.agentId).toBe(t.home);
    t.db.update(agents).set({ gatewayId: "g3" }).where(eq(agents.id, t.home)).run();
    const resolved = await t.services.approvals.resolve({
      approvalId: row?.id ?? "",
      decision: "allow-once",
      userId: t.userId,
    });
    expect(resolved.status).toBe("allowed");
    expect(t.openclaw.calls.connections.resolveApproval).toEqual(["g2"]);
  });

  it("두 연결이 같은 providerRunId 를 내도 각 런에 기록된다", async () => {
    t.openclaw.script(() => ({ admission: "dispatch", providerRunId: "oc-run-1" }));
    const a = await t.mention(t.office);
    const b = await t.mention(t.home);
    await t.flush();
    expect(getRun(t.db, a.id)).toMatchObject({ providerRunId: "oc-run-1", status: "queued" });
    expect(getRun(t.db, b.id)).toMatchObject({ providerRunId: "oc-run-1", status: "queued" });
  });

  it("멈춤·리셋은 그 런·에이전트의 연결로 보낸다", async () => {
    const b = await t.mention(t.home);
    await t.flush();
    await t.services.orchestrator.abort(b.id);
    expect(t.openclaw.calls.connections.abort).toEqual(["g2"]);
  });

  it("세션 복구 대상은 연결별로 나뉜다 — OpenClaw 에이전트 세션만", async () => {
    await t.mention(t.office);
    await t.mention(t.home);
    await t.mention(t.coder);
    await t.flush();
    const targets = sessionRecoverTargets(t.db);
    expect([...targets.keys()].sort()).toEqual(["g1", "g2"]);
    expect(targets.get("g1")).toEqual([{ sessionKey: t.sessionKey, agentId: "main" }]);
    expect(targets.get("g2")).toEqual([{ sessionKey: t.sessionKey, agentId: "main" }]);
  });

  it("묶임 없는 러너 에이전트 — send 결과의 러너 토큰 id 가 런에 남고, 그 러너의 이벤트가 같은 런으로 이어진다", async () => {
    t.claude.script((input, opts) => ({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: opts.connectionId ?? "tok-laptop",
    }));
    const run = await t.mention(t.coder);
    await t.flush();
    expect(t.claude.calls.connections.send).toEqual([null]);
    expect(t.connectionOf(run.id)).toBe("tok-laptop");
    t.claude.emit({
      kind: "run_signal",
      runId: run.id,
      connectionId: "tok-other",
      signal: { kind: "gateway_started" },
    });
    await t.flush();
    expect(getRun(t.db, run.id)?.status).toBe("queued");
    t.claude.emit({
      kind: "run_signal",
      runId: run.id,
      connectionId: "tok-laptop",
      signal: { kind: "gateway_started" },
    });
    await t.flush();
    expect(getRun(t.db, run.id)?.status).toBe("streaming");
    const { messageId } = await t.services.orchestrator.onCanonical(
      t.outbound({
        agentId: "coder",
        sessionKey: `agent:coder:dodok:channel:${t.conversationId}`,
        runId: run.id,
      }),
      "runner",
      "tok-laptop",
    );
    const stored = t.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId ?? ""))
      .get();
    expect(stored).toMatchObject({ authorId: t.coder, runId: run.id });
  });
  it("다른 연결이 낸 run_session 은 세션 행에 저장하지 않는다 — 그 런의 연결이 낸 것만 [태스크 3 리뷰 L2]", async () => {
    // 세션 id 를 스스로 짓는 프로그램처럼 — 서버가 id 를 짓지 않아 세션 행이 비어 있다
    t.claude.setCapabilities({
      agentsList: false,
      configSet: true,
      promptEveryRun: true,
      serverSessionIds: false,
    });
    t.claude.script((input, opts) => ({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: opts.connectionId ?? "tok-laptop",
    }));
    const run = await t.mention(t.coder);
    await t.flush();
    expect(t.connectionOf(run.id)).toBe("tok-laptop");
    const stored = () =>
      t.db
        .select({ id: agentSessions.providerSessionId })
        .from(agentSessions)
        .where(eq(agentSessions.agentId, t.coder))
        .get()?.id;
    t.claude.emit({
      kind: "run_session",
      runId: run.id,
      connectionId: "tok-other",
      providerSessionId: "hijack",
    });
    await t.flush();
    expect(stored()).toBeNull();
    t.claude.emit({
      kind: "run_session",
      runId: run.id,
      connectionId: "tok-laptop",
      providerSessionId: "thread_1",
    });
    await t.flush();
    expect(stored()).toBe("thread_1");
  });

  it("기다리던 런이 그 사이 묶인 러너로 나가면 send 결과의 연결이 런에 남고 그 런의 승인이 그 런에 붙는다", async () => {
    t.claude.script((input, opts) => ({
      admission: "dispatch",
      providerRunId: input.runId,
      connectionId: opts.connectionId ?? "tok-laptop",
    }));
    const a = await t.mention(t.coder);
    const b = await t.mention(t.coder);
    await t.flush();
    expect(t.claude.calls.send.map((s) => s.runId)).toEqual([a.id]);
    t.bindCoder("tok-laptop");
    t.claude.emit({
      kind: "run_signal",
      runId: a.id,
      connectionId: "tok-laptop",
      signal: { kind: "gateway_error", code: "X", message: "x" },
    });
    await t.flush();
    expect(t.claude.calls.connections.send).toEqual([null, "tok-laptop"]);
    expect(t.connectionOf(b.id)).toBe("tok-laptop");
    t.claude.emitApproval(
      t.approval({
        providerApprovalId: "runner:b",
        sessionKey: `agent:coder:dodok:channel:${t.conversationId}`,
        providerAgentId: "coder",
      }),
      "tok-laptop",
    );
    await t.flush();
    const row = t.db.select().from(approvals).where(eq(approvals.providerApprovalId, "runner:b")).get();
    expect(row).toMatchObject({ agentId: t.coder, runId: b.id, connectionId: "tok-laptop" });
    expect(getRun(t.db, b.id)?.status).toBe("awaiting_approval");
  });

  it("묶임 없는 러너 에이전트의 승인·런 없는 정본은 어느 러너 토큰 연결로 와도 그 에이전트에 붙는다", async () => {
    const coderKey = `agent:coder:dodok:channel:${t.conversationId}`;
    t.claude.emitApproval(
      t.approval({ providerApprovalId: "runner:x", sessionKey: coderKey, providerAgentId: "coder" }),
      "tok-other",
    );
    await t.flush();
    const row = t.db.select().from(approvals).where(eq(approvals.providerApprovalId, "runner:x")).get();
    expect(row).toMatchObject({ agentId: t.coder, connectionId: "tok-other" });
    seedAgentSession(t.db, { conversationId: t.conversationId, agentId: t.coder });
    const { messageId } = await t.services.orchestrator.onCanonical(
      t.outbound({ agentId: "coder", sessionKey: coderKey }),
      "runner",
      "tok-other",
    );
    const stored = t.db
      .select()
      .from(messages)
      .where(eq(messages.id, messageId ?? ""))
      .get();
    expect(stored?.authorId).toBe(t.coder);
  });
});
