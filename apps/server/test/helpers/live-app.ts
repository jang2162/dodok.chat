import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppDeps, createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from "../fakes/fake-gateway";
import { type FakePlugin, startFakePlugin } from "../fakes/fake-plugin";
import { login } from "./app";
import { testEnv } from "./env";

export type LiveApp = {
  app: App;
  gateway: FakeGateway;
  plugin: FakePlugin;
  /** owner 로그인 세션 */
  auth: Awaited<ReturnType<typeof login>>;
  /** 디바이스 아이덴티티·DATA_DIR 임시 디렉터리 — close() 가 지운다 */
  dir: string;
  /** 앱 → 가짜 플러그인 → 가짜 Gateway 순으로 닫고 임시 디렉터리를 지운다. 두 번 불러도 같은 프로미스 */
  close(): Promise<void>;
};

export type LiveAppOptions = FakeGatewayOptions & {
  /** 어댑터는 항상 실제 OpenClawAdapter 다 */
  deps?: Omit<AppDeps, "adapter">;
};

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * 네트워크 없이 서버 전체를 띄운다: 가짜 Gateway 기동 → 그 주소를 dev Gateway 로 설정 → createApp(실제 OpenClawAdapter)
 * → listen(0) → 가짜 플러그인 /bridge 접속 → 어댑터가 gateway·bridge 모두 connected → owner 로그인.
 * 도중에 실패하면 만든 것을 닫고 던진다.
 */
export async function bootLiveApp(opts: LiveAppOptions = {}): Promise<LiveApp> {
  const dir = mkdtempSync(join(tmpdir(), "dodok-live-"));
  let gateway: FakeGateway | undefined;
  let app: App | undefined;
  let plugin: FakePlugin | undefined;
  let closing: Promise<void> | undefined;

  const close = () => {
    closing ??= (async () => {
      // 앱이 먼저 닫혀야 플러그인이 shutdown notice 를 받고, 어댑터가 Gateway 연결을 스스로 끊는다
      try {
        await app?.close();
        plugin?.close();
        await gateway?.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    return closing;
  };

  try {
    gateway = await startFakeGateway(opts.grantAdmin === undefined ? {} : { grantAdmin: opts.grantAdmin });
    app = await createApp(
      loadConfig({
        ...testEnv,
        OPENCLAW_TARGET: "dev",
        OPENCLAW_DEV_GATEWAY_URL: gateway.url,
        OPENCLAW_DEV_GATEWAY_TOKEN: gateway.token,
        OPENCLAW_DEVICE_IDENTITY_PATH: join(dir, "openclaw-device.json"),
        DATA_DIR: dir,
        DB_PATH: ":memory:",
      }),
      opts.deps ?? {},
    );
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    plugin = await startFakePlugin({ bridgeUrl: app.url, token: testEnv.BRIDGE_TOKEN as string });
    await waitForAdapterConnected(app);
    const auth = await login(app);
    return { app, gateway, plugin, auth, dir, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** 어댑터 status 이벤트로 gateway·bridge 가 모두 connected 가 될 때까지 기다린다. */
function waitForAdapterConnected(app: App, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  const up = () => {
    const status = app.adapter.status();
    return status.gateway === "connected" && status.bridge === "connected";
  };
  if (up()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = app.adapter.onEvent((event) => {
      if (event.kind !== "status" || !up()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(`adapter not connected within ${timeoutMs}ms: ${JSON.stringify(app.adapter.status())}`),
      );
    }, timeoutMs);
  });
}
