import { useAgents, useCanManage } from "@/api/queries";
import { Button } from "@/ui/button";
import { LOCKED_NOTICE } from "@/features/settings/Section";
import { AgentRow } from "./AgentRow";
import { DiscoverDialog } from "./DiscoverDialog";

/**
 * 에이전트 관리(스펙 6.1): 목록·사용 토글·기본 프롬프트, 「에이전트 가져오기」(OpenClaw · Claude 러너, 러너 스펙 7장)·직접 입력.
 * 목록 조회 실패의 원인은 전역 토스트가 알린다 — 여기는 받은 목록이 없을 때만 그 자리에 「다시 시도」를 둔다.
 * 이미 받은 목록은 다시 불러오기가 실패해도 그대로 그린다.
 * 등록·수정은 admin 이상(팀 스펙 2장) — 아니면 등록 버튼이 없고 목록은 값만 보인다
 */
export function AgentsPage() {
  const agents = useAgents();
  const canManage = useCanManage();

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
  } else if (agents.data.length === 0) {
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
        {agents.data.map((agent) => (
          <AgentRow key={agent.id} agent={agent} readOnly={!canManage} />
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
    </section>
  );
}
