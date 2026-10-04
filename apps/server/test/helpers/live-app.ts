import type { BridgeHello } from "@dodok/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppDeps, createApp } from "../../src/app";
import { loadConfig } from "../../src/config";
import type { RunTimeouts } from "../../src/modules/runs/orchestrator";
import { type FakeGateway, type FakeGatewayOptions, startFakeGateway } from "../fakes/fake-gateway";
import { type FakePlugin, startFakePlugin } from "../fakes/fake-plugin";
import { login, noExternalPush } from "./app";
import { testEnv } from "./env";
import { openclawOf } from "./openclaw";

export type LiveApp = {
  app: App;
  gateway: FakeGateway;
  plugin: FakePlugin;
  /** owner 로그인 세션 */
  auth: Awaited<ReturnType<typeof login>>;
  /** 디바이스 아이덴티티·DATA_DIR·첨부(dir/attachments) 임시 디렉터리 — close() 가 지운다 */
  dir: string;
  /** 앱 → 가짜 플러그인 → 가짜 Gateway 순으로 닫고 임시 디렉터리를 지운다. 두 번 불러도 같은 프로미스 */
  close(): Promise<void>;
};

export type LiveAppOptions = FakeGatewayOptions & {
  /** 어댑터는 항상 실제 OpenClawAdapter 다 */
  deps?: Omit<AppDeps, "adapter">;
  /** loadConfig env 덮어쓰기(마지막에 펼친다) — 예: 파일 DB 로 재부팅을 잴 때 `{ DB_PATH }` */
  env?: Record<string, string>;
  /** 오케스트레이터 상한을 실제 시계로 잴 만큼 줄인다 — `deps.timeouts` 위에 덮는다 */
  timeouts?: Partial<RunTimeouts>;
  /** 가짜 플러그인 hello — 옛 플러그인(스레드 모름)을 흉내 낼 때 */
  pluginHello?: BridgeHello;
  /** listen 포트(기본 0 — 빈 포트). 재시작을 흉내 낼 때 앞 부팅의 포트를 준다 — 밖에서 붙은 클라이언트가 같은 주소로 돌아온다 */
  port?: number;
};

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * 네트워크 없이 서버 전체를 띄운다: 가짜 Gateway 기동 → 그 주소를 dev Gateway 로 설정 → createApp(실제 OpenClawAdapter)
 * → listen(0) → 가짜 플러그인 /bridge 접속 → 어댑터가 gateway·bridge 모두 connected → owner 로그인.
 * 도중에 실패하면 만든 것을 닫고 던진다.
 * 첨부 블롭은 앱마다 따로인 join(live.dir, "attachments") 에 쌓이고 close() 가 지운다(blobPath(그 경로, sha) 로 디스크를 본다).
 * 재부팅 뒤에도 블롭이 남아야 하면 두 부팅에 같은 env.ATTACHMENTS_DIR(과 파일 DB_PATH)을 주고 스스로 지운다 — 동시에 띄우지 않는다.
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
    gateway = await startFakeGateway({
      ...(opts.grantAdmin === undefined ? {} : { grantAdmin: opts.grantAdmin }),
      ...(opts.serverVersion === undefined ? {} : { serverVersion: opts.serverVersion }),
    });
    app = await createApp(
      loadConfig({
        ...testEnv,
        OPENCLAW_TARGET: "dev",
        OPENCLAW_DEV_GATEWAY_URL: gateway.url,
        OPENCLAW_DEV_GATEWAY_TOKEN: gateway.token,
        DATA_DIR: dir,
        DB_PATH: ":memory:",
        // 앱마다 따로(testEnv 주석) — dir 아래라 close() 가 함께 지운다
        ATTACHMENTS_DIR: join(dir, "attachments"),
        ...opts.env,
      }),
      {
        ...opts.deps,
        pushSend: opts.deps?.pushSend ?? noExternalPush,
        ...(opts.timeouts === undefined ? {} : { timeouts: { ...opts.deps?.timeouts, ...opts.timeouts } }),
      },
    );
    await app.fastify.listen({ host: "127.0.0.1", port: opts.port ?? 0 });
    plugin = await startFakePlugin({
      bridgeUrl: app.url,
      token: testEnv.BRIDGE_TOKEN as string,
      ...(opts.pluginHello === undefined ? {} : { hello: opts.pluginHello }),
    });
    await waitForAdapterConnected(app);
    const auth = await login(app);
    return { app, gateway, plugin, auth, dir, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** 어댑터 status 이벤트로 gateway·bridge 가 모두 connected 가 될 때까지 기다린다. dev:fake(scripts/dev-fake.ts)도 쓴다. */
export function waitForAdapterConnected(app: App, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  const up = () => {
    const status = openclawOf(app).status();
    return status.provider === "openclaw" && status.gateway === "connected" && status.bridge === "connected";
  };
  if (up()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const off = openclawOf(app).onEvent((event) => {
      if (event.kind !== "status" || !up()) return;
      clearTimeout(timer);
      off();
      resolve();
    });
    const timer = setTimeout(() => {
      off();
      reject(
        new Error(`adapter not connected within ${timeoutMs}ms: ${JSON.stringify(openclawOf(app).status())}`),
      );
    }, timeoutMs);
  });
}
