import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { Toaster } from "@/ui/sonner";
import { TooltipProvider } from "@/ui/tooltip";
import { type AppClient, createApp } from "./createApp";

/** `app` 은 테스트가 메모리 히스토리로 만든 것을 넘길 때만 — 없으면 브라우저 히스토리로 한 번 만든다 */
export function App({ app }: { app?: AppClient }) {
  const [{ queryClient, router }] = useState(() => app ?? createApp());
  return (
    <QueryClientProvider client={queryClient}>
      {/* shadcn Tooltip 은 스스로 Provider 를 두지 않는다 — 앱 루트에 하나 */}
      <TooltipProvider>
        <RouterProvider router={router} />
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}
