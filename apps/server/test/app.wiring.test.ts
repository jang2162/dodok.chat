import { AdapterError } from "@dodok/openclaw-adapter";
import { FakeAdapter, type FakeGatewayState } from "@dodok/openclaw-adapter/fake";
import { type AdapterStatus, BRIDGE_PROTOCOL, type Message, WIRE_PROTOCOL } from "@dodok/shared";
import Database from "better-sqlite3";
import { and, eq, isNull } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { io as connectSocket, type Socket } from "socket.io-client";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { type App, createApp, watchGatewayReconnecting } from "../src/app";
import { loadConfig } from "../src/config";
import { agentSessions, agents } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, listMessages } from "../src/modules/messages/service";
import { getRun, listRunEvents } from "../src/modules/runs/store";
import { ensureSession } from "../src/modules/sessions/service";
import { ServerBus } from "../src/realtime/bus";
import { sessionRecoverTargets } from "../src/wiring";
import { bootTestApp, login } from "./helpers/app";
import { testEnv } from "./helpers/env";
import { FAKE_GATEWAY_ID, fakeGatewayStatus } from "./helpers/gateways";
import { connectWire, openWire, type WireClient, waitFor } from "./helpers/wire";
import { openclawOf, soleGateway } from "./helpers/openclaw";

type Method = "GET" | "POST" | "PATCH";

/** 앱당 login 은 한 번만 — /auth/local 은 5회/분 레이트리밋 */
async function authed(app: App) {
  const session = await login(app);
  const api = (method: Method, url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers: session.headers,
      ...(payload === undefined ? {} : { payload }),
    });
  return { token: session.token, api };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "dodok-wiring-"));
}

/** 로그를 줄 단위로 모은다 — warn 단언용 */
function captureLogger() {
  const lines: Array<{ level: number; msg?: string } & Record<string, unknown>> = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(JSON.parse(line)) });
  return { logger, lines };
}

function seedAgentChannel(app: App, name: string, agentId?: string, gatewayId = FAKE_GATEWAY_ID) {
  const agent =
    agentId === undefined
      ? createAgent(app.db, {
          gatewayId,
          workspaceId: app.workspaceId,
          providerAgentId: "dev",
          handle: "dev",
          name: "Dev",
        })
      : { id: agentId };
  const channel = createChannel(app.db, { workspaceId: app.workspaceId, createdBy: app.ownerUserId, name });
  addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
  return { agentId: agent.id, channelId: channel.id };
}

/** threadRootId 를 주면 그 스레드의 답글로 스레드 런 */
async function startRun(app: App, channelId: string, agentId: string, threadRootId?: string) {
  const message = createUserMessage(app.db, app.bus, {
    channelId,
    authorId: app.ownerUserId,
    bodyMd: "@dev 안녕",
    clientMsgId: uuid(),
    threadRootId,
  });
  return app.orchestrator.enqueueRun(
    {
      agentId,
      channelId,
      triggerKind: "mention",
      rootMessageId: message.id,
      relayDepth: 0,
      ...(threadRootId === undefined ? {} : { threadRootId }),
    },
    { message },
  );
}

/** threadRootId 가 없으면 채널 세션 행 */
function sessionRow(app: App, channelId: string, agentId: string, threadRootId?: string) {
  return app.db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.channelId, channelId),
        eq(agentSessions.agentId, agentId),
        threadRootId === undefined
          ? isNull(agentSessions.threadRootId)
          : eq(agentSessions.threadRootId, threadRootId),
      ),
    )
    .get();
}

function systemMessages(app: App, channelId: string): Message[] {
  return listMessages(app.db, channelId, { limit: 200 }).messages.filter((m) => m.kind === "system");
}

