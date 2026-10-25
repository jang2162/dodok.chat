import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type ReactNode, type RefObject, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ThreadOpener } from "@/features/threads/threadOpener";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";

export type PanelTab = "settings" | "activity" | "thread";

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
  },
  {
    id: "activity",
    label: "활동",
    title: "활동",
    to: "/c/$channelId/s/$conversationId/activity",
    scroll: false,
  },
  {
    id: "thread",
    label: "스레드",
    title: "스레드",
    to: "/c/$channelId/s/$conversationId/t/$rootId",
    scroll: false,
  },
] as const satisfies ReadonlyArray<{
  id: PanelTab;
  label: string;
  title: string;
  to: string;
  scroll: boolean;
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

/**
 * 채널 오른쪽 패널의 바깥 틀(설계 5.1). 넓은 화면은 오른쪽 360px 패널, 좁은 화면(`useIsNarrow`)은 전체 화면 시트
 * (스펙 2.4). 머리에 탭 둘(설정·활동)과 닫기가 있고 내용은 `children` — 설정 패널·활동 패널이 같은 틀을 쓴다.
 *
 * 라우트 컴포넌트(설정·활동)가 아니라 그 **부모**(ChannelPage)가 그린다 — 탭을 옮겨도 머리의 링크가
 * 언마운트되지 않아야 초점이 `<body>` 로 떨어지지 않는다(브라우저 검증 D3). 탭 내용만 `<Outlet/>` 으로 바뀐다.
 *
 * 폭이 바뀌면 담는 그릇(aside ↔ 시트)이 바뀌지만 내용은 **같은 자리에서 한 번만** 그린다 —
 * 늘 같은 `host` div 로 포털을 보내고, 그릇이 그 div 를 제 안으로 옮겨 붙인다. 그릇을 갈아 끼울 때 안쪽이
 * 다시 마운트되면 고치던 초안이 사라진다(web-t11 리뷰 Minor 7). `host` 는 `display:contents` 라
 * 자리를 차지하지 않는다 — 내용이 곧 스크롤 영역의 자식이다
 */
export function PanelTabs({
  channelId,
  conversationId,
  rootId,
  active,
  children,
  openerRef,
  threadOpenerRef,
}: {
  channelId: string;
  /** 보고 있는 세션 — 탭을 옮기거나 닫아도 그 세션에 머문다(채널 머리·설정·활동은 채널 단위 그대로) */
  conversationId: string;
  /** 연 스레드의 루트(스레드 탭일 때) — 탭 머리의 「스레드」 링크가 쓴다 */
  rootId?: string;
  active: PanelTab;
  children: ReactNode;
  /** 패널을 여는 자리(헤더의 「채널 설정」) — 패널을 닫으면(좁은 화면 시트·넓은 화면 닫기 링크) 초점을 여기로 돌려준다(D14) */
  openerRef?: RefObject<HTMLAnchorElement | null>;
  /** 스레드를 연 자리(칩·「스레드에서 답하기」) — 스레드 탭을 닫으면 그 자리가 아직 화면에 있을 때 `openerRef` 대신 여기로 */
  threadOpenerRef?: RefObject<ThreadOpener | null>;
}) {
  const narrow = useIsNarrow();
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
            <div className="flex h-14 shrink-0 items-center border-b px-4 pr-12">
              <SheetTitle>{tab.title}</SheetTitle>
            </div>
            <TabBar
              ref={tabsRef}
              channelId={channelId}
              conversationId={conversationId}
              rootId={rootId}
              active={active}
            />
            <div ref={slot} className={bodyClass} />
          </SheetContent>
        </Sheet>
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
        className="flex w-[360px] shrink-0 flex-col border-l"
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b px-4">
          <h2 id={titleId} className="font-semibold">
            {tab.title}
          </h2>
          <Button asChild variant="ghost" size="icon-sm">
            {/*
             * 이 링크는 누르면 패널과 함께 언마운트돼 초점이 `<body>` 로 떨어졌다(D3·D13·D14 와 같은 부류). 패널이 내려가기
             * **전에** 헤더의 「채널 설정」 링크로 옮긴다 — 좁은 화면 시트가 닫힐 때 돌려주는 자리와 같다(D14).
             * 활동 탭도 같은 자리다: 헤더에 활동을 여는 자리는 따로 없고, 탭 머리는 패널과 함께 사라진다.
             * 칩·「스레드에서 답하기」로 연 스레드만 그 자리로 돌아간다(`returnTarget`, m5)
             */}
            <Link
              to="/c/$channelId/s/$conversationId"
              params={{ channelId, conversationId }}
              aria-label={`${tab.label} 닫기`}
              onClick={() => returnTarget()?.focus()}
            >
              <XIcon />
            </Link>
          </Button>
        </div>
        <TabBar channelId={channelId} conversationId={conversationId} rootId={rootId} active={active} />
        <div ref={slot} className={bodyClass} />
      </aside>
    </>
  );
}

/** 탭 머리. 실제 이동이라 링크다 — 지금 탭은 라우터 Link 가 `aria-current="page"` 를 붙인다. 스레드 탭은 연 스레드가 있을 때만 */
function TabBar({
  channelId,
  conversationId,
  rootId,
  active,
  ref,
}: {
  channelId: string;
  conversationId: string;
  rootId?: string;
  active: PanelTab;
  ref?: RefObject<HTMLElement | null>;
}) {
  const className = (id: PanelTab) =>
    cn(
      "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
      id === active
        ? "border-primary text-foreground"
        : "border-transparent text-muted-foreground hover:text-foreground",
    );
  return (
    <nav ref={ref} aria-label="패널 탭" className="flex shrink-0 gap-1 border-b px-2">
      {TABS.map((tab) =>
        tab.id === "thread" ? (
          rootId !== undefined && (
            <Link
              key={tab.id}
              data-tab-id={tab.id}
              to={tab.to}
              params={{ channelId, conversationId, rootId }}
              className={className(tab.id)}
            >
              {tab.label}
            </Link>
          )
        ) : (
          <Link
            key={tab.id}
            data-tab-id={tab.id}
            to={tab.to}
            params={{ channelId, conversationId }}
            className={className(tab.id)}
          >
            {tab.label}
          </Link>
        ),
      )}
    </nav>
  );
}
