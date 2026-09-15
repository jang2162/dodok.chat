import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";

describe("서버 통합 스모크 — 실제 OpenClawAdapter + 가짜 Gateway + 가짜 플러그인", () => {
  let live: LiveApp | undefined;

  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("bootLiveApp 뒤 GET /api/v1/adapter/status 가 gateway·bridge 모두 connected 를 내고, close() 는 임시 디렉터리를 지운다", async () => {
    live = await bootLiveApp();
    const { app, gateway, plugin, auth, dir } = live;

    expect(app.adapter).not.toBeInstanceOf(FakeAdapter);
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/adapter/status",
      headers: auth.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: "openclaw",
      gateway: "connected",
      bridge: "connected",
      capabilities: { sessionReset: true, agentsList: true, configSet: true },
    });

    // 어댑터가 가짜 Gateway 에 자기 기본 scopes 로 붙어 재접속 복구 구독까지 돌렸고, 디바이스 아이덴티티는 임시 경로에 있다
    await vi.waitFor(() =>
      expect(gateway.requests.map((r) => r.method)).toEqual(
        expect.arrayContaining(["connect", "sessions.subscribe"]),
      ),
    );
    expect(existsSync(join(dir, "openclaw-device.json"))).toBe(true);
    expect(plugin.helloResult?.protocol).toBe(1);

    await live.close();
    live = undefined;
    expect(existsSync(dir)).toBe(false);
    expect(plugin.notices).toEqual([{ reason: "shutdown", message: "server shutting down" }]);
    expect(app.adapter.status().gateway).toBe("down");
  });
});
