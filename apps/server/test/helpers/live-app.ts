import type { BridgeHello } from "@dodok/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type App, type AppDeps, createApp } from "../../src/app";
import { hasGateways } from "../../src/adapters/types";
import { loadConfig } from "../../src/config";
import {
  createGateway,
  gatewayConfig,
  listGatewayRows,
  updateGateway,
} from "../../src/modules/gateways/service";
import { issueBridgeToken } from "../../src/modules/setup/tokens";
import type { RunTimeouts } from "../../src/modules/runs/orchestrator";
import {
  type FakeGateway,
  type FakeGatewayAgent,
  type FakeGatewayOptions,
  startFakeGateway,
} from "../fakes/fake-gateway";
import { type FakePlugin, startFakePlugin } from "../fakes/fake-plugin";
import { login, noExternalPush } from "./app";
import { testEnv } from "./env";
import { openclawOf } from "./openclaw";

/** 앱에 붙은 가짜 Gateway 하나와 그 짝 가짜 플러그인 */
export type LiveGateway = {
  name: string;
  gateway: FakeGateway;
  /** DB 행 id(= 어댑터 연결 id) */
  gatewayId: string;
  /** 그 Gateway 에 발급한 브리지 토큰 원문 */
  bridgeToken: string;
  plugin: FakePlugin;
};

export type LiveApp = {
  app: App;
  /** 붙은 Gateway 전부, 더한 차례 — 첫 줄이 아래 gateway·gatewayId·bridgeToken·plugin 이다 */
  gateways: LiveGateway[];
  gateway: FakeGateway;
  /** 가짜 Gateway 의 DB 행 id(= 어댑터 연결 id) — OpenClaw 에이전트를 등록할 때 gatewayId 로 준다 */
  gatewayId: string;
  /** 그 Gateway 에 발급한 브리지 토큰 원문 — 가짜 플러그인이 이것으로 붙는다 */
  bridgeToken: string;
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
  /** 첫 Gateway 의 이름(기본 「가짜 Gateway」) */
  gatewayName?: string;
  /** 첫 Gateway 뒤에 더 붙일 가짜 Gateway·플러그인 짝(멀티 Gateway) — 각자 이름·agents.list 를 준다 */
  extraGateways?: Array<{ name: string; agents?: FakeGatewayAgent[] }>;
};

const CONNECT_TIMEOUT_MS = 5_000;

/**
 * 네트워크 없이 서버 전체를 띄운다: 가짜 Gateway 기동 → createApp(실제 OpenClawAdapter) → 가짜 Gateway 를 DB 에 넣고 어댑터에
 * 넣음(연결 페이지 「Gateway 추가」와 같다 — DB 에 이미 Gateway 가 있으면(파일 DB 재부팅) 같은 차례의 Gateway 의 주소·토큰을 새
 * 가짜로 바꾼다) → 그 Gateway 의 브리지 토큰 발급 → listen(0) → 가짜 플러그인 /bridge 접속 → 어댑터가 gateway·bridge 모두
 * connected → owner 로그인. `extraGateways` 가 있으면 Gateway·플러그인 짝마다 같은 일을 한다.
 * 도중에 실패하면 만든 것을 닫고 던진다.
 * 첨부 블롭은 앱마다 따로인 join(live.dir, "attachments") 에 쌓이고 close() 가 지운다(blobPath(그 경로, sha) 로 디스크를 본다).
 * 재부팅 뒤에도 블롭이 남아야 하면 두 부팅에 같은 env.ATTACHMENTS_DIR(과 파일 DB_PATH)을 주고 스스로 지운다 — 동시에 띄우지 않는다.
 */
