import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeClient } from "../src/bridge-client";
import type { OutboundCorrelation } from "../src/outbound";

// 2026.9.5 Gateway 는 번들을 같은 realm 에서 두 번 평가한다(ADR 0004). resetModules 뒤 다시 import 하면
// 다른 모듈 인스턴스가 나오는 것으로 그 꼴을 흉내 낸다 — 세대 1 이 startAccount, 세대 2 가 handleAction.
type Registry = typeof import("../src/bridge-registry");

async function loadGeneration(): Promise<Registry> {
  vi.resetModules();
  return await import("../src/bridge-registry");
}

function fakeBridge(name: string): BridgeClient {
  return { name } as unknown as BridgeClient;
}

afterEach(async () => {
  const { BRIDGES_KEY, CORRELATIONS_KEY } = await import("../src/bridge-registry");
  const g = globalThis as Record<symbol, unknown>;
  delete g[BRIDGES_KEY];
  delete g[CORRELATIONS_KEY];
  vi.resetModules();
});

describe("bridge-registry — 모듈 인스턴스를 넘는 공유", () => {
  it("세대 1 이 등록한 브리지를 세대 2 가 같은 객체로 찾는다", async () => {
    const gen1 = await loadGeneration();
    const bridge = fakeBridge("gen1");
    gen1.registerBridge("default", bridge);

    const gen2 = await loadGeneration();
    expect(gen2).not.toBe(gen1);
    expect(gen2.getBridge("default")).toBe(bridge);
  });

  it("세대 1 이 남긴 상관관계(runId·replyTo)를 세대 2 가 같은 객체로 본다 — 나중에 붙는 providerRunId 까지", async () => {
    const gen1 = await loadGeneration();
    const correlation: OutboundCorrelation = { runId: "run-1", replyToInboundId: "msg-1" };
    gen1.setCorrelation("agent:dev:dodok:channel:c1", correlation);

    const gen2 = await loadGeneration();
    correlation.providerRunId = "run-1";
    expect(gen2.getCorrelation("agent:dev:dodok:channel:c1")).toBe(correlation);
    expect(gen2.getCorrelation("agent:dev:dodok:channel:c1")).toEqual({
      runId: "run-1",
      replyToInboundId: "msg-1",
      providerRunId: "run-1",
    });
  });
});

describe("bridge-registry — 전역 자리", () => {
  it("두 Map 은 서로 다른 키를 쓴다", async () => {
    const reg = await loadGeneration();
    expect(reg.BRIDGES_KEY).not.toBe(reg.CORRELATIONS_KEY);
    // 쓰는 자리에서 키를 바꿔 끼워도 잡는다 — 같은 id 가 서로를 덮지 않는다
    const bridge = fakeBridge("x");
    const correlation: OutboundCorrelation = { runId: "run-x", replyToInboundId: "msg-x" };
    reg.registerBridge("x", bridge);
    reg.setCorrelation("x", correlation);
    expect(reg.getBridge("x")).toBe(bridge);
    expect(reg.getCorrelation("x")).toBe(correlation);
  });

  it("전역 자리에 Map 이 아닌 값이 있으면 키 이름을 담아 던진다 — 조용히 덮어 브리지를 잃지 않는다", async () => {
    const reg = await loadGeneration();
    const g = globalThis as Record<symbol, unknown>;
    g[reg.BRIDGES_KEY] = { stale: true };
    g[reg.CORRELATIONS_KEY] = { stale: true };
    expect(() => reg.getBridge("default")).toThrow("dodok.openclaw-plugin.bridges.v1");
    expect(() => reg.getCorrelation("agent:dev:dodok:channel:c1")).toThrow(
      "dodok.openclaw-plugin.correlations.v1",
    );
    expect(g[reg.BRIDGES_KEY]).toEqual({ stale: true });
  });
});

describe("bridge-registry — 삭제 가드", () => {
  it("새 세대가 덮은 뒤 옛 세대가 옛 브리지로 release 해도 새 브리지가 남는다", async () => {
    const oldGen = await loadGeneration();
    const oldBridge = fakeBridge("old");
    oldGen.registerBridge("default", oldBridge);

    // 핫 리로드: 새 세대 startAccount 가 옛 세대 finally 보다 먼저 돈다
    const newGen = await loadGeneration();
    const newBridge = fakeBridge("new");
    newGen.registerBridge("default", newBridge);

    expect(oldGen.releaseBridge("default", oldBridge)).toBe(false);
    expect(newGen.getBridge("default")).toBe(newBridge);
    expect(oldGen.getBridge("default")).toBe(newBridge);
  });

  it("등록한 그 객체로 release 하면 지워진다", async () => {
    const gen1 = await loadGeneration();
    const bridge = fakeBridge("only");
    gen1.registerBridge("default", bridge);

    const gen2 = await loadGeneration();
    expect(gen1.releaseBridge("default", bridge)).toBe(true);
    expect(gen2.getBridge("default")).toBeUndefined();
  });

  it("다른 계정의 브리지는 건드리지 않는다", async () => {
    const reg = await loadGeneration();
    const a = fakeBridge("a");
    const b = fakeBridge("b");
    reg.registerBridge("a", a);
    reg.registerBridge("b", b);
    expect(reg.releaseBridge("a", a)).toBe(true);
    expect(reg.getBridge("b")).toBe(b);
  });
});
