import type {
  RunnerFsListing,
  RunnerProgramStatus,
  RunnerProject,
  RunnerProjectCheck,
  RunnerSummary,
} from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { RouterContextProvider, createMemoryHistory } from "@tanstack/react-router";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { createAppRouter } from "@/app/router";
import { RunnersPage } from "@/features/runners/RunnersPage";

/** 「러너」 탭·러너 에이전트 만들기 시험의 가짜 서버 조각 — 러너·프로젝트·둘러보기 REST(러너 일반화 태스크 4 보고 1절의 꼴) */

type Reply = Response | Promise<Response>;
export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
export const apiErr = (status: number, code: string, message: string, details?: Record<string, unknown>) =>
  json(status, { code, message, ...(details ? { details } : {}) });

export const runnerId = (n: number) => `0190c000-0000-7000-8000-${String(n).padStart(12, "0")}`;
export const projectId = (n: number) => `0190d000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** Claude Code — 설치·로그인됨, 상한 acceptEdits·도구 상한 없음 */
export function programOf(over: Partial<RunnerProgramStatus> = {}): RunnerProgramStatus {
  return {
    program: "claude",
    available: true,
    version: "2.1.283",
    auth: "ok",
    capabilities: ["serverSessionIds", "approvals"],
    ceiling: { maxPermissionMode: "acceptEdits", allowedToolsCeiling: null },
    ...over,
  };
}

/** 붙은 러너 — 루트 둘(src·work), Claude Code 하나, 둘러보기 켜짐 */
export function runnerOf(n: number, over: Partial<RunnerSummary> = {}): RunnerSummary {
  const connected = over.connected ?? true;
  return {
    id: runnerId(n),
    label: `러너-${n}`,
    connected,
    revoked: false,
    runnerVersion: connected ? "0.2.0" : null,
    browse: connected ? true : null,
    roots: connected
      ? [
          { id: "src", label: "내 저장소들" },
          { id: "work", label: "회사" },
        ]
      : [],
    programs: connected ? [programOf()] : [],
    projectCount: 0,
    ...over,
  };
}

export function projectOf(n: number, over: Partial<RunnerProject> = {}): RunnerProject {
  return {
    id: projectId(n),
    runnerId: runnerId(1),
    rootId: "src",
    rootLabel: "내 저장소들",
    relPath: `app${n}`,
    label: `app${n}`,
    agentCount: 0,
    archivedAt: null,
    ...over,
  };
}

export type RunnerCall = { method: string; url: string; body: unknown };

/**
 * 러너 REST 를 처리하는 가짜 서버 조각 — 다른 가짜 서버(test/agentsPage 의 stubServer)의 `extra` 로 넘기거나 혼자 쓴다. 처리하지 않는
 * 요청이면 undefined. 프로젝트는 서버 상태로 들고 더하기·이름 바꾸기·보관·옮기기가 고친다
 */
export function runnersRoutes(
  opts: {
    runners?: RunnerSummary[];
    projects?: RunnerProject[];
    /** GET /runners/:id/fs — 기본은 빈 목록 */
    fs?: (runnerId: string, rootId: string, relPath: string) => Reply;
    /** POST /runners/:id/projects — 기본은 201 과 받은 본문으로 만든 프로젝트 */
    create?: (runnerId: string, body: Record<string, unknown>) => Reply | undefined;
    check?: (id: string) => Reply;
    move?: (id: string, body: Record<string, unknown>) => Reply | undefined;
  } = {},
) {
  const runners = opts.runners ?? [runnerOf(1)];
  const projects = [...(opts.projects ?? [])];
  const calls: RunnerCall[] = [];
  let seq = 100;
  const handle = (method: string, url: string, body: unknown): Reply | undefined => {
    if (!url.startsWith("/api/v1/runner")) return undefined;
    calls.push({ method, url, body });
    if (method === "GET" && url === "/api/v1/runners") return json(200, { runners });
    const fs = /^\/api\/v1\/runners\/([^/]+)\/fs\?rootId=([^&]*)&relPath=(.*)$/.exec(url);
    if (method === "GET" && fs) {
      const [, id = "", root = "", rel = ""] = fs;
      return (opts.fs ?? (() => json(200, { entries: [], truncated: false } satisfies RunnerFsListing)))(
        id,
        decodeURIComponent(root),
        decodeURIComponent(rel),
      );
    }
    const list = /^\/api\/v1\/runners\/([^/]+)\/projects$/.exec(url);
    if (list && method === "GET")
      return json(200, { projects: projects.filter((p) => p.runnerId === list[1]) });
    if (list && method === "POST") {
      const b = body as Record<string, unknown>;
      const custom = opts.create?.(list[1] ?? "", b);
      if (custom) return custom;
      const relPath = String(b.relPath);
      seq += 1;
      const project = projectOf(seq, {
        runnerId: list[1] ?? "",
        rootId: String(b.rootId),
        rootLabel: runners.find((r) => r.id === list[1])?.roots.find((r) => r.id === b.rootId)?.label ?? null,
        relPath,
        label: typeof b.label === "string" ? b.label : relPath.split("/").at(-1) || "root",
      });
      projects.push(project);
      return json(201, { project });
    }
    const one = /^\/api\/v1\/runner-projects\/([^/]+)(?:\/(archive|check|move))?$/.exec(url);
    if (one) {
      const [, id = "", action] = one;
      const i = projects.findIndex((p) => p.id === id);
      const current = projects[i];
      if (!current) return json(404, { code: "NOT_FOUND", message: "project not found" });
      const b = (body ?? {}) as Record<string, unknown>;
      if (method === "PATCH" && !action) {
        projects[i] = { ...current, label: String(b.label) };
        return json(200, { project: projects[i] });
      }
      if (method === "POST" && action === "archive") {
        projects[i] = { ...current, archivedAt: "2026-10-29T00:00:00.000Z" };
        return json(200, { project: projects[i] });
      }
      if (method === "POST" && action === "check")
        return (opts.check ?? (() => json(200, { ok: true, isGitRepo: true } satisfies RunnerProjectCheck)))(
          id,
        );
      if (method === "POST" && action === "move") {
        const custom = opts.move?.(id, b);
        if (custom) return custom;
        projects[i] = { ...current, runnerId: String(b.runnerId) };
        return json(200, { project: projects[i] });
      }
    }
    return undefined;
  };
  return { handle, calls, projects, runners };
}

/** 러너 REST 만 받는 가짜 fetch — 그 밖의 요청은 던진다 */
export function stubRunners(opts: Parameters<typeof runnersRoutes>[0] = {}, extra?: typeof globalThis.fetch) {
  const routes = runnersRoutes(opts);
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const hit = routes.handle(method, url, body);
    if (hit) return hit;
    if (extra) return extra(input, init);
    throw new Error(`예상 밖 요청 ${method} ${url}`);
  };
  return { ...routes, fetch };
}

/** 「러너」 탭만 그린다 — 라우터는 문맥만(연결 페이지·러너 탭 링크) */
export function renderRunnersPage(role = "admin", qc: QueryClient = createQueryClient(() => {})) {
  qc.setQueryData(qk.me, { user: { id: "u", handle: "me" }, workspaceId: "w", role });
  const router = createAppRouter(qc, createMemoryHistory({ initialEntries: ["/settings/runners"] }));
  render(
    <QueryClientProvider client={qc}>
      <RouterContextProvider router={router}>
        <RunnersPage />
      </RouterContextProvider>
    </QueryClientProvider>,
  );
  return qc;
}
