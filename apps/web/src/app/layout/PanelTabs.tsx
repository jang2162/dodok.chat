import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  ChevronRightIcon,
  FolderIcon,
  type LucideIcon,
  Maximize2Icon,
  MessagesSquareIcon,
  PanelRightIcon,
  SlidersHorizontalIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { otherModalOpen } from "@/features/search/openSearch";
import type { ThreadOpener } from "@/features/threads/threadOpener";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { ResizeHandle } from "./ResizeHandle";
import { OpenSidebarButton } from "./sidebarSheet";
import { PANEL, layoutStore, useLayoutWidths } from "./useLayoutWidths";

export type PanelTab = "settings" | "activity" | "files" | "thread" | "profile";

/**
 * 오른쪽 패널의 탭(설계 5.1). 순서가 화면 순서다.
 * `scroll` 은 틀이 세로 스크롤을 맡는가 — 활동·스레드 탭은 제 스크롤 영역을 따로 가진다(런 목록·타임라인, 메시지 목록).
 * 스레드 탭은 스레드를 연 동안에만 머리에 있다 — 어느 스레드인지(`rootId`)는 주소에서 온다(스레드·검색 스펙 4.2)
 */
const TABS = [
  {
    id: "settings",
    label: "설정",
    title: "채널 설정",
    to: "/c/$channelId/s/$conversationId/settings",
    scroll: true,
    icon: SlidersHorizontalIcon,
    badge: "새 항목",
  },
  {
    id: "activity",
    label: "활동",
    title: "활동",
    to: "/c/$channelId/s/$conversationId/activity",
    scroll: false,
    icon: ActivityIcon,
    badge: "승인 대기",
  },
  {
    id: "files",
    label: "파일",
    title: "파일",
    to: "/c/$channelId/s/$conversationId/files",
    scroll: true,
    icon: FolderIcon,
    badge: "새 항목",
  },
  {
    id: "thread",
    label: "스레드",
    title: "스레드",
    to: "/c/$channelId/s/$conversationId/t/$rootId",
    scroll: false,
    icon: MessagesSquareIcon,
    badge: "새 항목",
  },
  // 프로필은 연 동안에만 머리에 있다 — 누구의 것인지(`kind`·`id`)는 주소에서 온다(프로필 스펙 3.1)
  {
    id: "profile",
    label: "프로필",
    title: "프로필",
    to: "/c/$channelId/s/$conversationId/p/$kind/$id",
    scroll: true,
    icon: UserIcon,
    badge: "새 항목",
  },
] as const satisfies ReadonlyArray<{
  id: PanelTab;
  label: string;
  title: string;
  to: string;
  scroll: boolean;
  icon: LucideIcon;
  /** 머리 배지(`badges`)의 수가 무엇을 세는지 — 탭 이름 뒤에 붙는다(「활동, 승인 대기 2」) */
  badge: string;
}>;

const tabOf = (id: PanelTab) => TABS.find((t) => t.id === id) ?? TABS[0];

/**
 * 지금 열려 있는 패널 탭 — 없으면 패널을 그리지 않는다. 라우트가 아니라 **부모**(ChannelPage)가 틀을 그려야
 * 탭을 옮길 때 머리의 링크가 죽지 않는다(브라우저 검증 D3: 초점이 `<body>` 로 떨어지던 원인).
 * 이동이 끝난 자리로 본다 — 헤더의 설정 버튼(`ChannelHeader`)과 같은 눈이라 둘이 어긋나지 않는다.
 * 어느 채널의 주소인지는 보지 않는다: 채널을 옮기는 동안 한 틱 어긋나면 패널이 내려갔다 올라와
 * 고치던 초안과 열린 대화상자가 날아간다
 */
export function usePanelTab(): PanelTab | undefined {
  const matchRoute = useMatchRoute();
  // 채널 id 는 맞춰 보지 않는다 — 채널을 옮기는 동안 잠깐 어긋나 패널이 통째로 내려갔다 올라온다
  return TABS.find((t) => matchRoute({ to: t.to }))?.id;
}

