import {
  type Channel,
  OpsEvent,
  OpsEventsPage,
  OpsRunsRow,
  OpsRunsSummary,
  OpsStatus,
  type OpsSeverity,
  roleAtLeast,
} from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { vi } from "vitest";
import { type AdapterStatusList, qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { OpsPage } from "@/features/ops/OpsPage";
import { uid } from "./fixtures";
import { ADAPTER_OK, OPS_STATUS_OK, adapterStatusBody, json, shellGet } from "./shellApi";
import { OWNER } from "./setupServer";

/** 운영 화면 테스트의 가짜 서버·렌더 도우미. 픽스처는 shared 스키마를 통과시켜 계약과 맞춘다 */

type GatewayRow = OpsStatus["gateways"][number];
/** gateway·plugin 은 TEST_GATEWAY 한 줄을 덮는다 */
type StatusOver = Partial<Omit<OpsStatus, "server">> & {
  server?: Partial<OpsStatus["server"]>;
  gateway?: Partial<GatewayRow["gateway"]>;
  plugin?: Partial<GatewayRow["plugin"]>;
};

/** 기본은 문제 없음 — 모두 연결됨·핀과 같은 버전·디스크 넉넉·직전 종료 정상 */
export function opsStatusOf(over: StatusOver = {}): OpsStatus {
  const { gateway, plugin, ...rest } = over;
  const [base] = OPS_STATUS_OK.gateways;
  return OpsStatus.parse({
    ...OPS_STATUS_OK,
    runsToday: 12,
    ...rest,
    server: { ...OPS_STATUS_OK.server, ...over.server },
    gateways: rest.gateways ?? [
      { ...base, gateway: { ...base?.gateway, ...gateway }, plugin: { ...base?.plugin, ...plugin } },
    ],
  });
}

export const rowOf = (n: number, over: Partial<OpsRunsRow> = {}): OpsRunsRow =>
  OpsRunsRow.parse({ id: uid(n), name: `이름-${n}`, runs: 0, failed: 0, aborted: 0, blocked: 0, ...over });

/** 기본은 OpenClaw 만 붙은 서버가 주는 모양 — usageTrustedProviders 가 비어 있다(서버 ops.routes.test 「GET /runs」 가 고정) */
export const runsOf = (over: Partial<OpsRunsSummary> = {}): OpsRunsSummary =>
  OpsRunsSummary.parse({ days: 1, byChannel: [], byAgent: [], usageTrustedProviders: [], ...over });

export function eventOf(n: number, over: Partial<OpsEvent> = {}): OpsEvent {
  return OpsEvent.parse({
    id: uid(700 + n),
    kind: "run_failed",
    severity: "warn",
    key: `agent:${uid(11)}`,
    detail: { code: "TIMEOUT" },
    count: 1,
    firstAt: "2026-09-25T01:00:00.000Z",
    lastAt: "2026-09-25T01:00:00.000Z",
    ...over,
  });
}

/** OpenClaw 줄에 Claude 러너 줄(붙은 수 / 토큰 수)을 더한 GET /adapter/status 응답 */
export function withRunners(connected: number, tokens: number): AdapterStatusList {
  const body = adapterStatusBody(ADAPTER_OK);
  return {
    statuses: [...body.statuses, { provider: "claude", runners: { connected, tokens } }],
    capabilities: {
      ...body.capabilities,
      claude: { sessionReset: true, agentsList: true, configSet: false },
    },
  };
}

export type Call = { method: string; url: string; body: unknown };
type Reply = Response | Promise<Response>;

/**
 * URL 로 가르는 가짜 ops 서버. 사건 페이지는 `pages` 를 차례로 준다(커서 = 페이지 번호).
 * member 면 서버처럼 ops 경로가 403. 그 밖은 셸 기본 응답
 */
export function stubOpsServer(
  opts: {
    me?: unknown;
    status?: OpsStatus;
    runs?: (days: 1 | 7) => OpsRunsSummary;
    pages?: OpsEvent[][];
    patch?: (body: unknown) => Reply;
    /** 사건 페이지 응답을 스키마 검사 없이 그대로 준다 — 이 웹보다 새 서버가 보내는 모르는 kind·severity */
    rawEvents?: unknown[];
    ack?: () => Reply;
    /** GET /channels 응답 — 사건 문구가 채널 이름을 찾는 캐시. 없으면 셸 기본(빈 목록) */
    channels?: Channel[];
    /** GET /adapter/status 응답 — 없으면 셸 기본(OpenClaw 줄 하나) */
    adapter?: AdapterStatusList;
  } = {},
) {
  const calls: Call[] = [];
  let status = opts.status ?? opsStatusOf();
  const pages = opts.pages ?? [[]];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    const me = opts.me ?? OWNER;
    if (url === "/api/v1/auth/me") return json(200, me);
    if (opts.adapter && method === "GET" && url === "/api/v1/adapter/status") return json(200, opts.adapter);
    if (opts.channels && method === "GET" && url === "/api/v1/channels")
      return json(200, { channels: opts.channels });
    if (url.startsWith("/api/v1/ops/")) {
      // 운영은 admin 이상(팀 스펙 2장)
      if (!roleAtLeast((me as { role?: string }).role, "admin"))
        return json(403, { code: "FORBIDDEN", message: "admin only" });
      if (method === "GET" && url === "/api/v1/ops/status") return json(200, status);
      const runs = /^\/api\/v1\/ops\/runs\?days=(\d+)$/.exec(url);
      if (method === "GET" && runs) {
        const days = Number(runs[1]) as 1 | 7;
        return json(200, opts.runs ? opts.runs(days) : runsOf({ days }));
      }
      if (method === "GET" && url.startsWith("/api/v1/ops/events")) {
        if (opts.rawEvents) return json(200, { events: opts.rawEvents });
        const q = new URL(url, "http://x").searchParams;
        const at = Number(q.get("cursor") ?? 0);
        const severity = q.get("severity") as OpsSeverity | null;
        const events = (pages[at] ?? []).filter((e) => severity === null || e.severity === severity);
        const next = at + 1 < pages.length ? { nextCursor: String(at + 1) } : {};
        return json(200, OpsEventsPage.parse({ events, ...next }));
      }
      if (method === "POST" && url === "/api/v1/ops/events/ack") {
        if (opts.ack) return opts.ack();
        status = { ...status, unacked: { warn: 0, error: 0 } };
        return json(200, { acked: 3 });
      }
      if (method === "PATCH" && url === "/api/v1/ops/settings") {
        if (opts.patch) return opts.patch(body);
        const { dailyRunLimit } = body as { dailyRunLimit: number | null };
        status = { ...status, dailyRunLimit };
        return json(200, { dailyRunLimit });
      }
    }
    const shell = shellGet(input, init);
    if (shell) return shell;
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    calls,
    opsCalls: () => calls.filter((c) => c.url.startsWith("/api/v1/ops")),
    /** 서버 쪽 상태를 바꾼다 — 다음 GET ops/status 부터 이 값 */
    setStatus: (next: OpsStatus) => {
      status = next;
    },
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
  };
}

/** me 를 미리 넣고 페이지만 그린다(라우터는 링크의 문맥만) — 사이드바까지 띄우는 시나리오는 `renderRoute` */
export function renderOps(me: unknown = OWNER, qc: QueryClient = createQueryClient(() => {})) {
  qc.setQueryData(qk.me, me);
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/settings/operations"] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterContextProvider router={router}>
        <OpsPage />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
  return { qc, router };
}
