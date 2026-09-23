import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import { onlineManager } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { startPersistence } from "@/pwa/persist";
import { App } from "./App";
import type { AppClient } from "./createApp";
import { registerSessionReset } from "./session";

/**
 * 앱을 띄우는 배선(main.tsx 와 테스트가 같은 것을 부른다):
 * 1. Query 에 브라우저 온라인 여부를 알린다 — onlineManager 는 온라인으로 시작해 online·offline 이벤트로만 바뀌므로,
 *    오프라인으로 연 앱이 요청·재시도를 하고 「서버에 연결할 수 없습니다」 토스트를 낸다(p4-t4 리뷰 결함 2).
 *    알려 두면 요청을 쉬었다가 online 이벤트에 다시 부른다(me 재확인 포함)
 * 2. 오프라인 사본(스펙 4장)을 복원한다(최대 1초) — 그린 뒤에 복원하면 첫 화면이 사본 없이 me 를 기다린다
 * 3. 로그아웃·401(`resetClientState`)이 사본을 지우게 건다
 * 4. 같은 queryClient 로 그린다
 * 돌려준 함수는 저장·등록을 푼다(테스트용)
 */
export async function bootApp(
  app: AppClient,
  opts: {
    buster: string;
    render: (el: ReactNode) => void;
    storage?: AsyncStorage<string>;
    throttleMs?: number;
  },
): Promise<() => void> {
  onlineManager.setOnline(navigator.onLine);
  const persistence = await startPersistence(app.queryClient, opts);
  const unregister = registerSessionReset(() => void persistence.clear());
  opts.render(<App app={app} />);
  return () => {
    unregister();
    persistence.stop();
  };
}
