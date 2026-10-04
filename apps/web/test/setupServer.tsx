import type {
  BridgeTokenRecord,
  GatewaySetup,
  IssueBridgeTokenResult,
  IssueRunnerTokenResult,
  RunnerConnection,
  RunnerTokenRecord,
  SetupStatus,
} from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { ConnectionPage } from "@/features/setup/ConnectionPage";
import { ME, json, shellGet } from "./shellApi";

/** 연결 페이지 테스트의 가짜 서버·렌더 도우미 */

export const OWNER = { ...ME, role: "owner" };
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_FILE = "f".repeat(64);
export const PUBLIC_URL = "wss://chat.example.com/bridge";
/** 연결 페이지가 그리는 첫 Gateway — 브리지 토큰 경로가 이 아래다 */
export const GATEWAY_ID = "0190a000-0000-7000-8000-00000000a001";
export const TOKENS_PATH = `/api/v1/gateways/${GATEWAY_ID}/bridge-tokens`;

export const tokenId = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

export function tokenOf(n: number, over: Partial<BridgeTokenRecord> = {}): BridgeTokenRecord {
  return {
    id: tokenId(n),
    label: `토큰-${n}`,
    prefix: `pre${n}xx`.slice(0, 6),
    createdAt: `2026-09-2${n}T00:00:00.000Z`,
    lastUsedAt: null,
    revokedAt: null,
    connected: false,
    ...over,
  };
}

type StatusOver = {
  server?: Partial<SetupStatus["server"]>;
  /** 첫 Gateway 의 gateway 블록 */
  gateway?: Partial<GatewaySetup["gateway"]>;
  bridge?: Partial<SetupStatus["bridge"]>;
  /** 첫 Gateway 에 붙은 플러그인 */
  plugin?: Partial<NonNullable<GatewaySetup["bridge"]["plugin"]>> | null;
  pluginFile?: SetupStatus["pluginFile"];
  pluginMatches?: boolean | null;
  /** 참이면 Gateway 가 하나도 없다 */
  noGateway?: boolean;
  runners?: Partial<SetupStatus["runners"]>;
};

/** 붙은 러너 하나 — 기본은 같은 빌드(SHA_A)·에이전트 하나 */
export function runnerOf(n: number, over: Partial<RunnerConnection> = {}): RunnerConnection {
  return {
    tokenId: tokenId(n),
    label: `러너-${n}`,
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.283",
    claudeCodeVersion: "2.1.283",
    bundleSha256: SHA_A,
    capabilities: ["threads", "interrupt", "approvals", "attachments"],
    connectedAt: "2026-09-27T01:00:00.000Z",
    agents: [
      {
        id: `coder${n}`,
        name: `코더${n}`,
        model: "sonnet",
        workdirLabel: "my-repo",
        conflict: false,
        boundTokenId: null,
      },
    ],
    ...over,
  };
}

/** 기본은 모두 연결됨·같은 빌드 — 테스트가 다른 칸만 덮는다 */
export function statusOf(over: StatusOver = {}): SetupStatus {
  const plugin =
    over.plugin === null
      ? null
      : {
          version: "0.0.0",
          sdkVersion: "2026.9.4",
          gatewayVersion: "2026.9.5",
          bundleSha256: SHA_A,
          tokenId: tokenId(1),
          connectedAt: "2026-09-25T00:00:00.000Z",
          ...over.plugin,
        };
  const gateway: GatewaySetup = {
    id: GATEWAY_ID,
    name: "사무실",
    url: "wss://gateway.example.com",
    enabled: true,
    gateway: {
      state: "connected",
      host: "gateway.example.com",
      version: "2026.9.5",
      pinned: "2026.9.4",
      drift: true,
      pairing: null,
      ...over.gateway,
    },
    bridge: { state: plugin ? "connected" : "down", plugin },
    pluginMatches: over.pluginMatches === undefined ? true : over.pluginMatches,
  };
  return {
    server: { version: "0.1.0", ...over.server },
    bridge: { publicUrl: PUBLIC_URL, ...over.bridge },
    pluginFile: over.pluginFile ?? { available: true, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 123_456 },
    gateways: over.noGateway ? [] : [gateway],
    runners: { list: [], runnerFile: { available: false }, ...over.runners },
  };
}

export const RAW_TOKEN = `dbt_${"Z".repeat(43)}`;
export const RAW_RUNNER_TOKEN = `drn_${"Q".repeat(43)}`;
export const RUNNER_SERVER_URL = "https://chat.example.com";

export type Call = { method: string; url: string; body: unknown };
type Reply = Response | Promise<Response>;