describe("부팅 정리 — 파일 DB 로 두 번 부팅", () => {
  it("첫 부팅에서 끝나지 않은 런을 두 번째 부팅의 recoverOnBoot 가 SERVER_RESTART 로 닫고, 그 뒤에 adapter.connect() 를 부른다", async () => {
    const base = tempDir();
    const DB_PATH = join(base, "dodok.sqlite");
    try {
      const firstAdapter = new FakeAdapter();
      const first = await bootTestApp({ DB_PATH }, { adapters: [firstAdapter] });
      const { agentId, channelId } = seedAgentChannel(first, "restart");
      const run = await startRun(first, channelId, agentId);
      await vi.waitFor(() => expect(firstAdapter.calls.send).toHaveLength(1));
      firstAdapter.emit({ kind: "run_signal", runId: run.id, signal: { kind: "gateway_started" } });
      expect(getRun(first.db, run.id)?.status).toBe("streaming");
      await first.close(); // 런을 끝내지 않고 닫는다

      const secondAdapter = new FakeAdapter();
      let statusAtConnect: string | undefined;
      vi.spyOn(secondAdapter, "connect").mockImplementation(async () => {
        // createApp 이 끝나기 전이라 app.db 가 없다 — 같은 파일을 따로 열어 본다
        const peek = new Database(DB_PATH, { readonly: true });
        statusAtConnect = (
          peek.prepare("select status from runs where id = ?").get(run.id) as { status: string }
        ).status;
        peek.close();
      });
      const second = await bootTestApp({ DB_PATH }, { adapters: [secondAdapter] });
      try {
        expect(secondAdapter.connect).toHaveBeenCalledTimes(1);
        expect(statusAtConnect).toBe("error");
        expect(getRun(second.db, run.id)).toMatchObject({
          status: "error",
          error: { code: "SERVER_RESTART" },
          endedAt: expect.any(String),
        });
        expect(
          listRunEvents(second.db, run.id, 0)
            .map((e) => e.type)
            .slice(-2),
        ).toEqual(["STATE_SNAPSHOT", "RUN_ERROR"]);
        expect(second.orchestrator.activeRuns(channelId)).toEqual([]);
        // 어댑터 연결 전 정리 — Gateway abort·forgetRun 을 부르지 않는다
        expect(secondAdapter.calls.abort).toEqual([]);
        expect(secondAdapter.calls.forget).toEqual([]);
      } finally {
        await second.close();
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("sessionRecoverTargets 는 agent_sessions 를 { sessionKey, agentId: providerAgentId, cursor? } 로 돌려준다", async () => {
    const app = await bootTestApp();
    try {
      const { agentId, channelId } = seedAgentChannel(app, "recover");
      const other = createAgent(app.db, {
        gatewayId: FAKE_GATEWAY_ID,
        workspaceId: app.workspaceId,
        providerAgentId: "fin-provider",
        handle: "fin",
        name: "Fin",
      });
      addMember(app.db, channelId, { memberType: "agent", memberId: other.id }, app.logger);
      expect(sessionRecoverTargets(app.db).size).toBe(0);

      ensureSession(app.db, openclawOf(app), { channelId, agentId });
      ensureSession(app.db, openclawOf(app), { channelId, agentId: other.id });
      app.db
        .update(agentSessions)
        .set({ historyCursor: "cursor-1" })
        .where(eq(agentSessions.agentId, other.id))
        .run();

      // gateway_id 가 빈 OpenClaw 에이전트는 .env 의 Gateway 하나(연결 env)로 모인다
      const targets = sessionRecoverTargets(app.db);
      expect([...targets.keys()]).toEqual([FAKE_GATEWAY_ID]);
      expect(targets.get(FAKE_GATEWAY_ID)).toEqual(
        expect.arrayContaining([
          { sessionKey: `agent:dev:dodok:channel:${channelId}`, agentId: "dev" },
          {
            sessionKey: `agent:fin-provider:dodok:channel:${channelId}`,
            agentId: "fin-provider",
            cursor: "cursor-1",
          },
        ]),
      );
      expect(targets.get(FAKE_GATEWAY_ID)).toHaveLength(2);

      // OpenClaw 가 아닌 에이전트의 세션은 Gateway 에 없다 — 복구 대상이 아니다
      app.db.update(agents).set({ provider: "claude" }).where(eq(agents.id, other.id)).run();
      expect(sessionRecoverTargets(app.db)).toEqual(
        new Map([
          [FAKE_GATEWAY_ID, [{ sessionKey: `agent:dev:dodok:channel:${channelId}`, agentId: "dev" }]],
        ]),
      );
    } finally {
      await app.close();
    }
  });
});

describe("REST·wire 배선 (FakeAdapter)", () => {
  let app: App;
  let adapter: FakeAdapter;
  let token: string;
  let api: Awaited<ReturnType<typeof authed>>["api"];
  let dev: string;
  const sockets: WireClient[] = [];

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapters: [adapter] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ({ token, api } = await authed(app));
    dev = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
    }).id;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    adapter.setGatewayState({ gateway: "connected", bridge: "connected" });
    adapter.setCapabilities({
      sessionReset: true,
      agentsList: true,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    await app.close();
  });

  it("App 은 주입한 어댑터(레지스트리)와 서비스(orchestrator·router·runs)를 노출한다", () => {
    expect(app.registry.all()).toEqual([adapter]);
    expect(app.registry.forProvider("openclaw")).toBe(adapter);
    expect(app.orchestrator).toBe(app.services.orchestrator);
    expect(app.services.router.routeMessage).toEqual(expect.any(Function));
    expect(app.services.runs.activeRuns).toEqual(expect.any(Function));
    expect(app.services.runs.pendingApprovals).toEqual(expect.any(Function));
    expect(app.services.approvals.ingest).toEqual(expect.any(Function));
  });

  it("PATCH /channels/:id { prompt } 는 앱의 어댑터 syncChannelConfig 를 부른다", async () => {
    const { channelId } = seedAgentChannel(app, "sync", dev);
    const before = adapter.calls.syncChannelConfig.length;
    const res = await api("PATCH", `/channels/${channelId}`, { prompt: "짧게" });
    expect(res.statusCode).toBe(200);
    expect(adapter.calls.syncChannelConfig.slice(before)).toEqual([
      { channelId, config: { systemPrompt: "짧게" } },
    ]);
  });

  it("POST /channels/:id/agents/:agentId/reset — 진행 런 abort → resetSession(ensureSession 키) → 세션 리비전·시작 시각 갱신 → info 시스템 메시지", async () => {
    const { channelId } = seedAgentChannel(app, "reset-ok", dev);
    const fin = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "fin",
      handle: "fin",
      name: "Fin",
    });
    addMember(app.db, channelId, { memberType: "agent", memberId: fin.id }, app.logger);
    const run = await startRun(app, channelId, dev);
    const otherRun = await startRun(app, channelId, fin.id); // 같은 채널, 다른 에이전트 세션
    await vi.waitFor(() => expect(adapter.calls.send.some((s) => s.runId === run.id)).toBe(true));
    const session = sessionRow(app, channelId, dev);
    expect(session).toMatchObject({ promptRevisionAtStart: 1, sessionStartedAt: null });
    expect(
      (await api("PATCH", `/channels/${channelId}`, { prompt: "새 규칙" })).json().channel.promptRevision,
    ).toBe(2);
    const abortSpy = vi.spyOn(adapter, "abort");
    const resetSpy = vi.spyOn(adapter, "resetSession");
    const resetsBefore = adapter.calls.reset.length;

    const res = await api("POST", `/channels/${channelId}/agents/${dev}/reset`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(adapter.calls.reset.slice(resetsBefore)).toEqual([session?.sessionKey]);
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith(run.id, session?.sessionKey, FAKE_GATEWAY_ID);
    expect(getRun(app.db, otherRun.id)?.status).toBe("queued");
    expect(abortSpy.mock.invocationCallOrder[0]).toBeLessThan(resetSpy.mock.invocationCallOrder[0] ?? 0);
    expect(getRun(app.db, run.id)?.status).toBe("aborted");
    expect(sessionRow(app, channelId, dev)).toMatchObject({
      sessionKey: session?.sessionKey,
      promptRevisionAtStart: 2,
      sessionStartedAt: expect.any(Date),
      lifecycleRevision: "fake-1",
    });
    expect(systemMessages(app, channelId)).toEqual([
      expect.objectContaining({
        authorType: "system",
        bodyMd: "@dev 의 대화를 새로 시작했습니다",
        systemMeta: { kind: "info" },
      }),
    ]);

    // 진행 런이 없으면 abort 하지 않는다
    abortSpy.mockClear();
    expect((await api("POST", `/channels/${channelId}/agents/${dev}/reset`)).statusCode).toBe(200);
    expect(abortSpy).not.toHaveBeenCalled();
    expect(systemMessages(app, channelId)).toHaveLength(2);
  });

  it("reset — 같은 에이전트의 대기 런은 진행 런보다 먼저 닫아 Gateway 로 나가지 않는다(대기 런은 adapter.abort 없이)", async () => {
    const { channelId } = seedAgentChannel(app, "reset-queue", dev);
    const first = await startRun(app, channelId, dev);
    const second = await startRun(app, channelId, dev); // 같은 세션 — 대기
    await vi.waitFor(() => expect(adapter.calls.send.some((s) => s.runId === first.id)).toBe(true));
    expect(adapter.calls.send.some((s) => s.runId === second.id)).toBe(false);
    const abortSpy = vi.spyOn(adapter, "abort");
    const sendsBefore = adapter.calls.send.length;

    expect((await api("POST", `/channels/${channelId}/agents/${dev}/reset`)).statusCode).toBe(200);

    expect(adapter.calls.send).toHaveLength(sendsBefore); // 대기 런이 Gateway 로 나가지 않았다
    expect(getRun(app.db, first.id)?.status).toBe("aborted");
    expect(getRun(app.db, second.id)?.status).toBe("aborted");
    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(abortSpy).toHaveBeenCalledWith(first.id, expect.any(String), FAKE_GATEWAY_ID);
  });

  it("reset — sessionReset capability 가 없으면 409 CONFLICT(ADAPTER_CAPABILITY_MISSING), 어댑터·세션·메시지를 건드리지 않는다", async () => {
    const { channelId } = seedAgentChannel(app, "reset-cap", dev);
    adapter.setCapabilities({
      sessionReset: false,
      agentsList: true,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });
    const resetsBefore = adapter.calls.reset.length;

    const res = await api("POST", `/channels/${channelId}/agents/${dev}/reset`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: "CONFLICT",
      message: "ADAPTER_CAPABILITY_MISSING: sessions.reset 권한 없음",
    });
    expect(adapter.calls.reset).toHaveLength(resetsBefore);
    expect(systemMessages(app, channelId)).toEqual([]);
  });

  it("reset — AdapterError 는 코드대로(ADAPTER_UNAVAILABLE 503), Gateway FORBIDDEN 은 409 ADAPTER_CAPABILITY_MISSING, 멤버가 아니면 404", async () => {
    const { channelId } = seedAgentChannel(app, "reset-err", dev);
    vi.spyOn(adapter, "resetSession")
      .mockRejectedValueOnce(new AdapterError("ADAPTER_UNAVAILABLE", "sessions.reset: gateway not connected"))
      .mockRejectedValueOnce(new AdapterError("FORBIDDEN", "sessions.reset: missing scope operator.admin"));

    const unavailable = await api("POST", `/channels/${channelId}/agents/${dev}/reset`);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      code: "ADAPTER_UNAVAILABLE",
      message: "sessions.reset: gateway not connected",
    });

    const forbidden = await api("POST", `/channels/${channelId}/agents/${dev}/reset`);
    expect(forbidden.statusCode).toBe(409);
    expect(forbidden.json()).toMatchObject({
      code: "CONFLICT",
      message: expect.stringMatching(/^ADAPTER_CAPABILITY_MISSING/),
    });

    expect(sessionRow(app, channelId, dev)?.sessionStartedAt).toBeNull();
    expect(systemMessages(app, channelId)).toEqual([]);

    const outsider = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "ops",
      handle: "ops",
      name: "Ops",
    });
    expect((await api("POST", `/channels/${channelId}/agents/${outsider.id}/reset`)).statusCode).toBe(404);
    expect((await api("POST", `/channels/${uuid()}/agents/${dev}/reset`)).statusCode).toBe(404);
    expect((await api("POST", `/channels/${channelId}/agents/not-an-id/reset`)).statusCode).toBe(400);
  });

  it("reset — 저장된 providerAgentId 가 세션 키 규칙 밖이면 500 이 아니라 400 VALIDATION(런 경로와 같은 사유), 어댑터를 건드리지 않는다", async () => {
    const bad = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "bad:id",
      handle: "badid",
      name: "Bad",
    }).id;
    const { channelId } = seedAgentChannel(app, "reset-badid", bad);
    const resetsBefore = adapter.calls.reset.length;

    const res = await api("POST", `/channels/${channelId}/agents/${bad}/reset`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      code: "VALIDATION",
      message:
        "OpenClaw 에이전트 id 가 세션 키 규칙(영문·숫자·_·-)에 맞지 않습니다 — 올바른 id 로 에이전트를 다시 등록하세요",
    });
    expect(adapter.calls.reset).toHaveLength(resetsBefore);
    expect(systemMessages(app, channelId)).toEqual([]);
  });

  it("reset?threadRootId — 그 스레드 세션만: 스레드 런만 abort·스레드 키로 resetSession·스레드 행 갱신·info 는 스레드에", async () => {
    const { channelId } = seedAgentChannel(app, "reset-thread", dev);
    const root = createUserMessage(app.db, app.bus, {
      channelId,
      authorId: app.ownerUserId,
      bodyMd: "루트",
      clientMsgId: uuid(),
    });
    const channelRun = await startRun(app, channelId, dev);
    const threadRun = await startRun(app, channelId, dev, root.id);
    await vi.waitFor(() =>
      expect(adapter.calls.send.filter((s) => [channelRun.id, threadRun.id].includes(s.runId))).toHaveLength(
        2,
      ),
    );
    const channelSession = sessionRow(app, channelId, dev);
    const threadSession = sessionRow(app, channelId, dev, root.id);
    expect(threadSession?.sessionKey).toBe(`agent:dev:dodok:channel:${channelId}:thread:${root.id}`);
    const abortSpy = vi.spyOn(adapter, "abort");
    const resetsBefore = adapter.calls.reset.length;

    const res = await api("POST", `/channels/${channelId}/agents/${dev}/reset?threadRootId=${root.id}`);

    expect(res.statusCode).toBe(200);
    expect(adapter.calls.reset.slice(resetsBefore)).toEqual([threadSession?.sessionKey]);
    expect(abortSpy.mock.calls).toEqual([[threadRun.id, threadSession?.sessionKey, FAKE_GATEWAY_ID]]);
    expect(getRun(app.db, threadRun.id)?.status).toBe("aborted");
    expect(getRun(app.db, channelRun.id)?.status).toBe("queued");
    expect(sessionRow(app, channelId, dev, root.id)).toMatchObject({ lifecycleRevision: "fake-1" });
    expect(sessionRow(app, channelId, dev)).toMatchObject({
      lifecycleRevision: channelSession?.lifecycleRevision,
    });
    const info = listMessages(app.db, channelId, {
      limit: 50,
      scope: { threadRootId: root.id },
    }).messages.filter((m) => m.kind === "system");
    expect(info).toEqual([
      expect.objectContaining({ bodyMd: "@dev 의 대화를 새로 시작했습니다", threadRootId: root.id }),
    ]);
    expect(systemMessages(app, channelId)).toEqual([]); // 채널 타임라인(루트만)에는 없다

    // 채널 리셋은 스레드 런을 건드리지 않는다
    const again = await startRun(app, channelId, dev, root.id);
    abortSpy.mockClear();
    expect((await api("POST", `/channels/${channelId}/agents/${dev}/reset`)).statusCode).toBe(200);
    expect(abortSpy.mock.calls.map(([runId]) => runId)).toEqual([channelRun.id]);
    expect(getRun(app.db, again.id)?.status).not.toBe("aborted");
  });

  it("reset?threadRootId — 답글·다른 채널 루트·없는 id 는 404, UUID 가 아니면 400", async () => {
    const { channelId } = seedAgentChannel(app, "reset-thread-bad", dev);
    const other = seedAgentChannel(app, "reset-thread-other", dev);
    const say = (at: string, threadRootId?: string) =>
      createUserMessage(app.db, app.bus, {
        channelId: at,
        authorId: app.ownerUserId,
        bodyMd: "m",
        clientMsgId: uuid(),
        threadRootId,
      });
    const root = say(channelId);
    const reply = say(channelId, root.id);
    const foreign = say(other.channelId);
    const resetsBefore = adapter.calls.reset.length;
    for (const id of [reply.id, foreign.id, uuid()]) {
      const res = await api("POST", `/channels/${channelId}/agents/${dev}/reset?threadRootId=${id}`);
      expect(res.statusCode).toBe(404);
    }
    expect((await api("POST", `/channels/${channelId}/agents/${dev}/reset?threadRootId=x`)).statusCode).toBe(
      400,
    );
    expect(adapter.calls.reset).toHaveLength(resetsBefore);
  });

  it("GET /adapter/status 는 어댑터마다 AdapterStatus 와 provider 별 capabilities, 인증이 필요하다", async () => {
    adapter.setGatewayState({ gateway: "reconnecting" });
    adapter.setCapabilities({
      sessionReset: false,
      agentsList: true,
      configSet: true,
      promptEveryRun: false,
      serverSessionIds: false,
    });
    const res = await api("GET", "/adapter/status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      statuses: [{ provider: "openclaw", gateways: [fakeGatewayStatus({ gateway: "reconnecting" })] }],
      capabilities: {
        openclaw: {
          sessionReset: false,
          agentsList: true,
          configSet: true,
          promptEveryRun: false,
          serverSessionIds: false,
        },
      },
    });
    const anonymous = await app.fastify.inject({ method: "GET", url: "/api/v1/adapter/status" });
    expect(anonymous.statusCode).toBe(401);
  });

  it("어댑터 status 이벤트 → bus adapter.status → wire adapter.status", async () => {
    const socket = await connectWire(app, token);
    sockets.push(socket);
    const status: AdapterStatus = {
      provider: "openclaw",
      gateways: [fakeGatewayStatus({ gateway: "reconnecting", bridge: "down" })],
    };
    const received = waitFor(socket, "adapter.status");
    adapter.emit({ kind: "status", status, capabilities: adapter.capabilities() });
    expect(await received).toEqual(status);
  });

  it("/healthz 는 매번 DB 에 select 를 돌리고, 실패하면 503 db: error", async () => {
    const get = vi.spyOn(app.db, "get");
    const ok = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, db: "ok" });
    expect(get).toHaveBeenCalledTimes(1);

    get.mockImplementationOnce(() => {
      throw new Error("SQLITE_IOERR");
    });
    const broken = await app.fastify.inject({ method: "GET", url: "/healthz" });
    expect(broken.statusCode).toBe(503);
    expect(broken.json()).toMatchObject({ ok: false, db: "error" });
  });
});

