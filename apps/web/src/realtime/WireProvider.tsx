import { Id, type PresenceUpdate } from "@dodok/shared";
import { notifyManager, type QueryClient, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ApiRequestError } from "@/api/http";
import { type MeResponse, qk, useMe } from "@/api/queries";
import { registerSessionReset, resetClientState } from "@/app/session";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { resetApprovalNotices } from "@/features/approvals/notify";
import { useRunStore } from "@/features/runs/runStore";
import { dropLocalPush, syncPushSubscription } from "@/pwa/push";
import { attachHandlers, type NotifyTarget } from "./handlers";
import { createSubscriptions, type Subscriptions } from "./subscriptions";
import { createWireSocket, useWireStatus, type WireSocket } from "./wire";

/** 승인 알림의 화면 사정 + 채널 이동 알림(presence) — `createApp()` 이 라우터로 만든다 */
export type AppNotifyTarget = NotifyTarget & {
  /** 경로가 바뀔 때마다 부른다. 해제 함수를 돌려준다 */
  onLocationChange?(fn: () => void): () => void;
};

type WireRuntime = { socket: WireSocket | undefined; subscriptions: Subscriptions | undefined };
const NONE: WireRuntime = { socket: undefined, subscriptions: undefined };
const WireContext = createContext<WireRuntime>(NONE);

/**
 * 로그인 여부 = me 캐시에 값이 있는가. `useMe().isSuccess` 만 보면 안 된다 — 세션 정리의 `queryClient.clear()` 는
 * 관찰자에게 알리지 않아, 로그아웃 뒤에도 성공으로 남고 다시 로그인해도 소켓을 새로 만들지 못한다.
 * 캐시 알림은 `batchCalls` 로 미룬다 — 렌더 중 `useQuery` 가 쿼리를 새로 만들면 캐시가 곧바로 알리는데,
 * 그 자리에서 받으면 렌더 도중 갱신이 된다(React 경고). Query 의 훅들도 같은 방식으로 구독한다
 */
function useSignedIn(qc: QueryClient): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const notify = notifyManager.batchCalls(onChange);
      return qc.getQueryCache().subscribe((e) => {
        if (e.query.queryKey[0] === qk.me[0]) notify();
      });
    },
    [qc],
  );
  return useSyncExternalStore(subscribe, () => qc.getQueryData(qk.me) !== undefined);
}

/**
 * 로그인이 확인되면 wire 소켓을 만들어 붙인다(스펙 3.3·4.2). `onUnauthorized` 는 정체성이 고정된 함수여야 한다
 * (`createApp()` 의 것) — 렌더마다 새 함수면 소켓을 다시 만든다.
 */