export async function bootLiveApp(opts: LiveAppOptions = {}): Promise<LiveApp> {
  const dir = mkdtempSync(join(tmpdir(), "dodok-live-"));
  const fakeGateways: FakeGateway[] = [];
  const plugins: FakePlugin[] = [];
  let app: App | undefined;
  let closing: Promise<void> | undefined;

  const close = () => {
    closing ??= (async () => {
      // 앱이 먼저 닫혀야 플러그인이 shutdown notice 를 받고, 어댑터가 Gateway 연결을 스스로 끊는다
      try {
        await app?.close();
        for (const plugin of plugins) plugin.close();
        await Promise.all(fakeGateways.map((gateway) => gateway.close()));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })();
    return closing;
  };

  try {
    const specs = [
      {
        name: opts.gatewayName ?? "가짜 Gateway",
        ...(opts.agents === undefined ? {} : { agents: opts.agents }),
      },
      ...(opts.extraGateways ?? []),
    ];
    for (const spec of specs) {
      fakeGateways.push(
        await startFakeGateway({
          ...(opts.serverVersion === undefined ? {} : { serverVersion: opts.serverVersion }),
          ...(spec.agents === undefined ? {} : { agents: spec.agents }),
        }),
      );
    }
    app = await createApp(
      loadConfig({
        ...testEnv,
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
    const added = specs.map((spec, index) => ({
      name: spec.name,
      gateway: fakeGateways[index] as FakeGateway,
      ...addFakeGateway(app as App, fakeGateways[index] as FakeGateway, index, spec.name),
    }));
    await app.fastify.listen({ host: "127.0.0.1", port: opts.port ?? 0 });
    const gateways: LiveGateway[] = [];
    for (const [index, entry] of added.entries()) {
      const spec = specs[index];
      const plugin = await startFakePlugin({
        bridgeUrl: app.url,
        token: entry.bridgeToken,
        ...(opts.pluginHello === undefined ? {} : { hello: opts.pluginHello }),
        ...(spec?.agents === undefined
          ? {}
          : {
              agents: spec.agents.map((a) => ({
                agentId: a.id,
                ...(a.name === undefined ? {} : { name: a.name }),
              })),
            }),
      });
      plugins.push(plugin);
      gateways.push({ ...entry, plugin });
    }
    await waitForAdapterConnected(app);
    const auth = await login(app);
    const [first] = gateways as [LiveGateway];
    return {
      app,
      gateways,
      gateway: first.gateway,
      gatewayId: first.gatewayId,
      bridgeToken: first.bridgeToken,
      plugin: first.plugin,
      auth,
      dir,
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/**
 * 가짜 Gateway 를 그 앱의 DB 와 OpenClaw 어댑터에 넣고(DB 에 index 번째 Gateway 가 이미 있으면 그 행을 이 주소로) 그 Gateway 의
 * 브리지 토큰을 발급한다
 */
function addFakeGateway(
  app: App,
  gateway: FakeGateway,
  index: number,
  name: string,
): { gatewayId: string; bridgeToken: string } {
  const existing = listGatewayRows(app.db, app.workspaceId)[index];
  // 가짜·실연 Gateway 는 워크스페이스 owner 가 만든 것 — 만들 때 승인된다
  const owner = { userId: app.ownerUserId, role: "owner" } as const;
  const row = existing
    ? updateGateway(app.db, app.workspaceId, existing.id, { url: gateway.url, token: gateway.token }, owner)
        .row
    : createGateway(app.db, app.workspaceId, { name, url: gateway.url, token: gateway.token }, owner);
  const openclaw = app.registry.forProvider("openclaw");
  if (!openclaw || !hasGateways(openclaw))
    throw new Error("live app has no gateway-managing OpenClaw adapter");
  openclaw.upsertGateway(gatewayConfig(row));
  const { token } = issueBridgeToken(app.db, app.workspaceId, row.id, "live-app");
  return { gatewayId: row.id, bridgeToken: token };
}

/**
 * 어댑터 status 이벤트로 Gateway 가 하나 이상이고 모두 gateway·bridge connected 가 될 때까지 기다린다.
 */
export function waitForAdapterConnected(app: App, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
  const up = () => {
    const status = openclawOf(app).status();
    return (
      status.provider === "openclaw" &&
      status.gateways.length > 0 &&
      status.gateways.every((g) => g.gateway === "connected" && g.bridge === "connected")
    );
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
