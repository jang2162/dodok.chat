import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { type PendingActions, PendingActionsContext, usePendingActions } from "./pendingActions";

it("Provider 가 없으면 null — 있으면 그 값(태스크 9 가 ChannelPage 에서 넣는다)", () => {
  expect(renderHook(() => usePendingActions()).result.current).toBeNull();

  const actions: PendingActions = { retry: vi.fn(), discard: vi.fn() };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PendingActionsContext.Provider value={actions}>{children}</PendingActionsContext.Provider>
  );
  expect(renderHook(() => usePendingActions(), { wrapper }).result.current).toBe(actions);
});
