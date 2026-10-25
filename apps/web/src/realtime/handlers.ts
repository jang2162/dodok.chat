import {
  type AdapterStatus,
  type Agent,
  type Channel,
  type Message,
  type OpenClawGatewayStatus,
  type OpsStatus,
  type ServerToClientEvents,
  UnreadSnapshot,
} from "@dodok/shared";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiRequestError, api } from "@/api/http";
import { type AdapterStatusResponse, type MeResponse, meQuery, qk } from "@/api/queries";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { canDecideApproval } from "@/features/approvals/decider";
import { forgetApproval, notifyApproval } from "@/features/approvals/notify";
import { applyChannel, isChannelArchived } from "@/features/channels/archived";
import { hasChannelGap, noteSeq, type Timeline, upsert } from "@/features/messages/timeline";
import { isViewingAtEnd, needsResync, useUnread } from "@/features/reads/useUnread";
import { useRunStore } from "@/features/runs/runStore";
import type { Subscriptions } from "./subscriptions";
import { getChannelSeq, noteChannelSeq, patchTimeline, updateThread } from "./timelineCache";
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

/** 에이전트 줄이 보이는 Gateway 의 얼굴(id·이름) — 순서가 달라도 같은 집합이면 같다 */
const gatewayNames = (gateways: readonly OpenClawGatewayStatus[]) =>
  gateways
    .map((g) => `${g.id}:${g.name}`)
    .sort()
    .join("\n");

/** 재연결을 멈춘 상태 — 끊김·전송 실패가 덮어쓰지 않는다 */
const STOPPED: ReadonlySet<WireStatus> = new Set(["protocol_mismatch", "rejected"]);

/**
 * 승인 알림이 쓰는 화면 사정(설계 5.4). 라우터를 realtime 안으로 들이지 않으려고 주입받는다 —
 * 앱 하나에 하나이고 정체성이 고정돼야 한다(`createApp()` 의 것)
 */
