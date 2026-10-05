import { useAgents, useCanManage } from "@/api/queries";
import { Button } from "@/ui/button";
import { LOCKED_NOTICE } from "@/features/settings/Section";
import { useEffect, useRef, useState } from "react";
import { AgentRow } from "./AgentRow";
import { ArchivedAgents } from "./ArchivedAgents";
import { isArchived } from "./archived";
import { DiscoverDialog } from "./DiscoverDialog";

/**
 * 에이전트 관리(스펙 6.1): 목록·사용 토글·기본 프롬프트, 「에이전트 가져오기」(OpenClaw · Claude 러너, 러너 스펙 7장)·직접 입력.
 * 목록 조회 실패의 원인은 전역 토스트가 알린다 — 여기는 받은 목록이 없을 때만 그 자리에 「다시 시도」를 둔다.
 * 이미 받은 목록은 다시 불러오기가 실패해도 그대로 그린다.
 * 등록·수정·삭제·되살리기는 admin 이상(팀 스펙 2장) — 아니면 등록 버튼이 없고 목록은 값만 보인다.
 * 서버 목록은 보관(삭제)한 에이전트도 함께 준다 — 살아 있는 것만 목록에, 보관한 것은 아래 접힌 「삭제된 에이전트 N」 묶음에(스펙 「에이전트 보관」 절)
 */
export function AgentsPage() {
  const agents = useAgents();
  const canManage = useCanManage();
  const live = agents.data?.filter((a) => !isArchived(a)) ?? [];
  const archived = agents.data?.filter(isArchived) ?? [];
  const groupRef = useRef<HTMLButtonElement>(null);
  // 보관하면 그 줄(과 「삭제」)이 사라진다 — 초점을 묶음 단추로. 묶음은 다시 그린 뒤에야 생기므로 그려진 다음에 옮긴다
  const [archivedAt, setArchivedAt] = useState(0);
  useEffect(() => {
    if (archivedAt > 0) groupRef.current?.focus();
  }, [archivedAt]);
  // 되살리면 그 줄이 묶음에서 빠진다 — 묶음이 남으면 묶음 단추로, 마지막 하나였으면(묶음도 사라진다) 살아 있는 목록에 돌아온 그 줄로.
  // 목록 캐시가 되살린 에이전트를 실은 뒤에야 줄이 생기므로 그때까지 기다린다
  const [restoredId, setRestoredId] = useState<string | null>(null);
  const restoredRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const data = agents.data ?? [];
    if (restoredId === null || !data.some((a) => a.id === restoredId && !isArchived(a))) return;
    (data.some(isArchived) ? groupRef.current : restoredRef.current)?.focus();
    setRestoredId(null);
  }, [restoredId, agents.data]);

  let content;
  if (agents.isPending) {
    content = (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  } else if (!agents.data) {
    // 받은 목록 없이 실패했을 때만(isError). 다시 불러오기 실패는 아래에서 받은 목록을 그린다
    content = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">에이전트 목록을 불러오지 못했습니다</p>
        <Button
          variant="outline"
          size="sm"
          disabled={agents.isFetching}
          onClick={() => void agents.refetch()}
        >
          다시 시도
        </Button>
      </div>
    );
  } else if (live.length === 0) {
    content = (
      <p className="text-sm text-muted-foreground">
        {canManage
          ? "등록된 에이전트가 없습니다. 「에이전트 가져오기」로 등록하세요."
          : "등록된 에이전트가 없습니다."}
      </p>
    );
  } else {
    content = (
      <ul className="flex flex-col gap-3">
        {live.map((agent) => (
          <AgentRow
            key={agent.id}
            agent={agent}
            readOnly={!canManage}
            onArchived={() => setArchivedAt((n) => n + 1)}
            {...(agent.id === restoredId ? { focusRef: restoredRef } : {})}
          />
        ))}
      </ul>
    );
  }

  return (
    <section data-testid="page-agents" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold">에이전트</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            OpenClaw·Claude 러너 에이전트를 등록하고 사용 여부·기본 프롬프트를 정합니다.
          </p>
        </div>
        {canManage && <DiscoverDialog agents={agents.data ?? []} disabled={!agents.data} />}
      </header>
      {!canManage && <p className="-mt-3 text-xs text-muted-foreground">{LOCKED_NOTICE}</p>}
      {content}
      {archived.length > 0 && (
        <ArchivedAgents
          agents={archived}
          readOnly={!canManage}
          toggleRef={groupRef}
          onRestored={setRestoredId}
        />
      )}
    </section>
  );
}
