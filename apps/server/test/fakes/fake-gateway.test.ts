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
import { parseApprovalFrame } from "../../../../packages/openclaw-adapter/src/gateway/approvals";
import { createGatewayEventMapper } from "../../../../packages/openclaw-adapter/src/gateway/events";
import {
  APPROVAL_RESOLVED_BY,
  FAKE_GATEWAY_METHODS,
  type FakeGateway,
  startFakeGateway,
} from "./fake-gateway";

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
    opts: {
      grantAdmin?: boolean;
      scopes?: string[];
      onClose?: (info: { code: number }) => void;
      /** 기본 true — 실물처럼 세션 이벤트는 구독한 연결에만 오므로 SESSION_KEY 를 구독한다 */
      subscribe?: boolean;
    } = {},
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
    if (opts.subscribe !== false) {
      await connection.request("sessions.messages.subscribe", { key: SESSION_KEY, agentId: "dev" });
    }
    return { gateway, connection, frames };
  }

  it("세션 이벤트는 sessions.messages.subscribe 한 연결에만 간다(실물) — 키 없는 이벤트는 모두에게", async () => {
    const { gateway, frames: subscribed } = await connect();
    const { frames: silent } = await connect({ subscribe: false });

    await gateway.chatDelta(RUN_ID, SESSION_KEY, "dev", "안");
    await vi.waitFor(() => expect(subscribed).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(silent).toHaveLength(0);

    await gateway.emitEvent("sessions.changed", { reason: "test" });
    await vi.waitFor(() => expect(silent).toHaveLength(1));
    expect(subscribed).toHaveLength(2);
  });

  it("flush() 가 resolve 되면 앞서 보낸 프레임은 연결된 클라이언트가 이미 받아 처리했다", async () => {
    const { gateway, frames } = await connect();
    const { frames: other } = await connect();

    await gateway.lifecycleStart(RUN_ID, SESSION_KEY, "dev");
    await gateway.chatDelta(RUN_ID, SESSION_KEY, "dev", "안");
    await gateway.chatFinal(RUN_ID, SESSION_KEY, "dev", "안");
    await gateway.flush();

    expect(frames.map((f) => f.event)).toEqual(["agent", "chat", "chat"]);
    expect(other.map((f) => f.event)).toEqual(["agent", "chat", "chat"]);
  });

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

  it("tickIntervalMs 면 구독 없는 연결에도 tick 을 보내 실제 클라이언트가 무활동으로 끊지 않고, close() 가 그 타이머를 치운다", async () => {
    // 틱 타이머만 가짜 시계로 두고 시간 진행을 명시한다 — "100ms 안에 두 번" 같은 실시계 예산이 사라진다.
    // setTimeout·Date 는 실물로 남긴다: WS 전송과 connectGateway 의 접속 시간제한이 그대로 돌아야 한다.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
      gateway = await startFakeGateway({ tickIntervalMs: 30 });
      const tickTimer = setIntervalSpy.mock.results[
        setIntervalSpy.mock.calls.findIndex(([, ms]) => ms === 30)
      ]?.value as ReturnType<typeof setInterval> | undefined;
      setIntervalSpy.mockRestore();
      expect(tickTimer).toBeDefined();

      const closes: number[] = [];
      const { frames } = await connect({ subscribe: false, onClose: (info) => closes.push(info.code) });
      // 30ms 간격이니 60ms 를 돌리면 정확히 두 번. 프레임이 닿았는지는 flush()(ping/pong)로 — 시계와 무관하다
      await vi.advanceTimersByTimeAsync(60);
      await gateway.flush();
      expect(frames.filter((f) => f.event === "tick")).toHaveLength(2);
      expect(frames.every((f) => f.event === "tick")).toBe(true);
      expect(frames[0]?.payload).toEqual({ ts: expect.any(Number) });
      expect(closes).toEqual([]);

      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      try {
        await gateway.close();
        expect(clearIntervalSpy).toHaveBeenCalledWith(tickTimer);
      } finally {
        clearIntervalSpy.mockRestore();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  // ── 승인 (승인 스파이크 3.2·3.4·4.1·4.4·5.2) ──────────────────

  /** 승인 프레임 하나를 띄우고 그 payload 를 돌려준다 */
  async function requestApproval(
    gateway: FakeGateway,
    frames: Frame[],
    req: Parameters<FakeGateway["requestApproval"]>[3],
  ) {
    const outcome = gateway.requestApproval(RUN_ID, SESSION_KEY, "dev", req);
    const frame = await waitForFrame(frames, "plugin.approval.requested");
    return { outcome, payload: frame.payload as Record<string, unknown> };
  }

  /** 프레임은 이름으로 찾는다 — 실물처럼 승인 하나가 여러 프레임(정본 + 세션 스냅샷)으로 나가서 자리가 밀린다 */
  function waitForFrame(frames: Frame[], event: string): Promise<Frame> {
    return vi.waitFor(() => {
      const found = frames.find((f) => f.event === event);
      expect(found, `${event} 프레임이 오지 않았다`).toBeDefined();
      return found as Frame;
    });
  }

  it("승인: requested 는 실물 모양(3.2)이고 어댑터 정규화를 그대로 지난다", async () => {
    const { gateway, frames } = await connect();
    const { payload } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      title: "claude-cli native tool: Write",
      toolName: "Write",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 10_000,
    });

    expect(payload).toMatchObject({ approvalKind: "plugin", id: expect.stringMatching(/^plugin:/) });
    // ⚠ 실측(p2-t6) — 같은 승인이 세션 스냅샷으로도 온다. 정본에는 `urlPath` 가 없고 스냅샷에는 `toolCallId` 가 없다
    const snapshot = await waitForFrame(frames, "session.approval");
    expect(snapshot.payload).toMatchObject({
      sessionKey: SESSION_KEY,
      approval: {
        id: payload.id,
        status: "pending",
        urlPath: `/approve/${encodeURIComponent(payload.id as string)}`,
      },
    });
    expect(payload.urlPath).toBeUndefined();
    expect(parseApprovalFrame("session.approval", snapshot.payload)?.toolCallId).toBeUndefined();
    // 시각은 실제 시계로 채운다 — TTL 이 그대로 만료 시각이 된다
    expect((payload.expiresAtMs as number) - (payload.createdAtMs as number)).toBe(10_000);
    expect(payload.request).toMatchObject({
      sessionKey: SESSION_KEY,
      agentId: "dev",
      toolCallId: "toolu_fake_a",
      toolName: "Write",
      title: "claude-cli native tool: Write",
      allowedDecisions: ["allow-once", "deny"],
      pluginId: "claude-cli",
      runId: null, // 승인 페이로드에 런 id 는 오지 않는다
    });
    // 전역 프레임이라 payload 최상위에 sessionKey 가 없다 — 구독과 무관하게 모든 연결로 간다
    expect(payload.sessionKey).toBeUndefined();

    // 실제 어댑터 정규화에 그대로 넣었을 때 우리 승인이 나온다 — 손으로 만든 모양이 어긋나면 여기서 깨진다
    expect(parseApprovalFrame("plugin.approval.requested", payload)).toMatchObject({
      providerApprovalId: payload.id,
      kind: "plugin",
      sessionKey: SESSION_KEY,
      providerAgentId: "dev",
      channelId: CHANNEL_ID,
      toolCallId: "toolu_fake_a",
      toolName: "Write",
      status: "pending",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
    });
  });

  it("승인: approval.resolve 는 terminal 스냅샷으로 답하고(4.1) 그 뒤 resolved 이벤트가 온다(3.4)", async () => {
    const { gateway, connection, frames } = await connect();
    const { outcome, payload } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      ttlMs: 10_000,
    });

    const res = await connection.request("approval.resolve", {
      id: payload.id,
      kind: "plugin",
      decision: "allow-once",
    });
    expect(res).toMatchObject({
      applied: true,
      approval: {
        id: payload.id,
        status: "allowed",
        decision: "allow-once",
        reason: "user",
        source: { agentId: "dev", sessionKey: SESSION_KEY },
      },
    });
    await expect(outcome).resolves.toEqual({
      approvalId: payload.id,
      decision: "allow-once",
      expired: false,
    });

    const resolved = await waitForFrame(frames, "plugin.approval.resolved");
    expect(resolved.payload).toMatchObject({
      id: payload.id,
      decision: "allow-once",
      resolvedBy: APPROVAL_RESOLVED_BY,
    });
    expect(parseApprovalFrame("plugin.approval.resolved", resolved.payload)).toMatchObject({
      status: "allowed",
      decision: "allow-once",
    });

    // 이미 확정된 승인에 다시 보내도 오류가 아니다 — applied:false 에 같은 스냅샷(4.4)
    const again = await connection.request("approval.resolve", {
      id: payload.id,
      kind: "plugin",
      decision: "deny",
    });
    expect(again).toMatchObject({ applied: false, approval: { status: "allowed", decision: "allow-once" } });
    // 확정은 한 번뿐이다 — resolved 이벤트가 또 나가지 않는다
    await gateway.flush();
    expect(frames.filter((f) => f.event === "plugin.approval.resolved")).toHaveLength(1);
  });

  it("승인: 목록 밖 결정은 malformed-verdict 거절로 확정된다(4.4 의 fail-closed 함정)", async () => {
    const { gateway, connection, frames } = await connect();
    const { outcome, payload } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      allowedDecisions: ["allow-once", "deny"],
      ttlMs: 10_000,
    });

    const res = await connection.request("approval.resolve", {
      id: payload.id,
      kind: "plugin",
      decision: "allow-always",
    });
    expect(res).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny", reason: "malformed-verdict" },
    });
    await expect(outcome).resolves.toMatchObject({ decision: "deny", expired: false });
  });

  it("승인: 없는 id 는 approval not found 로 거절한다(4.4)", async () => {
    const { connection } = await connect();
    await expect(
      connection.request("approval.resolve", { id: "plugin:nope", kind: "plugin", decision: "deny" }),
    ).rejects.toMatchObject({ details: { reason: "APPROVAL_NOT_FOUND" } });
  });

  it("승인: TTL 이 지나면 만료 — decision deny + resolvedBy null 로 오고(5.2) 정규화하면 expired/timeout", async () => {
    const { gateway, frames } = await connect();
    const { outcome, payload } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      ttlMs: 20,
    });

    await expect(outcome).resolves.toEqual({ approvalId: payload.id, decision: "deny", expired: true });
    const resolved = await waitForFrame(frames, "plugin.approval.resolved");
    expect(resolved.payload).toMatchObject({ id: payload.id, decision: "deny", resolvedBy: null });
    expect(parseApprovalFrame("plugin.approval.resolved", resolved.payload)).toMatchObject({
      status: "expired",
      reason: "timeout",
      decision: "deny",
    });
  });

  it("승인: onTimeout silent 면 만료 프레임을 보내지 않는다(서버 만료 감시를 재는 대본)", async () => {
    const { gateway, frames } = await connect();
    const { outcome } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      ttlMs: 20,
      onTimeout: "silent",
    });

    await expect(outcome).resolves.toMatchObject({ decision: "deny", expired: true });
    await gateway.flush();
    expect(frames.map((f) => f.event)).toEqual(["plugin.approval.requested", "session.approval"]);
  });

  it("승인: chat.abort 는 그 런의 미해결 승인을 프레임 없이 버린다(대본이 거기서 멈춘다)", async () => {
    const { gateway, connection, frames } = await connect();
    const { outcome } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      ttlMs: 10_000,
    });

    await connection.request("chat.abort", { sessionKey: SESSION_KEY, runId: RUN_ID });
    await expect(outcome).resolves.toMatchObject({ decision: "deny", expired: false });
    await gateway.flush();
    expect(frames.filter((f) => f.event === "plugin.approval.resolved")).toEqual([]);
  });

  it("승인: close() 는 기다리던 대본을 깨운다(프로미스가 남지 않는다)", async () => {
    const { gateway, frames } = await connect();
    const { outcome } = await requestApproval(gateway, frames, {
      toolCallId: "toolu_fake_a",
      ttlMs: 10_000,
    });
    await gateway.close();
    await expect(outcome).resolves.toMatchObject({ decision: "deny", expired: false });
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
