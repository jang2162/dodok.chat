import type {
  Agent,
  BridgeTokenRecord,
  DeleteGatewayResult,
  GatewaySetup,
  IssueBridgeTokenResult,
  IssueRunnerTokenResult,
  ReissueRunnerTokenResult,
  RunnerConnection,
  RunnerSummary,
  RunnerTokenRecord,
  SetupStatus,
} from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { TooltipProvider } from "@/ui/tooltip";
import { ME, json, shellGet } from "./shellApi";

/** 「연결」 탭의 Gateway 상세·러너 토큰 시험의 가짜 서버·렌더 도우미 */

export const OWNER = { ...ME, role: "owner" };
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_FILE = "f".repeat(64);
export const PUBLIC_URL = "wss://chat.example.com/bridge";
/** 연결 페이지가 그리는 첫 Gateway — 브리지 토큰 경로가 이 아래다 */
export const GATEWAY_ID = "0190a000-0000-7000-8000-00000000a001";
export const TOKENS_PATH = `/api/v1/gateways/${GATEWAY_ID}/bridge-tokens`;

export const tokenId = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** 브리지·러너 토큰 한 줄 — 러너 토큰은 주인(ownerUserId)이 더 있다. 브리지 토큰 자리에도 그대로 들어간다 */
export function tokenOf(n: number, over: Partial<RunnerTokenRecord> = {}): RunnerTokenRecord {
  return {
    id: tokenId(n),
    label: `토큰-${n}`,
    prefix: `pre${n}xx`.slice(0, 6),
    createdAt: `2026-09-2${n}T00:00:00.000Z`,
    lastUsedAt: null,
    revokedAt: null,
    connected: false,
    ownerUserId: null,
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
  /** 첫 Gateway 뒤에 이어 붙일 Gateway(`gatewayOf`) */
  moreGateways?: GatewaySetup[];
  runners?: Partial<SetupStatus["runners"]>;
};

/** 붙은 러너 하나 — 기본은 같은 빌드(SHA_A) */
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
    gateways: over.noGateway ? [] : [gateway, ...(over.moreGateways ?? [])],
    runners: { list: [], runnerFile: { available: false }, ...over.runners },
  };
}

/** n 번째 Gateway 의 id·브리지 토큰 경로 — 1 은 `GATEWAY_ID` */
export const gatewayId = (n: number) => `0190a000-0000-7000-8000-00000000a00${n}`;
export const tokensPath = (id: string) => `/api/v1/gateways/${id}/bridge-tokens`;

/** 둘째 이후 Gateway — 기본은 꺼지지 않은 채 연결됨, 플러그인 없음 */
export function gatewayOf(
  n: number,
  over: Partial<Omit<GatewaySetup, "gateway">> & { gateway?: Partial<GatewaySetup["gateway"]> } = {},
): GatewaySetup {
  return {
    id: gatewayId(n),
    name: `Gateway-${n}`,
    url: `wss://gw${n}.example.com`,
    enabled: true,
    bridge: { state: "down", plugin: null },
    pluginMatches: null,
    ...over,
    gateway: {
      state: "connected",
      host: `gw${n}.example.com`,
      version: "2026.9.4",
      pinned: "2026.9.4",
      drift: false,
      pairing: null,
      ...over.gateway,
    },
  };
}

export const RAW_TOKEN = `dbt_${"Z".repeat(43)}`;
export const RAW_RUNNER_TOKEN = `drn_${"Q".repeat(43)}`;
/** 다시 발급의 새 원문 */
export const RAW_REISSUED_TOKEN = `drn_${"R".repeat(43)}`;
export const RUNNER_SERVER_URL = "https://chat.example.com";

export type Call = { method: string; url: string; body: unknown };
type Reply = Response | Promise<Response>;

