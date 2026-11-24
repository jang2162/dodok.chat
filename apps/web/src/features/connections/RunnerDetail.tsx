import { type Agent, type ConnectionsResponse, type RunnerSummary, roleAtLeast } from "@dodok/shared";
import { useParams } from "@tanstack/react-router";
import { BookOpenIcon, LaptopIcon, PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useAgents } from "@/api/queries";
import { useCancelRunnerUpdateQueue } from "@/features/agents/mutations";
import { RunnerAgentForm } from "@/features/agents/RunnerAgentForm";
import { AddProjectDialog } from "@/features/runners/AddProjectDialog";
import { ProjectList } from "@/features/runners/ProjectList";
import { useRunners } from "@/features/runners/queries";
import { ProgramsCard, runnerFacts } from "@/features/runners/RunnerParts";
import { useRunnerTokens, useSetupStatus } from "@/features/setup/queries";
import { InstallSteps } from "@/features/setup/RunnerSection";
import { RunnerTokenList } from "@/features/setup/RunnerTokenList";
import { Button } from "@/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/ui/dialog";
import { AgentLinks } from "./ConnectionTreeList";
import { DetailCard, OverflowMenu } from "./DetailCard";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { RunnerUpdateButton, RunnerUpdateStatus, useRunnerUpdate } from "./RemoteUpdate";
import { canManageConnection, useViewer } from "./permissions";
import { useConnectionList } from "./queries";
import { stateTone } from "./tree";
import { runnerStateLabel } from "./useConnectionTree";

type ListedRunner = ConnectionsResponse["runners"][number];

/**
 * 러너 상세(연결 탭 통합 스펙 3.3·5장, 연결 재설계 스펙 목표 2·3·4) — 러너 하나 = 러너 토큰 하나(id 가 같다). 관리할 수 있는 사람(그 러너의
 * 주인·admin 이상): 머리(아이콘·라벨·상태 칩·값 줄 — 주인·판본·루트, 「러너 업데이트」, 「⋯」 메뉴의 설치 안내)·카드 「에이전트 프로그램」·
 * 「프로젝트」·「봇」·(있을 때만) 「프로젝트 밖 에이전트」·(설치 전이면) 「설치 안내」·「러너 토큰」(다시 발급·폐기).
 * 그 밖의 사람: 머리(라벨·상태·주인)·그 러너의 에이전트만 — 설치·토큰·루트는 주인과 admin 이상의 몫이다
 */
export function RunnerDetail() {
  const { runnerId } = useParams({ strict: false });
  const id = runnerId ?? "";
  const { role, meId } = useViewer();
  const list = useConnectionList();
  // admin 이상은 주인과 상관없이 관리한다 — 목록을 기다리지 않는다
  if (list.isPending && !roleAtLeast(role, "admin"))
    return <DetailPending failed={false} retry={() => void list.refetch()} />;
  const entry = list.data?.runners.find((r) => r.id === id);
  return canManageConnection(role, meId, entry?.owner?.id ?? null) ? (
    <ManagedRunner id={id} entry={entry} />
  ) : (
    <MemberRunner id={id} entry={entry} />
  );
}

function ManagedRunner({ id, entry }: { id: string; entry: ListedRunner | undefined }) {
  const runners = useRunners();
  const runner = runners.data?.find((r) => r.id === id);
  if (!runners.data) return <DetailPending failed={runners.isError} retry={() => void runners.refetch()} />;
  if (!runner) return <NotFoundDetail />;
  return <ManagedRunnerBody runner={runner} runners={runners.data} entry={entry} />;
}

function ManagedRunnerBody({
  runner,
  runners,
  entry,
}: {
  runner: RunnerSummary;
  runners: readonly RunnerSummary[];
  entry: ListedRunner | undefined;
}) {
  const addButton = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const update = useRunnerUpdate(runner);
  const status = useSetupStatus();
  const tokens = useRunnerTokens();
  const token = tokens.data?.find((t) => t.id === runner.id);
  const [guideOpen, setGuideOpen] = useState(false);
  const label = runnerStateLabel(runner);
  // 지금 붙어 있거나 한 번이라도 붙은 러너는 설치를 마친 것이다 — 설치 안내는 「⋯」 메뉴로(드문 것), 아직이면 카드로 펼쳐 둔다
  const installed = runner.connected || (token !== undefined && token.lastUsedAt !== null);
  // 보관·옮기기로 줄이 빠진 뒤의 초점 — 「프로젝트 추가」, 그것이 잠겨 있으면(끊김·폐기) 상세 머리
  const afterRemove = () => {
    const add = addButton.current;
    return add && !add.disabled ? add : heading.current;
  };
  return (
    <article aria-label={runner.label} data-testid="runner-detail" className="flex flex-col gap-4">
      <DetailHeader
        icon={<LaptopIcon />}
        title={runner.label}
        headingRef={heading}
        state={{ tone: stateTone(label), label }}
        facts={["러너", entry?.owner ? `주인 ${entry.owner.name}` : null, ...runnerFacts(runner)]}
        primary={<RunnerUpdateButton update={update} />}
        menu={
          <OverflowMenu
            label={`${runner.label} 더 보기`}
            items={
              status.data && installed
                ? [{ label: "설치 안내", icon: <BookOpenIcon />, onSelect: () => setGuideOpen(true) }]
                : []
            }
          />
        }
      >
        <RunnerUpdateStatus update={update} />
        <UpdateQueued runner={runner} />
      </DetailHeader>
      {runner.revoked && <p className="text-sm text-muted-foreground">토큰이 폐기된 러너입니다.</p>}
      {!runner.revoked && <ProgramsCard runner={runner} />}
      <DetailCard
        title="프로젝트"
        count={runner.projectCount}
        action={<AddProjectDialog runner={runner} triggerRef={addButton} triggerVariant="ghost" />}
      >
        <ProjectList runner={runner} runners={runners} afterRemove={afterRemove} />
      </DetailCard>
      <RunnerBots runner={runner} />
      <UnboundAgents runnerId={runner.id} />
      {status.data && !installed && (
        <DetailCard title="설치 안내">
          <InstallSteps status={status.data} />
        </DetailCard>
      )}
      {status.data && (
        <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
          <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>설치 안내</DialogTitle>
              <DialogDescription>
                러너 머신에 dodok-runner 를 깔고 이 러너의 토큰으로 붙입니다.
              </DialogDescription>
            </DialogHeader>
            <InstallSteps status={status.data} />
          </DialogContent>
        </Dialog>
      )}
      <DetailCard title="러너 토큰">
        {token ? (
          <RunnerTokenList tokens={[token]} status={status.data} issueButton={heading} />
        ) : tokens.data ? (
          <p className="text-sm text-muted-foreground">이 러너의 토큰을 찾을 수 없습니다.</p>
        ) : (
          <DetailPending failed={tokens.isError} retry={() => void tokens.refetch()} />
        )}
      </DetailCard>
    </article>
  );
}

