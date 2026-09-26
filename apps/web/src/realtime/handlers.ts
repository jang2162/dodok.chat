import {
  type AdapterStatus,
  type Agent,
  type Channel,
  type Message,
  type OpsStatus,
  roleAtLeast,
  type ServerToClientEvents,
} from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRequestError } from "@/api/http";
import { type AdapterStatusResponse, type MeResponse, meQuery, qk } from "@/api/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { forgetApproval, notifyApproval } from "@/features/approvals/notify";
import { hasGap, noteSeq, type Timeline, upsert } from "@/features/messages/timeline";
import { useRunStore } from "@/features/runs/runStore";
import type { Subscriptions } from "./subscriptions";
import { getTimeline, updateThread, updateTimeline } from "./timelineCache";
import { useTypingStore } from "./typing";
import { useWireStatus, type WireSocket, type WireStatus } from "./wire";

/** system.notice 토스트 지속시간(스펙 8장) */
export const NOTICE_DURATION_MS = { info: 4_000, warn: 6_000, error: Infinity } as const;
/** socket.io 가 스스로 다시 붙지 않는 거절(미들웨어 connect_error)·서버 끊김 뒤, 직접 다시 붙기까지의 첫 간격 */
export const WIRE_RETRY_BASE_MS = 2_000;
/** 백오프 상한 — 서버가 오래 없어도 이보다 드물게 두드리지 않는다 */
export const WIRE_RETRY_MAX_MS = 30_000;

/**
 * 직접 재연결 간격 — 2초에서 시작해 30초까지 두 배씩, 지터 ±20%(같은 순간 끊긴 탭들이 한꺼번에 몰리지 않게).
 * `attempt` 는 0부터. 다시 붙으면(`connect`) 0 으로 돌아간다
 */
export function nextRetryDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(WIRE_RETRY_BASE_MS * 2 ** attempt, WIRE_RETRY_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}

/** 재연결을 멈춘 상태 — 끊김·전송 실패가 덮어쓰지 않는다 */
const STOPPED: ReadonlySet<WireStatus> = new Set(["protocol_mismatch", "rejected"]);

/**
 * 승인 알림이 쓰는 화면 사정(설계 5.4). 라우터를 realtime 안으로 들이지 않으려고 주입받는다 —
 * 앱 하나에 하나이고 정체성이 고정돼야 한다(`createApp()` 의 것)
 */
export type NotifyTarget = {
  /** 지금 보고 있는 채널 */
  currentChannelId(): string | undefined;
  /** 알림을 눌렀을 때 — 그 채널의 활동 탭 */
  openActivity(channelId: string): void;
};

type Deps = {
  queryClient: QueryClient;
  subscriptions: Subscriptions;
  onUnauthorized: () => void;
  notify: NotifyTarget;
};
type MessageEvent = Parameters<ServerToClientEvents["message.created"]>[0];

