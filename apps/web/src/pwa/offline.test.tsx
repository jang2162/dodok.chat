import { type Agent, ComponentsV1, type Message, type MessageInteraction, type Person } from "@dodok/shared";
import { onlineManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "@/api/http";
import { meQuery, qk } from "@/api/queries";
import { bootApp } from "@/app/boot";
import { createApp } from "@/app/createApp";
import { Banners } from "@/app/layout/Banners";
import { createQueryClient } from "@/app/queryClient";
import { resetClientState } from "@/app/session";
import type { Timeline } from "@/features/messages/timeline";
import { useWireStatus } from "@/realtime/wire";
import { TooltipProvider } from "@/ui/tooltip";
import { createdSockets } from "../../test/fakeSocket";
import { CH, msg, uid } from "../../test/fixtures";
import { memoryStorage } from "../../test/memoryStorage";
import { agentOf } from "../../test/settingsServer";
import { stubScrollLayout } from "../../test/scrollLayout";
import { ADAPTER_OK, ME, adapterStatusBody, channelOf, json, shellGet } from "../../test/shellApi";
import { PERSIST_KEY, startPersistence, touchRecentChannel, touchRecentConversation } from "./persist";

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

  it("Query 가 모르는 오프라인(navigator.onLine 만 거짓, onlineManager 는 온라인)도 배너를 낸다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(200, ME)),
    );
    const qc = createQueryClient(() => {});
    qc.setQueryData(qk.me, ME);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(onlineManager.isOnline()).toBe(true);
    renderBanners(qc);
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
  });

  it("me 가 값을 가진 채 네트워크 오류면 오프라인 — wire 가 다시 붙으면 me 를 다시 불러 배너를 내린다", async () => {
    let down = true;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      if (down) throw new TypeError("Failed to fetch");
      return String(input) === "/api/v1/adapter/status"
        ? json(200, adapterStatusBody(ADAPTER_OK))
        : json(200, ME);
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
  /** 앞선 세션이 남긴 사본 — 채널 CH 를 60개 메시지까지 보고 떠났다(마지막은 `last` 로 바꿀 수 있다) */
  async function savedCopy(last?: Message, agents: Agent[] = [], people?: Person[]) {
    const storage = memoryStorage();
    const qc = createQueryClient(() => {});
    const p = await startPersistence(qc, { buster: "b1", storage, throttleMs: 0 });
    qc.setQueryData(qk.me, ME);
    qc.setQueryData(qk.channels, [channelOf(CH, { name: "general" })]);
    qc.setQueryData(qk.agents, agents);
    if (people) qc.setQueryData(qk.people, people);
    touchRecentChannel(qc, CH);
    // 그 채널에서 마지막으로 본 세션 — 「이전 대화」(id = 채널 id). 사본은 채널마다 그 세션 하나를 담는다
    touchRecentConversation(qc, CH, CH);
    qc.setQueryData(qk.channel(CH), channelOf(CH, { name: "general" }));
    qc.setQueryData(qk.members(CH), []);
    const items = Array.from({ length: 60 }, (_, i) => msg(i + 1, { bodyMd: `메시지 ${i + 1}` }));
    if (last) items[59] = last;
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), { items, pending: [], hasOlder: false, lastSeq: 60 });
    await vi.waitFor(() => expect(storage.map.get(PERSIST_KEY)).toContain('"timeline"'));
    p.stop();
    return storage;
  }

  /** main.tsx 와 같은 배선(bootApp) — 그리기만 testing-library 로 */
  async function boot(storage: ReturnType<typeof memoryStorage>) {
    const history = createMemoryHistory({ initialEntries: [`/c/${CH}/s/${CH}`] });
    const app = createApp(history);
    const moves: string[] = [];
    history.subscribe(({ location }) => moves.push(location.href));
    cleanups.push(await bootApp(app, { buster: "b1", storage, throttleMs: 0, render: (el) => render(el) }));
    return { app, history, moves };
  }

  it("사본 복원을 기다린 뒤 그린다 — 로그아웃·401(세션 정리)이 사본을 지운다(bootApp 배선)", async () => {
    const storage = await savedCopy();
    const saved = storage.map.get(PERSIST_KEY) ?? "";
    let answer: (v: string) => void = () => {};
    storage.getItem.mockImplementationOnce(() => new Promise<string>((r) => (answer = r)));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const app = createApp(createMemoryHistory({ initialEntries: [`/c/${CH}/s/${CH}`] }));
    const drawn = vi.fn();
    const booted = bootApp(app, { buster: "b1", storage, throttleMs: 30, render: drawn });
    await new Promise((r) => setTimeout(r, 20));
    expect(drawn).not.toHaveBeenCalled();
    answer(saved);
    cleanups.push(await booted);
    expect(drawn).toHaveBeenCalledTimes(1);
    expect(app.queryClient.getQueryData(qk.me)).toEqual(ME);

    // 세션 정리에 건 지우기만으로 — 캐시 비우기(me 없는 캐시를 지우는 두 번째 겹)를 막아도 사본과 쓰던 저장이 사라진다
    await new Promise((r) => setTimeout(r, 60));
    vi.spyOn(app.queryClient, "clear").mockImplementation(() => {});
    app.queryClient.setQueryData(qk.agents, [{ id: "late" }]);
    resetClientState(app.queryClient);
    await new Promise((r) => setTimeout(r, 120));
    expect(storage.map.has(PERSIST_KEY)).toBe(false);
  });

  it("[결함 2] 기기가 오프라인으로 열리면(navigator.onLine 만 거짓) 요청을 쉬고 토스트 없이 배너 — online 이벤트에 me 를 다시 확인한다", async () => {
    const storage = await savedCopy();
    let online = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      if (!online) throw new TypeError("Failed to fetch");
      if (String(input) === "/api/v1/auth/me") return json(200, ME);
      return shellGet(input, init) ?? json(200, { members: [] });
    });
    vi.stubGlobal("fetch", fetch);
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await boot(storage);

    expect(await screen.findByText("메시지 60")).toBeInTheDocument();
    expect(screen.getByText(OFFLINE)).toBeInTheDocument();
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByText("서버에 연결할 수 없습니다")).toBeNull();

    online = true;
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(meCalls(fetch)).toBe(1));
    await waitFor(() => expect(screen.queryByText(OFFLINE)).toBeNull());
  });

  it("[Review Focus 3] 사본에서 복원한 채널에서도 삭제(보관)한 에이전트의 메시지 작성자는 「삭제됨」 — 「알 수 없음」이 아니다", async () => {
    const gone = agentOf(uid(77), "old", { name: "옛 봇", archivedAt: "2026-10-05T00:00:00.000Z" });
    const storage = await savedCopy(
      msg(60, { authorType: "agent", authorId: gone.id, bodyMd: `마지막 답 <@a:${gone.id}>` }),
      [gone],
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    setBrowserOnline(false);
    await boot(storage);

    const body = await screen.findByText("마지막 답", { exact: false });
    const article = body.closest("article");
    expect(article).not.toBeNull();
    expect(within(article as HTMLElement).getByText("옛 봇")).toBeInTheDocument();
    expect(within(article as HTMLElement).getAllByText("삭제됨").length).toBeGreaterThanOrEqual(1);
    expect(within(article as HTMLElement).queryByText("알 수 없음")).toBeNull();
    expect(article?.querySelector("[data-mention][data-archived]")).toHaveTextContent("@old삭제됨");
  });

  it("[Review Focus 5] 사본에서 복원한 채널에서도 비활성 멤버의 메시지 작성자·멘션 칩은 「비활성」 — 「알 수 없음」이 아니다", async () => {
    const gone: Person = {
      id: uid(78),
      handle: "jihoon",
      displayName: "지훈",
      role: "member",
      deactivatedAt: "2026-10-06T00:00:00.000Z",
    };
    const storage = await savedCopy(
      msg(60, { authorId: gone.id, bodyMd: `마지막 말 <@u:${gone.id}>` }),
      [],
      [{ id: ME.user.id, handle: "owner", displayName: "주인", role: "owner", deactivatedAt: null }, gone],
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    setBrowserOnline(false);
    await boot(storage);

    const body = await screen.findByText("마지막 말", { exact: false });
    const article = body.closest("article");
    expect(article).not.toBeNull();
    expect(within(article as HTMLElement).getByText("지훈")).toBeInTheDocument();
    expect(within(article as HTMLElement).getAllByText("비활성").length).toBeGreaterThanOrEqual(1);
    expect(within(article as HTMLElement).queryByText("알 수 없음")).toBeNull();
    expect(article?.querySelector("[data-mention][data-deactivated]")).toHaveTextContent("@jihoon비활성");
  });

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
    expect(new URLSearchParams(history.location.search).get("next")).toBe(`/c/${CH}/s/${CH}`);
    await waitFor(() => expect(storage.map.has(PERSIST_KEY)).toBe(false));
    expect(app.queryClient.getQueryData(qk.timeline(CH, CH))).toBeUndefined();
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

  it("[결함 1] 사본으로 연 채널의 첫 구독은 새로 받는다 — 닫혀 있던 동안 다른 기기가 누른 카드의 결과 줄이 보인다", async () => {
    const card = msg(60, {
      bodyMd: "메시지 60",
      components: ComponentsV1.parse({
        id: "cmp_1",
        reusable: true,
        blocks: [{ type: "actions", items: [{ type: "button", id: "plus", label: "+1" }] }],
      }),
      componentState: { expiresAt: "2999-01-01T00:00:00.000Z", consumed: [] },
    });
    const storage = await savedCopy(card);
    // 다른 기기에서 누른 「+1」 — seq 는 그대로, interactions 만 바뀌었다(아래 pressed). 세션 REST 는 지금 값을 준다
    let pressedNow: MessageInteraction[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url === "/api/v1/auth/me") return json(200, ME);
      if (url.startsWith(`/api/v1/conversations/${CH}/messages`))
        return json(200, { messages: [{ ...card, interactions: pressedNow }], hasMore: true });
      return shellGet(input, init) ?? json(200, { members: [] });
    });
    vi.stubGlobal("fetch", fetch);
    await boot(storage);
    expect(await screen.findByText("메시지 60")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "상호작용 기록" })).toBeNull();

    const pressed: MessageInteraction = {
      id: uid(700),
      componentId: "cmp_1",
      userId: ME.user.id,
      itemId: "plus",
      values: {},
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    await waitFor(() => expect(createdSockets).toHaveLength(1));
    const fake = createdSockets[0];
    if (!fake) throw new Error("no socket");
    pressedNow = [pressed];
    // 서버처럼: 처음 구독은 메시지 없이 커서만(판정 PS5), 이어 받기(lastSeq)면 그 뒤 메시지만 — 카드 갱신은 seq 가 같아 오지 않는다.
    // 그래서 복원한 세션은 첫 구독 뒤 세션 REST 로 다시 받아야 결과 줄이 보인다
    fake.onAck("channel.subscribe", () => ({
      ok: true,
      data: { messages: [], hasMore: false, latestSeq: 60, activeRuns: [], pendingApprovals: [] },
    }));
    fake.socket.connected = true;
    act(() => fake.serverEmit("connect"));

    await waitFor(() =>
      expect(document.querySelector(`[data-interaction-id="${pressed.id}"]`)).not.toBeNull(),
    );
    expect(fake.sentOf("channel.subscribe")).toEqual([{ channelId: CH }]);
  });
});
