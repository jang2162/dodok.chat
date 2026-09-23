import { onlineManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "@/api/http";
import { meQuery, qk } from "@/api/queries";
import { App } from "@/app/App";
import { createApp } from "@/app/createApp";
import { Banners } from "@/app/layout/Banners";
import { createQueryClient } from "@/app/queryClient";
import { registerSessionReset } from "@/app/session";
import type { Timeline } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { TooltipProvider } from "@/ui/tooltip";
import { CH, msg } from "../../test/fixtures";
import { memoryStorage } from "../../test/memoryStorage";
import { stubScrollLayout } from "../../test/scrollLayout";
import { ADAPTER_OK, ME, channelOf, json, shellGet } from "../../test/shellApi";
import { PERSIST_KEY, startPersistence, touchRecentChannel } from "./persist";

const OFFLINE = "오프라인 — 저장된 내용을 보여 줍니다";
const RECONNECTING = "서버에 다시 연결하는 중…";
const UNAUTHORIZED = { code: "UNAUTHORIZED", message: "로그인이 필요하다" };

/** 브라우저 온라인 여부 — navigator.onLine 과 Query 의 onlineManager 를 함께(이벤트로 오는 것처럼) */
function setBrowserOnline(online: boolean) {
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(online);
  act(() => onlineManager.setOnline(online));
}

const cleanups: Array<() => void> = [];
let restoreLayout: () => void = () => {};
beforeEach(() => {
  restoreLayout = stubScrollLayout();
});
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  restoreLayout();
  onlineManager.setOnline(true);
  useWireStatus.getState().setStatus("idle");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const meCalls = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls.filter((c) => String(c[0]) === "/api/v1/auth/me").length;

describe("Banners — 오프라인", () => {
  function renderBanners(qc: QueryClient) {
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Banners />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it("브라우저가 오프라인이면 「오프라인」 배너 하나 — 「다시 연결하는 중」은 같은 사실이라 내지 않는다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, ME)),
    );
    const qc = createQueryClient(() => {});
    qc.setQueryData(qk.me, ME);
    setBrowserOnline(false);
    useWireStatus.getState().setStatus("reconnecting");
    renderBanners(qc);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.getByText(OFFLINE).closest("[role=status]")).not.toBeNull();
    expect(screen.queryByText(RECONNECTING)).toBeNull();

    setBrowserOnline(true);
    await waitFor(() => expect(screen.queryByText(OFFLINE)).toBeNull());
    expect(screen.getByText(RECONNECTING)).toBeInTheDocument();
  });

  it("me 가 값을 가진 채 네트워크 오류면 오프라인 — wire 가 다시 붙으면 me 를 다시 불러 배너를 내린다", async () => {
    let down = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (down) throw new TypeError("Failed to fetch");
      return String(input) === "/api/v1/adapter/status" ? json(200, ADAPTER_OK) : json(200, ME);
    });
    vi.stubGlobal("fetch", fetch);
    const qc = createQueryClient(() => {});
    qc.setQueryData(qk.me, ME);
    await qc.fetchQuery({ ...meQuery, staleTime: 0, retry: false }).catch(() => {});
    expect(qc.getQueryState(qk.me)?.error).toBeInstanceOf(NetworkError);
    useWireStatus.getState().setStatus("reconnecting");
    renderBanners(qc);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();

    down = false;
    const before = meCalls(fetch);
    act(() => useWireStatus.getState().setStatus("connected"));
    await waitFor(() => expect(screen.queryByText(OFFLINE)).toBeNull());
    expect(meCalls(fetch)).toBe(before + 1);
  });

  it("온라인이고 me 가 멀쩡하면 오프라인 배너는 없다(연결 중 배너는 그대로)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, ME)),
    );
    const qc = createQueryClient(() => {});
    qc.setQueryData(qk.me, ME);
    useWireStatus.getState().setStatus("reconnecting");
    renderBanners(qc);
    expect(await screen.findByText(RECONNECTING)).toBeInTheDocument();
    expect(screen.queryByText(OFFLINE)).toBeNull();
  });
});

