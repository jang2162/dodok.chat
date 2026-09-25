import { useIsOwner } from "@/api/queries";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { Button } from "@/ui/button";
import { EventList } from "./EventList";
import { LimitForm } from "./LimitForm";
import { useOpsStatus } from "./queries";
import { RunsTable } from "./RunsTable";
import { StatusCard } from "./StatusCard";

function OwnerContent() {
  const status = useOpsStatus();
  return (
    <>
      {status.data ? (
        <>
          <StatusCard status={status.data} />
          <RunsTable />
          <LimitForm status={status.data} />
        </>
      ) : status.isError ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-sm text-muted-foreground">운영 상태를 불러오지 못했습니다</p>
          <Button variant="outline" size="sm" onClick={() => void status.refetch()}>
            다시 시도
          </Button>
        </div>
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          불러오는 중…
        </p>
      )}
      <EventList />
    </>
  );
}

/**
 * 운영 화면(스펙 `docs/superpowers/specs/2026-09-25-ops-hardening-design.md` 7장): 상태·런 집계·한도·최근 사건.
 * owner 만 본다 — 아니면 ops API 를 부르지 않고 「권한이 없습니다」(연결 페이지와 같은 규칙)
 */
export function OpsPage() {
  const owner = useIsOwner();
  return (
    <section
      data-testid="page-operations"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <OpenSidebarButton />
          <h1 className="text-xl font-semibold">운영</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          서버·연결 상태, 오늘과 이번 주의 런, 워크스페이스 런 한도, 최근 사건을 봅니다.
        </p>
      </header>
      {owner ? (
        <OwnerContent />
      ) : (
        <p className="text-sm text-muted-foreground">
          권한이 없습니다 — 운영 화면은 워크스페이스 owner 만 볼 수 있습니다.
        </p>
      )}
    </section>
  );
}
