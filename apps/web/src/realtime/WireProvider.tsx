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
import { qk, useMe } from "@/api/queries";
import { registerSessionReset, resetClientState } from "@/app/session";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { useRunStore } from "@/features/runs/runStore";
import { attachHandlers } from "./handlers";
import { createSubscriptions, type Subscriptions } from "./subscriptions";
import { createWireSocket, useWireStatus, type WireSocket } from "./wire";

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
}: {
  children: ReactNode;
  onUnauthorized: () => void;
}) {
  const qc = useQueryClient();
  useMe(); // 가드·로그인 화면과 같은 me 쿼리 — 없으면 불러 둔다
  const signedIn = useSignedIn(qc);
  const [runtime, setRuntime] = useState<WireRuntime>(NONE);

  useEffect(() => {
    if (!signedIn) return;
    const socket = createWireSocket();
    const subscriptions = createSubscriptions({ socket, queryClient: qc });
    const detach = attachHandlers(socket, {
      queryClient: qc,
      subscriptions,
      // 겹쳐 불려도 멱등이다 — onUnauthorized(createApp)도 resetClientState 를 부른다
      onUnauthorized: () => {
        resetClientState(qc);
        onUnauthorized();
      },
    });
    const unregister = registerSessionReset(() => {
      socket.disconnect();
      useRunStore.getState().reset();
      useApprovalStore.getState().reset();
      useWireStatus.getState().setStatus("idle");
    });
    useWireStatus.getState().setStatus("connecting");
    socket.connect();
    setRuntime({ socket, subscriptions });
    return () => {
      unregister();
      detach();
      socket.disconnect();
      useWireStatus.getState().setStatus("idle");
      setRuntime(NONE);
    };
  }, [signedIn, qc, onUnauthorized]);

  return <WireContext.Provider value={runtime}>{children}</WireContext.Provider>;
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
