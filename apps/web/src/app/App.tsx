import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { WireProvider } from "@/realtime/WireProvider";
import { Toaster } from "@/ui/sonner";
import { TooltipProvider } from "@/ui/tooltip";
import { type AppClient, createApp } from "./createApp";
import { usePreventFileDrop } from "./fileDrop";
import { registerUnauthorized } from "./session";

/** `app` 은 테스트가 메모리 히스토리로 만든 것을 넘길 때만 — 없으면 브라우저 히스토리로 한 번 만든다 */
export function App({ app }: { app?: AppClient }) {
  const [{ queryClient, router, onUnauthorized }] = useState(() => app ?? createApp());
  // Query 밖 REST 401(과거 페이지·빈틈 이어 받기)도 같은 곳으로. createApp 이 아니라 여기서 마운트 동안만 등록한다 —
  // StrictMode 가 useState 초기화를 두 번 불러 버려지는 앱이 남지 않게
  useEffect(() => registerUnauthorized(onUnauthorized), [onUnauthorized]);
  usePreventFileDrop();
  return (
    <QueryClientProvider client={queryClient}>
      {/* wire `UNAUTHORIZED` 도 REST 401 과 같은 곳으로(next·「이미 /login 이면 생략」) — 정체성이 고정된 함수다 */}
      <WireProvider onUnauthorized={onUnauthorized}>
        {/* shadcn Tooltip 은 스스로 Provider 를 두지 않는다 — 앱 루트에 하나 */}
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </WireProvider>
    </QueryClientProvider>
  );
}