export function WireProvider({
  children,
  onUnauthorized,
  notify,
}: {
  children: ReactNode;
  onUnauthorized: () => void;
  /** 승인 알림이 쓰는 화면 사정(설계 5.4)·채널 이동 — `createApp()` 이 만든, 정체성이 고정된 것 */
  notify: AppNotifyTarget;
}) {
  const qc = useQueryClient();
  const me = useMe(); // 가드·로그인 화면과 같은 me 쿼리 — 없으면 불러 둔다
  const signedIn = useSignedIn(qc);
  const [runtime, setRuntime] = useState<WireRuntime>(NONE);
  // 세션 없이 앱을 열었다(만료 뒤 사본 없이 로그인 화면) — 값이 없는 me 의 401 은 세션 정리로 오지 않으므로 여기서
  // 기기 구독을 해지한다(사본이 있는 경로와 같게). 401 만 — 네트워크 오류·5xx·오프라인은 일시적일 수 있다
  const sessionGone = !signedIn && me.error instanceof ApiRequestError && me.error.status === 401;

  useEffect(() => {
    if (sessionGone) void dropLocalPush();
  }, [sessionGone]);

  useEffect(() => {
    if (!signedIn) return;
    const socket = createWireSocket();
    const subscriptions = createSubscriptions({ socket, queryClient: qc });
    const detach = attachHandlers(socket, {
      queryClient: qc,
      subscriptions,
      notify,
      // 겹쳐 불려도 멱등이다 — onUnauthorized(createApp)도 resetClientState 를 부른다
      onUnauthorized: () => {
        resetClientState(qc);
        onUnauthorized();
      },
    });
    const detachPresence = attachPresence(socket, notify);
    const unregister = registerSessionReset(() => {
      // 세션이 끝났다(로그아웃은 그 전에 서버 해지까지 마쳤다 — useLogout). 401 이면 서버에 물을 수 없으니 기기 구독만
      // 해지한다 — 다음에 이 브라우저를 쓰는 사람에게 앞 사람의 알림이 오지 않게(Review Focus 1)
      void dropLocalPush();
      socket.disconnect();
      useRunStore.getState().reset();
      useApprovalStore.getState().reset();
      // 이미 알린 승인 기록도 — 다른 사람으로 다시 로그인하면 같은 승인을 다시 알려야 한다
      resetApprovalNotices();
      useWireStatus.getState().setStatus("idle");
    });
    useWireStatus.getState().setStatus("connecting");
    socket.connect();
    setRuntime({ socket, subscriptions });
    // 앱을 열 때(로그인 상태) 한 번 — 이 사람이 켠 구독이면 다시 등록한다(스펙 5.1)
    const me = qc.getQueryData<MeResponse>(qk.me);
    if (me) void syncPushSubscription(me.user.id);
    return () => {
      detachPresence();
      unregister();
      detach();
      socket.disconnect();
      useWireStatus.getState().setStatus("idle");
      setRuntime(NONE);
    };
  }, [signedIn, qc, onUnauthorized, notify]);

  return <WireContext.Provider value={runtime}>{children}</WireContext.Provider>;
}

/**
 * `presence.update`(스펙 5.3) — 서버가 「그 채널을 보고 있으면」 푸시를 거른다. 연결될 때마다(서버는 끊긴 소켓의 상태를
 * 지운다), `visibilitychange`·채널 이동 때 보낸다. 끊겨 있거나 지난번과 같은 값이면 보내지 않는다.
 * `pagehide`(탭 닫기·다른 주소로 이동)에서는 지난번과 같아도 「안 보임」을 보낸다 — 끊기기 직전 마지막 값이 되게.
 * 이때 `visibilityState` 는 아직 "visible" 이라 값을 덮어 쓴다. Chromium 은 pagehide 뒤 소켓이 살아 있는 동안
 * `visibilitychange` hidden 도 와서 측정상 결과가 같다(p4-c1) — 언로드 때 그것이 오지 않는 엔진 대비다.
 * 채널 id 는 uuid 일 때만 싣는다 — 서버 스키마가 거르는 값을 보내지 않게
 */
function attachPresence(socket: WireSocket, notify: AppNotifyTarget): () => void {
  let last: string | undefined;
  const current = (): PresenceUpdate => {
    const channelId = notify.currentChannelId();
    return {
      visible: document.visibilityState === "visible",
      ...(Id.safeParse(channelId).success ? { channelId } : {}),
    };
  };
  const send = (force: boolean, hidden = false) => {
    if (!socket.connected) {
      last = undefined;
      return;
    }
    const p = hidden ? { ...current(), visible: false } : current();
    const key = JSON.stringify(p);
    if (!force && key === last) return;
    last = key;
    socket.emit("presence.update", p);
  };
  const onConnect = () => send(true);
  const onChange = () => send(false);
  const onPageHide = () => send(true, true);
  socket.on("connect", onConnect);
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("pagehide", onPageHide);
  const unwatch = notify.onLocationChange?.(onChange);
  return () => {
    socket.off("connect", onConnect);
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("pagehide", onPageHide);
    unwatch?.();
  };
}

export const useWire = (): WireRuntime => useContext(WireContext);

/** 채널 화면이 떠 있는 동안 구독한다(스펙 4.3-1·5). 소켓이 생기거나 채널이 바뀌면 다시 들어간다 */
export function useChannelSubscription(channelId: string): void {
  const { subscriptions } = useWire();
  useEffect(() => {
    if (!subscriptions) return;
    // 실패(시간 초과 등)는 다음 재연결의 resubscribeAll 이 다시 맞춘다
    void subscriptions.enter(channelId).catch(() => undefined);
    return () => subscriptions.leave(channelId);
  }, [subscriptions, channelId]);
}
