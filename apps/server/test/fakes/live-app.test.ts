import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootLiveApp, type LiveApp } from "../helpers/live-app";
import { openclawStatus, openclawOf } from "../helpers/openclaw";

describe("서버 통합 스모크 — 실제 OpenClawAdapter + 가짜 Gateway + 가짜 플러그인", () => {
  let live: LiveApp | undefined;

  afterEach(async () => {
    await live?.close();
    live = undefined;
  });

  it("bootLiveApp 뒤 GET /api/v1/adapter/status 가 gateway·bridge 모두 connected 를 내고, close() 는 임시 디렉터리를 지운다", async () => {
    live = await bootLiveApp();
    const { app, gateway, plugin, auth, dir } = live;

    expect(openclawOf(app)).not.toBeInstanceOf(FakeAdapter);
    const res = await app.fastify.inject({
      method: "GET",
      url: "/api/v1/adapter/status",
      headers: auth.headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      // 기본 어댑터는 OpenClaw 와 Claude 러너 둘 — 러너는 붙은 것도 토큰도 없다
      statuses: [
        { provider: "openclaw", gateway: "connected", bridge: "connected" },
        { provider: "claude", runners: { connected: 0, tokens: 0 } },
      ],
      capabilities: {
        openclaw: {
          sessionReset: true,
          agentsList: true,
          configSet: true,
          promptEveryRun: false,
          serverSessionIds: false,
        },
        claude: {
          sessionReset: true,
          agentsList: true,
          configSet: true,
          promptEveryRun: true,
          serverSessionIds: true,
        },
      },
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
    expect(openclawStatus(openclawOf(app)).gateway).toBe("down");
  });

  it("OPENCLAW_FRAME_DUMP_PATH 를 주면 어댑터가 받은 Gateway 프레임을 그 파일에 남기고 앱 close() 에서 닫는다", async () => {
    const dumpDir = mkdtempSync(join(tmpdir(), "dodok-live-dump-"));
    const path = join(dumpDir, "frames.jsonl");
    try {
      live = await bootLiveApp({ env: { OPENCLAW_FRAME_DUMP_PATH: path } });
      // sessionKey 가 없는 프레임은 구독과 무관하게 모든 연결에 간다
      await live.gateway.emitEvent("agent", {
        runId: "not-ours",
        stream: "lifecycle",
        data: { phase: "start" },
      });
      await live.gateway.flush();
      await live.close();
      live = undefined;

      const frames = readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { frame: { event: string; payload: { runId?: string } } }).frame);
      expect(frames).toEqual([
        expect.objectContaining({ event: "agent", payload: expect.objectContaining({ runId: "not-ours" }) }),
      ]);
    } finally {
      rmSync(dumpDir, { recursive: true, force: true });
    }
  });
});