/** URL 로 가르는 가짜 서버. 토큰 목록을 서버 상태로 들고, 발급·폐기가 그것을 고친다. 그 밖은 셸 기본 응답 */
export function stubSetupServer(
  opts: {
    status?: SetupStatus;
    tokens?: BridgeTokenRecord[];
    runnerTokens?: RunnerTokenRecord[];
    me?: unknown;
    issue?: (label: string) => Reply;
    plugin?: () => Reply;
    runner?: () => Reply;
    /** PUT runner-tokens/:id/agents/:agentId — 기본은 200 */
    bind?: (tokenId: string, agentId: string) => Reply;
  } = {},
) {
  const tokens = [...(opts.tokens ?? [])];
  const runnerTokens = [...(opts.runnerTokens ?? [])];
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (url === "/api/v1/auth/me") return json(200, opts.me ?? OWNER);
    if (method === "GET" && url === "/api/v1/setup/status") return json(200, opts.status ?? statusOf());
    if (method === "GET" && url === TOKENS_PATH) return json(200, { tokens });
    if (method === "POST" && url === TOKENS_PATH) {
      const label = (body as { label: string }).label;
      if (opts.issue) return opts.issue(label);
      const record = tokenOf(9, {
        label,
        prefix: RAW_TOKEN.slice(4, 10),
        createdAt: "2026-09-25T01:00:00.000Z",
      });
      tokens.push(record);
      const result: IssueBridgeTokenResult = {
        token: RAW_TOKEN,
        record,
        pluginConfig: {
          channels: { dodok: { accounts: { default: { bridgeUrl: PUBLIC_URL, token: RAW_TOKEN } } } },
        },
      };
      return json(201, result);
    }
    const del = url.startsWith(`${TOKENS_PATH}/`) ? [url, url.slice(TOKENS_PATH.length + 1)] : null;
    if (method === "DELETE" && del) {
      const t = tokens.find((x) => x.id === del[1]);
      if (t) t.revokedAt = "2026-09-25T02:00:00.000Z";
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && url === "/api/v1/setup/runner-tokens") return json(200, { tokens: runnerTokens });
    if (method === "POST" && url === "/api/v1/setup/runner-tokens") {
      const label = (body as { label: string }).label;
      const record = tokenOf(8, {
        label,
        prefix: RAW_RUNNER_TOKEN.slice(4, 10),
        createdAt: "2026-09-27T02:00:00.000Z",
      });
      runnerTokens.push(record);
      const result: IssueRunnerTokenResult = {
        token: RAW_RUNNER_TOKEN,
        record,
        runnerConfig: { serverUrl: RUNNER_SERVER_URL, tokenFile: "~/.dodok-runner/token" },
      };
      return json(201, result);
    }
    const delRunner = /^\/api\/v1\/setup\/runner-tokens\/([^/]+)$/.exec(url);
    if (method === "DELETE" && delRunner) {
      const t = runnerTokens.find((x) => x.id === delRunner[1]);
      if (t) t.revokedAt = "2026-09-27T03:00:00.000Z";
      return new Response(null, { status: 204 });
    }
    const bind = /^\/api\/v1\/setup\/runner-tokens\/([^/]+)\/agents\/([^/]+)$/.exec(url);
    if (method === "PUT" && bind) {
      if (opts.bind) return opts.bind(bind[1] ?? "", bind[2] ?? "");
      return json(200, { agent: { providerAgentId: bind[2] } });
    }
    if (method === "GET" && url === "/api/v1/setup/runner.tgz")
      return opts.runner
        ? opts.runner()
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-disposition": `attachment; filename="dodok-claude-runner-ffffffffffff.tgz"`,
            },
          });
    if (method === "GET" && url === "/api/v1/setup/plugin.tgz")
      return opts.plugin
        ? opts.plugin()
        : new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: {
              "content-disposition": `attachment; filename="dodok-openclaw-plugin-ffffffffffff.tgz"`,
            },
          });
    // 라우트로 띄울 때 셸(사이드바·배너)이 부르는 것
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    // 연결 페이지 API — 설정 상태·tgz 와 Gateway 아래 브리지 토큰
    setupCalls: () =>
      calls.filter((c) => c.url.startsWith("/api/v1/setup") || c.url.startsWith("/api/v1/gateways")),
  };
}

/**
 * me 를 미리 넣고 페이지만 그린다 — 라우트 가드가 me 를 채운 뒤의 모습. 라우터는 문맥만 준다(원문이 보이는 동안의 이동 막기가
 * 라우터를 쓴다) — 셸까지 띄우는 이동 시나리오는 `renderRoute`
 */
export function renderConnection(me: unknown = OWNER, qc: QueryClient = createQueryClient(() => {})) {
  qc.setQueryData(qk.me, me);
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/settings/connection"] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterContextProvider router={router}>
        <ConnectionPage />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
  return qc;
}

/** 캐시(쿼리·뮤테이션) 전체를 한 문자열로 — 원문이 어디에도 없는지 볼 때 */
export function cacheDump(qc: QueryClient): string {
  return JSON.stringify({
    queries: qc
      .getQueryCache()
      .getAll()
      .map((q) => ({ key: q.queryKey, state: q.state })),
    mutations: qc
      .getMutationCache()
      .getAll()
      .map((m) => m.state),
  });
}
