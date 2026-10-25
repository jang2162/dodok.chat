import { Link } from "@tanstack/react-router";
import { ApiRequestError, NetworkError } from "@/api/http";
import { OpenSidebarButton, useOpenSidebar } from "@/app/layout/sidebarSheet";
import { Button } from "@/ui/button";

/**
 * 채널을 아직 못 그리는 자리 — 채널 화면(ChannelPage)과 채널 주소의 세션 넘김(ChannelRedirect)이 같이 쓴다. 작성기·렌더러를 끌어오지
 * 않게 채널 화면과 따로 둔다(라우트 조각이 나뉜다)
 */
export function ChannelLoading() {
  return (
    <>
      <div className="flex h-14 shrink-0 items-center border-b px-2">
        <OpenSidebarButton />
      </div>
      <p role="status" className="p-6 text-sm text-muted-foreground">
        불러오는 중…
      </p>
    </>
  );
}

/**
 * 오프라인이라 채널 주소를 세션으로 넘기지 못했다 — 세션 목록은 사본에 없고 이 채널의 마지막으로 본 세션도 없다(app/router
 * `toLatestSession`). 연결되면 쉬던 목록 조회가 다시 나가 넘어간다(`ChannelRedirect`)
 */
export function ChannelOffline() {
  const openSidebar = useOpenSidebar();
  return (
    <>
      {openSidebar && (
        <div className="flex h-14 shrink-0 items-center px-2">
          <OpenSidebarButton />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-lg font-semibold">오프라인이라 이 채널을 열 수 없습니다</h1>
        <p className="text-sm text-muted-foreground">
          이 기기에 저장된 세션이 없습니다. 연결되면 다시 불러옵니다.
        </p>
      </div>
    </>
  );
}

/** 주소의 id 가 틀렸거나(VALIDATION) 없는 채널(404)이면 「찾을 수 없음」, 그 밖은 원인과 「다시 시도」 */
export function ChannelUnavailable({
  error,
  retrying,
  onRetry,
}: {
  error: Error;
  retrying: boolean;
  onRetry: () => void;
}) {
  const openSidebar = useOpenSidebar();
  const notFound = error instanceof ApiRequestError && (error.status === 404 || error.code === "VALIDATION");
  const cause = error instanceof NetworkError || error instanceof ApiRequestError ? error.message : undefined;
  return (
    <>
      {openSidebar && (
        <div className="flex h-14 shrink-0 items-center px-2">
          <OpenSidebarButton />
        </div>
      )}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        {notFound ? (
          <>
            <h1 className="text-lg font-semibold">채널을 찾을 수 없습니다</h1>
            <p className="text-sm text-muted-foreground">삭제되었거나 주소가 잘못되었습니다.</p>
            <Button asChild variant="outline" size="sm">
              <Link to="/">첫 화면으로</Link>
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">채널을 불러오지 못했습니다</h1>
            {cause && <p className="text-sm text-muted-foreground">{cause}</p>}
            <Button variant="outline" size="sm" disabled={retrying} onClick={onRetry}>
              다시 시도
            </Button>
          </>
        )}
      </div>
    </>
  );
}