/** 스레드를 메인 보기로 열 때 가운데 머리의 경로·돌아가기(UI 시안 06) — ChannelPage 가 준다 */
export type ThreadMain = {
  /** 경로 첫 칸 — 일반 채널은 「# 이름」, 사람 DM 은 그 제목 */
  channelLabel: string;
  sessionTitle?: string;
  /** ←·Esc — 세션으로 돌아가 원글 자리로 */
  onBack: () => void;
};

/**
 * 채널 오른쪽 패널의 바깥 틀(설계 5.1). 넓은 화면은 오른쪽 패널(기본 384px — 왼쪽 경계 손잡이로 320–720px, UI 시안 04), 좁은 화면(`useIsNarrow`)은 전체 화면 시트
 * (스펙 2.4). 머리는 한 줄 — 탭(세그먼트 꼴)과 닫기. 지금 탭의 제목은 보이지 않게 남겨 패널의 이름으로 쓴다(패널 재설계 스펙 목표 5).
 * 내용은 `children` — 설정 패널·활동 패널이 같은 틀을 쓴다.
 *
 * 라우트 컴포넌트(설정·활동)가 아니라 그 **부모**(ChannelPage)가 그린다 — 탭을 옮겨도 머리의 링크가
 * 언마운트되지 않아야 초점이 `<body>` 로 떨어지지 않는다(브라우저 검증 D3). 탭 내용만 `<Outlet/>` 으로 바뀐다.
 *
 * 폭이 바뀌면 담는 그릇(aside ↔ 시트)이 바뀌지만 내용은 **같은 자리에서 한 번만** 그린다 —
 * 늘 같은 `host` div 로 포털을 보내고, 그릇이 그 div 를 제 안으로 옮겨 붙인다. 그릇을 갈아 끼울 때 안쪽이
 * 다시 마운트되면 고치던 초안이 사라진다(web-t11 리뷰 Minor 7). `host` 는 `display:contents` 라
 * 자리를 차지하지 않는다 — 내용이 곧 스크롤 영역의 자식이다.
 *
 * 스레드 탭은 넓은 화면에서 **메인 보기**(`view="main"`, UI 시안 06)로도 연다 — 같은 host 를 가운데 칸으로 옮겨 붙이므로 스레드 작성기·
 * 스트리밍 버블·승인 카드가 다시 마운트되지 않는다(초안이 그대로). 그때 세션 화면은 ChannelPage 가 숨긴다
 */
