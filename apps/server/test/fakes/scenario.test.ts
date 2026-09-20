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
