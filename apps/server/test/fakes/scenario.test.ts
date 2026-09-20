import type { InboundDeliver, OutboundMessage } from "@dodok/shared";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "socket.io";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachBridge, type BridgeHandle } from "../../../../packages/openclaw-adapter/src/bridge/server";
import {
  connectGateway,
  type GatewayConnection,
} from "../../../../packages/openclaw-adapter/src/gateway/client";
import { type FakeGateway, startFakeGateway } from "./fake-gateway";
import { type FakePlugin, startFakePlugin } from "./fake-plugin";
import { createScenario, type ScenarioAgent } from "./scenario";

const TOKEN = "fake-bridge-token";
const CHANNEL_ID = "01a09fc9-d204-7551-89d6-38544d07d001";

function delivery(agentId: string, text: string): InboundDeliver {
  return {
    deliveryId: randomUUID(),
    kind: "message",
    channelId: CHANNEL_ID,
    agentId,
    sessionKey: `agent:${agentId}:dodok:channel:${CHANNEL_ID}`,
    runId: randomUUID(),
    message: {
      id: randomUUID(),
      author: { type: "user", handle: "owner", displayName: "Owner" },
      text,
      attachments: [],
      ts: new Date().toISOString(),
    },
    context: { recentMessages: [], participants: [], relayRules: "" },
    options: {},
  };
}

type Frame = { event: string; payload?: unknown };