export function PanelTabs({
  channelId,
  conversationId,
  rootId,
  profile,
  active,
  children,
  openerRef,
  threadOpenerRef,
  only,
  badges,
  view = "panel",
  main,
}: {
  channelId: string;
  /** 보고 있는 세션 — 탭을 옮기거나 닫아도 그 세션에 머문다(채널 머리·설정·활동은 채널 단위 그대로) */
  conversationId: string;
  /** 연 스레드의 루트(스레드 탭일 때) — 탭 머리의 「스레드」 링크가 쓴다 */
  rootId?: string;
  /** 연 프로필(프로필 탭일 때) — 탭 머리의 「프로필」 링크가 쓴다 */
  profile?: { kind: string; id: string };
  active: PanelTab;
  children: ReactNode;
  /** 패널을 여는 자리(헤더의 「채널 설정」) — 패널을 닫으면(좁은 화면 시트·넓은 화면 닫기 링크) 초점을 여기로 돌려준다(D14) */
  openerRef?: RefObject<HTMLAnchorElement | null>;
  /** 스레드를 연 자리(칩·「스레드에서 답하기」) — 스레드 탭을 닫으면 그 자리가 아직 화면에 있을 때 `openerRef` 대신 여기로 */
  threadOpenerRef?: RefObject<ThreadOpener | null>;
  /** 머리에 둘 탭(없으면 전부) — 에이전트 DM 은 설정·스레드가 없다(에이전트 DM 계획 판정 PD2) */
  only?: readonly PanelTab[];
  /** 탭 머리의 수(활동이면 승인 대기 수) — 0 이나 없음이면 그리지 않는다 */
  badges?: Partial<Record<PanelTab, number>>;
  /** 스레드 탭의 보기 — 주소의 `view=main` 이면 "main"(좁은 화면은 늘 시트) */
  view?: "panel" | "main";
  /** 메인 보기 머리 — 없으면 「크게 보기」를 그리지 않는다 */
  main?: ThreadMain;
}) {
  const narrow = useIsNarrow();
  const layout = useLayoutWidths();
  const mainMode =
    !narrow && active === "thread" && rootId !== undefined && main !== undefined && view === "main";
  // 넓은 화면에 오른쪽 패널이 그려져 있는가 — 사이드바가 가운데 최소 폭을 셀 때 쓴다(페인트 전에 알려 한 프레임 넘치지 않게)
  const panelShown = !narrow && !mainMode;
  useLayoutEffect(() => {
    layoutStore.setPanelOpen(panelShown);
    return () => layoutStore.setPanelOpen(false);
  }, [panelShown]);
  // 보기를 바꾸면 누른 단추가 사라진다 — 초점이 떨어졌으면 반대쪽 단추가 받는다(D3 와 같은 부류)
  const toggleRef = useRef<HTMLAnchorElement>(null);
  const wasMain = useRef(mainMode);
  useEffect(() => {
    if (wasMain.current === mainMode) return;
    wasMain.current = mainMode;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) toggleRef.current?.focus();
  }, [mainMode]);
  // 메인 보기의 Esc — 세션으로. 가운데 칸에 캡처 단계로 단다: 작성기 편집기(ProseMirror)는 빈 채여도 Esc 를 먹어(preventDefault)
  // 버블 단계에서는 받을 수 없다. 대신 먼저 Esc 를 써야 하는 것은 여기서 양보한다 — `@`·`/` 제안이 열린 편집기(후보 0개 포함),
  // 입력 칸(작성기의 사용자 지정 칸처럼 Esc 로 닫는 것), 다른 대화상자·시트. 메뉴는 포털이라 이 칸 밖에서 Esc 를 받는다.
  // 초점이 없을 때(body)는 문서 단계에서 — 열린 메뉴가 먼저 쓰면(Radix 가 preventDefault) 두고 간다
  const mainRef = useRef(main);
  mainRef.current = mainMode ? main : undefined;
  const mainSection = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const m = mainRef.current;
      if (!m || e.key !== "Escape" || e.defaultPrevented || otherModalOpen()) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select")) return;
      // 제안이 열린 편집기 — 후보가 0개면 목록(`aria-controls`)이 없으므로 suggestion 플러그인이 쿼리에 다는 장식으로도 본다.
      // 그 Esc 는 제안만 닫고, 닫힌 뒤의 Esc 에서 떠난다
      const box = target?.closest('[role="textbox"]');
      if (box?.hasAttribute("aria-controls") || box?.querySelector("[data-decoration-id]")) return;
      e.preventDefault();
      e.stopPropagation();
      m.onBack();
    };
    // 본문 글자를 눌러 초점이 아무 데도 없을 때(body)도 — 그때 키는 이 칸을 지나지 않는다
    const onBodyKey = (e: globalThis.KeyboardEvent) => {
      if (e.target === document.body) onKey(e);
    };
    el.addEventListener("keydown", onKey, true);
    document.addEventListener("keydown", onBodyKey);
    return () => {
      el.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keydown", onBodyKey);
    };
  }, []);
  const navigate = useNavigate();
  const titleId = useId();
  const tabsRef = useRef<HTMLElement>(null);
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = "contents";
    return el;
  });
  // 지금 그릇의 자리 — 붙을 때마다 host 를 그 안으로 옮긴다
  const slot = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && host.parentElement !== el) el.appendChild(host);
    },
    [host],
  );
  const body = createPortal(children, host);
  const tab = tabOf(active);
  // 다른 스레드가 열렸으면(주소·검색·푸시 — 칩이 적지 않는 길) 앞 스레드를 연 자리는 잊는다. 닫는 순간에는 비교하지 않는다:
  // 주소가 먼저 바뀌어 스레드 탭의 마지막 렌더에는 rootId 가 없다
  useEffect(() => {
    const t = threadOpenerRef?.current;
    if (threadOpenerRef && rootId !== undefined && t && t.rootId !== rootId) threadOpenerRef.current = null;
  }, [threadOpenerRef, rootId]);
  /**
   * 닫을 때 초점을 돌려줄 자리 — 이 스레드를 연 칩·버튼(스레드 탭, 아직 붙어 있을 때), 아니면 헤더의 「채널 설정」(D14).
   * 읽는 동시에 그 자리를 잊는다(m4) — 그래야 같은 스레드를 다음에 주소·검색·푸시로 다시 열었을 때 이번에 쓴 칩으로
   * 돌아가지 않는다. 닫을 때만 부르므로(아래 두 자리) 여기서 지워도 열려 있는 동안의 값은 그대로다
   */
  const returnTarget = (): HTMLElement | null | undefined => {
    if (active !== "thread") return openerRef?.current;
    const t = threadOpenerRef?.current;
    if (threadOpenerRef) threadOpenerRef.current = null;
    return t?.el.isConnected ? t.el : openerRef?.current;
  };
  const bodyClass = cn("min-h-0 flex-1", tab.scroll ? "overflow-y-auto" : "flex flex-col overflow-hidden");

  if (narrow) {
    return (
      <>
        {body}
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open)
              void navigate({ to: "/c/$channelId/s/$conversationId", params: { channelId, conversationId } });
          }}
        >
          <SheetContent
            side="right"
            data-testid="page-channel-panel"
            data-panel-tab={active}
            aria-describedby={undefined}
            className="w-full gap-0 p-0 sm:max-w-none"
            /*
             * 시트가 열리면 **탭 머리**에서 시작한다(브라우저 검증 D14). Radix 는 열 때 링크를 건너뛰고
             * (`removeLinks`) 첫 입력에 초점을 줘서, 뒤에 있는 탭 링크로 가려면 Shift+Tab 이나 Tab 17회가 걸렸다.
             * 넓은 화면(aside)은 대화상자가 아니라 초점을 옮길 일이 없다 — 링크 순서 그대로다
             */
            onOpenAutoFocus={(e) => {
              // 지금 탭의 링크 — `aria-current` 가 아니라 `active` 로 찾는다(이동이 끝나기 전 프레임에도 어긋나지 않게)
              const link = tabsRef.current?.querySelector<HTMLElement>(`[data-tab-id="${active}"]`);
              if (!link) return;
              e.preventDefault();
              link.focus();
            }}
            /*
             * 닫으면(Esc·닫기·탭 밖 이동) 시트를 연 자리로 돌려준다. 라우트로 열려 Radix 가 돌려줄 Trigger 가 없어
             * 초점이 `<body>` 로 떨어졌다(D14). 사이드바 시트(AppShell)와 같은 수법이다
             */
            onCloseAutoFocus={(e) => {
              const target = returnTarget();
              if (!target) return;
              e.preventDefault();
              target.focus();
            }}
          >
            {/* 닫기는 시트의 것(오른쪽 위 「닫기」)이라 그 자리를 비워 둔다 */}
            <div className="flex h-12 shrink-0 items-center border-b pr-12 pl-2">
              <SheetTitle className="sr-only">{tab.title}</SheetTitle>
              <TabBar
                ref={tabsRef}
                channelId={channelId}
                conversationId={conversationId}
                rootId={rootId}
                profile={profile}
                active={active}
                only={only}
                badges={badges}
              />
            </div>
            <div ref={slot} className={bodyClass} />
          </SheetContent>
        </Sheet>
      </>
    );
  }
  if (mainMode && main && rootId !== undefined) {
    return (
      <>
        {body}
        <section
          data-testid="thread-main"
          data-panel-tab={active}
          aria-labelledby={titleId}
          className="flex min-w-0 flex-1 flex-col"
          ref={mainSection}
        >
          <div className="flex h-12 shrink-0 items-center gap-1 border-b px-2">
            <OpenSidebarButton />
            <Button variant="ghost" size="icon-sm" aria-label="채널로 돌아가기" onClick={main.onBack}>
              <ArrowLeftIcon />
            </Button>
            <h2 id={titleId} className="flex min-w-0 flex-1 items-center gap-1 text-sm">
              <span className="truncate font-semibold">{main.channelLabel}</span>
              {main.sessionTitle !== undefined && (
                <>
                  <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate text-muted-foreground">{main.sessionTitle}</span>
                </>
              )}
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0">스레드</span>
            </h2>
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <Link
                ref={toggleRef}
                to="/c/$channelId/s/$conversationId/t/$rootId"
                params={{ channelId, conversationId, rootId }}
                search={{}}
                aria-label="패널로 보기"
                title="패널로 보기"
                onClick={() => layoutStore.setThreadView("panel")}
              >
                <PanelRightIcon />
              </Link>
            </Button>
          </div>
          {/* 본문은 채널 화면과 같은 폭 — 폭을 묶으면 「크게 보기」가 넓은 화면에서 패널과 다를 바 없이 좁다 */}
          <div className="flex min-h-0 flex-1">
            <div ref={slot} className="flex min-h-0 w-full flex-1 flex-col overflow-hidden" />
          </div>
        </section>
      </>
    );
  }
  return (
    <>
      {body}
      <aside
        data-testid="page-channel-panel"
        data-panel-tab={active}
        aria-labelledby={titleId}
        style={{ width: layout.drawn.panel }}
        className="relative flex shrink-0 flex-col border-l"
      >
        <ResizeHandle
          label="패널 너비"
          value={layout.drawn.panel}
          range={PANEL}
          grow={-1}
          className="-left-[5px]"
          onDrag={layoutStore.dragPanel}
          onCommit={layoutStore.commit}
          onSet={layoutStore.setPanel}
        />
        <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-2">
          <h2 id={titleId} className="sr-only">
            {tab.title}
          </h2>
          <TabBar
            channelId={channelId}
            conversationId={conversationId}
            rootId={rootId}
            profile={profile}
            active={active}
            only={only}
            badges={badges}
          />
          {active === "thread" && rootId !== undefined && main !== undefined && (
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
              <Link
                ref={toggleRef}
                to="/c/$channelId/s/$conversationId/t/$rootId"
                params={{ channelId, conversationId, rootId }}
                search={{ view: "main" }}
                aria-label="크게 보기"
                title="크게 보기"
                onClick={() => layoutStore.setThreadView("main")}
              >
                <Maximize2Icon />
              </Link>
            </Button>
          )}
          <Button asChild variant="ghost" size="icon-sm" className="shrink-0">
            {/*
             * 이 링크는 누르면 패널과 함께 언마운트돼 초점이 `<body>` 로 떨어졌다(D3·D13·D14 와 같은 부류). 패널이 내려가기
             * **전에** 헤더의 「채널 설정」 링크로 옮긴다 — 좁은 화면 시트가 닫힐 때 돌려주는 자리와 같다(D14).
             * 활동 탭도 같은 자리다: 헤더에 활동을 여는 자리는 따로 없고, 탭 머리는 패널과 함께 사라진다.
             * 칩·「스레드에서 답하기」로 연 스레드만 그 자리로 돌아간다(`returnTarget`, m5).
             * 수정자 클릭(Cmd·Ctrl·Shift·Alt)·가운데 클릭은 라우터가 옮기지 않아 패널이 그대로 남는다 — 그때는 초점도 두고 간다
             */}
            <Link
              to="/c/$channelId/s/$conversationId"
              params={{ channelId, conversationId }}
              aria-label={`${tab.label} 닫기`}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                returnTarget()?.focus();
              }}
            >
              <XIcon />
            </Link>
          </Button>
        </div>
        <div ref={slot} className={bodyClass} />
      </aside>
    </>
  );
}