describe("종료·실패 정리", () => {
  it("close() 순서 — 새 wire 연결 거부 → orchestrator.stop → adapter.close → io.close → fastify.close → DB 닫기, 두 번 불러도 한 번만", async () => {
    const adapter = new FakeAdapter();
    const app = await bootTestApp({}, { adapters: [adapter] });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    const { token } = await login(app);
    const existing = await connectWire(app, token);
    const late: WireClient[] = [];
    try {
      let releaseAdapter: () => void = () => undefined;
      const stop = vi.spyOn(app.orchestrator, "stop");
      const adapterClose = vi
        .spyOn(adapter, "close")
        .mockImplementation(() => new Promise<void>((resolve) => (releaseAdapter = resolve)));
      const ioClose = vi.spyOn(app.io, "close");
      const fastifyClose = vi.spyOn(app.fastify, "close");
      const dbClose = vi.spyOn(app.db.$client, "close");

      const closing = app.close();
      expect(app.close()).toBe(closing);
      await vi.waitFor(() => expect(adapterClose).toHaveBeenCalled());

      // 어댑터를 닫는 중 — 새 wire 연결은 거부, 기존 연결은 아직 살아 있다
      const socket = openWire(app, { token, protocol: WIRE_PROTOCOL });
      late.push(socket);
      const refused = await new Promise<Error & { data?: unknown }>((resolve, reject) => {
        socket.once("connect", () => reject(new Error("종료 중인데 접속됐다")));
        socket.once("connect_error", (err) => resolve(err as Error & { data?: unknown }));
      });
      expect(refused.data).toEqual({ code: "ADAPTER_UNAVAILABLE", message: "server shutting down" });
      expect(existing.connected).toBe(true);
      expect(ioClose).not.toHaveBeenCalled();

      releaseAdapter();
      await closing;
      await app.close();

      const order = [stop, adapterClose, ioClose, fastifyClose, dbClose].map(
        (spy) => spy.mock.invocationCallOrder,
      );
      expect(order.map((calls) => calls.length)).toEqual([1, 1, 1, 1, 1]);
      const firsts = order.map((calls) => calls[0] ?? 0);
      expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
      expect(app.db.$client.open).toBe(false);
    } finally {
      existing.close();
      for (const socket of late) socket.close();
      await app.close();
    }
  });

  it("close() 는 10초 상한(테스트는 closeTimeoutMs)을 넘기면 warn 을 남기고 끝난다", async () => {
    const adapter = new FakeAdapter();
    const { logger, lines } = captureLogger();
    const app = await bootTestApp({}, { adapters: [adapter], logger, closeTimeoutMs: 50 });
    let releaseAdapter: () => void = () => undefined;
    vi.spyOn(adapter, "close").mockImplementation(
      () => new Promise<void>((resolve) => (releaseAdapter = resolve)),
    );

    await app.close();
    expect(lines).toContainEqual(
      expect.objectContaining({ level: 40, msg: "app close timed out", timeoutMs: 50 }),
    );
    expect(app.db.$client.open).toBe(true);

    // 상한 뒤에도 남은 단계는 이어서 끝난다
    releaseAdapter();
    await vi.waitFor(() => expect(app.db.$client.open).toBe(false));
  });

  it("createApp 도중 실패하면 만든 것(어댑터·DB)을 닫고 그 오류를 다시 던진다", async () => {
    const adapter = new FakeAdapter();
    vi.spyOn(adapter, "onEvent").mockImplementation(() => {
      throw new Error("subscribe boom");
    });
    const adapterClose = vi.spyOn(adapter, "close");
    const adapterConnect = vi.spyOn(adapter, "connect");
    const dbClose = vi.spyOn(Database.prototype, "close");
    try {
      await expect(bootTestApp({}, { adapters: [adapter] })).rejects.toThrow("subscribe boom");
      expect(adapterClose).toHaveBeenCalledTimes(1);
      expect(adapterConnect).not.toHaveBeenCalled();
      expect(dbClose).toHaveBeenCalledTimes(1);
    } finally {
      dbClose.mockRestore();
    }
  });

  it("TRUST_PROXY=true 면 레이트리밋 키가 X-Forwarded-For 를 따른다(기본 false 는 연결 주소)", async () => {
    const off = await bootTestApp();
    const on = await bootTestApp({ TRUST_PROXY: "true" });
    const local = (app: App, ip: string) =>
      app.fastify.inject({
        method: "POST",
        url: "/api/v1/auth/local",
        headers: { "x-forwarded-for": ip },
        payload: { token: "wrong-token-xxxxxxxxxx" },
      });
    try {
      for (const app of [off, on]) {
        for (let i = 0; i < 5; i++) expect((await local(app, "203.0.113.7")).statusCode).toBe(401);
      }
      // 프록시를 믿지 않으면 헤더가 달라도 같은 클라이언트(inject 주소)다
      expect((await local(off, "203.0.113.8")).statusCode).toBe(429);
      expect((await local(on, "203.0.113.8")).statusCode).toBe(401);
      expect((await local(on, "203.0.113.7")).statusCode).toBe(429);
    } finally {
      await off.close();
      await on.close();
    }
  });
});

