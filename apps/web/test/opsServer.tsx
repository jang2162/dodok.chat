import {
  OpsEvent,
  OpsEventsPage,
  OpsRunsRow,
  OpsRunsSummary,
  OpsStatus,
  type OpsSeverity,
} from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { OpsPage } from "@/features/ops/OpsPage";
import { uid } from "./fixtures";
import { OPS_STATUS_OK, json, shellGet } from "./shellApi";
import { OWNER } from "./setupServer";

/** 운영 화면 테스트의 가짜 서버·렌더 도우미. 픽스처는 shared 스키마를 통과시켜 계약과 맞춘다 */

type StatusOver = Partial<Omit<OpsStatus, "server" | "gateway" | "plugin">> & {
  server?: Partial<OpsStatus["server"]>;
  gateway?: Partial<OpsStatus["gateway"]>;
  plugin?: Partial<OpsStatus["plugin"]>;
};

/** 기본은 문제 없음 — 모두 연결됨·핀과 같은 버전·디스크 넉넉·직전 종료 정상 */
export function opsStatusOf(over: StatusOver = {}): OpsStatus {
  return OpsStatus.parse({
    ...OPS_STATUS_OK,
    runsToday: 12,
    ...over,
    server: { ...OPS_STATUS_OK.server, ...over.server },
    gateway: { ...OPS_STATUS_OK.gateway, ...over.gateway },
    plugin: { ...OPS_STATUS_OK.plugin, ...over.plugin },
  });
}

export const rowOf = (n: number, over: Partial<OpsRunsRow> = {}): OpsRunsRow =>
  OpsRunsRow.parse({ id: uid(n), name: `이름-${n}`, runs: 0, failed: 0, aborted: 0, blocked: 0, ...over });

export const runsOf = (over: Partial<OpsRunsSummary> = {}): OpsRunsSummary =>
  OpsRunsSummary.parse({ days: 1, byChannel: [], byAgent: [], usageTrusted: false, ...over });

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
    if (url.startsWith("/api/v1/ops/")) {
      if ((me as { role?: string }).role !== "owner")
        return json(403, { code: "FORBIDDEN", message: "owner only" });
      if (method === "GET" && url === "/api/v1/ops/status") return json(200, status);
      const runs = /^\/api\/v1\/ops\/runs\?days=(\d+)$/.exec(url);
      if (method === "GET" && runs) {
        const days = Number(runs[1]) as 1 | 7;
        return json(200, opts.runs ? opts.runs(days) : runsOf({ days }));
      }
      if (method === "GET" && url.startsWith("/api/v1/ops/events")) {
        const q = new URL(url, "http://x").searchParams;
        const at = Number(q.get("cursor") ?? 0);
        const severity = q.get("severity") as OpsSeverity | null;
        const events = (pages[at] ?? []).filter((e) => severity === null || e.severity === severity);
        const next = at + 1 < pages.length ? { nextCursor: String(at + 1) } : {};
        return json(200, OpsEventsPage.parse({ events, ...next }));
      }
      if (method === "POST" && url === "/api/v1/ops/events/ack") {
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
