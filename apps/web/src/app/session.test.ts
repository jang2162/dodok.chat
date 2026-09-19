import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { notifyUnauthorized, registerSessionReset, registerUnauthorized, resetClientState } from "./session";

it("resetClientState 는 등록된 정리를 부르고 Query 캐시를 비운다 — 해제한 정리는 부르지 않는다", () => {
  const qc = new QueryClient();
  qc.setQueryData(["channels"], []);
  const kept = vi.fn();
  const removed = vi.fn();
  const unregisterKept = registerSessionReset(kept);
  const unregisterRemoved = registerSessionReset(removed);
  unregisterRemoved();

  resetClientState(qc);

  expect(kept).toHaveBeenCalledTimes(1);
  expect(removed).not.toHaveBeenCalled();
  expect(qc.getQueryData(["channels"])).toBeUndefined();
  unregisterKept();
});

it("notifyUnauthorized 는 등록된 401 처리를 부른다 — 해제한 것은 부르지 않는다", () => {
  const kept = vi.fn();
  const removed = vi.fn();
  const unregisterKept = registerUnauthorized(kept);
  registerUnauthorized(removed)();

  notifyUnauthorized();

  expect(kept).toHaveBeenCalledTimes(1);
  expect(removed).not.toHaveBeenCalled();
  unregisterKept();
});
