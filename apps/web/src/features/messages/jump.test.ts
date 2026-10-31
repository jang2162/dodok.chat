import type { Message } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { getThread, getTimeline, updateThread, updateTimeline } from "@/realtime/timelineCache";
import { CH, msg } from "../../../test/fixtures";
import { json } from "../../../test/shellApi";
import { firstRootAfter, jumpToSeq, loadLatest, loadNewer } from "./jump";
import { emptyTimeline, noteSeq, type Timeline, threadFromPage, upsert } from "./timeline";

const ROOT = msg(1, { bodyMd: "루트" });
const reply = (seq: number) => msg(seq, { threadRootId: ROOT.id, bodyMd: `답글 ${seq}` });

let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
/** URL → 응답. 없으면 404 */
let routes: Map<string, () => Promise<Response> | Response>;
beforeEach(() => {
  routes = new Map();
  fetchMock = vi.fn<typeof globalThis.fetch>(async (input) => {
    const reply = routes.get(String(input));
    return reply ? reply() : json(404, { code: "NOT_FOUND", message: String(input) });
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** 응답을 손으로 풀어 주는 자리 — 받는 사이에 wire 변경을 끼워 넣는다 */
function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

/** 구독한 채널: 최신 루트 40·44, 채널의 끝(답글 포함)은 46 */
function subscribed() {
  const qc = createQueryClient(() => {});
  qc.setQueryData<Timeline>(qk.timeline(CH, CH), {
    ...emptyTimeline(),
    items: [msg(40), msg(44)],
    hasOlder: true,
    lastSeq: 46,
  });
  return qc;
}
const seqs = (t: Timeline | undefined) => t?.items.map((m) => m.seq);
const channelUrl = (q: string) => `/api/v1/conversations/${CH}/messages?${q}`;
const threadUrl = (q: string) => `/api/v1/conversations/${CH}/threads/${ROOT.id}/messages?${q}`;

describe("채널 — around 로 갈아 끼우기", () => {
  it("그 seq 의 around 페이지(50)로 — 더 새것이 있으면 떨어진 창, lastSeq 는 채널의 끝 그대로", async () => {
    const qc = subscribed();
    routes.set(channelUrl("limit=50&around=9"), () =>
      json(200, { messages: [msg(5), msg(9), msg(12)], hasMore: true, hasMoreAfter: true }),
    );
    await jumpToSeq(qc, CH, CH, 9);
    const t = getTimeline(qc, CH, CH);
    expect(seqs(t)).toEqual([5, 9, 12]);
    expect(t).toMatchObject({ hasOlder: true, hasNewer: true, lastSeq: 46 });
  });

  it("받는 사이 온 wire 변경은 결과에 다시 얹는다 — 창 안 루트의 수정, 창 밖 새 루트는 seq 만", async () => {
    const qc = subscribed();
    const res = deferred();
    routes.set(channelUrl("limit=50&around=9"), () => res.promise);
    const done = jumpToSeq(qc, CH, CH, 9);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    updateTimeline(qc, CH, CH, (t) => upsert(t, { ...msg(9), bodyMd: "고친 본문" }));
    updateTimeline(qc, CH, CH, (t) => upsert(t, msg(47)));
    updateTimeline(qc, CH, CH, (t) => noteSeq(t, 48));
    res.resolve(json(200, { messages: [msg(5), msg(9), msg(12)], hasMore: true, hasMoreAfter: true }));
    await done;
    const t = getTimeline(qc, CH, CH);
    expect(seqs(t)).toEqual([5, 9, 12]);
    expect(t?.items[1]?.bodyMd).toBe("고친 본문");
    expect(t?.lastSeq).toBe(48);
  });
});

describe("firstRootAfter — 읽음 위치 뒤 첫 루트를 묻기만 한다", () => {
  it("afterSeq·limit 1 로 묻고 그 메시지를 돌려준다 — 캐시는 건드리지 않는다", async () => {
    const qc = subscribed();
    const before = getTimeline(qc, CH, CH);
    routes.set(`/api/v1/conversations/${CH}/messages?limit=1&afterSeq=11`, () =>
      json(200, { messages: [msg(14)], hasMore: true }),
    );
    expect((await firstRootAfter(CH, 11))?.seq).toBe(14);
    expect(getTimeline(qc, CH, CH)).toBe(before);
  });

  it("뒤에 루트가 없으면 undefined", async () => {
    routes.set(`/api/v1/conversations/${CH}/messages?limit=1&afterSeq=11`, () =>
      json(200, { messages: [], hasMore: false }),
    );
    expect(await firstRootAfter(CH, 11)).toBeUndefined();
  });
});

describe("채널 — 떨어진 창의 아래로 이어 받기·최신으로", () => {
  function detached() {
    const qc = subscribed();
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({
      ...t!,
      items: [msg(5), msg(9)],
      hasNewer: true,
    }));
    return qc;
  }

  it("가장 새 항목 뒤(afterSeq)를 붙이고, 더 없으면 창이 끝에 닿는다", async () => {
    const qc = detached();
    routes.set(channelUrl("limit=50&afterSeq=9"), () => json(200, { messages: [msg(12)], hasMore: true }));
    await loadNewer(qc, CH, CH);
    expect(seqs(getTimeline(qc, CH, CH))).toEqual([5, 9, 12]);
    expect(getTimeline(qc, CH, CH)?.hasNewer).toBe(true);
    routes.set(channelUrl("limit=50&afterSeq=12"), () => json(200, { messages: [msg(44)], hasMore: false }));
    await loadNewer(qc, CH, CH);
    expect(seqs(getTimeline(qc, CH, CH))).toEqual([5, 9, 12, 44]);
    expect(getTimeline(qc, CH, CH)?.hasNewer).toBe(false);
  });

  it("마지막 쪽을 받는 사이 온 새 루트는 떨어진 창이라 버려졌어도 결과에 들어간다", async () => {
    const qc = detached();
    const res = deferred();
    routes.set(channelUrl("limit=50&afterSeq=9"), () => res.promise);
    const done = loadNewer(qc, CH, CH);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    updateTimeline(qc, CH, CH, (t) => upsert(t, msg(47)));
    // 받는 동안은 창 밖이라 목록에 없다
    expect(seqs(getTimeline(qc, CH, CH))).toEqual([5, 9]);
    res.resolve(json(200, { messages: [msg(44)], hasMore: false }));
    await done;
    expect(seqs(getTimeline(qc, CH, CH))).toEqual([5, 9, 44, 47]);
  });

  it("받는 사이 타임라인이 새로 시작됐으면(최신으로·fresh) 붙이지 않는다", async () => {
    const qc = detached();
    const res = deferred();
    routes.set(channelUrl("limit=50&afterSeq=9"), () => res.promise);
    const done = loadNewer(qc, CH, CH);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({
      ...t!,
      items: [msg(40), msg(44)],
      hasNewer: false,
    }));
    res.resolve(json(200, { messages: [msg(12)], hasMore: true }));
    await done;
    expect(seqs(getTimeline(qc, CH, CH))).toEqual([40, 44]);
    expect(getTimeline(qc, CH, CH)?.hasNewer).toBe(false);
  });

  it("받는 사이 다른 떨어진 창(around)으로 갈아 끼웠으면 옛 창의 다음 쪽을 붙이지 않는다", async () => {
    const qc = detached();
    const res = deferred();
    routes.set(channelUrl("limit=50&afterSeq=9"), () => res.promise);
    const done = loadNewer(qc, CH, CH);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    qc.setQueryData<Timeline>(qk.timeline(CH, CH), (t) => ({
      ...t!,
      items: [msg(30), msg(33)],
      hasNewer: true,
    }));
    res.resolve(json(200, { messages: [msg(12)], hasMore: true }));
    await done;
    expect(seqs(getTimeline(qc, CH, CH))).toEqual([30, 33]);
    expect(getTimeline(qc, CH, CH)?.hasNewer).toBe(true);
  });

  it("최신으로 — 최신 페이지로 새로 시작하고 lastSeq 는 내려가지 않는다", async () => {
    const qc = detached();
    routes.set(channelUrl("limit=50"), () => json(200, { messages: [msg(40), msg(44)], hasMore: true }));
    await loadLatest(qc, CH, CH);
    const t = getTimeline(qc, CH, CH);
    expect(seqs(t)).toEqual([40, 44]);
    expect(t?.hasNewer).toBeFalsy();
    expect(t?.hasOlder).toBe(true);
    expect(t?.lastSeq).toBe(46);
  });
});

describe("스레드 — around·이어 받기", () => {
  function withThread(messages: Message[] = [reply(80), reply(90)]) {
    const qc = subscribed();
    qc.setQueryData(qk.thread(CH, CH, ROOT.id), threadFromPage(undefined, ROOT, messages, true));
    return qc;
  }

  it("스레드 REST 의 around — 루트가 맨 앞, 받는 사이 온 답글 수정은 다시 얹는다", async () => {
    const qc = withThread();
    const res = deferred();
    routes.set(threadUrl("limit=50&around=33"), () => res.promise);
    const done = jumpToSeq(qc, CH, CH, 33, ROOT.id);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    updateThread(qc, CH, CH, ROOT.id, (t) => upsert(t, { ...reply(33), bodyMd: "고친 답글" }));
    res.resolve(
      json(200, { root: ROOT, messages: [reply(30), reply(33)], hasMore: true, hasMoreAfter: true }),
    );
    await done;
    const t = getThread(qc, CH, CH, ROOT.id);
    expect(seqs(t)).toEqual([1, 30, 33]);
    expect(t?.items[2]?.bodyMd).toBe("고친 답글");
    expect(t?.hasNewer).toBe(true);
  });

  it("스레드의 아래로 이어 받기 — afterSeq 는 가장 새 답글", async () => {
    const qc = withThread();
    qc.setQueryData<Timeline>(qk.thread(CH, CH, ROOT.id), (t) => ({ ...t!, hasNewer: true }));
    routes.set(threadUrl("limit=50&afterSeq=90"), () =>
      json(200, { root: ROOT, messages: [reply(95)], hasMore: false }),
    );
    await loadNewer(qc, CH, CH, ROOT.id);
    const t = getThread(qc, CH, CH, ROOT.id);
    expect(seqs(t)).toEqual([1, 80, 90, 95]);
    expect(t?.hasNewer).toBe(false);
  });

  it("스레드 최신으로 — 최신 페이지로 새로 시작", async () => {
    const qc = withThread([reply(30)]);
    qc.setQueryData<Timeline>(qk.thread(CH, CH, ROOT.id), (t) => ({ ...t!, hasNewer: true }));
    routes.set(threadUrl("limit=50"), () =>
      json(200, { root: ROOT, messages: [reply(80), reply(90)], hasMore: true }),
    );
    await loadLatest(qc, CH, CH, ROOT.id);
    const t = getThread(qc, CH, CH, ROOT.id);
    expect(seqs(t)).toEqual([1, 80, 90]);
    expect(t?.hasNewer).toBeFalsy();
  });
});
