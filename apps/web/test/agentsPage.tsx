import type { Agent, OpenClawGatewayStatus } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import userEvent from "@testing-library/user-event";
import { expect, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { AgentsPage } from "@/features/agents/AgentsPage";
import { ADAPTER_OK, TEST_GATEWAY, adapterStatusBody } from "./shellApi";

/** 에이전트 페이지 테스트의 가짜 서버·렌더 도우미 — 목록 쪽과 등록 쪽 테스트가 함께 쓴다 */

export type Body = Record<string, unknown>;
export type Reply = Response | Promise<Response>;
export type Call = { method: string; url: string; body: unknown };

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
export const apiErr = (status: number, code: string, message: string) => json(status, { code, message });

/** 둘째 Gateway — 같은 id 의 에이전트가 두 Gateway 에 있을 때 */
export const HOME_GATEWAY: OpenClawGatewayStatus = {
  ...TEST_GATEWAY,
  id: "01a00000-0000-7000-8000-0000000000a2",
  name: "집",
};
/** OpenClaw 찾기 주소 — Gateway 를 고른다(멀티 Gateway 스펙 「에이전트 API」 절) */
export const discoverUrl = (gatewayId: string = TEST_GATEWAY.id) =>
  `/api/v1/agents/discover?provider=openclaw&gatewayId=${gatewayId}`;
const GATEWAY_OF = (id: string | undefined) =>
  [TEST_GATEWAY, HOME_GATEWAY].find((g) => g.id === id) ?? TEST_GATEWAY;

let seq = 0;
/** OpenClaw 에이전트는 따로 주지 않으면 TEST_GATEWAY 에 묶여 있다(서버 응답의 `gateway` 요약) */
export function makeAgent(
  fields: Partial<Agent> & Pick<Agent, "providerAgentId" | "handle" | "name">,
): Agent {
  seq += 1;
  const provider = fields.provider ?? "openclaw";
  return {
    id: `0190a000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    workspaceId: "0190a000-0000-7000-8000-00000000ffff",
    provider,
    enabled: true,
    createdAt: "2026-09-19T00:00:00.000Z",
    archivedAt: null,
    dmAccess: "admins",
    ...(provider === "openclaw" ? { gateway: { id: TEST_GATEWAY.id, name: TEST_GATEWAY.name } } : {}),
    ...fields,
  };
}
/** 보관한 시각(서버 응답의 archivedAt) */
export const ARCHIVED_AT = "2026-10-05T00:00:00.000Z";
export const dev = () =>
  makeAgent({ providerAgentId: "dev", handle: "dev", name: "Dev 에이전트", basePrompt: "기존 프롬프트" });
export const fin = () =>
  makeAgent({ providerAgentId: "fin", handle: "fin", name: "Fin 에이전트", enabled: false });

/**
 * URL 로 가르는 가짜 서버. 에이전트 목록을 서버 상태로 들고, POST·PATCH 기본 처리기는 그 상태를 고쳐 `{ agent }` 를 돌려준다.
 * 처리기를 바꾸는 테스트는 마지막 인자(기본 처리기)로 넘길 수 있다
 */
export function stubServer(
  opts: {
    agents?: Agent[];
    list?: (fallback: () => Reply) => Reply;
    /** OpenClaw 찾기 — 고른 Gateway id 를 받는다 */
    discover?: (gatewayId: string) => Reply;
    /** `GET /agents/discover?provider=claude` — 기본은 빈 목록(붙은 러너 없음) */
    discoverClaude?: () => Reply;
    create?: (body: Body, fallback: (body: Body) => Reply) => Reply;
    patch?: (id: string, body: Body, fallback: (id: string, body: Body) => Reply) => Reply;
    /** PUT /agents/:id/gateway(owner) — 기본은 서버 상태를 고쳐 `{ agent }` */
    move?: (id: string, body: Body, fallback: (id: string, body: Body) => Reply) => Reply;
    /** GET /adapter/status 의 OpenClaw Gateway 목록 — 기본은 TEST_GATEWAY 하나 */
    gateways?: OpenClawGatewayStatus[];
    /** DELETE /agents/:id(보관) — 기본은 서버 상태의 archivedAt 을 채워 `{ agent }` */
    archive?: (id: string, fallback: (id: string) => Reply) => Reply;
    /** POST /agents/:id/restore — 기본은 서버 상태의 archivedAt 을 비워 `{ agent }` */
    restore?: (id: string, fallback: (id: string) => Reply) => Reply;
  } = {},
) {
  const state = [...(opts.agents ?? [])];
  const calls: Call[] = [];
  const listDefault = () => json(200, { agents: state });
  const createDefault = (body: Body) => {
    const { gatewayId, ...fields } = body;
    const gateway = typeof gatewayId === "string" ? GATEWAY_OF(gatewayId) : undefined;
    const agent = makeAgent({
      ...(fields as Pick<Agent, "providerAgentId" | "handle" | "name">),
      ...(gateway ? { gateway: { id: gateway.id, name: gateway.name } } : {}),
    });
    state.push(agent);
    return json(201, { agent });
  };
  const patchDefault = (id: string, body: Body) => {
    const i = state.findIndex((a) => a.id === id);
    const current = state[i];
    if (!current) return apiErr(404, "NOT_FOUND", "agent not found");
    const next: Agent = { ...current, ...(body as Partial<Agent>) };
    if (body.basePrompt === null) delete next.basePrompt;
    state[i] = next;
    return json(200, { agent: next });
  };
  const moveDefault = (id: string, body: Body) => {
    const i = state.findIndex((a) => a.id === id);
    const current = state[i];
    if (!current) return apiErr(404, "NOT_FOUND", "agent not found");
    const gateway = GATEWAY_OF(String(body.gatewayId));
    const next: Agent = { ...current, gateway: { id: gateway.id, name: gateway.name } };
    state[i] = next;
    return json(200, { agent: next });
  };
  const setArchived = (id: string, archivedAt: string | null) => {
    const i = state.findIndex((a) => a.id === id);
    const current = state[i];
    if (!current) return apiErr(404, "NOT_FOUND", "agent not found");
    const next: Agent = { ...current, archivedAt };
    state[i] = next;
    return json(200, { agent: next });
  };
  const archiveDefault = (id: string) =>
    setArchived(id, state.find((a) => a.id === id)?.archivedAt ?? ARCHIVED_AT);
  const restoreDefault = (id: string) => setArchived(id, null);
  const gateways = opts.gateways ?? [TEST_GATEWAY];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body: Body | undefined = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (method === "GET" && url === "/api/v1/agents") return (opts.list ?? ((f) => f()))(listDefault);
    if (method === "GET" && url === "/api/v1/adapter/status") {
      return json(200, { ...adapterStatusBody(ADAPTER_OK), statuses: [{ provider: "openclaw", gateways }] });
    }
    const discover = /^\/api\/v1\/agents\/discover\?provider=openclaw&gatewayId=([^&]+)$/.exec(url);
    if (method === "GET" && discover?.[1])
      return (opts.discover ?? (() => json(200, { agents: [] })))(discover[1]);
    if (method === "GET" && url === "/api/v1/agents/discover?provider=claude")
      return (opts.discoverClaude ?? (() => json(200, { agents: [] })))();
    if (method === "POST" && url === "/api/v1/agents")
      return (opts.create ?? ((b, f) => f(b)))(body ?? {}, createDefault);
    const moved = /^\/api\/v1\/agents\/([^/]+)\/gateway$/.exec(url);
    if (method === "PUT" && moved?.[1])
      return (opts.move ?? ((i, b, f) => f(i, b)))(moved[1], body ?? {}, moveDefault);
    const restored = /^\/api\/v1\/agents\/([^/]+)\/restore$/.exec(url);
    if (method === "POST" && restored?.[1])
      return (opts.restore ?? ((i, f) => f(i)))(restored[1], restoreDefault);
    const m = /^\/api\/v1\/agents\/([^/]+)$/.exec(url);
    if (method === "PATCH" && m?.[1])
      return (opts.patch ?? ((i, b, f) => f(i, b)))(m[1], body ?? {}, patchDefault);
    if (method === "DELETE" && m?.[1]) return (opts.archive ?? ((i, f) => f(i)))(m[1], archiveDefault);
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return {
    /** 서버가 들고 있는 목록 — 다른 탭이 바꾼 것을 흉내 낼 때 고친다 */
    state,
    count: (method: string, url: string) => calls.filter((c) => c.method === method && c.url === url).length,
    bodies: (method: string) => calls.filter((c) => c.method === method).map((c) => c.body),
  };
}

/** 로그인한 사람은 owner — 라우트 가드가 받아 둔 me 를 흉내 낸다(이미 있으면 그대로). member 화면은 `role` 을 넘긴다 */
export function renderPage(qc: QueryClient = createQueryClient(() => {}), role = "owner") {
  if (qc.getQueryData(qk.me) === undefined)
    qc.setQueryData(qk.me, { user: { id: "u", handle: "owner" }, workspaceId: "w", role });
  // 라우터는 문맥만 준다 — 「러너 없음」 안내의 연결 페이지 링크가 쓴다
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/agents"] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterContextProvider router={router}>
        <AgentsPage />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
  return qc;
}

/** 풀릴 때까지 응답을 붙잡는다 */
export function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** 목록을 받기 전엔 가져오기 버튼이 잠겨 있다 — 풀리길 기다려 누른다 */
export async function openDiscover() {
  const trigger = await screen.findByRole("button", { name: "에이전트 가져오기" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await userEvent.click(trigger);
  return screen.findByRole("dialog");
}