export type NotifyTarget = {
  /** 지금 보고 있는 채널 */
  currentChannelId(): string | undefined;
  /** 지금 보고 있는 세션 — 승인 카드는 그 세션에서만 보인다(채널 세션 계획 판정 PS7) */
  currentConversationId(): string | undefined;
  /** 알림을 눌렀을 때 — 그 승인의 세션 활동 탭 */
  openActivity(channelId: string, conversationId: string): void;
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
  /** 마지막으로 보낸 현황 요청 — 끊김·다시 요청 뒤에 늦게 온 응답을 버린다 */
  let unreadRequest = 0;

  /**
   * 새 메시지·수정(채널 세션 계획 판정 PS6). 구독한 적 없는 채널(커서 없음)은 무시, 커서 뒤로 빈틈이면 넣지 않고 커서로 이어 받는다
   * (스펙 4.3-3·4). 채널 룸 하나로 모든 세션의 루트와 스레드 답글이 온다 — 커서는 어느 세션의 글이든 올리고, 글은 **그 세션**의
   * 캐시에만 넣는다(받은 적 없는 세션은 버린다 — 열 때 REST 로 받는다). 세션 타임라인은 루트만, 답글은 seq 만 기록하고 연 스레드의
   * 캐시에 넣는다. 루트의 바뀐 요약(`threadSummary`)은 서버가 루트 `message.updated` 로 따로 보낸다
   */
  function applyMessage({ message: m }: MessageEvent, updated: boolean): void {
    const seen = getChannelSeq(qc, m.channelId);
    if (seen === undefined) return;
    const { channelId, conversationId } = m;
    const rootId = m.threadRootId;
    // 이미 지난 seq 의 수정 — 빈틈을 볼 일이 없다
    const stale = updated && m.seq <= seen;
    if (!stale && hasChannelGap(seen, m)) {
      void subscriptions.catchUp(channelId).catch(() => undefined);
      return;
    }
    if (!stale) noteChannelSeq(qc, channelId, m.seq);
    if (rootId !== undefined) {
      if (!stale) patchTimeline(qc, channelId, conversationId, (prev) => noteSeq(prev, m.seq));
      updateThread(qc, channelId, conversationId, rootId, (prev) =>
        keeps(prev, m, updated) ? upsert(prev, m) : prev,
      );
      return;
    }
    // 연 스레드의 루트는 적재 범위와 상관없이 늘 맞춘다(패널 맨 위에 늘 있다)
    updateThread(qc, channelId, conversationId, m.id, (prev) => upsert(prev, m));
    // 적재 범위 밖(더 옛것)의 수정은 넣지 않는다 — 과거 페이지(beforeSeq)가 가장 옛 seq 를 기준으로 삼는다. 받는 중인 첫 페이지에
    // 다시 적용될 때도 같은 규칙이다(`patchTimeline`)
    patchTimeline(qc, channelId, conversationId, (prev) =>
      stale && !prev.items.some((x) => x.id === m.id) ? prev : upsert(prev, m),
    );
  }

  /** 스레드 캐시에 넣을 답글인가 — 수정이면 가진 것이거나 적재 범위(가장 옛 답글) 안일 때만 */
  function keeps(thread: Timeline, m: Message, updated: boolean): boolean {
    if (!updated || !thread.hasOlder || thread.items.some((x) => x.id === m.id)) return true;
    const oldestReply = thread.items.find((x) => x.threadRootId !== undefined);
    return oldestReply !== undefined && m.seq > oldestReply.seq;
  }

  /**
   * 읽지 않음 현황(`GET /me/unread`)을 받아 통째로 갈아 끼운다 — 붙을 때마다, 그리고 보관 상태가 현황과 어긋날 때.
   * 실패하면 굵게·배지를 끈다(토스트 없음 — 틀린 배지보다 없는 배지). 다음 연결이 다시 받는다
   */
  async function loadUnread(): Promise<void> {
    const request = ++unreadRequest;
    const current = () => request === unreadRequest && !detached;
    useUnread.getState().beginSnapshot();
    let snapshot: UnreadSnapshot;
    try {
      snapshot = UnreadSnapshot.parse(await api<unknown>("GET", "/me/unread"));
    } catch (e) {
      if (!current()) return;
      useUnread.getState().failSnapshot();
      if (e instanceof ApiRequestError && e.status === 401) onUnauthorized();
      return;
    }
    if (current()) useUnread.getState().applySnapshot(snapshot);
  }

  /** 사이드바 목록(보관하지 않은 채널)에 있는가 — 읽지 않음 항목을 새로 만드는 것은 이 채널만 */
  const listed = (channelId: string) =>
    qc.getQueryData<Channel[]>(qk.channels)?.some((c) => c.id === channelId && !isChannelArchived(c)) ??
    false;

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
      // 결정할 수 있는 사람에게만 — 카드 버튼과 같은 규칙(`canDecideApproval`). 다른 사람은 카드만 본다
      if (!canDecideApproval(approval, qc.getQueryData<MeResponse>(qk.me))) return;
      notifyApproval(approval, {
        visible: document.visibilityState === "visible",
        currentConversationId: notify.currentConversationId(),
        onClick: () => notify.openActivity(approval.channelId, approval.conversationId),
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
    /**
     * 워크스페이스 방으로 온다 — 구독하지 않은 채널도. 보관하면 사이드바에서 빠지고 열린 화면은 상세 캐시로 읽기 전용이 된다(`applyChannel`)
     */
    "channel.updated": ({ channel }) => {
      applyChannel(qc, channel);
      // 보관하면 현황에서 빠지고, 보관 해제하면 그동안의 읽음 위치 그대로 돌아와야 한다 — 스냅숏이 그렇게 싣는다
      if (needsResync(channel)) void loadUnread();
    },
    "channel.member.changed": ({ channelId, members }) => qc.setQueryData(qk.members(channelId), members),
    /**
     * 에이전트가 바뀌었다(등록·수정·옮기기·보관·되살리기 — 본문 없음, 계획 판정 PS4). 목록과 채널 멤버를 다시 받게 낡은 것으로 둔다 —
     * 보관·되살리기는 서버가 channel.member.changed 를 내지 않는다(멤버 응답이 읽을 때 거른다). exact: 찾기 목록도 [agents] 아래라
     * 고르는 중인 등록 대화상자를 다시 부르지 않게(adapter.status 와 같은 까닭)
     */
    "agents.changed": () => {
      void qc.invalidateQueries({ queryKey: qk.agents, exact: true });
      void qc.invalidateQueries({ queryKey: qk.membersAll });
    },
    /**
     * 사람 목록(가입·역할·표시 이름·비활성화·다시 활성화 뒤 전체) — 통째로 바꾼다. 내 역할이 바뀌었으면 me 를 다시 받는다: 역할의
     * 정본은 `/auth/me` 이고(팀 스펙 6장) 관리 화면은 그것을 본다. 비활성화됐으면(role 은 남는다) 서버가 소켓을 끊고 다음 REST 가 401 이다.
     * 멤버 표·대기 초대(가입은 초대를 쓰고, 강등·비활성화는 링크를 폐기한다)는 낡은 것으로 둔다 — 보고 있는 화면만 다시 부른다
     */
    "people.changed": ({ people }) => {
      qc.setQueryData(qk.people, people);
      void qc.invalidateQueries({ queryKey: qk.team });
      const me = qc.getQueryData<MeResponse>(qk.me);
      const mine = me && people.find((p) => p.id === me.user.id);
      if (mine?.role !== undefined && mine.role !== me?.role)
        void qc.fetchQuery({ ...meQuery, staleTime: 0 }).catch(() => undefined);
    },
    // 어댑터마다 따로 온다(러너 계획 판정 P7) — 연결 점·배너가 보는 캐시는 OpenClaw 의 것만, 러너 줄은 운영 화면 캐시에.
    // 모르는 제공자는 무시한다
    "adapter.status": (status: AdapterStatus) => {
      if (status.provider === "openclaw") {
        const prev = qc.getQueryData<AdapterStatusResponse>(qk.adapter);
        qc.setQueryData<AdapterStatusResponse>(qk.adapter, (prev) => prev && { ...prev, ...status });
        // 에이전트 줄·멘션 후보는 Gateway 이름을 에이전트 목록(`Agent.gateway`)에서 읽는다 — 다른 탭에서 Gateway 를 지우거나
        // 이름을 바꾸면 그 목록을 다시 받아야 「Gateway 가 삭제됨」·새 이름이 보인다. exact: 찾기 목록도 [agents] 아래라,
        // 지운 Gateway 의 찾기를 다시 부르면 404 가 난다
        if (prev && gatewayNames(prev.gateways) !== gatewayNames(status.gateways))
          void qc.invalidateQueries({ queryKey: qk.agents, exact: true });
      } else if (status.provider === "claude") {
        qc.setQueryData(qk.runnerAdapter, status.runners);
        // 등록 대화상자가 열린 채 러너가 붙거나 떨어져도 그 목록이 낡지 않게
        void qc.invalidateQueries({ queryKey: qk.discoverOf("claude") });
      }
    },
    /**
     * 연결 설정 상태(owner 에게만 온다) — 통째로 바꾼다. 토큰 목록의 「지금 접속 중」·마지막 사용은 목록 응답에 있어
     * 다시 받게 낡은 것으로 둔다(보고 있는 화면만 곧바로 다시 부른다)
     */
    "setup.status": ({ status }) => {
      qc.setQueryData(qk.setupStatus, status);
      // 상태에 남은 Gateway 의 토큰 목록만 — 지워진 Gateway 의 카드가 아직 붙어 있는 틈에 다시 부르면 404 가 전역 토스트로 뜬다
      const live = new Set(status.gateways.map((g) => g.id));
      void qc.invalidateQueries({
        queryKey: qk.bridgeTokens,
        predicate: (q) => live.has(String(q.queryKey[qk.bridgeTokens.length])),
      });
      void qc.invalidateQueries({ queryKey: qk.runnerTokens });
      // 러너 토큰 수는 발급·폐기 때 wire adapter.status 로 바로 안 나갈 수 있다 — 상태가 바뀌면 러너 줄도 다시 받는다
      void qc.invalidateQueries({ queryKey: qk.runnerAdapter });
    },
    /**
     * 운영 사건(owner·admin 에게만 온다) — 배지가 읽는 상태의 `unacked` 는 곧바로 덮는다(상태를 아직 안 받았으면 만들지 않는다).
     * 상태의 나머지 칸(디스크·버전·런 수)도 사건과 함께 바뀌었을 수 있어 상태와 사건 목록은 낡은 것으로 둔다 —
     * 보고 있는 화면만 곧바로 다시 부른다(브라우저 검증 D1)
     */
    "ops.event": ({ unacked }) => {
      qc.setQueryData<OpsStatus>(qk.opsStatus, (prev) => prev && { ...prev, unacked });
      void qc.invalidateQueries({ queryKey: qk.opsStatus });
      void qc.invalidateQueries({ queryKey: qk.opsEventsAll });
    },
    /**
     * 다른 채널의 새 글(본문 없음, 워크스페이스 방) — 보는 채널만 구독하므로 사이드바는 이것으로 안다. 보고 있는 채널의 끝이
     * 보이면 더하지 않는다(읽음 전송이 맡는다)
     */
    "channel.activity": (activity) =>
      useUnread.getState().applyActivity(activity, {
        me: qc.getQueryData<MeResponse>(qk.me)?.user.id,
        viewing: subscriptions.active(),
        atEnd: isViewingAtEnd(activity.channelId),
        listed: listed(activity.channelId),
      }),
    /** 이 사람의 읽음 위치가 올랐다(user 방) — 이 탭이 보낸 것도, 다른 기기·가려진 탭이 보낸 것도 여기로 온다 */
    "channel.read": (update) => useUnread.getState().applyRead(update, { listed: listed(update.channelId) }),
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
    // 끊긴 사이 놓친 activity 는 더해 갈 수 없다 — 통째로 다시 받는다
    void loadUnread();

    // 다시 붙으면 끊긴 사이 놓친 adapter.status·ops.event 를 메운다 — 서버는 접속 때 상태를 보내지 않는다(재검증 N1).
    // 떠 있는 쿼리만 다시 부른다: member 의 ops 쿼리는 관찰자가 없거나 꺼져 있어(owner 만 켠다) 요청이 나가지 않는다
    if (connectedOnce) {
      void qc.invalidateQueries({ queryKey: qk.adapter });
      // 에이전트 줄·멘션 후보의 Gateway 이름은 adapter.status 처리기만 고친다 — 재연결은 그 처리를 거치지 않아 끊긴 사이
      // 이름 바꾸기·지우기를 놓친다(재리뷰 N2). exact: [agents] 아래 찾기 목록까지 다시 부르면 지운 Gateway 가 404 다
      void qc.invalidateQueries({ queryKey: qk.agents, exact: true });
      void qc.invalidateQueries({ queryKey: qk.opsStatus });
      void qc.invalidateQueries({ queryKey: qk.opsEventsAll });
    }
    connectedOnce = true;
  };
  const onDisconnect = (reason: string) => {
    // 끊긴 동안 오는 activity 가 없다 — 낡아 갈 숫자를 그리지 않는다. 나가 있던 현황 요청의 응답도 버린다
    unreadRequest += 1;
    useUnread.getState().failSnapshot();
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
