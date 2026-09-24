import type { BridgeTokenRecord, IssueBridgeTokenResult, SetupStatus } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { ConnectionPage } from "@/features/setup/ConnectionPage";
import { ME, json, shellGet } from "./shellApi";

/** 연결 페이지 테스트의 가짜 서버·렌더 도우미 */

export const OWNER = { ...ME, role: "owner" };
export const SHA_A = "a".repeat(64);
export const SHA_B = "b".repeat(64);
export const SHA_FILE = "f".repeat(64);
export const PUBLIC_URL = "wss://chat.example.com/bridge";

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
  gateway?: Partial<SetupStatus["gateway"]>;
  bridge?: Partial<SetupStatus["bridge"]>;
  plugin?: Partial<NonNullable<SetupStatus["bridge"]["plugin"]>> | null;
  pluginFile?: SetupStatus["pluginFile"];
  pluginMatches?: boolean | null;
  envTokenIgnored?: boolean;
};

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
  return {
    server: { version: "0.1.0", ...over.server },
    gateway: {
      state: "connected",
      host: "gateway.example.com",
      version: "2026.9.5",
      pairing: null,
      ...over.gateway,
    },
    bridge: { state: plugin ? "connected" : "down", publicUrl: PUBLIC_URL, plugin, ...over.bridge },
    pluginFile: over.pluginFile ?? { available: true, sha256: SHA_FILE, bundleSha256: SHA_A, bytes: 123_456 },
    pluginMatches: over.pluginMatches === undefined ? true : over.pluginMatches,
    envTokenIgnored: over.envTokenIgnored ?? false,
  };
}

export const RAW_TOKEN = `dbt_${"Z".repeat(43)}`;

export type Call = { method: string; url: string; body: unknown };
type Reply = Response | Promise<Response>;

/** URL 로 가르는 가짜 서버. 토큰 목록을 서버 상태로 들고, 발급·폐기가 그것을 고친다. 그 밖은 셸 기본 응답 */
export function stubSetupServer(
  opts: {
    status?: SetupStatus;
    tokens?: BridgeTokenRecord[];
    me?: unknown;
    issue?: (label: string) => Reply;
    plugin?: () => Reply;
  } = {},
) {
  const tokens = [...(opts.tokens ?? [])];
  const calls: Call[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (url === "/api/v1/auth/me") return json(200, opts.me ?? OWNER);
    if (method === "GET" && url === "/api/v1/setup/status") return json(200, opts.status ?? statusOf());
    if (method === "GET" && url === "/api/v1/setup/bridge-tokens") return json(200, { tokens });
    if (method === "POST" && url === "/api/v1/setup/bridge-tokens") {
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
    const del = /^\/api\/v1\/setup\/bridge-tokens\/([^/]+)$/.exec(url);
    if (method === "DELETE" && del) {
      const t = tokens.find((x) => x.id === del[1]);
      if (t) t.revokedAt = "2026-09-25T02:00:00.000Z";
      return new Response(null, { status: 204 });
    }
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
    setupCalls: () => calls.filter((c) => c.url.startsWith("/api/v1/setup")),
  };
}

/** me 를 미리 넣고 페이지만 그린다 — 라우트 가드가 me 를 채운 뒤의 모습 */
export function renderConnection(me: unknown = OWNER, qc: QueryClient = createQueryClient(() => {})) {
  qc.setQueryData(qk.me, me);
  render(
    <QueryClientProvider client={qc}>
      <ConnectionPage />
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
