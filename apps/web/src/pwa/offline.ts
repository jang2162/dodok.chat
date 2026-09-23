import { notifyManager, onlineManager, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { NetworkError } from "@/api/http";
import { qk } from "@/api/queries";
import { useWireStatus } from "@/realtime/wire";

/**
 * 오프라인인가(스펙 4장) — 브라우저가 오프라인이거나, me 가 값을 가진 채(사본·앞선 로그인) 네트워크 오류로 끝났다.
 * 브라우저 값은 onlineManager 의 online·offline 이벤트로 다시 읽는다(Query 가 요청을 쉬는 기준과 같다). 다만 오프라인으로
 * 시작하면 이벤트가 없어 onlineManager 는 온라인이라 여기므로 `navigator.onLine` 도 본다.
 * 서버만 내려갔다 돌아오면(브라우저는 줄곧 온라인) 다시 부를 계기가 없다 — wire 가 다시 붙으면 me 를 다시 불러
 * 배너를 내리고 세션을 확인한다(401 이면 queryClient 가 지우고 로그인으로)
 */
export function useOffline(): boolean {
  const qc = useQueryClient();
  const browserOffline = useSyncExternalStore(
    (onChange) => onlineManager.subscribe(onChange),
    () => !navigator.onLine || !onlineManager.isOnline(),
  );
  const meDown = useMeDown(qc);
  const wireUp = useWireStatus((s) => s.status === "connected");
  useEffect(() => {
    if (meDown && wireUp) void qc.refetchQueries({ queryKey: qk.me, exact: true }, { cancelRefetch: false });
  }, [meDown, wireUp, qc]);
  return browserOffline || meDown;
}

/**
 * me 가 값을 가진 채 네트워크 오류인가 — 관찰자(useQuery)를 두지 않고 캐시만 구독한다. 관찰자는 세션 정리
 * (`queryClient.clear()`) 뒤 다시 그려질 때 me 를 새로 만들어 불러오므로, 로그인 화면으로 가는 길에 「이미 로그인」을
 * 만들어 되돌아간다. 캐시 알림은 WireProvider 의 useSignedIn 처럼 `batchCalls` 로 미룬다
 */
function useMeDown(qc: QueryClient): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const notify = notifyManager.batchCalls(onChange);
      return qc.getQueryCache().subscribe((e) => {
        if (e.query.queryKey[0] === qk.me[0]) notify();
      });
    },
    [qc],
  );
  return useSyncExternalStore(subscribe, () => {
    const state = qc.getQueryState(qk.me);
    return state?.data !== undefined && state.error instanceof NetworkError;
  });
}
