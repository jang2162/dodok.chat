import { RUNNER_PROGRAM_NAME, type RunnerProgramStatus, type RunnerSummary } from "@dodok/shared";
import { useRef } from "react";
import { useCanManage, useIsOwner } from "@/api/queries";
import { Link } from "@tanstack/react-router";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { AddProjectDialog } from "./AddProjectDialog";
import { AUTH_LABEL } from "./copy";
import { ProjectList } from "./ProjectList";
import { useRunners } from "./queries";

/**
 * 「러너」 탭(`/settings/runners`, 러너 일반화 스펙 7장): 러너마다 카드 — 연결 상태·판본·프로그램·루트와 그 러너의 프로젝트.
 * admin 이상만 본다 — 아니면 러너 API 를 부르지 않고 「권한이 없습니다」(멤버·운영 탭과 같은 규칙). 토큰 발급·폐기·설치 안내는 연결
 * 페이지(owner)에 남는다
 */
export function RunnersPage() {
  const manager = useCanManage();
  return (
    <section data-testid="page-runners" className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">러너</h1>
        <p className="text-sm text-muted-foreground">
          사람의 머신에서 도는 러너와 그 루트 안의 프로젝트입니다. 러너 에이전트는 프로젝트 안에서 돕니다 —
          에이전트는 「에이전트」 탭에서 만듭니다.
        </p>
      </header>
      {manager ? (
        <RunnerList />
      ) : (
        <p className="text-sm text-muted-foreground">권한이 없습니다 — 러너는 관리자만 볼 수 있습니다.</p>
      )}
    </section>
  );
}

function RunnerList() {
  const runners = useRunners();
  const owner = useIsOwner();
  if (runners.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  if (!runners.data)
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">러너 목록을 불러오지 못했습니다</p>
        <Button
          variant="outline"
          size="sm"
          disabled={runners.isFetching}
          onClick={() => void runners.refetch()}
        >
          다시 시도
        </Button>
      </div>
    );
  if (runners.data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        러너가 없습니다 —{" "}
        {owner ? (
          <Link to="/settings/connection" className="underline underline-offset-4">
            연결 페이지
          </Link>
        ) : (
          "연결 페이지"
        )}
        에서 러너 토큰을 발급해 러너를 붙이세요{owner ? "." : "(워크스페이스 owner 가 할 수 있습니다)."}
      </p>
    );
  return (
    <div className="flex flex-col gap-4">
      {runners.data.map((runner) => (
        <RunnerCard key={runner.id} runner={runner} runners={runners.data} />
      ))}
    </div>
  );
}

/**
 * 러너 하나. 붙어 있으면 판본·프로그램·루트, 끊겼으면 「끊김」 하나 — 서버는 끊긴 러너가 마지막으로 알린 내용을 들고 있지 않다(스펙
 * 5장). 폐기한 러너는 맡을 연결이 다시 생기지 않으니 프로젝트를 다른 러너로 옮기라고 알린다
 */
function RunnerCard({ runner, runners }: { runner: RunnerSummary; runners: readonly RunnerSummary[] }) {
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const live = runner.connected && !runner.revoked;
  // 보관·옮기기로 줄이 빠진 뒤의 초점 — 「프로젝트 추가」, 그것이 잠겨 있으면(끊김·폐기) 카드 머리. 잠긴 버튼의 focus() 는 아무것도
  // 하지 않아 초점이 body 로 떨어진다
  const afterRemove = () => {
    const add = addButton.current;
    return add && !add.disabled ? add : heading.current;
  };
  return (
    <article aria-label={runner.label} className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 ref={heading} tabIndex={-1} className="font-medium break-all outline-none">
          {runner.label}
        </h2>
        {runner.revoked ? (
          <Badge variant="outline">폐기됨</Badge>
        ) : runner.connected ? (
          <Badge>연결됨</Badge>
        ) : (
          <Badge variant="outline">끊김</Badge>
        )}
      </div>
      {runner.revoked && (
        <p className="text-sm text-muted-foreground">
          토큰이 폐기된 러너입니다. 프로젝트를 다른 러너로 옮기면 그 에이전트가 다시 답합니다.
        </p>
      )}
      {live && <RunnerDetail runner={runner} />}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">프로젝트</h3>
          <AddProjectDialog runner={runner} triggerRef={addButton} />
        </div>
        <ProjectList runner={runner} runners={runners} afterRemove={afterRemove} />
      </div>
    </article>
  );
}

/** 붙은 러너의 판본·루트·프로그램 */
function RunnerDetail({ runner }: { runner: RunnerSummary }) {
  return (
    <dl className="flex flex-col gap-1.5 text-sm">
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">러너</dt>
        <dd>{runner.runnerVersion}</dd>
      </div>
      <div className="flex flex-wrap gap-x-2">
        <dt className="text-muted-foreground">루트</dt>
        <dd className="min-w-0 break-all">
          {runner.roots.length === 0 ? "없음" : runner.roots.map((r) => r.label).join(" · ")}
          {runner.browse === false && <span className="text-muted-foreground"> (둘러보기 꺼짐)</span>}
        </dd>
      </div>
      <div className="flex flex-col gap-1">
        <dt className="text-muted-foreground">프로그램</dt>
        <dd>
          {runner.programs.length === 0 ? (
            "켜진 프로그램이 없습니다"
          ) : (
            <ul className="flex flex-col gap-1">
              {runner.programs.map((p) => (
                <ProgramLine key={p.program} program={p} />
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

/** 프로그램 한 줄 — 설치(판본)·로그인·권한 상한. 못 쓰는 것은 흐리게 사유와 함께 */
function ProgramLine({ program }: { program: RunnerProgramStatus }) {
  const name = RUNNER_PROGRAM_NAME[program.program];
  if (!program.available)
    return (
      <li aria-label={name} className="text-muted-foreground">
        <span className="font-medium">{name}</span> — 쓸 수 없음
        {program.reason && <> · {program.reason}</>}
      </li>
    );
  const tools = program.ceiling.allowedToolsCeiling;
  return (
    <li aria-label={name} className="break-words">
      <span className="font-medium">{name}</span>
      {program.version && <> {program.version}</>} · {AUTH_LABEL[program.auth]} · 권한 상한{" "}
      <code className="font-mono text-xs">{program.ceiling.maxPermissionMode}</code>
      {tools !== null && <> · 허용 도구 상한 {tools.length === 0 ? "없음" : tools.join(", ")}</>}
      {program.reason && <span className="text-muted-foreground"> · {program.reason}</span>}
    </li>
  );
}