/**
 * 탭 머리 — 세그먼트 꼴(아이콘 + 글). 실제 이동이라 링크다 — 지금 탭은 라우터 Link 가 `aria-current="page"` 를 붙인다.
 * 스레드·프로필 탭은 연 것이 있을 때만. 배지 수는 보이는 숫자와 따로 접근 이름에 붙인다(「활동, 승인 대기 2」)
 */
function TabBar({
  channelId,
  conversationId,
  rootId,
  profile,
  active,
  only,
  badges,
  ref,
}: {
  channelId: string;
  conversationId: string;
  rootId?: string;
  profile?: { kind: string; id: string };
  active: PanelTab;
  only?: readonly PanelTab[];
  badges?: Partial<Record<PanelTab, number>>;
  ref?: RefObject<HTMLElement | null>;
}) {
  const shown = TABS.filter(
    (tab) =>
      (only === undefined || only.includes(tab.id)) &&
      (tab.id !== "profile" || profile !== undefined) &&
      (tab.id !== "thread" || rootId !== undefined),
  );
  return (
    <nav
      ref={ref}
      aria-label="패널 탭"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md bg-muted p-0.5"
    >
      {shown.map((tab) => {
        const Icon = tab.icon;
        const count = badges?.[tab.id] ?? 0;
        return (
          <Link
            key={tab.id}
            data-tab-id={tab.id}
            to={tab.to}
            params={{
              channelId,
              conversationId,
              ...(tab.id === "thread" ? { rootId } : {}),
              ...(tab.id === "profile" ? profile : {}),
            }}
            aria-label={count > 0 ? `${tab.label}, ${tab.badge} ${count}` : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-sm px-2.5 py-1 text-sm font-medium whitespace-nowrap transition-colors",
              "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
              tab.id === active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5" />
            {tab.label}
            {count > 0 && (
              <span
                aria-hidden="true"
                className="min-w-4 rounded-full bg-[color-mix(in_oklch,var(--warning)_30%,transparent)] px-1 text-center text-xs leading-4 text-foreground tabular-nums"
              >
                {count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 머리의 「파일」 단추(파일함 스펙 「어디서 여나」) — 파일 탭을 여닫는다. 채널·에이전트 DM·사람 DM 머리가 같이 쓴다. `ref` 는 한 줄기
 * direct 처럼 머리에 설정·활동 단추가 없을 때 패널을 닫으면 초점이 돌아올 자리로 쓴다
 */
export function FilesTabLink({
  channelId,
  conversationId,
  ref,
}: {
  channelId: string;
  conversationId: string;
  ref?: RefObject<HTMLAnchorElement | null>;
}) {
  const matchRoute = useMatchRoute();
  const params = { channelId, conversationId };
  const open = Boolean(matchRoute({ to: "/c/$channelId/s/$conversationId/files", params }));
  return (
    <Button asChild variant="ghost" size="icon-sm">
      <Link
        ref={ref}
        to={open ? "/c/$channelId/s/$conversationId" : "/c/$channelId/s/$conversationId/files"}
        params={params}
        activeOptions={{ exact: true }}
        aria-label="파일"
        aria-expanded={open}
      >
        <FolderIcon />
      </Link>
    </Button>
  );
}
