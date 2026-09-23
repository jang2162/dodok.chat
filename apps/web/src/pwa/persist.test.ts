import type { DehydratedState } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { registerSessionReset, resetClientState } from "@/app/session";
import type { Timeline } from "@/features/messages/timeline";
import { CH, CH2, msg, uid } from "../../test/fixtures";
import { memoryStorage } from "../../test/memoryStorage";
import { channelOf, ME } from "../../test/shellApi";
import {
  PERSIST_KEY,
  PERSIST_MAX_AGE_MS,
  RECENT_MAX,
  TIMELINE_KEEP,
  shouldPersist,
  startPersistence,
  touchRecentChannel,
  trimForPersist,
} from "./persist";

const stored = (s: ReturnType<typeof memoryStorage>) => {
  const raw = s.map.get(PERSIST_KEY);
  return raw === undefined
    ? undefined
    : (JSON.parse(raw) as { buster: string; timestamp: number; clientState: DehydratedState });
};
const storedKeys = (s: ReturnType<typeof memoryStorage>) =>
  stored(s)
    ?.clientState.queries.map((q) => JSON.stringify(q.queryKey))
    .sort();

const timelineOf = (n: number, over: Partial<Timeline> = {}): Timeline => ({
  items: Array.from({ length: n }, (_, i) => msg(i + 1)),
  pending: [],
  hasOlder: false,
  lastSeq: n,
  ...over,
});

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function persist(qc: QueryClient, storage = memoryStorage(), buster = "b1") {
  const p = await startPersistence(qc, { buster, storage, throttleMs: 0 });
  stops.push(p.stop);
  return { p, storage };
}

describe("shouldPersist", () => {
  const recent = [CH];
  const yes = (key: readonly unknown[]) => shouldPersist({ queryKey: key }, recent);
  it("me·채널 목록·에이전트·최근 목록은 늘", () => {
    expect(yes(["me"])).toBe(true);
    expect(yes(["channels"])).toBe(true);
    expect(yes(["agents"])).toBe(true);
    expect(yes(["recentChannels"])).toBe(true);
  });
  it("채널·멤버·타임라인은 최근 목록에 있는 채널만", () => {
    for (const head of ["channel", "members", "timeline"]) {
      expect(yes([head, CH])).toBe(true);
      expect(yes([head, CH2])).toBe(false);
    }
  });
  it("런·활동·어댑터·에이전트 찾기는 저장하지 않는다", () => {
    expect(yes(["runs", uid(5), "events"])).toBe(false);
    expect(yes(["channels", CH, "runs"])).toBe(false);
    expect(yes(["adapter"])).toBe(false);
    expect(yes(["agents", "discover"])).toBe(false);
  });
});

describe("trimForPersist", () => {
  const state = (data: unknown, key: readonly unknown[] = ["timeline", CH]): DehydratedState => ({
    mutations: [],
    queries: [
      {
        queryKey: key,
        queryHash: JSON.stringify(key),
        dehydratedAt: 1,
        state: {
          data,
          dataUpdateCount: 1,
          dataUpdatedAt: 1,
          error: null,
          errorUpdateCount: 0,
          errorUpdatedAt: 0,
          fetchFailureCount: 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: "success",
          fetchStatus: "idle",
        },
      },
    ],
  });

  it("타임라인은 마지막 50개만, hasOlder 는 참, 보내는 중 항목은 뺀다, lastSeq 는 그대로", () => {
    const pending = [
      {
        clientMsgId: "c",
        channelId: CH,
        bodyMd: "x",
        createdAt: "2026-09-23T00:00:00.000Z",
        state: "sending" as const,
      },
    ];
    const out = trimForPersist(state(timelineOf(120, { pending })));
    const t = out.queries[0]?.state.data as Timeline;
    expect(t.items).toHaveLength(TIMELINE_KEEP);
    expect(t.items[0]?.seq).toBe(71);
    expect(t.items.at(-1)?.seq).toBe(120);
    expect(t.hasOlder).toBe(true);
    expect(t.pending).toEqual([]);
    expect(t.lastSeq).toBe(120);
  });

  it("50개 이하면 hasOlder 는 원래 값", () => {
    const t = trimForPersist(state(timelineOf(3))).queries[0]?.state.data as Timeline;
    expect(t.items).toHaveLength(3);
    expect(t.hasOlder).toBe(false);
  });

  it("오류 상태(값은 있는 채 네트워크 실패)는 성공으로 저장한다 — 오류 객체는 직렬화되지 않는다", () => {
    const s = state(ME, ["me"]);
    const q = s.queries[0];
    if (!q) throw new Error("no query");
    q.state = {
      ...q.state,
      status: "error",
      error: new Error("x"),
      fetchFailureCount: 3,
      fetchFailureReason: new Error("x"),
    };
    const out = trimForPersist(s).queries[0]?.state;
    expect(out).toMatchObject({
      status: "success",
      error: null,
      fetchFailureCount: 0,
      fetchFailureReason: null,
      fetchStatus: "idle",
      data: ME,
    });
  });
});

