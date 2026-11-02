import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsOwner } from "@/api/queries";
import { useIsNarrow } from "@/hooks/useIsNarrow";
import { Button } from "@/ui/button";
import { ConnectionTreeList } from "./ConnectionTreeList";
import { CONNECTION_DETAIL_SCROLL_ID, ConnectionsContext, type ConnectionsCtx } from "./context";
import { DetailPending } from "./NotFoundDetail";
import { useConnectionTree } from "./useConnectionTree";

const BASE = "/settings/connection";

/**
 * 「연결」 탭(연결 탭 통합 스펙 3장) — 목록(트리) + 상세. 넓은 화면은 트리 칸 | 상세(`Outlet`), 좁은 화면은 한 칸씩: 탭 주소 자체는
 * 트리, 상세 주소는 상세만(「← 연결」은 설정 셸 머리가 단다). 트리 머리의 라이브 영역은 늘 두고(Gateway 삭제 같은 알림),
 * 상세가 사라질 때의 초점을 트리의 자리로 돌려준다(`ConnectionsContext`)
 */
export function ConnectionsLayout() {
  const narrow = useIsNarrow();
  const rendered = useRouterState({ select: (s) => s.matches.at(-1)?.pathname });
  const atIndex = rendered === BASE || rendered === `${BASE}/`;
  const [notice, setNotice] = useState("");
  const focusDetail = useRef(false);
  const [focusTarget, setFocusTarget] = useState<"archived" | "add" | undefined>();
  const ctx = useMemo<ConnectionsCtx>(
    () => ({ announce: setNotice, focusDetail, focusTree: setFocusTarget }),
    [],
  );
  const onNavigate = useCallback(() => {
    focusDetail.current = true;
  }, []);

  const tree = useConnectionTree();
  const archivedToggle = useRef<HTMLButtonElement>(null);
  const addLink = useRef<HTMLAnchorElement>(null);
  // 보관·삭제로 상세가 비면 트리의 자리로 — 그 자리는 트리를 다시 그린 뒤에야 생긴다
  useEffect(() => {
    if (focusTarget === undefined) return;
    const el = focusTarget === "archived" ? archivedToggle.current : addLink.current;
    if (!el) return;
    el.focus();
    setFocusTarget(undefined);
  }, [focusTarget, tree.tree]);

  const list = (
    <div className="flex flex-col gap-4">
      <ListHeader addRef={addLink} />
      <p aria-live="polite" className="px-2 text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
      {tree.tree ? (
        <ConnectionTreeList tree={tree.tree} onNavigate={onNavigate} archivedToggleRef={archivedToggle} />
      ) : (
        <div className="px-2">
          <DetailPending failed={tree.error} retry={tree.refetch} />
        </div>
      )}
    </div>
  );

  return (
    <ConnectionsContext.Provider value={ctx}>
      {narrow ? (
        <section data-testid="page-connection" className="flex w-full flex-col gap-4 p-4">
          {atIndex ? list : <Outlet />}
        </section>
      ) : (
        <section data-testid="page-connection" className="flex min-h-0 min-w-0 flex-1">
          <div data-testid="connection-tree" className="w-72 shrink-0 overflow-y-auto border-r p-3">
            {list}
          </div>
          <div
            id={CONNECTION_DETAIL_SCROLL_ID}
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
              <Outlet />
            </div>
          </div>
        </section>
      )}
    </ConnectionsContext.Provider>
  );
}

function ListHeader({ addRef }: { addRef: React.Ref<HTMLAnchorElement> }) {
  // 1단계는 연결 추가가 owner 의 일이다(서버가 막는다) — 2단계에서 member 에게도 열린다
  const owner = useIsOwner();
  return (
    <header className="flex flex-col gap-2 px-2">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">연결</h1>
        {owner && (
          <Button asChild size="sm">
            <Link ref={addRef} to="/settings/connection/new">
              <PlusIcon />
              연결 추가
            </Link>
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">에이전트가 어디에 붙어 있는지 보고 관리합니다.</p>
    </header>
  );
}

/** 넓은 화면에서 탭 주소만 열었을 때 오른쪽 — 좁은 화면은 이 자리를 그리지 않는다(트리가 첫 화면) */
export function ConnectionIndex() {
  return <p className="text-sm text-muted-foreground">왼쪽에서 연결이나 에이전트를 고르세요.</p>;
}