/** URL 로 가르는 가짜 서버. 토큰 목록을 서버 상태로 들고, 발급·폐기가 그것을 고친다. 그 밖은 셸 기본 응답 */
export function stubSetupServer(
  opts: {
    /** 함수면 요청마다 부른다 — 삭제 뒤 상태처럼 도중에 바뀌는 서버. 응답을 붙잡아 두려면 Response 약속을 돌려준다 */
    status?: SetupStatus | (() => SetupStatus | Promise<Response>);
    /** 첫 Gateway(`GATEWAY_ID`)의 브리지 토큰 */
    tokens?: BridgeTokenRecord[];
    /** 다른 Gateway 의 브리지 토큰(Gateway id → 목록) */
    gatewayTokens?: Record<string, BridgeTokenRecord[]>;
    /** GET /agents — 기본은 셸의 빈 목록 */
    agents?: Agent[];
    /** POST /gateways — 기본은 201 과 받은 본문으로 만든 요약 */
    createGateway?: (body: unknown) => Reply;
    /** PATCH /gateways/:id — 기본은 200 */
    updateGateway?: (id: string, body: unknown) => Reply;
    /** DELETE /gateways/:id — 기본은 200 { unboundAgents: 0, deletedTokens: 0 } */
    deleteGateway?: (id: string) => Reply;
    runnerTokens?: RunnerTokenRecord[];
    me?: unknown;
    issue?: (label: string) => Reply;
    /** POST /setup/runner-tokens/:id/reissue — 기본은 200 과 새 원문(`RAW_REISSUED_TOKEN`)·같은 줄 */
    reissue?: (id: string) => Reply;
    runner?: () => Reply;
  } = {},
) {
  const tokens = [...(opts.tokens ?? [])];
  const tokensOf = new Map<string, BridgeTokenRecord[]>();
  for (const [id, list] of Object.entries(opts.gatewayTokens ?? {})) tokensOf.set(id, [...list]);
  tokensOf.set(GATEWAY_ID, tokens);
  const runnerTokens = [...(opts.runnerTokens ?? [])];
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (url === "/api/v1/auth/me") return json(200, opts.me ?? OWNER);
    if (method === "GET" && url === "/api/v1/setup/status") {
      const status = typeof opts.status === "function" ? opts.status() : opts.status;
      return status instanceof Promise ? status : json(200, status ?? statusOf());
    }
    const bridge = /^\/api\/v1\/gateways\/([^/]+)\/bridge-tokens(?:\/([^/]+))?$/.exec(url);
    if (bridge) {
      const list = tokensOf.get(bridge[1] ?? "") ?? [];
      tokensOf.set(bridge[1] ?? "", list);
      if (method === "GET" && !bridge[2]) return json(200, { tokens: list });
      if (method === "POST" && !bridge[2]) {
        const label = (body as { label: string }).label;
        if (opts.issue) return opts.issue(label);
        const record = tokenOf(9, {
          label,
          prefix: RAW_TOKEN.slice(4, 10),
          createdAt: "2026-09-25T01:00:00.000Z",
        });
        list.push(record);
        const result: IssueBridgeTokenResult = {
          token: RAW_TOKEN,
          record,
          pluginConfig: {
            channels: { dodok: { accounts: { default: { bridgeUrl: PUBLIC_URL, token: RAW_TOKEN } } } },
          },
        };
        return json(201, result);
      }
      if (method === "DELETE" && bridge[2]) {
        const t = list.find((x) => x.id === bridge[2]);
        if (t) t.revokedAt = "2026-09-25T02:00:00.000Z";
        return new Response(null, { status: 204 });
      }
    }
    if (method === "POST" && url === "/api/v1/gateways") {
      if (opts.createGateway) return opts.createGateway(body);
      const { name, url: gwUrl } = body as { name: string; url: string };
      return json(201, {
        id: gatewayId(7),
        name,
        url: gwUrl,
        enabled: true,
        tokenSet: true,
        ownerUserId: null,
        createdAt: "2026-10-04T00:00:00.000Z",
        updatedAt: "2026-10-04T00:00:00.000Z",
      });
    }
    const gw = /^\/api\/v1\/gateways\/([^/]+)$/.exec(url);
    if (gw && method === "PATCH") {
      if (opts.updateGateway) return opts.updateGateway(gw[1] ?? "", body);
      return json(200, { id: gw[1], ...(body as object) });
    }
    if (gw && method === "DELETE") {
      if (opts.deleteGateway) return opts.deleteGateway(gw[1] ?? "");
      const result: DeleteGatewayResult = { unboundAgents: 0, deletedTokens: 0 };
      return json(200, result);
    }
    if (method === "GET" && url === "/api/v1/agents" && opts.agents)
      return json(200, { agents: opts.agents });
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
    const reissue = /^\/api\/v1\/setup\/runner-tokens\/([^/]+)\/reissue$/.exec(url);
    if (method === "POST" && reissue) {
      const id = reissue[1] ?? "";
      if (opts.reissue) return opts.reissue(id);
      const t = runnerTokens.find((x) => x.id === id);
      if (!t) return json(404, { code: "NOT_FOUND", message: "x" });
      t.prefix = RAW_REISSUED_TOKEN.slice(4, 10);
      const result: ReissueRunnerTokenResult = {
        token: RAW_REISSUED_TOKEN,
        record: t,
        runnerConfig: { serverUrl: RUNNER_SERVER_URL, tokenFile: "~/.dodok-runner/token" },
      };
      return json(200, result);
    }
    const delRunner = /^\/api\/v1\/setup\/runner-tokens\/([^/]+)$/.exec(url);
    if (method === "DELETE" && delRunner) {
      const t = runnerTokens.find((x) => x.id === delRunner[1]);
      if (t) t.revokedAt = "2026-09-27T03:00:00.000Z";
      return new Response(null, { status: 204 });
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
    // 「연결」 트리·러너 상세(admin 이상)가 부르는 러너 목록 — 러너 하나 = 러너 토큰 하나. 붙음은 setup 상태의 러너 줄로 가른다
    if (method === "GET" && url === "/api/v1/runners") {
      const status = typeof opts.status === "object" ? opts.status : undefined;
      const live = new Set((status?.runners.list ?? []).map((r) => r.tokenId));
      const runners: RunnerSummary[] = runnerTokens.map((t) => {
        const connected = live.has(t.id) && t.revokedAt === null;
        return {
          id: t.id,
          label: t.label,
          connected,
          revoked: t.revokedAt !== null,
          runnerVersion: connected ? "0.0.0" : null,
          browse: connected ? true : null,
          roots: [],
          programs: [],
          projectCount: 0,
        };
      });
      return json(200, { runners });
    }
    if (method === "GET" && /^\/api\/v1\/runners\/[^/]+\/projects$/.test(url))
      return json(200, { projects: [] });
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

/** 러너(= 러너 토큰) 상세 주소 */
export const runnerDetailPath = (id: string) => `/settings/connection/runner/${id}`;

/** n 번째 Gateway 의 상세 주소 — 기본은 첫 Gateway(`GATEWAY_ID`) */
export const gatewayDetailPath = (id: string = GATEWAY_ID) => `/settings/connection/gateway/${id}`;

/**
 * me 를 미리 넣고 「연결」 탭의 그 주소를 셸째 띄운다 — 라우트 가드가 me 를 채운 뒤의 모습. 기본은 첫 Gateway 의 상세.
 * 라우터를 돌려준다(원문이 보이는 동안의 이동 막기·삭제 뒤 이동을 잰다)
 */
export function renderConnection(
  me: unknown = OWNER,
  qc: QueryClient = createQueryClient(() => {}),
  path: string = gatewayDetailPath(),
) {
  qc.setQueryData(qk.me, me);
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: [path] }));
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return Object.assign(qc, { router });
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