/** 「업데이트 대기」 문구(러너 봇 2부 스펙 T16) */
export const UPDATE_QUEUED_TEXT = "업데이트 대기 — 런이 끝나면 올립니다";

/**
 * 봇이 request_runner_update 로 둔 대기(T16) — 그 러너의 런이 모두 끝나면 서버가 「업데이트」와 같은 요청을 보낸다. 「취소」로 지운다.
 * 웹 「업데이트」 단추는 대기와 상관없이 지금처럼 바로 보낸다(바쁘면 러너가 거절)
 */
function UpdateQueued({ runner }: { runner: RunnerSummary }) {
  const cancel = useCancelRunnerUpdateQueue(runner.id);
  if (!runner.updateQueued) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="update-queued">
      <p role="status" className="text-sm text-muted-foreground">
        {UPDATE_QUEUED_TEXT}
      </p>
      <Button variant="outline" size="sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
        취소
      </Button>
    </div>
  );
}

/**
 * 「봇 N」(러너 봇 스펙 B2·B11) — 이 러너의 봇과 「봇 만들기」. 봇은 프로젝트 없이 러너가 만든 봇 폴더에서 돈다. 끊기거나 폐기된 러너는
 * 잠근다(만들기는 붙은 러너에만 — 서버 503). 능력 bots 가 없는 러너는 폼 안에서 사유와 함께 잠근다
 */
function RunnerBots({ runner }: { runner: RunnerSummary }) {
  const agents = useAgents();
  const [open, setOpen] = useState(false);
  const all = agents.data ?? [];
  const takenHandles = useMemo(() => new Set(all.map((a) => a.handle)), [all]);
  const bots = all.filter(
    (a) =>
      a.provider === "runner" && a.runner?.tokenId === runner.id && a.runner.bot && a.archivedAt === null,
  );
  const live = runner.connected && !runner.revoked;
  return (
    <DetailCard
      title="봇"
      count={bots.length}
      action={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" size="sm" variant="ghost" disabled={!live}>
              <PlusIcon />
              봇 만들기
            </Button>
          </DialogTrigger>
          <DialogContent aria-describedby={undefined} className="max-h-[85svh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>봇 만들기</DialogTitle>
            </DialogHeader>
            {open && (
              <RunnerAgentForm
                runnerId={runner.id}
                takenHandles={takenHandles}
                onCreated={() => setOpen(false)}
              />
            )}
          </DialogContent>
        </Dialog>
      }
    >
      {bots.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 봇이 없습니다.</p>
      ) : (
        <AgentLinks agents={bots} />
      )}
    </DetailCard>
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
      !a.runnerAgent?.projectId &&
      // 봇은 「봇」 묶음에(러너 봇 스펙 B11) — 이 묶음은 옛 것만
      !a.runner?.bot,
  );
  if (here.length === 0) return null;
  return (
    <DetailCard title="프로젝트 밖 에이전트" count={here.length}>
      <AgentLinks agents={here} />
    </DetailCard>
  );
}

/**
 * 관리할 수 없는 사람 — 연결 목록의 러너 줄(라벨·상태·주인), 없으면(옛 서버) 에이전트에 실린 러너 요약(라벨·폐기)으로 머리를 짓는다
 */
function MemberRunner({ id, entry }: { id: string; entry: ListedRunner | undefined }) {
  const agents = useAgents();
  if (!agents.data) return <DetailPending failed={agents.isError} retry={() => void agents.refetch()} />;
  const here = agents.data.filter((a) => a.provider === "runner" && a.runner?.tokenId === id);
  const summary = entry ?? here[0]?.runner;
  if (!summary) return <NotFoundDetail />;
  const live = here.filter((a) => a.archivedAt === null);
  const label = entry ? runnerStateLabel(entry) : summary.revoked ? "폐기됨" : null;
  return (
    <div data-testid="runner-detail" className="flex flex-col gap-4">
      <DetailHeader
        icon={<LaptopIcon />}
        title={summary.label}
        state={label === null ? undefined : { tone: stateTone(label), label }}
        facts={["러너", entry?.owner ? `주인 ${entry.owner.name}` : null]}
      />
      <DetailCard title="에이전트" count={live.length}>
        {live.length === 0 ? (
          <p className="text-sm text-muted-foreground">아직 에이전트가 없습니다.</p>
        ) : (
          <AgentLinks agents={live} />
        )}
      </DetailCard>
    </div>
  );
}
