import { Link, Navigate, Outlet, useRouterState } from "@tanstack/react-router";
import { useRef } from "react";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { SettingsFocusContext, useMarkSettingsFocus, useSettingsHeadingFocus } from "./focus";
import { SettingsNav } from "./SettingsNav";

/**
 * 넓은 화면 탭 내용 칸의 id — 탭을 옮기면 라우터가 이 칸을 맨 위로 돌린다(`scrollToTopSelectors`). 셸의 스크롤 상자는 이 칸을
 * 품기만 하고 스스로는 스크롤하지 않으므로, 이 목록에서 빠지면 앞 탭에서 내린 만큼 내려간 채로 다음 탭이 열린다
 */
export const SETTINGS_SCROLL_ID = "settings-scroll";

/** 탭 페이지가 머리 아래로 지나갈 때 가리는 바탕 — 머리는 스크롤해도 위에 붙어 있다 */
const NARROW_HEADER =
  "sticky top-0 z-10 flex h-12 shrink-0 items-center gap-1 border-b bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80";

/**
 * `/settings` 레이아웃(설정 통합 스펙 「레이아웃」 절, 계획 판정 PS5). 넓은 화면은 셸의 페이지 영역 안에서 왼쪽 탭 목록(고정) +
 * 오른쪽 탭 내용(따로 스크롤). 좁은 화면은 `/settings` 자체가 탭 목록 페이지(`SettingsIndex`)이고, 탭 페이지는 위에 붙는 머리에
 * 사이드바 메뉴 단추와 「← 설정」을 단다. 탭 페이지는 메뉴 단추를 그리지 않는다 — 이 머리가 그린다(메뉴 단추가 둘이면 시트가
 * 초점을 돌려줄 단추가 엇갈린다, sidebarSheet `SidebarTrigger`)
 */
export function SettingsLayout() {
  const narrow = useIsNarrow();
  const rendered = useRouterState({ select: (s) => s.matches.at(-1)?.pathname });
  const content = useRef<HTMLDivElement>(null);
  const markFocus = useSettingsHeadingFocus(content, rendered);
  const atIndex = rendered === "/settings" || rendered === "/settings/";

  return (
    <SettingsFocusContext.Provider value={markFocus}>
      {narrow ? (
        <div ref={content} data-testid="settings-content" className="flex flex-col [&_h1:focus]:outline-none">
          {!atIndex && (
            <div data-testid="settings-header" className={NARROW_HEADER}>
              <OpenSidebarButton />
              <BackLink />
            </div>
          )}
          <Outlet />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* 랜드마크는 nav 하나로 — aside 로 두면 셸의 사이드바(complementary)와 이름 없이 겹친다 */}
          <div className="w-52 shrink-0 overflow-y-auto border-r p-2">
            <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">설정</p>
            <SettingsNav />
          </div>
          <div
            ref={content}
            id={SETTINGS_SCROLL_ID}
            data-testid="settings-content"
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto [&_h1:focus]:outline-none"
          >
            <Outlet />
          </div>
        </div>
      )}
    </SettingsFocusContext.Provider>
  );
}

/** 좁은 화면 탭 페이지 머리의 「← 설정」 — 화살표는 그림이라 읽지 않는다 */
function BackLink() {
  const markFocus = useMarkSettingsFocus();
  return (
    <Link
      to="/settings"
      onClick={() => markFocus("/settings")}
      className="flex h-9 items-center gap-1 rounded-md px-2 text-sm font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span aria-hidden>←</span> 설정
    </Link>
  );
}

/**
 * `/settings` 자체 — 좁은 화면은 탭 목록 페이지, 넓은 화면은 탭 목록이 늘 옆에 있으니 「내 계정」으로 넘긴다(기록을 남기지 않게
 * replace — 뒤로 가기가 다시 넘겨지는 주소에 갇히지 않는다). 폭이 바뀌면 그 자리에서 다시 가른다
 */
export function SettingsIndex() {
  const narrow = useIsNarrow();
  if (!narrow) return <Navigate to="/settings/account" replace />;
  return (
    <section data-testid="page-settings" className="flex w-full flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <OpenSidebarButton />
        <h1 className="text-xl font-semibold">설정</h1>
      </header>
      <SettingsNav large />
    </section>
  );
}
