import { type Agent, type RunnerSummary, roleAtLeast } from "@dodok/shared";
import { useParams } from "@tanstack/react-router";
import { useRef } from "react";
import { useAgents, useRole } from "@/api/queries";
import { AddProjectDialog } from "@/features/runners/AddProjectDialog";
import { ProjectList } from "@/features/runners/ProjectList";
import { useRunners } from "@/features/runners/queries";
import { RunnerFacts } from "@/features/runners/RunnerParts";
import { useRunnerTokens, useSetupStatus } from "@/features/setup/queries";
import { InstallSteps, RunnerExposure } from "@/features/setup/RunnerSection";
import { RunnerTokenList } from "@/features/setup/RunnerTokenList";
import { Section } from "@/features/setup/sections";
import { Badge } from "@/ui/badge";
import { AgentLinks } from "./ConnectionTreeList";
import { DetailHeader } from "./DetailHeader";
import { HelpDetails } from "./HelpDetails";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { runnerStateLabel } from "./useConnectionTree";

/** 러너 경고 한 줄(연결 탭 통합 스펙 3.3) — 늘 보인다. 「?」 안에 「드러나는 것」 네 줄 */
export const RUNNER_WARNING =
  "이 러너의 에이전트는 채널 멤버 누구나 부를 수 있고, 루트 안 파일을 읽습니다. 루트는 좁게, 상한은 낮게.";

/**
 * 러너 상세(연결 탭 통합 스펙 3.3) — 러너 하나 = 러너 토큰 하나(id 가 같다). admin 이상: 머리(라벨·상태)·판본·루트·프로그램·경고 한 줄·
 * 「프로젝트 N」. owner 는 더해 「설치 안내」(붙은 적이 있으면 접힘)와 그 러너의 토큰 한 줄(다시 발급·폐기). member: 러너 목록 API 가
 * 없어 에이전트의 러너 요약으로 머리(라벨)·경고·그 러너의 에이전트만
 */
export function RunnerDetail() {
  const { runnerId } = useParams({ strict: false });
  const admin = roleAtLeast(useRole(), "admin");
  return admin ? <ManagedRunner id={runnerId ?? ""} /> : <MemberRunner id={runnerId ?? ""} />;
}

function Warning() {
  return (
    <div className="flex flex-col gap-1.5">
      <p role="note" className="text-sm font-medium text-amber-700 dark:text-amber-400">
        {RUNNER_WARNING}
      </p>
      <HelpDetails label="러너 경고">
        <RunnerExposure />
      </HelpDetails>
    </div>
  );
}

function ManagedRunner({ id }: { id: string }) {
  const runners = useRunners();
  const owner = useRole() === "owner";
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  if (!runners.data) return <DetailPending failed={runners.isError} retry={() => void runners.refetch()} />;
  const runner = runners.data.find((r) => r.id === id);
  if (!runner) return <NotFoundDetail />;
  const label = runnerStateLabel(runner);
  const live = runner.connected && !runner.revoked;
  // 보관·옮기기로 줄이 빠진 뒤의 초점 — 「프로젝트 추가」, 그것이 잠겨 있으면(끊김·폐기) 상세 머리
  const afterRemove = () => {
    const add = addButton.current;
    return add && !add.disabled ? add : heading.current;
  };
  return (
    <article aria-label={runner.label} data-testid="runner-detail" className="flex flex-col gap-6">
      <DetailHeader
        title={runner.label}
        headingRef={heading}
        badge={<Badge variant={label === "연결됨" ? "default" : "outline"}>{label}</Badge>}
        meta={<>러너{runner.runnerVersion && <> · dodok-runner {runner.runnerVersion}</>}</>}
      />
      {runner.revoked && (
        <p className="text-sm text-muted-foreground">
          토큰이 폐기된 러너입니다. 프로젝트를 다른 러너로 옮기면 그 에이전트가 다시 답합니다.
        </p>
      )}
      {live && <RunnerFacts runner={runner} />}
      <Warning />
      <Section title={`프로젝트 ${runner.projectCount}`} bare>
        <div>
          <AddProjectDialog runner={runner} triggerRef={addButton} />
        </div>
        <ProjectList runner={runner} runners={runners.data} afterRemove={afterRemove} />
      </Section>
      <UnboundAgents runnerId={runner.id} />
      {owner && <OwnerSections runner={runner} />}
    </article>
  );
}

/** 프로젝트에 묶이지 않은 이 러너의 에이전트(옛 것) — 있을 때만 */
function UnboundAgents({ runnerId }: { runnerId: string }) {
  const agents = useAgents();
  const here = (agents.data ?? []).filter(
    (a: Agent) =>
      a.provider === "runner" &&
      a.runner?.tokenId === runnerId &&
      a.archivedAt === null &&
      !a.runnerAgent?.projectId,
  );
  if (here.length === 0) return null;
  return (
    <Section title={`프로젝트 밖 에이전트 ${here.length}`} bare>
      <AgentLinks agents={here} />
    </Section>
  );
}

/** owner — 설치 안내와 이 러너의 토큰 한 줄 */
function OwnerSections({ runner }: { runner: RunnerSummary }) {
  const status = useSetupStatus();
  const tokens = useRunnerTokens();
  const token = tokens.data?.find((t) => t.id === runner.id);
  // 지금 붙어 있거나 한 번이라도 붙은 러너는 설치를 마친 것이다 — 접어 둔다
  const installed = runner.connected || (token !== undefined && token.lastUsedAt !== null);
  return (
    <>
      {status.data && (
        <details
          aria-label="설치 안내"
          open={!installed || undefined}
          className="rounded-md border p-3 text-sm"
        >
          <summary className="cursor-pointer font-medium">설치 안내</summary>
          <div className="mt-3">
            <InstallSteps status={status.data} />
          </div>
        </details>
      )}
      <Section title="러너 토큰" bare>
        {token ? (
          <RunnerTokenList tokens={[token]} status={status.data} />
        ) : tokens.data ? (
          <p className="text-sm text-muted-foreground">이 러너의 토큰을 찾을 수 없습니다.</p>
        ) : (
          <DetailPending failed={tokens.isError} retry={() => void tokens.refetch()} />
        )}
      </Section>
    </>
  );
}

/** member — 러너 목록 API 가 없다(admin 이상). 에이전트에 실린 러너 요약(라벨·폐기)으로 머리를 짓는다 */
function MemberRunner({ id }: { id: string }) {
  const agents = useAgents();
  if (!agents.data) return <DetailPending failed={agents.isError} retry={() => void agents.refetch()} />;
  const here = agents.data.filter((a) => a.provider === "runner" && a.runner?.tokenId === id);
  const summary = here[0]?.runner;
  if (!summary) return <NotFoundDetail />;
  const live = here.filter((a) => a.archivedAt === null);
  return (
    <div data-testid="runner-detail" className="flex flex-col gap-6">
      <DetailHeader
        title={summary.label}
        badge={summary.revoked ? <Badge variant="outline">폐기됨</Badge> : undefined}
        meta="러너"
      />
      <Warning />
      <Section title={`에이전트 ${live.length}`} bare>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 에이전트가 없습니다.</p>
        ) : (
          <AgentLinks agents={live} />
        )}
      </Section>
    </div>
  );
}