describe("touchRecentChannel", () => {
  it("앞으로 옮기고 중복 없이 5개로 자른다", () => {
    const qc = new QueryClient();
    for (let i = 1; i <= 7; i += 1) touchRecentChannel(qc, uid(i));
    touchRecentChannel(qc, uid(4));
    expect(qc.getQueryData(qk.recentChannels)).toEqual([uid(4), uid(7), uid(6), uid(5), uid(3)]);
    expect(RECENT_MAX).toBe(5);
  });
});

describe("startPersistence", () => {
  /** 로그인한 앱이 캐시에 두는 것들 */
  function seed(qc: QueryClient) {
    qc.setQueryData(qk.me, ME);
    qc.setQueryData(qk.channels, [channelOf(CH), channelOf(CH2)]);
    qc.setQueryData(qk.agents, []);
    qc.setQueryData(qk.adapter, { provider: "openclaw", gateway: "connected", bridge: "connected" });
    touchRecentChannel(qc, CH);
    qc.setQueryData(qk.channel(CH), channelOf(CH));
    qc.setQueryData(qk.members(CH), []);
    qc.setQueryData(qk.timeline(CH), timelineOf(60));
    qc.setQueryData(qk.timeline(CH2), timelineOf(2));
    qc.setQueryData(qk.channelRuns(CH), []);
  }

  it("골라서 저장한다 — 최근 채널의 것·me·목록만, 타임라인은 잘라서", async () => {
    const qc = createQueryClient(() => {});
    const { storage } = await persist(qc);
    seed(qc);
    await vi.waitFor(() =>
      expect(storedKeys(storage)).toEqual(
        [
          ["agents"],
          ["channel", CH],
          ["channels"],
          ["me"],
          ["members", CH],
          ["recentChannels"],
          ["timeline", CH],
        ]
          .map((k) => JSON.stringify(k))
          .sort(),
      ),
    );
    const t = stored(storage)?.clientState.queries.find((q) => q.queryKey[0] === "timeline")?.state
      .data as Timeline;
    expect(t.items).toHaveLength(TIMELINE_KEEP);
    expect(stored(storage)?.buster).toBe("b1");
    // 메모리의 캐시는 자르지 않는다
    expect(qc.getQueryData<Timeline>(qk.timeline(CH))?.items).toHaveLength(60);
  });

  it("사본에 세션 토큰·쿠키가 없다 — 뮤테이션(로그인 토큰 variables)은 저장하지 않는다", async () => {
    document.cookie = "dodok_probe=cookie-value-123";
    const qc = createQueryClient(() => {});
    const { storage } = await persist(qc);
    seed(qc);
    await qc
      .getMutationCache()
      .build(qc, { mutationFn: async (_token: string) => ({ sessionToken: "tok-secret-456" }) })
      .execute("tok-secret-456");
    // 뮤테이션 뒤의 저장을 기다린다 — 표식이 보이면 그 저장에 뮤테이션도 들어갈 수 있었다
    qc.setQueryData(qk.agents, [{ id: "after-mutation" }]);
    await vi.waitFor(() => expect(storage.map.get(PERSIST_KEY)).toContain("after-mutation"));
    const raw = storage.map.get(PERSIST_KEY) ?? "";
    expect(raw).not.toContain("tok-secret-456");
    expect(raw).not.toContain("cookie-value-123");
    expect(raw.toLowerCase()).not.toContain("sessiontoken");
    expect(stored(storage)?.clientState.mutations).toEqual([]);
    document.cookie = "dodok_probe=; expires=Thu, 01 Jan 1970 00:00:00 GMT";
  });

  it("me 가 없으면 저장하지 않는다(로그인하지 않은 캐시)", async () => {
    const qc = createQueryClient(() => {});
    const { storage } = await persist(qc);
    qc.setQueryData(qk.channels, [channelOf(CH)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(storage.map.has(PERSIST_KEY)).toBe(false);
  });

  async function savedBy(buster = "b1") {
    const first = createQueryClient(() => {});
    const { p, storage } = await persist(first, memoryStorage(), buster);
    seed(first);
    await vi.waitFor(() => expect(storedKeys(storage)).toContain(JSON.stringify(["timeline", CH])));
    p.stop();
    return storage;
  }

  it("복원한다 — 저장한 값이 새 클라이언트에 있고, me 는 다시 확인하도록 낡은 것으로 둔다", async () => {
    const storage = await savedBy();
    const qc = createQueryClient(() => {});
    await persist(qc, storage);
    expect(qc.getQueryData(qk.me)).toEqual(ME);
    expect(qc.getQueryData<Timeline>(qk.timeline(CH))?.items).toHaveLength(TIMELINE_KEEP);
    expect(qc.getQueryData(qk.recentChannels)).toEqual([CH]);
    expect(qc.getQueryData(qk.adapter)).toBeUndefined();
    expect(qc.getQueryCache().find({ queryKey: qk.me, exact: true })?.isStale()).toBe(true);
  });

  it("복원한 최근 채널의 사본은 관찰자가 없어도 5분 뒤 지워지지 않는다(gcTime)", async () => {
    const storage = await savedBy();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const qc = createQueryClient(() => {});
    const restored = startPersistence(qc, { buster: "b1", storage, throttleMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    stops.push((await restored).stop);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(qc.getQueryData(qk.timeline(CH))).toBeDefined();
    expect(qc.getQueryData(qk.recentChannels)).toEqual([CH]);
  });

  it("7일이 넘은 사본은 버린다", async () => {
    const storage = await savedBy();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + PERSIST_MAX_AGE_MS + 24 * 3600_000);
    const qc = createQueryClient(() => {});
    await persist(qc, storage);
    expect(qc.getQueryData(qk.me)).toBeUndefined();
    expect(storage.map.has(PERSIST_KEY)).toBe(false);
  });

  it("빌드가 바뀌면(buster 다름) 버린다", async () => {
    const storage = await savedBy("old-build");
    const qc = createQueryClient(() => {});
    await persist(qc, storage, "new-build");
    expect(qc.getQueryData(qk.me)).toBeUndefined();
    expect(storage.map.has(PERSIST_KEY)).toBe(false);
  });

  it("복원이 1초 안에 안 끝나면 복원 없이 돌려준다 — 늦게 온 값도 넣지 않는다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const storage = memoryStorage();
    let answer: (v: string) => void = () => {};
    storage.getItem.mockImplementation(() => new Promise<string>((r) => (answer = r)));
    const qc = createQueryClient(() => {});
    let done = false;
    const started = startPersistence(qc, { buster: "b1", storage, throttleMs: 0 }).then((p) => {
      done = true;
      stops.push(p.stop);
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await started;
    answer(
      JSON.stringify({ buster: "b1", timestamp: Date.now(), clientState: { mutations: [], queries: [] } }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(qc.getQueryData(qk.me)).toBeUndefined();
  });

  it("로그아웃(resetClientState)이면 저장소를 비운다 — 기다리던 저장도 되살리지 않는다", async () => {
    const qc = createQueryClient(() => {});
    const storage = memoryStorage();
    const p = await startPersistence(qc, { buster: "b1", storage, throttleMs: 30 });
    stops.push(p.stop);
    const unregister = registerSessionReset(() => void p.clear());
    stops.push(unregister);
    seed(qc);
    await vi.waitFor(() => expect(storedKeys(storage)).toContain(JSON.stringify(["me"])));
    // 잘라 두기 간격(30ms) 안의 변경 — 기다리는 저장이 하나 생긴다
    qc.setQueryData(qk.agents, [{ id: "late" }]);
    resetClientState(qc);
    await new Promise((r) => setTimeout(r, 120));
    expect(storage.map.has(PERSIST_KEY)).toBe(false);
  });

  it("다른 사람이 다시 로그인하면 그 사람의 것을 저장한다", async () => {
    const qc = createQueryClient(() => {});
    const { p, storage } = await persist(qc);
    seed(qc);
    await vi.waitFor(() => expect(storedKeys(storage)).toContain(JSON.stringify(["me"])));
    await p.clear();
    qc.clear();
    qc.setQueryData(qk.me, { ...ME, user: { id: "b", handle: "bee" } });
    await vi.waitFor(() => expect(storage.map.get(PERSIST_KEY)).toContain('"bee"'));
    expect(storage.map.get(PERSIST_KEY)).not.toContain('"owner"');
  });

  it("저장소가 던지면 복원·저장 없이 돈다", async () => {
    const storage = memoryStorage();
    storage.getItem.mockRejectedValue(new Error("idb gone"));
    storage.setItem.mockRejectedValue(new Error("idb gone"));
    storage.removeItem.mockRejectedValue(new Error("idb gone"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const qc = createQueryClient(() => {});
    const p = await startPersistence(qc, { buster: "b1", storage, throttleMs: 0 });
    stops.push(p.stop);
    seed(qc);
    await new Promise((r) => setTimeout(r, 20));
    await expect(p.clear()).resolves.toBeUndefined();
    expect(qc.getQueryData(qk.me)).toEqual(ME);
  });
});