describe("오프라인 사본으로 띄우기 (createApp + 메모리 히스토리 + 가짜 fetch)", () => {
  /** 앞선 세션이 남긴 사본 — 채널 CH 를 60개 메시지까지 보고 떠났다 */
  async function savedCopy() {
    const storage = memoryStorage();
    const qc = createQueryClient(() => {});
    const p = await startPersistence(qc, { buster: "b1", storage, throttleMs: 0 });
    qc.setQueryData(qk.me, ME);
    qc.setQueryData(qk.channels, [channelOf(CH, { name: "general" })]);
    qc.setQueryData(qk.agents, []);
    touchRecentChannel(qc, CH);
    qc.setQueryData(qk.channel(CH), channelOf(CH, { name: "general" }));
    qc.setQueryData(qk.members(CH), []);
    const items = Array.from({ length: 60 }, (_, i) => msg(i + 1, { bodyMd: `메시지 ${i + 1}` }));
    qc.setQueryData<Timeline>(qk.timeline(CH), { items, pending: [], hasOlder: false, lastSeq: 60 });
    await vi.waitFor(() => expect(storage.map.get(PERSIST_KEY)).toContain('"timeline"'));
    p.stop();
    return storage;
  }

  /** main.tsx 와 같은 순서 — 만들고, 복원을 기다리고, 지우기를 세션 정리에 걸고, 그린다 */
  async function boot(storage: ReturnType<typeof memoryStorage>) {
    const history = createMemoryHistory({ initialEntries: [`/c/${CH}`] });
    const app = createApp(history);
    const persistence = await startPersistence(app.queryClient, { buster: "b1", storage, throttleMs: 0 });
    cleanups.push(
      persistence.stop,
      registerSessionReset(() => void persistence.clear()),
    );
    const moves: string[] = [];
    history.subscribe(({ location }) => moves.push(location.href));
    render(<App app={app} />);
    return { app, history, moves };
  }

  it("오프라인으로 시작해도 me 요청 없이 채널 화면·저장된 메시지·배너가 뜨고, 보내기는 막힌다", async () => {
    const storage = await savedCopy();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetch);
    setBrowserOnline(false);
    await boot(storage);

    expect(await screen.findByTestId("page-channel")).toBeInTheDocument();
    expect(await screen.findByText("메시지 60")).toBeInTheDocument();
    expect(screen.getByText(OFFLINE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "보내기" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "보내기" })).toHaveAccessibleDescription(
      "연결되면 보낼 수 있습니다",
    );
    expect(meCalls(fetch)).toBe(0);
  });

  it("[Review Focus 2] 사본으로 뜬 뒤 연결이 돌아와 me 가 401 이면 사본을 지우고 로그인으로 한 번 — 되돌아오지 않는다", async () => {
    const storage = await savedCopy();
    let online = false;
    // me 만 401 — 다른 쿼리의 401 도 로그인으로 보내므로, me 경로 하나로 되는지를 따로 잰다
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (!online) throw new TypeError("Failed to fetch");
      if (String(input) === "/api/v1/auth/me") return json(401, UNAUTHORIZED);
      return shellGet(input, init) ?? json(200, { members: [] });
    });
    vi.stubGlobal("fetch", fetch);
    setBrowserOnline(false);
    const { app, history, moves } = await boot(storage);
    expect(await screen.findByText("메시지 60")).toBeInTheDocument();
    expect(storage.map.has(PERSIST_KEY)).toBe(true);

    online = true;
    setBrowserOnline(true);

    expect(await screen.findByRole("heading", { name: "로그인" })).toBeInTheDocument();
    expect(history.location.pathname).toBe("/login");
    expect(new URLSearchParams(history.location.search).get("next")).toBe(`/c/${CH}`);
    await waitFor(() => expect(storage.map.has(PERSIST_KEY)).toBe(false));
    expect(app.queryClient.getQueryData(qk.timeline(CH))).toBeUndefined();
    // 로그인 화면의 me 401 은 다시 보내지 않는다 — 이동 한 번, me 요청도 멈춘다
    const settled = meCalls(fetch);
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(moves).toHaveLength(1);
    expect(meCalls(fetch)).toBeLessThanOrEqual(settled + 1);
    expect(storage.map.has(PERSIST_KEY)).toBe(false);
  });

  it("온라인으로 시작하면 사본으로 곧바로 띄우고 me 를 한 번 다시 확인한다 — 200 이면 사본을 지키고 배너 없음", async () => {
    const storage = await savedCopy();
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      return shellGet(input, init) ?? json(200, { members: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await boot(storage);
    expect(await screen.findByText("메시지 60")).toBeInTheDocument();
    await waitFor(() => expect(meCalls(fetch)).toBe(1));
    expect(screen.queryByText(OFFLINE)).toBeNull();
    expect(storage.map.get(PERSIST_KEY)).toContain('"timeline"');
  });
});