/** 서버 이벤트를 Query 캐시·런 스토어·작성 중 저장소·연결 상태에 반영한다(스펙 4장). 해제 함수를 돌려준다 */
export function attachHandlers(socket: WireSocket, deps: Deps): () => void {
  const { queryClient: qc, subscriptions, onUnauthorized, notify } = deps;
  const setStatus = (s: WireStatus) => useWireStatus.getState().setStatus(s);
  let detached = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** 이어진 직접 재연결 횟수 — 백오프 간격을 정한다. 다시 붙으면 0 으로 */
  let retryAttempt = 0;
  /** 한 번이라도 붙었는가 — 두 번째 connect 부터가 다시 붙은 것이다 */
  let connectedOnce = false;

  /**
   * 새 메시지·수정. 구독한 적 없는 채널(캐시 없음)은 무시, 빈틈이면 넣지 않고 lastSeq 로 이어 받는다(스펙 4.3-3·4).
   * 채널 룸 하나로 루트와 스레드 답글이 함께 온다(스레드·검색 스펙 4.1) — 채널 타임라인은 루트만, 답글은 seq 만 기록하고
   * 연 스레드의 캐시에 넣는다. 루트의 바뀐 요약(`threadSummary`)은 서버가 루트 `message.updated` 로 따로 보낸다
   */
  function applyMessage({ message: m }: MessageEvent, updated: boolean): void {
    const t = getTimeline(qc, m.channelId);
    if (!t) return;
    const rootId = m.threadRootId;
    // 이미 지난 seq 의 수정 — 빈틈을 볼 일이 없다
    const stale = updated && m.seq <= t.lastSeq;
    // 빈 채널(lastSeq 0)은 hasGap 이 빈틈으로 보지 않는다 — 구독 경합으로 앞 메시지를 놓쳤을 수 있다(web-t3 리뷰 Ruling)
    if (!stale && (hasGap(t, m) || (t.lastSeq === 0 && m.seq > 1))) {
      void subscriptions.catchUp(m.channelId).catch(() => undefined);
      return;
    }
    if (rootId !== undefined) {
      if (!stale) updateTimeline(qc, m.channelId, (prev) => noteSeq(prev, m.seq));
      updateThread(qc, m.channelId, rootId, (prev) => (keeps(prev, m, updated) ? upsert(prev, m) : prev));
      return;
    }
    // 연 스레드의 루트는 적재 범위와 상관없이 늘 맞춘다(패널 맨 위에 늘 있다)
    updateThread(qc, m.channelId, m.id, (prev) => upsert(prev, m));
    // 적재 범위 밖(더 옛것)의 수정은 넣지 않는다 — 과거 페이지(beforeSeq)가 가장 옛 seq 를 기준으로 삼는다
    if (stale && !t.items.some((x) => x.id === m.id)) return;
    updateTimeline(qc, m.channelId, (prev) => upsert(prev, m));
  }

  /** 스레드 캐시에 넣을 답글인가 — 수정이면 가진 것이거나 적재 범위(가장 옛 답글) 안일 때만 */
  function keeps(thread: Timeline, m: Message, updated: boolean): boolean {
    if (!updated || !thread.hasOlder || thread.items.some((x) => x.id === m.id)) return true;
    const oldestReply = thread.items.find((x) => x.threadRootId !== undefined);
    return oldestReply !== undefined && m.seq > oldestReply.seq;
  }

  function retryLater(): void {
    clearTimeout(retryTimer);
    const delay = nextRetryDelay(retryAttempt);
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      if (!detached) socket.connect();
    }, delay);
  }

  /**
   * wire `UNAUTHORIZED` 는 먼저 REST 세션을 확인한다(web-t4 리뷰 Ruling). 핸드셰이크 Origin 이 APP_ORIGIN 과 다르면
   * 세션이 살아 있어도 wire 만 거부되는데, 그때 로그인으로 보내면 로그인 ↔ 앱을 끝없이 오간다.
   * me 401 → onUnauthorized, me 200 → `rejected`(다시 붙어도 같다), 그 밖(네트워크 등) → 끊김처럼 다시 붙는다.
   */
  async function verifySession(): Promise<void> {
    try {
      await qc.fetchQuery({ ...meQuery, staleTime: 0 });
    } catch (e) {
      if (detached) return;
      if (e instanceof ApiRequestError && e.status === 401) {
        onUnauthorized();
        return;
      }
      setStatus("reconnecting");
      retryLater();
      return;
    }
    if (detached) return;
    setStatus("rejected");
    socket.disconnect();
  }

  const on: Partial<ServerToClientEvents> = {
    "message.created": (p) => applyMessage(p, false),
    "message.updated": (p) => applyMessage(p, true),
    "run.state": ({ run, resync }) => {
      useRunStore.getState().applyState(run);
      if (resync) void subscriptions.runReplay.resync(run);
    },
    "run.event": ({ event }) => subscriptions.runReplay.live(event),
    /**
     * 승인 요구·확정. 같은 승인이 프레임 둘로 와 두 번 발행될 수 있어(p2-t6 Ruling C) 스토어가 id 로 병합한다 —
     * 카드는 하나다. 확정 사실은 클라이언트 시계로 그린 「만료됨」을 덮는다
     */
    "approval.requested": ({ approval }) => {
      useApprovalStore.getState().apply(approval);
      // 이미 답한 승인은 알리지 않는다 — 재접속 되감기·늦게 온 프레임이 확정 뒤에 올 수 있다
      if (approval.status !== "pending") return;
      // 결정은 admin 이상의 몫이다(팀 스펙 5장) — member 는 카드만 본다(「관리자가 결정합니다」)
      if (!roleAtLeast(qc.getQueryData<MeResponse>(qk.me)?.role, "admin")) return;
      notifyApproval(approval, {
        visible: document.visibilityState === "visible",
        currentChannelId: notify.currentChannelId(),
        onClick: () => notify.openActivity(approval.channelId),
        // 캐시에 없으면(아직 못 받았다) 일반 문구로 — 알림 때문에 REST 를 부르지 않는다
        handle: qc.getQueryData<Agent[]>(qk.agents)?.find((a) => a.id === approval.agentId)?.handle,
        channelName: qc.getQueryData<Channel[]>(qk.channels)?.find((c) => c.id === approval.channelId)?.name,
      });
    },
    "approval.resolved": ({ approval }) => {
      useApprovalStore.getState().apply(approval);
      forgetApproval(approval.id);
    },
    /**
     * 새 채널 — 사이드바가 보는 목록 캐시에 덧붙인다(만든 사람은 useCreateChannel 이 먼저 넣는다).
     * 같은 id 가 이미 있으면 그대로 둔다 — 늦게 온 created 가 그새 바뀐 값(channel.updated)을 되돌리지 않게.
     * 목록을 아직 안 받았으면 만들지 않는다 — 한 채널짜리 목록을 완전한 것처럼 두지 않는다(useCreateChannel 과 같은 규칙)
     */
    "channel.created": ({ channel }) => {
      qc.setQueryData<Channel[]>(qk.channels, (list) =>
        list && !list.some((c) => c.id === channel.id) ? [...list, channel] : list,
      );
    },
    "channel.updated": ({ channel }) => {
      qc.setQueryData<Channel[]>(qk.channels, (list) =>
        list?.map((c) => (c.id === channel.id ? channel : c)),
      );
      qc.setQueryData<Channel>(qk.channel(channel.id), channel);
    },
    "channel.member.changed": ({ channelId, members }) => qc.setQueryData(qk.members(channelId), members),
    /**
     * 사람 목록(가입·역할·표시 이름·내보내기 뒤 전체) — 통째로 바꾼다. 내 역할이 바뀌었으면 me 를 다시 받는다: 역할의 정본은
     * `/auth/me` 이고(팀 스펙 6장) 관리 화면은 그것을 본다. 내보내졌으면(내 줄의 role 이 없다) 서버가 소켓을 끊고 다음 REST 가 401 이다
     */
    "people.changed": ({ people }) => {
      qc.setQueryData(qk.people, people);
      const me = qc.getQueryData<MeResponse>(qk.me);
      const mine = me && people.find((p) => p.id === me.user.id);
      if (mine?.role !== undefined && mine.role !== me?.role)
        void qc.fetchQuery({ ...meQuery, staleTime: 0 }).catch(() => undefined);
    },
    "adapter.status": (status: AdapterStatus) =>
      qc.setQueryData<AdapterStatusResponse>(qk.adapter, (prev) => prev && { ...prev, ...status }),
    /**
     * 연결 설정 상태(owner 에게만 온다) — 통째로 바꾼다. 토큰 목록의 「지금 접속 중」·마지막 사용은 목록 응답에 있어
     * 다시 받게 낡은 것으로 둔다(보고 있는 화면만 곧바로 다시 부른다)
     */
    "setup.status": ({ status }) => {
      qc.setQueryData(qk.setupStatus, status);
      void qc.invalidateQueries({ queryKey: qk.bridgeTokens });
    },
    /**
     * 운영 사건(owner 에게만 온다) — 배지가 읽는 상태의 `unacked` 는 곧바로 덮는다(상태를 아직 안 받았으면 만들지 않는다).
     * 상태의 나머지 칸(디스크·버전·런 수)도 사건과 함께 바뀌었을 수 있어 상태와 사건 목록은 낡은 것으로 둔다 —
     * 보고 있는 화면만 곧바로 다시 부른다(브라우저 검증 D1)
     */
    "ops.event": ({ unacked }) => {
      qc.setQueryData<OpsStatus>(qk.opsStatus, (prev) => prev && { ...prev, unacked });
      void qc.invalidateQueries({ queryKey: qk.opsStatus });
      void qc.invalidateQueries({ queryKey: qk.opsEventsAll });
    },
    typing: (p) => useTypingStore.getState().note(p),
    "system.notice": ({ level, message }) => {
      const opts = { duration: NOTICE_DURATION_MS[level] };
      if (level === "info") toast.info(message, opts);
      else if (level === "warn") toast.warning(message, opts);
      else toast.error(message, opts);
    },
  };

  const onConnect = () => {
    clearTimeout(retryTimer);
    retryAttempt = 0;
    setStatus("connected");
    // 처음 붙을 때도 — 연결 전에 들어간 채널은 enter 가 보내지 않고 기억만 한다
    void subscriptions.resubscribeAll().catch(() => undefined);

    // 다시 붙으면 끊긴 사이 놓친 adapter.status·ops.event 를 메운다 — 서버는 접속 때 상태를 보내지 않는다(재검증 N1).
    // 떠 있는 쿼리만 다시 부른다: member 의 ops 쿼리는 관찰자가 없거나 꺼져 있어(owner 만 켠다) 요청이 나가지 않는다
    if (connectedOnce) {
      void qc.invalidateQueries({ queryKey: qk.adapter });
      void qc.invalidateQueries({ queryKey: qk.opsStatus });
      void qc.invalidateQueries({ queryKey: qk.opsEventsAll });
    }
    connectedOnce = true;
  };
  const onDisconnect = (reason: string) => {
    if (STOPPED.has(useWireStatus.getState().status)) return;
    setStatus(reason === "io client disconnect" ? "offline" : "reconnecting");
    // 서버가 끊은 소켓은 socket.io 가 다시 붙지 않는다. 세션이 폐기됐으면 다시 붙을 때 UNAUTHORIZED → verifySession
    if (reason === "io server disconnect") retryLater();
  };
  const onConnectError = (err: Error) => {
    const code = (err as Error & { data?: { code?: unknown } }).data?.code;
    if (code === "PROTOCOL_MISMATCH") {
      setStatus("protocol_mismatch");
      socket.disconnect();
      return;
    }
    if (code === "UNAUTHORIZED") {
      void verifySession();
      return;
    }
    setStatus("reconnecting");
    // 전송 실패는 socket.io 가 다시 붙는다(active). 미들웨어 거절은 소켓을 닫으므로 직접 다시 붙는다
    if (!socket.active) retryLater();
  };

  const entries = Object.entries(on) as Array<[keyof ServerToClientEvents, (...args: never[]) => void]>;
  // socket.io 의 이벤트 이름·리스너 제네릭은 표에서 좁혀지지 않는다 — 위 표가 ServerToClientEvents 로 타입을 맞춘다
  const untyped = socket as unknown as {
    on(e: string, fn: (...args: never[]) => void): void;
    off(e: string, fn: (...args: never[]) => void): void;
  };
  for (const [event, fn] of entries) untyped.on(event, fn);
  socket.on("connect", onConnect);
  socket.on("disconnect", onDisconnect);
  socket.on("connect_error", onConnectError);

  return () => {
    detached = true;
    clearTimeout(retryTimer);
    for (const [event, fn] of entries) untyped.off(event, fn);
    socket.off("connect", onConnect);
    socket.off("disconnect", onDisconnect);
    socket.off("connect_error", onConnectError);
  };
}