describe("watchGatewayReconnecting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Gateway 가 60초 넘게 reconnecting 이면 그 이름을 넣은 system.notice warn 을 한 번 보내고, 벗어났다 돌아오면 다시 잰다", () => {
    const adapter = new FakeAdapter();
    adapter.upsertGateway({ id: FAKE_GATEWAY_ID, name: "집", url: "ws://a", token: "t", enabled: true });
    const bus = new ServerBus();
    const notices: unknown[] = [];
    bus.on("system.notice", (n) => notices.push(n));
    const logger = { warn: vi.fn() };
    const status = (gateway: FakeGatewayState["gateway"], bridge: FakeGatewayState["bridge"] = "down") => {
      adapter.setGatewayState({ gateway, bridge });
      adapter.emitStatus();
    };
    const notice = { level: "warn", message: "OpenClaw Gateway 「집」에 연결하지 못하고 있습니다" };

    adapter.setGatewayState({ gateway: "down", bridge: "down" });
    const watch = watchGatewayReconnecting(adapter, bus, logger);
    status("reconnecting");
    vi.advanceTimersByTime(59_999);
    status("reconnecting", "connected"); // 브리지만 바뀌어도 다시 재지 않는다
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(notices).toEqual([notice]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(600_000);
    expect(notices).toHaveLength(1);

    status("connected");
    status("reconnecting");
    vi.advanceTimersByTime(30_000);
    status("down"); // 60초 전에 벗어나면 알리지 않는다
    vi.advanceTimersByTime(60_000);
    expect(notices).toHaveLength(1);

    status("reconnecting");
    vi.advanceTimersByTime(60_000);
    expect(notices).toHaveLength(2);

    status("connected");
    status("reconnecting");
    watch.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    status("reconnecting");
    expect(vi.getTimerCount()).toBe(0);
    expect(notices).toHaveLength(2);

    // 시작할 때 이미 reconnecting 이면 그때부터 잰다
    const again = watchGatewayReconnecting(adapter, bus, logger);
    vi.advanceTimersByTime(60_000);
    expect(notices).toHaveLength(3);
    again.close();
  });
});

