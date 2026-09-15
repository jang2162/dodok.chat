import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectGateway,
  DEFAULT_GATEWAY_CAPS,
  DEFAULT_GATEWAY_SCOPES,
  type GatewayConnection,
} from "../../../../packages/openclaw-adapter/src/gateway/client";
import { createGatewayEventMapper } from "../../../../packages/openclaw-adapter/src/gateway/events";
import { FAKE_GATEWAY_METHODS, type FakeGateway, startFakeGateway } from "./fake-gateway";

const RUN_ID = "01a09fc9-d204-7551-89d6-38544d07b001";
const CHANNEL_ID = "01a09fc9-d204-7551-89d6-38544d07b002";
const SESSION_KEY = `agent:dev:dodok:channel:${CHANNEL_ID}`;

type Frame = { type: "event"; event: string; payload?: unknown; seq?: number };

describe("가짜 Gateway — 실제 connectGateway 로 붙는다", () => {
  let dir: string;
  let gateway: FakeGateway | undefined;
  const connections: GatewayConnection[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-fake-gateway-"));
  });

  afterEach(async () => {
    for (const connection of connections.splice(0)) await connection.stop();
    await gateway?.close();
    gateway = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(
    opts: { grantAdmin?: boolean; scopes?: string[]; onClose?: (info: { code: number }) => void } = {},
  ) {
    gateway ??= await startFakeGateway(opts.grantAdmin === undefined ? {} : { grantAdmin: opts.grantAdmin });
    const frames: Frame[] = [];
    const connection = await connectGateway({
      url: gateway.url,
      token: gateway.token,
      deviceIdentityPath: join(dir, "device.json"),
      connectTimeoutMs: 5_000,
      ...(opts.scopes ? { scopes: opts.scopes } : {}),
      ...(opts.onClose ? { onClose: opts.onClose } : {}),
      onEvent: (frame) => frames.push(frame as Frame),
    });
    connections.push(connection);
    return { gateway, connection, frames };
  }

  it("connect.challenge → connect → hello-ok: protocol 4, 요청한 scopes 를 에코하고, 우리가 쓰는 메서드를 광고한다", async () => {
    const scopes = ["operator.read", "operator.write"];
    const { gateway, connection } = await connect({ scopes });

    expect(connection.hello.type).toBe("hello-ok");
    expect(connection.hello.protocol).toBe(4);
    expect(connection.hello.auth).toEqual({ method: "token", role: "operator", scopes });
    expect(connection.hello.server.version).toBe("2026.9.4");
    expect(connection.hello.features.methods).toEqual([...FAKE_GATEWAY_METHODS]);
    expect(connection.hello.policy.tickIntervalMs).toBe(30_000);

    // 수신 기록: 첫 요청이 connect 이고, 실제 클라이언트가 보낸 scopes·caps·token·서명한 챌린지 nonce 가 실린다
    const [first] = gateway.requests;
    expect(first?.method).toBe("connect");
    expect(first?.params).toMatchObject({
      role: "operator",
      scopes,
      caps: DEFAULT_GATEWAY_CAPS,
      auth: { token: gateway.token },
      device: { nonce: expect.any(String) },
    });
  });

  it("scopes 를 주지 않으면 어댑터 기본 scopes(operator.admin 포함)가 그대로 에코된다", async () => {
    const { connection } = await connect();
    expect(connection.hello.auth.scopes).toEqual(DEFAULT_GATEWAY_SCOPES);
  });

  it("chat.send 는 runId = idempotencyKey·status started 로 답한 뒤 onChatSend 를 부른다", async () => {
    const { gateway, connection } = await connect();
    const seen: unknown[] = [];
    gateway.onChatSend((params) => {
      seen.push(params);
    });
    const params = { sessionKey: SESSION_KEY, agentId: "dev", message: "안녕", idempotencyKey: RUN_ID };

    await expect(connection.request("chat.send", params)).resolves.toEqual({
      runId: RUN_ID,
      status: "started",
    });
    await vi.waitFor(() => expect(seen).toEqual([params]));
    expect(gateway.requests.at(-1)).toMatchObject({ type: "req", method: "chat.send", params });
  });

  it("이벤트 헬퍼는 태스크 10 매퍼가 읽는 모양으로 onEvent 에 도착하고, seq 는 단조 증가하며, 델타 스냅샷은 누적이다", async () => {
    const { gateway, frames } = await connect();
    await gateway.lifecycleStart(RUN_ID, SESSION_KEY, "dev");
    await gateway.toolStart(RUN_ID, SESSION_KEY, "dev", {
      toolCallId: "toolu_fake_1",
      name: "Read",
      args: { path: "README.md" },
    });
    await gateway.toolResult(RUN_ID, SESSION_KEY, "dev", {
      toolCallId: "toolu_fake_1",
      name: "Read",
      result: "hello",
    });
    await gateway.chatDelta(RUN_ID, SESSION_KEY, "dev", "안");
    await gateway.chatDelta(RUN_ID, SESSION_KEY, "dev", "녕");
    await gateway.chatFinal(RUN_ID, SESSION_KEY, "dev", "안녕");
    await gateway.sessionMessageUsage(RUN_ID, SESSION_KEY);
    await vi.waitFor(() => expect(frames).toHaveLength(7));

    expect(frames.map((f) => f.event)).toEqual([
      "agent",
      "agent",
      "agent",
      "chat",
      "chat",
      "chat",
      "session.message",
    ]);
    const seqs = frames.map((f) => f.seq ?? -1);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1] ?? Infinity);
    for (const frame of frames) {
      expect(frame.payload).toMatchObject({ sessionKey: SESSION_KEY });
      // 실물 session.message 는 최상위에 runId 가 없고 message.idempotencyKey 로 런을 가리킨다(ADR 0001 6.3)
      if (frame.event !== "session.message") expect(frame.payload).toMatchObject({ runId: RUN_ID });
    }
    expect(frames[4]?.payload).toMatchObject({
      state: "delta",
      agentId: "dev",
      deltaText: "녕",
      message: { role: "assistant", content: [{ type: "text", text: "안녕" }] },
    });

    // 실제 매퍼에 그대로 넣었을 때 런 이벤트·신호가 나온다 — 손으로 만든 모양이 매퍼와 어긋나면 여기서 깨진다
    const mapper = createGatewayEventMapper({ isOurRun: (runId) => runId === RUN_ID });
    const mapped = frames.flatMap((frame) => mapper.map(frame));
    expect(mapped.map((m) => m.event?.type ?? m.signal?.kind)).toEqual([
      "gateway_started",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "tool_start",
      "TOOL_CALL_RESULT",
      "TOOL_CALL_END",
      "tool_end",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "text_delta",
      "TEXT_MESSAGE_CONTENT",
      "text_delta",
      "TEXT_MESSAGE_END",
      "gateway_final",
      "CUSTOM",
    ]);
    expect(mapped.find((m) => m.event?.type === "TOOL_CALL_START")?.event).toMatchObject({
      toolCallName: "Read",
    });
    expect(mapped.find((m) => m.event?.type === "TOOL_CALL_ARGS")?.event).toMatchObject({
      delta: JSON.stringify({ path: "README.md" }),
    });
    expect(mapped.find((m) => m.event?.type === "TOOL_CALL_RESULT")?.event).toMatchObject({
      content: "hello",
      ok: true,
    });
    expect(mapped.find((m) => m.signal?.kind === "gateway_final")?.snapshotText).toBe("안녕");
    expect(mapped.at(-1)?.event).toMatchObject({ name: "openclaw.usage" });
  });

  it("chatError·emitEvent 도 같은 연결로 흘러간다", async () => {
    const { gateway, frames } = await connect();
    await gateway.chatError(RUN_ID, SESSION_KEY, "dev", { errorKind: "model_error", errorMessage: "boom" });
    await gateway.emitEvent("sessions.changed", { reason: "participants", sessionKey: SESSION_KEY });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[0]?.payload).toMatchObject({
      runId: RUN_ID,
      state: "error",
      errorKind: "model_error",
      errorMessage: "boom",
    });
    expect(frames[1]).toMatchObject({ event: "sessions.changed", payload: { sessionKey: SESSION_KEY } });
  });

  it("구독·목록·기록 요청에 응답 표대로 답한다 — chat.history 는 cursor 가 있으면 reset", async () => {
    const { connection } = await connect();
    await expect(connection.request("sessions.subscribe", {})).resolves.toEqual({ subscribed: true });
    await expect(
      connection.request("sessions.messages.subscribe", { key: SESSION_KEY, agentId: "dev" }),
    ).resolves.toEqual({ subscribed: true });
    await expect(connection.request("sessions.list", {})).resolves.toEqual({ sessions: [] });
    await expect(connection.request("agents.list", {})).resolves.toEqual({
      agents: [
        { id: "dev", name: "dev" },
        { id: "fin", name: "fin" },
      ],
    });

    const history = await connection.request("chat.history", { sessionKey: SESSION_KEY, agentId: "dev" });
    expect(history).toEqual({
      sessionKey: SESSION_KEY,
      sessionId: expect.any(String),
      messages: [],
      completeSnapshot: true,
    });
    await expect(
      connection.request("chat.history", { sessionKey: SESSION_KEY, agentId: "dev", cursor: "c-1" }),
    ).resolves.toEqual({ kind: "reset" });
  });

  it("chat.abort 는 { ok: true } 로 답하고 그 런의 chat aborted 이벤트를 보낸다", async () => {
    const { connection, frames } = await connect();
    await expect(
      connection.request("chat.abort", { sessionKey: SESSION_KEY, runId: RUN_ID }),
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    expect(frames[0]).toMatchObject({
      event: "chat",
      payload: { runId: RUN_ID, sessionKey: SESSION_KEY, agentId: "dev", state: "aborted" },
    });
  });

  it("sessions.reset 은 grantAdmin(기본 true)이면 entry 를, 같은 키의 sessionId 는 그대로 준다", async () => {
    const { connection } = await connect();
    const history = await connection.request<{ sessionId: string }>("chat.history", {
      sessionKey: SESSION_KEY,
      agentId: "dev",
    });
    const reset = await connection.request("sessions.reset", { key: SESSION_KEY });
    expect(reset).toEqual({
      ok: true,
      key: SESSION_KEY,
      entry: {
        sessionId: history.sessionId,
        lifecycleRevision: expect.any(String),
        sessionStartedAt: expect.any(Number),
      },
    });
  });

  it("grantAdmin: false 면 sessions.reset 은 FORBIDDEN/MISSING_SCOPE, 모르는 메서드는 grantAdmin 과 무관하게 같은 오류", async () => {
    const { connection } = await connect({ grantAdmin: false });
    const missingScope = {
      code: "FORBIDDEN",
      details: { code: "MISSING_SCOPE", missingScope: "operator.admin" },
    };
    await expect(connection.request("sessions.reset", { key: SESSION_KEY })).rejects.toMatchObject(
      missingScope,
    );
    await expect(connection.request("dodok.no.such.method", {})).rejects.toMatchObject(missingScope);
  });

  it("close() 는 열린 연결을 끊고(post-hello onClose) 포트를 닫는다", async () => {
    const closes: number[] = [];
    const { gateway } = await connect({ onClose: (info) => closes.push(info.code) });
    const { url } = gateway;
    await gateway.close();
    await vi.waitFor(() => expect(closes).toHaveLength(1));

    // 같은 주소로 새 접속은 거절된다(서버가 닫혔다)
    await expect(
      connectGateway({
        url,
        token: "unused",
        deviceIdentityPath: join(dir, "device.json"),
        connectTimeoutMs: 2_000,
      }),
    ).rejects.toThrow();
  });
});