describe("시나리오 — 인바운드 대본을 Gateway 이벤트와 플러그인 정본으로 흘린다", () => {
  let dir: string;
  let io: Server;
  let bridge: BridgeHandle;
  let gateway: FakeGateway;
  let connection: GatewayConnection;
  let plugin: FakePlugin;
  let frames: Frame[];
  let outbound: OutboundMessage[];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "dodok-scenario-"));
    frames = [];
    outbound = [];
    gateway = await startFakeGateway({});
    connection = await connectGateway({
      url: gateway.url,
      token: gateway.token,
      deviceIdentityPath: join(dir, "device.json"),
      connectTimeoutMs: 5_000,
      onEvent: (frame) => frames.push(frame),
    });
    // 실물처럼 세션 이벤트는 구독한 연결에만 온다 — 대본이 쓰는 두 에이전트의 세션을 구독한다
    for (const agentId of ["dev", "fin"]) {
      await connection.request("sessions.messages.subscribe", {
        key: `agent:${agentId}:dodok:channel:${CHANNEL_ID}`,
        agentId,
      });
    }
    const http = createServer();
    io = new Server(http);
    bridge = attachBridge(io, {
      token: TOKEN,
      serverVersion: "9.9.9",
      onOutboundMessage: async (_session, message) => {
        outbound.push(message);
        return { messageId: `stored-${outbound.length}` };
      },
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    plugin = await startFakePlugin({
      bridgeUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      token: TOKEN,
    });
  });

  afterEach(async () => {
    plugin.close();
    bridge.close();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await connection.stop();
    await gateway.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("dispatch 를 ack 한 뒤 lifecycle start → tool → 델타 → final 을 흘리고, 정본을 outbound.message 로 보낸다", async () => {
    const dev: ScenarioAgent = () => ({
      deltas: ["안녕", "하세요"],
      reply: "안녕하세요",
      tool: { name: "Read", args: { path: "a.md" }, result: "본문" },
    });
    const scenario = createScenario({ gateway, plugin, agents: { dev } });
    const d = delivery("dev", "@dev 안녕");

    await expect(bridge.deliverInbound(d, 2_000)).resolves.toEqual({
      ok: true,
      data: { admission: "dispatch", providerRunId: d.runId },
    });
    await vi.waitFor(() => expect(outbound).toHaveLength(1));
    await vi.waitFor(() => expect(frames).toHaveLength(6));

    expect(
      frames.map((f) => {
        const p = f.payload as { stream?: string; state?: string; data?: { phase?: string } };
        return `${f.event}:${p.stream ?? p.state}${p.data?.phase ? `:${p.data.phase}` : ""}`;
      }),
    ).toEqual([
      "agent:lifecycle:start",
      "agent:tool:start",
      "agent:tool:result",
      "chat:delta",
      "chat:delta",
      "chat:final",
    ]);
    for (const frame of frames) {
      expect(frame.payload).toMatchObject({ runId: d.runId, sessionKey: d.sessionKey, agentId: "dev" });
    }
    expect(frames[1]?.payload).toMatchObject({ data: { name: "Read", args: { path: "a.md" } } });
    expect(frames[2]?.payload).toMatchObject({ data: { name: "Read", result: "본문" } });
    expect(frames[5]?.payload).toMatchObject({
      message: { content: [{ type: "text", text: "안녕하세요" }] },
    });

    expect(outbound[0]).toMatchObject({
      channelId: CHANNEL_ID,
      agentId: "dev",
      sessionKey: d.sessionKey,
      runId: d.runId,
      replyToInboundId: d.message.id,
      text: "안녕하세요",
      attachments: [],
    });
    expect(scenario.turns).toEqual([{ agentId: "dev", delivery: d }]);
    expect(scenario.errors).toEqual([]);
  });

  it("drop 이면 그 사유로 ack 만 하고 Gateway 이벤트·정본을 내지 않는다", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      agents: { dev: () => ({ reply: "안 보냄", drop: "bot-loop-protection" }) },
    });
    const d = delivery("dev", "@dev 반복");
    await expect(bridge.deliverInbound(d, 2_000)).resolves.toEqual({
      ok: true,
      data: { admission: "drop", reason: "bot-loop-protection" },
    });
    // 같은 연결로 요청 한 번을 왕복시켜 앞선 프레임이 있었다면 도착했을 시점까지 기다린다
    await connection.request("sessions.list", {});
    expect(frames).toEqual([]);
    expect(outbound).toEqual([]);
    expect(scenario.turns).toEqual([{ agentId: "dev", delivery: d }]);
  });

  it("턴 인덱스는 에이전트별로 센다, 델타가 없어도 final·정본은 나간다", async () => {
    const seen: string[] = [];
    const scenario = createScenario({
      gateway,
      plugin,
      agents: {
        dev: ({ index, delivery: d }) => {
          seen.push(`dev#${index}:${d.message.text}`);
          return { reply: `dev 답 ${index}` };
        },
        fin: ({ index }) => {
          seen.push(`fin#${index}`);
          return { reply: `fin 답 ${index}` };
        },
      },
    });
    await bridge.deliverInbound(delivery("dev", "하나"), 2_000);
    await vi.waitFor(() => expect(outbound).toHaveLength(1));
    await bridge.deliverInbound(delivery("fin", "둘"), 2_000);
    await vi.waitFor(() => expect(outbound).toHaveLength(2));
    await bridge.deliverInbound(delivery("dev", "셋"), 2_000);
    await vi.waitFor(() => expect(outbound).toHaveLength(3));

    expect(seen).toEqual(["dev#0:하나", "fin#0", "dev#1:셋"]);
    expect(outbound.map((m) => m.text)).toEqual(["dev 답 0", "fin 답 0", "dev 답 1"]);
    expect(scenario.turns.map((t) => t.agentId)).toEqual(["dev", "fin", "dev"]);
    await vi.waitFor(() => expect(frames.filter((f) => f.event === "chat")).toHaveLength(3));
  });

  it("fail 이면 lifecycle start 뒤 chat error(errorMessage)로 끝내고 툴·델타·final·정본을 내지 않는다", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      agents: {
        dev: () => ({
          deltas: ["안 보냄"],
          reply: "안 보냄",
          tool: { name: "Read", args: {}, result: "" },
          fail: "boom",
        }),
      },
    });
    const failed = delivery("dev", "@dev 실패");
    await expect(bridge.deliverInbound(failed, 2_000)).resolves.toMatchObject({
      ok: true,
      data: { admission: "dispatch" },
    });
    await scenario.idle();
    // 같은 연결로 요청 한 번을 왕복시켜 앞서 쓴 프레임이 도착했을 시점까지 기다린다
    await connection.request("sessions.list", {});

    expect(
      frames.map((f) => {
        const p = f.payload as { stream?: string; state?: string };
        return `${f.event}:${p.stream ?? p.state}`;
      }),
    ).toEqual(["agent:lifecycle", "chat:error"]);
    expect(frames[1]?.payload).toMatchObject({ runId: failed.runId, state: "error", errorMessage: "boom" });
    expect(outbound).toEqual([]);
    expect(scenario.errors).toEqual([]);
  });

  it("deltaDelayMs 면 델타마다 그만큼 기다렸다 보낸다(실제 시계)", async () => {
    const DELAY = 50;
    const arrivals: Array<{ event: string; at: number }> = [];
    connection.subscribe((frame) => arrivals.push({ event: frame.event, at: performance.now() }));
    createScenario({
      gateway,
      plugin,
      agents: { dev: () => ({ deltas: ["느", "리게"], reply: "느리게", deltaDelayMs: DELAY }) },
    });
    // 재생은 이 시각 뒤에 시작하므로 n 번째 델타는 아무리 빨라도 여기서 n×DELAY 뒤에 나간다
    const sentAt = performance.now();
    await bridge.deliverInbound(delivery("dev", "@dev 느리게"), 2_000);
    await vi.waitFor(() => expect(outbound).toHaveLength(1));

    const deltas = arrivals.filter((a) => a.event === "chat").slice(0, 2);
    const [start] = arrivals;
    expect(start?.event).toBe("agent");
    expect(deltas).toHaveLength(2);
    // 도착 시각은 보낸 시각의 하한일 뿐이다 — 이 쪽 루프가 밀리면 앞 프레임이 늦게 찍혀 프레임 사이 "간격"이 실제보다
    // 줄어 보인다(부하에서 43ms 로 관측). 그래서 프레임끼리 빼지 않고, 재생 전 시각에 누적으로 건다 —
    // 부하는 늦추기만 하므로 이 방향의 하한은 흔들리지 않는다.
    // 타이머는 루프 시각(ms 단위 캐시)으로 재므로 performance.now 로는 타이머당 1ms 안팎 일찍 보일 수 있어 그만큼 뺀다.
    expect((deltas[0]?.at ?? 0) - sentAt).toBeGreaterThanOrEqual(DELAY - 2);
    expect((deltas[1]?.at ?? 0) - sentAt).toBeGreaterThanOrEqual(2 * DELAY - 4);
  });

  it("재생 중 chat.abort 를 받으면 그 런은 거기서 멈춘다 — 남은 델타·final·정본 없음(실물처럼)", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      agents: { dev: () => ({ deltas: ["하", "나", "둘"], reply: "하나둘", deltaDelayMs: 30 }) },
    });
    const stopped = delivery("dev", "@dev 느리게");
    // 첫 델타를 받자마자 중지한다(폴링 없이) — 둘째 델타(30ms 뒤)보다 먼저 닿는다
    const aborting = new Promise<unknown>((resolve) => {
      const off = connection.subscribe((frame) => {
        if (frame.event !== "chat") return;
        off();
        resolve(connection.request("chat.abort", { sessionKey: stopped.sessionKey, runId: stopped.runId }));
      });
    });
    await bridge.deliverInbound(stopped, 2_000);
    await expect(aborting).resolves.toEqual({ ok: true });
    await scenario.idle();
    await connection.request("sessions.list", {});

    const states = frames
      .filter((f) => f.event === "chat" && (f.payload as { runId?: string }).runId === stopped.runId)
      .map((f) => (f.payload as { state?: string }).state);
    expect(states).toContain("aborted");
    expect(states).not.toContain("final");
    expect(states.filter((s) => s === "delta").length).toBeLessThan(3);
    expect(outbound).toEqual([]);
    expect(scenario.errors).toEqual([]);
  });

  it("대본의 approval — 툴 start 뒤 승인을 띄우고, 결정이 나야 툴 result·델타·정본이 이어진다", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      agents: {
        dev: () => ({ approval: { ttlMs: 5_000, onDecision: "continue" }, deltas: ["끝"], reply: "끝" }),
      },
    });
    const sent = delivery("dev", "@dev 승인");
    await bridge.deliverInbound(sent, 2_000);
    const requested = await vi.waitFor(() => {
      const found = frames.find((f) => f.event === "plugin.approval.requested");
      expect(found).toBeDefined();
      return found as Frame;
    });
    // 승인 대기는 「툴 start 는 왔는데 result 가 안 오는 구간」이다(실물 4.2) — 델타도 정본도 아직 없다
    // 승인 하나가 두 프레임으로 나간다 — 정본(`toolCallId`) + 세션 스냅샷(`urlPath`), 실물과 같은 짝(⚠ 실측 p2-t6)
    expect(frames.map((f) => f.event)).toEqual([
      "agent",
      "agent",
      "plugin.approval.requested",
      "session.approval",
    ]);
    expect(outbound).toEqual([]);
    const start = frames[1]?.payload as { data: { phase: string; name: string; toolCallId: string } };
    expect(start.data).toMatchObject({ phase: "start", name: "Write" });
    expect((requested.payload as { request: { toolCallId: string } }).request.toolCallId).toBe(
      start.data.toolCallId,
    );

    const { id } = requested.payload as { id: string };
    await connection.request("approval.resolve", { id, kind: "plugin", decision: "allow-once" });
    await scenario.idle();

    // 확정도 짝이다 — 실물 순서대로 `session.approval(terminal)` 이 먼저, `plugin.approval.resolved` 가 뒤(3.4·5.2)
    expect(frames.map((f) => f.event)).toEqual([
      "agent",
      "agent",
      "plugin.approval.requested",
      "session.approval",
      "session.approval",
      "plugin.approval.resolved",
      "agent",
      "chat",
      "chat",
    ]);
    // 자리(index)가 아니라 프레임을 보고 고른다 — 승인이 프레임 둘로 나가 뒤가 밀린다
    const result = frames
      .map((f) => (f.payload as { data?: { phase?: string } }).data)
      .find((data) => data?.phase === "result");
    expect(result).toMatchObject({ phase: "result", isError: false, result: "ok" });
    expect(outbound.map((m) => m.text)).toEqual(["끝"]);
    expect(scenario.errors).toEqual([]);
  });

  it("onDecision 을 주지 않으면 결정대로 — 거절·만료면 툴 결과가 실물 거절 문구로 나간다(4.3)", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      // TTL 이 짧고 아무도 누르지 않는다 → 만료 → 툴 오류
      agents: { dev: () => ({ approval: { toolName: "Read", ttlMs: 20 }, reply: "그래도 답합니다" }) },
    });
    await bridge.deliverInbound(delivery("dev", "@dev 승인"), 2_000);
    await scenario.idle();

    const result = frames.find(
      (f) => f.event === "agent" && (f.payload as { data: { phase: string } }).data.phase === "result",
    );
    const data = (result?.payload as { data: { isError: boolean; result: string } } | undefined)?.data;
    expect(data).toMatchObject({
      isError: true,
      result: "PreToolUse:Read hook error: OpenClaw user denied native tool use (Read).",
    });
    // 거절·만료는 런을 죽이지 않는다 — 정본은 그대로 온다
    expect(outbound.map((m) => m.text)).toEqual(["그래도 답합니다"]);
    expect(scenario.errors).toEqual([]);
  });

  it("승인 둘이면 한 런에 겹쳐 뜨고, 둘 다 확정돼야 재생이 이어진다", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      agents: {
        dev: () => ({
          approval: [
            { toolName: "Write", ttlMs: 200 },
            { toolName: "Read", ttlMs: 5_000, onDecision: "continue" },
          ],
          reply: "둘 다 끝",
        }),
      },
    });
    await bridge.deliverInbound(delivery("dev", "@dev 승인 둘"), 2_000);
    const requested = await vi.waitFor(() => {
      const found = frames.filter((f) => f.event === "plugin.approval.requested");
      expect(found).toHaveLength(2);
      return found;
    });
    // 첫 승인이 만료돼도(200ms) 재생은 멈춰 있다 — 둘째가 살아 있다
    await vi.waitFor(() =>
      expect(frames.filter((f) => f.event === "plugin.approval.resolved")).toHaveLength(1),
    );
    expect(outbound).toEqual([]);
    // 겹침의 정의 — 둘째 승인은 첫째가 확정되기 **전에** 떠 있었다(하나씩 기다렸다면 순서가 뒤집힌다)
    const order = frames.map((f) => f.event);
    expect(order.indexOf("plugin.approval.resolved")).toBeGreaterThan(
      order.lastIndexOf("plugin.approval.requested"),
    );

    const alive = (requested[1]?.payload as { id: string } | undefined)?.id;
    await connection.request("approval.resolve", { id: alive, kind: "plugin", decision: "allow-once" });
    await scenario.idle();
    expect(outbound.map((m) => m.text)).toEqual(["둘 다 끝"]);
    expect(scenario.errors).toEqual([]);
  });

  it("idle() 은 재생 중인 런이 모두 끝나야 resolve 한다", async () => {
    const scenario = createScenario({
      gateway,
      plugin,
      agents: { dev: () => ({ deltas: ["a", "b"], reply: "ab", deltaDelayMs: 20 }) },
    });
    await scenario.idle(); // 재생 중인 것이 없으면 곧바로
    await bridge.deliverInbound(delivery("dev", "하나"), 2_000);
    await bridge.deliverInbound(delivery("dev", "둘"), 2_000);
    await scenario.idle();
    expect(outbound.map((m) => m.text)).toEqual(["ab", "ab"]);
  });

  it("대본이 없는 에이전트면 INTERNAL 로 ack 한다", async () => {
    createScenario({ gateway, plugin, agents: {} });
    await expect(bridge.deliverInbound(delivery("ghost", "누구"), 2_000)).resolves.toMatchObject({
      ok: false,
      error: { code: "INTERNAL", message: expect.stringContaining("ghost") },
    });
  });
});
