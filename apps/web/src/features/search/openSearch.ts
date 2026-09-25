import { createContext, useContext } from "react";

/** 검색 대화상자를 연다 — 앱 셸(`AppShell`)이 준다. 셸 밖에서는 아무것도 하지 않는다 */
export const OpenSearchContext = createContext<() => void>(() => {});
export const useOpenSearch = (): (() => void) => useContext(OpenSearchContext);

/** `⌘K`(macOS)·`Ctrl+K` — 다른 수식 키가 섞이면 아니다 */
export const isSearchShortcut = (e: KeyboardEvent): boolean =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
