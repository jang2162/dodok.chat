import type { Agent, OpenClawGatewayStatus, RunnerProject, RunnerSummary, SetupStatus } from "@dodok/shared";
import { vi } from "vitest";
import { createQueryClient } from "@/app/queryClient";
import { runnersRoutes } from "./runnersServer";
import { ADAPTER_OK, ME, TEST_GATEWAY, adapterStatusBody, json, renderRoute, shellGet } from "./shellApi";

/**
 * 「연결」 탭을 셸째 띄우는 가짜 서버 — 에이전트·wire Gateway 목록·setup 상태(owner)·러너 REST(admin). 역할에 없는 API 를 불렀는지
 * 세려고 모든 요청을 모은다. 다른 처리기(`extra`)가 먼저 받는다 — 상세 시험이 브리지 토큰·대화상자 요청을 거기서 가른다
 */
export function stubConnection(
  opts: {
    role?: string;
    agents?: Agent[];
    gateways?: OpenClawGatewayStatus[];
    setup?: SetupStatus;
    runners?: RunnerSummary[];
    projects?: RunnerProject[];
    extra?: (method: string, url: string, body: unknown) => Response | Promise<Response> | undefined;
  } = {},
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const runners = runnersRoutes({ runners: opts.runners ?? [], projects: opts.projects ?? [] });
  const agents = [...(opts.agents ?? [])];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    const hit = opts.extra?.(method, url, body);
    if (hit) return hit;
    if (url === "/api/v1/auth/me") return json(200, { ...ME, role: opts.role ?? "owner" });
    if (method === "GET" && url === "/api/v1/agents") return json(200, { agents });
    if (method === "GET" && url === "/api/v1/adapter/status")
      return json(200, {
        ...adapterStatusBody(ADAPTER_OK),
        statuses: [{ provider: "openclaw", gateways: opts.gateways ?? [TEST_GATEWAY] }],
      });
    if (method === "GET" && url === "/api/v1/setup/status" && opts.setup) return json(200, opts.setup);
    const runner = runners.handle(method, url, body);
    if (runner) return runner;
    const shell = shellGet(input, init);
    if (shell) return shell;
    return json(404, { code: "NOT_FOUND", message: `예상 밖 요청 ${method} ${url}` });
  });
  vi.stubGlobal("fetch", fetch);
  return {
    agents,
    calls,
    count: (method: string, url: string | RegExp) =>
      calls.filter((c) => c.method === method && (typeof url === "string" ? c.url === url : url.test(c.url)))
        .length,
  };
}

/** 셸째 그 주소를 띄운다 */
export const renderConnectionRoute = (path = "/settings/connection") =>
  renderRoute(
    path,
    createQueryClient(() => {}),
  );
