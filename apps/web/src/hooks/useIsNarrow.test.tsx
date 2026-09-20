import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { stubMedia } from "../../test/media";
import { useIsNarrow } from "./useIsNarrow";

afterEach(() => vi.restoreAllMocks());

it("폭이 바뀌면(matchMedia change) 다시 그린다 — 내려가면 구독을 푼다", () => {
  const media = stubMedia(false);
  const { result, unmount } = renderHook(() => useIsNarrow());
  expect(result.current).toBe(false);
  expect(media.listeners()).toBe(1);

  media.setNarrow(true);
  expect(result.current).toBe(true);
  media.setNarrow(false);
  expect(result.current).toBe(false);

  unmount();
  expect(media.listeners()).toBe(0);
});
