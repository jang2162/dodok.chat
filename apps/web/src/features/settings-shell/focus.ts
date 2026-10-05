import { type RefObject, createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * 설정 안에서 옮겨 갈 때(탭 목록·「← 설정」) 부른다 — 받은 경로가 그려지면 그 내용의 제목(`h1`)으로 초점을 옮긴다(설정 통합 스펙
 * 「레이아웃」 절). SettingsLayout 이 넣는다. 밖에서 들어오는 이동(사이드바·주소창·뒤로 가기)은 부르지 않는다 — 좁은 화면 시트가
 * 닫히며 메뉴 단추에 주는 초점(AppShell)을 뺏지 않게
 */
export const SettingsFocusContext = createContext<(to: string) => void>(() => {});
export const useMarkSettingsFocus = () => useContext(SettingsFocusContext);

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);

/**
 * `rendered` 는 지금 그려진 경로다 — 라우터의 matches 에서 읽어야 한다. `location` 은 이동이 시작될 때 바뀌어 아직 앞 화면이
 * 그려져 있을 수 있고, 그때 찾은 `h1` 은 앞 화면의 것이다. 제목이 늦게 붙으면(조각을 받는 중) 붙을 때까지 지켜본다
 */
export function useSettingsHeadingFocus(root: RefObject<HTMLElement | null>, rendered: string | undefined) {
  /** 기다리는 경로와 표시 — 지금 탭을 다시 눌렀으면 그려진 경로가 그대로라, 표시가 바뀌어야 효과가 다시 돈다 */
  const [pending, setPending] = useState<{ to: string } | undefined>();
  useEffect(() => {
    const el = root.current;
    if (pending === undefined || rendered === undefined || !el || trimSlash(rendered) !== pending.to) return;
    const tryFocus = () => {
      const heading = el.querySelector("h1");
      if (!heading) return false;
      setPending(undefined);
      // 제목은 초점 순서에 넣지 않는다 — 스크립트로만 받는다
      if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
      heading.focus();
      return true;
    };
    if (tryFocus()) return;
    const observer = new MutationObserver(() => {
      if (tryFocus()) observer.disconnect();
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [root, rendered, pending]);
  return useCallback((to: string) => setPending({ to: trimSlash(to) }), []);
}
