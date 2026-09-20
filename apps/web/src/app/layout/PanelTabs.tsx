import { Link, useMatchRoute, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { type ReactNode, useCallback, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";

export type PanelTab = "settings" | "activity";

/**
 * 오른쪽 패널의 탭 둘(설계 5.1). 순서가 화면 순서다.
 * `scroll` 은 틀이 세로 스크롤을 맡는가 — 활동 탭은 제 스크롤 영역을 따로 가진다(런 목록·타임라인)
 */
const TABS = [
  { id: "settings", label: "설정", title: "채널 설정", to: "/c/$channelId/settings", scroll: true },
  { id: "activity", label: "활동", title: "활동", to: "/c/$channelId/activity", scroll: false },
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
  active,
  children,
}: {
  channelId: string;
  active: PanelTab;
  children: ReactNode;
}) {
  const narrow = useIsNarrow();
  const navigate = useNavigate();
  const titleId = useId();
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
  const bodyClass = cn("min-h-0 flex-1", tab.scroll ? "overflow-y-auto" : "flex flex-col overflow-hidden");

  if (narrow) {
    return (
      <>
        {body}
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) void navigate({ to: "/c/$channelId", params: { channelId } });
          }}
        >
          <SheetContent
            side="right"
            data-testid="page-channel-panel"
            data-panel-tab={active}
            aria-describedby={undefined}
            className="w-full gap-0 p-0 sm:max-w-none"
          >
            <div className="flex h-14 shrink-0 items-center border-b px-4 pr-12">
              <SheetTitle>{tab.title}</SheetTitle>
            </div>
            <TabBar channelId={channelId} active={active} />
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
            <Link to="/c/$channelId" params={{ channelId }} aria-label={`${tab.label} 닫기`}>
              <XIcon />
            </Link>
          </Button>
        </div>
        <TabBar channelId={channelId} active={active} />
        <div ref={slot} className={bodyClass} />
      </aside>
    </>
  );
}

/** 탭 머리. 실제 이동이라 링크다 — 지금 탭은 라우터 Link 가 `aria-current="page"` 를 붙인다 */
function TabBar({ channelId, active }: { channelId: string; active: PanelTab }) {
  return (
    <nav aria-label="패널 탭" className="flex shrink-0 gap-1 border-b px-2">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          to={tab.to}
          params={{ channelId }}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors",
            tab.id === active
              ? "border-primary text-foreground"
              : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
