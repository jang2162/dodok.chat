import { createContext, useContext } from "react";

/** 검색 대화상자를 연다 — 앱 셸(`AppShell`)이 준다. 셸 밖에서는 아무것도 하지 않는다 */
export const OpenSearchContext = createContext<() => void>(() => {});
export const useOpenSearch = (): (() => void) => useContext(OpenSearchContext);

/**
 * `⌘K`(macOS)·`Ctrl+K` — 다른 수식 키가 섞이면 아니다. 한글 입력기가 켜져 있으면 `key` 가 「k」 가 아닐 수 있어 물리 키
 * (`code`)도 본다
 */
export const isSearchShortcut = (e: KeyboardEvent): boolean =>
  (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key.toLowerCase() === "k" || e.code === "KeyK");

/** 검색 대화상자의 표지 — `otherModalOpen` 이 자기 자신은 세지 않게 */
export const SEARCH_DIALOG_ATTR = "data-search-dialog";

/**
 * 검색 말고 다른 모달(대화상자·시트)이 열려 있는가 — 열려 있으면 `⌘K` 를 무시한다(그 위에 겹쳐 열고 결과로 가면 밑의 모달이
 * 남는다). 앱의 모달은 모두 Radix Dialog 라 열린 동안 `role="dialog"`·`data-state="open"` 이다
 */
export const otherModalOpen = (): boolean =>
  [...document.querySelectorAll('[role="dialog"][data-state="open"]')].some(
    (el) => !el.hasAttribute(SEARCH_DIALOG_ATTR),
  );
