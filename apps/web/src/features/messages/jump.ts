import type { QueryClient } from "@tanstack/react-query";
import { qk } from "@/api/queries";
import { fetchThreadPage } from "@/features/threads/queries";
import { restFetchPage } from "@/realtime/subscriptions";
import { getThread, getTimeline, withThreadEdits, withTimelineEdits } from "@/realtime/timelineCache";
import {
  appendNewer,
  emptyTimeline,
  fromLatest,
  jumpAround,
  threadAround,
  threadFromPage,
  type Timeline,
} from "./timeline";

/** 결과로 가기·아래로 이어 받기·최신으로가 한 번에 받는 수(과거 페이지와 같다) */
const PAGE = 50;

/**
 * 타임라인(`threadRootId` 가 없으면 채널, 있으면 그 스레드)을 REST 로 받아 갈아 끼운다. 받는 사이 wire 가 고친 것은 결과에
 * 다시 얹는다(`with*Edits`) — 결과를 만드는 `next` 는 받은 **뒤의** 캐시로 계산하므로 이미 반영된 변경이 한 번 더 적용될 뿐이다.
 * `next` 가 undefined 면(캐시가 없다·그 사이 새로 시작됐다) 그대로 둔다
 */
async function replace(
  qc: QueryClient,
  channelId: string,
  threadRootId: string | undefined,
  next: () => Promise<Timeline | undefined>,
): Promise<void> {
  let skipped = false;
  const run = async () => {
    const r = await next();
    if (r === undefined) skipped = true;
    return r ?? emptyTimeline();
  };
  if (threadRootId === undefined) {
    const t = await withTimelineEdits(qc, channelId, run);
    if (!skipped) qc.setQueryData(qk.timeline(channelId), t);
  } else {
    const t = await withThreadEdits(qc, channelId, threadRootId, run);
    if (!skipped) qc.setQueryData(qk.thread(channelId, threadRootId), t);
  }
}

const read = (qc: QueryClient, channelId: string, threadRootId?: string) =>
  threadRootId === undefined ? getTimeline(qc, channelId) : getThread(qc, channelId, threadRootId);

/**
 * 결과로 가기(스레드·검색 스펙 5.3) — 그 seq 를 가운데 둔 페이지로 갈아 끼운다. 채널 타임라인에서 답글 seq 는 서버가 그 루트를
 * 가운데로 둔다. 채널은 구독 응답을 받은 뒤에 부른다 — 그 전의 `fresh` 가 최신 페이지로 다시 덮는다(`useJump`)
 */
export async function jumpToSeq(
  qc: QueryClient,
  channelId: string,
  seq: number,
  threadRootId?: string,
): Promise<void> {
  const q = { around: seq, limit: PAGE };
  await replace(qc, channelId, threadRootId, async () => {
    if (threadRootId === undefined) {
      const page = await restFetchPage(channelId, q);
      const cur = getTimeline(qc, channelId);
      return cur && jumpAround(cur, page);
    }
    const page = await fetchThreadPage(channelId, threadRootId, q);
    const cur = getThread(qc, channelId, threadRootId);
    return cur && threadAround(cur, page.root, page);
  });
}

/** 떨어진 창(`hasNewer`)의 아래로 이어 받기 — 가장 새 항목 뒤를 한 쪽. 더 없으면 창이 끝에 닿는다 */
export async function loadNewer(qc: QueryClient, channelId: string, threadRootId?: string): Promise<void> {
  const newest = read(qc, channelId, threadRootId)?.items.at(-1);
  if (!newest) return;
  const q = { afterSeq: newest.seq, limit: PAGE };
  await replace(qc, channelId, threadRootId, async () => {
    const page =
      threadRootId === undefined
        ? await restFetchPage(channelId, q)
        : await fetchThreadPage(channelId, threadRootId, q);
    const cur = read(qc, channelId, threadRootId);
    // 그 사이 타임라인이 새로 시작됐으면(최신으로·빈틈 복구) 붙이지 않는다
    if (!cur?.hasNewer || cur.items.at(-1)?.seq !== newest.seq) return undefined;
    return appendNewer(cur, page.messages, page.hasMore);
  });
}

/** 떨어진 창에서 최신으로 — 최신 페이지로 새로 시작한다. 채널의 `lastSeq` 는 내려가지 않는다(거짓 빈틈 없음) */
export async function loadLatest(qc: QueryClient, channelId: string, threadRootId?: string): Promise<void> {
  await replace(qc, channelId, threadRootId, async () => {
    if (threadRootId === undefined) {
      const page = await restFetchPage(channelId, { limit: PAGE });
      const cur = getTimeline(qc, channelId);
      if (!cur) return undefined;
      const t = fromLatest(cur, page.messages, page.hasMore);
      return { ...t, lastSeq: Math.max(t.lastSeq, cur.lastSeq) };
    }
    const page = await fetchThreadPage(channelId, threadRootId, { limit: PAGE });
    const cur = getThread(qc, channelId, threadRootId);
    return cur && threadFromPage(cur, page.root, page.messages, page.hasMore);
  });
}