describe("실제 어댑터(createOpenClawAdapter) 부팅", () => {
  const sockets: Socket[] = [];
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });

  it("deps.adapter 없이 부팅하면 실제 어댑터를 만들고, Gateway 접속 실패는 부팅을 막지 않으며, 정본 훅·브리지 토큰이 배선되고, close() 는 플러그인에 shutdown 을 알리고 5초 안에 끝난다", async () => {
    const base = tempDir();
    const { logger } = captureLogger();
    const app = await createApp(
      loadConfig({ ...testEnv, DATA_DIR: base, ATTACHMENTS_DIR: join(base, "attachments") }),
      { logger },
    );
    try {
      expect(openclawOf(app)).not.toBeInstanceOf(FakeAdapter);
      await app.fastify.listen({ host: "127.0.0.1", port: 0 });
      const health = await app.fastify.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      // Gateway 0개로 떴다 — 연결 페이지 「Gateway 추가」(REST)로 붙인다. 닫힌 포트라 어떤 Gateway 에도 닿지 않는다
      const { headers } = await login(app);
      const added = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/gateways",
        headers,
        payload: { name: "닫힌 포트", url: "ws://127.0.0.1:1", token: "t" },
      });
      expect(added.statusCode).toBe(201);
      const gatewayId = (added.json() as { id: string }).id;
      // 디바이스 아이덴티티는 Gateway 마다 DATA_DIR/gateways/<Gateway id>/(멀티 Gateway 스펙 「디바이스 아이덴티티」 절)
      const deviceIdentityPath = join(base, "gateways", gatewayId, "device.json");
      const issued = await app.fastify.inject({
        method: "POST",
        url: `/api/v1/gateways/${gatewayId}/bridge-tokens`,
        headers,
        payload: { label: "real" },
      });
      const bridgeToken = (issued.json() as { token: string }).token;
      expect(["down", "reconnecting"]).toContain(soleGateway(openclawOf(app)).gateway);
      // 부팅 뒤 connect() 가 접속 루프를 돌렸다 — DATA_DIR(임시 디렉터리) 아래 디바이스 아이덴티티를 쓰고, 거부되면 reconnecting
      await vi.waitFor(() => expect(existsSync(deviceIdentityPath)).toBe(true));
      await vi.waitFor(() => expect(soleGateway(openclawOf(app)).gateway).toBe("reconnecting"), {
        timeout: 3_000,
      });

      const { agentId, channelId } = seedAgentChannel(app, "real", undefined, gatewayId);
      const plugin = connectSocket(`${app.url}/bridge`, {
        transports: ["websocket"],
        auth: { token: bridgeToken },
        reconnection: false,
        forceNew: true,
      });
      sockets.push(plugin);
      await new Promise<void>((resolve, reject) => {
        plugin.once("connect", () => resolve());
        plugin.once("connect_error", reject);
      });
      const hello = await plugin.emitWithAck("hello", {
        pluginId: "dodok",
        version: "0.0.0",
        sdkVersion: "2026.9.4",
        capabilities: [],
      });
      expect(hello).toEqual({
        ok: true,
        data: { serverVersion: packageJson.version, protocol: BRIDGE_PROTOCOL },
      });
      await vi.waitFor(() => expect(soleGateway(openclawOf(app)).bridge).toBe("connected"));

      // 브리지 정본 → orchestrator.onCanonical → 에이전트 메시지 저장, 그 id 로 ack
      const ack = (await plugin.emitWithAck("outbound.message", {
        outboundId: "out-real-1",
        channelId,
        agentId: "dev",
        sessionKey: `agent:dev:dodok:channel:${channelId}`,
        text: "정본",
        attachmentIds: [],
        ts: new Date().toISOString(),
      })) as { ok: boolean; data?: { messageId: string } };
      expect(ack.ok).toBe(true);
      const stored = listMessages(app.db, channelId, { limit: 10 }).messages;
      expect(stored).toEqual([
        expect.objectContaining({ id: ack.data?.messageId, authorId: agentId, bodyMd: "정본" }),
      ]);
      // 다른 채널 세션이 보관한 채널에 쓰는 새 글 — 저장의 계약 오류 코드가 플러그인 ack 까지 간다
      const archived = seedAgentChannel(app, "archived", agentId, gatewayId).channelId;
      const archivedRes = await app.fastify.inject({
        method: "POST",
        url: `/api/v1/channels/${archived}/archive`,
        headers,
      });
      expect(archivedRes.statusCode).toBe(200);
      const refused = await plugin.emitWithAck("outbound.message", {
        outboundId: "out-real-archived",
        channelId: archived,
        agentId: "dev",
        sessionKey: `agent:dev:dodok:channel:${channelId}`,
        text: "보관한 채널에",
        attachmentIds: [],
        ts: new Date().toISOString(),
      });
      expect(refused).toMatchObject({ ok: false, error: { code: "CHANNEL_ARCHIVED" } });
      expect(listMessages(app.db, archived, { limit: 10 }).messages).toEqual([]);

      const notice = new Promise((resolve) => plugin.once("system.notice", resolve));
      const started = performance.now();
      await app.close();
      expect(performance.now() - started).toBeLessThan(5_000);
      expect(await notice).toEqual({ reason: "shutdown", message: "server shutting down" });
      expect(soleGateway(openclawOf(app)).gateway).toBe("down");
      expect(app.db.$client.open).toBe(false);
    } finally {
      await app.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
