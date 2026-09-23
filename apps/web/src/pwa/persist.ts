import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  type AsyncStorage,
  type PersistedClient,
  type Persister,
  persistQueryClientRestore,
  persistQueryClientSubscribe,
} from "@tanstack/query-persist-client-core";
import type { DehydratedState, QueryClient } from "@tanstack/react-query";
import { del, get, set } from "idb-keyval";
import { qk } from "@/api/queries";
import type { Timeline } from "@/features/messages/timeline";

/** 최근 본 채널 수 · 채널마다 남기는 최근 메시지 수 · 사본의 최대 나이(스펙 4장) */
export const RECENT_MAX = 5;
export const TIMELINE_KEEP = 50;
export const PERSIST_MAX_AGE_MS = 7 * 24 * 3600_000;
/** IndexedDB(idb-keyval 기본 저장소) 안의 키 하나에 사본 전체를 둔다 */
export const PERSIST_KEY = "dodok.query";
/** 복원을 기다리는 최대 시간 — 넘으면 사본 없이 띄운다 */
const RESTORE_TIMEOUT_MS = 1000;

declare const __BUILD_ID__: string;
/** 빌드마다 바뀌는 값(vite.config.ts `define`) — 다르면 사본을 버린다(`buster`) */
export const BUILD_ID: string = __BUILD_ID__;

/** 채널을 열 때 — 앞으로 옮기고 중복 없이 RECENT_MAX 개로 자른다 */
export function touchRecentChannel(qc: QueryClient, channelId: string): void {
  qc.setQueryData<string[]>(qk.recentChannels, (prev = []) =>
    [channelId, ...prev.filter((id) => id !== channelId)].slice(0, RECENT_MAX),
  );
}

/**
 * 사본에 담을 쿼리(스펙 4장). me·채널 목록·에이전트·최근 목록은 늘, 채널 하나의 것(채널·멤버·타임라인)은 최근 본
 * 채널만. 런·활동·어댑터 상태는 지나간 실시간 값이라 담지 않는다(복원하면 틀린 상태를 보인다)
 */
export function shouldPersist(query: { queryKey: readonly unknown[] }, recent: readonly string[]): boolean {
  const [head, id] = query.queryKey;
  if (head === "me" || head === "channels" || head === "agents" || head === "recentChannels")
    return query.queryKey.length === 1;
  if (head === "channel" || head === "members" || head === "timeline")
    return query.queryKey.length === 2 && typeof id === "string" && recent.includes(id);
  return false;
}

function trimTimeline(t: Timeline): Timeline {
  const items = t.items.slice(-TIMELINE_KEEP);
  return { ...t, items, pending: [], hasOlder: t.hasOlder || items.length < t.items.length };
}

/**
 * 저장 직전에 고친다(메모리의 캐시는 그대로): 타임라인은 최근 50개·보내는 중 항목 없이, 값을 가진 채 실패한 쿼리
 * (오프라인의 me 등)는 성공으로 — 오류 객체는 직렬화되지 않고, 복원 뒤 오류로 남으면 오프라인 판단이 틀린다
 */
export function trimForPersist(state: DehydratedState): DehydratedState {
  return {
    mutations: [],
    queries: state.queries.map((q) => ({
      ...q,
      state: {
        ...q.state,
        ...(q.queryKey[0] === "timeline" && q.state.data
          ? { data: trimTimeline(q.state.data as Timeline) }
          : {}),
        status: "success",
        error: null,
        fetchFailureCount: 0,
        fetchFailureReason: null,
        fetchStatus: "idle",
      },
    })),
  };
}

const idbStorage: AsyncStorage<string> = {
  getItem: (k) => get<string>(k).then((v) => v ?? null),
  setItem: (k, v) => set(k, v),
  removeItem: (k) => del(k),
};

type Persistence = { stop(): void; clear(): Promise<void> };
type Tagged = PersistedClient & { epoch?: number };

/**
 * 오프라인 사본(스펙 4장) — 복원을 기다린 뒤(최대 1초) 저장을 시작한다. 저장소가 없거나 던지면 저장 없이 돈다.
 * `clear()` 는 로그아웃·401(`resetClientState`)이 부른다. 잘라 두기(throttle) 때문에 기다리던 저장이 지운 뒤에
 * 쓰일 수 있어, 저장마다 세대(epoch)를 달고 지우면 세대를 올려 옛 세대의 저장은 버린다.
 * me 가 없는 캐시(로그인 전·지운 뒤)는 저장하지 않고 지운다 — 사본은 로그인한 사람의 것이다
 */
export async function startPersistence(
  qc: QueryClient,
  opts: { buster: string; storage?: AsyncStorage<string>; throttleMs?: number },
): Promise<Persistence> {
  const storage = opts.storage ?? idbStorage;
  let epoch = 0;
  const base = createAsyncStoragePersister({
    storage,
    key: PERSIST_KEY,
    throttleTime: opts.throttleMs ?? 1000,
    serialize: ({ epoch: at, ...client }: Tagged) => {
      if (at !== epoch) throw new Error("stale persist epoch");
      return JSON.stringify({ ...client, clientState: trimForPersist(client.clientState) });
    },
  });
  const removeClient = async () => {
    try {
      await base.removeClient();
    } catch {
      // 저장소 오류 — 저장 없이 돈다
    }
  };
  const persister: Persister = {
    persistClient: (client) =>
      client.clientState.queries.some((q) => q.queryKey[0] === qk.me[0])
        ? base.persistClient({ ...client, epoch } as Tagged)
        : removeClient(),
    // 1초 안에 못 읽으면 사본 없이 — 늦게 온 값은 race 가 버린다
    restoreClient: () =>
      Promise.race([
        base.restoreClient(),
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), RESTORE_TIMEOUT_MS)),
      ]),
    removeClient,
  };

  // 복원한 최근 채널의 것은 화면에 관찰자가 없어도 사본 기한 동안 남아야 한다 — 기본 gcTime(5분)이면 다음 저장에서 빠진다
  for (const head of ["channel", "members", "timeline"])
    qc.setQueryDefaults([head], { gcTime: PERSIST_MAX_AGE_MS });
  qc.setQueryDefaults(qk.recentChannels, { gcTime: Number.POSITIVE_INFINITY });

  try {
    await persistQueryClientRestore({
      queryClient: qc,
      persister,
      buster: opts.buster,
      maxAge: PERSIST_MAX_AGE_MS,
    });
    // 사본의 me 는 낡은 것으로 둔다 — 첫 관찰자·연결 회복 때 다시 불러 세션을 확인한다(401 이면 지우고 로그인으로)
    void qc.invalidateQueries({ queryKey: qk.me, exact: true, refetchType: "none" });
  } catch {
    // 읽지 못한 사본은 persistQueryClientRestore 가 지웠다 — 사본 없이 띄운다
  }

  const unsubscribe = persistQueryClientSubscribe({
    queryClient: qc,
    persister,
    buster: opts.buster,
    dehydrateOptions: {
      shouldDehydrateMutation: () => false,
      shouldDehydrateQuery: (q) =>
        q.state.data !== undefined && shouldPersist(q, qc.getQueryData<string[]>(qk.recentChannels) ?? []),
    },
  });

  return {
    stop: unsubscribe,
    clear: async () => {
      epoch += 1;
      await removeClient();
    },
  };
}
