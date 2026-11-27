import type { RunnerProgram, RunnerProgramStatus, RunnerSummary } from "@dodok/shared";
import type { ReactNode } from "react";
import { DetailCard, StatusChip } from "@/features/connections/DetailCard";
import type { StateTone } from "@/features/connections/tree";
import { AUTH_LABEL, LOGIN_LABEL } from "./copy";
import { ProgramBadge } from "./ProgramBadge";
import { PROGRAM_META, type ProgramRowState, programRows } from "./programMeta";

/** 러너가 띄우는 CLI(hello `programs[].cli`) — 판본 뒤 괄호. 옛 러너는 싣지 않아 붙지 않는다 */
const CLI_LABEL = { installed: "설치본", bundled: "내장" } as const;

/** 끊긴 러너의 프로그램 카드 — programs 가 빈 목록으로 온다(「지원 예정」 줄을 만들지 않는다) */
export const PROGRAMS_DISCONNECTED = "끊김 — 다시 접속하면 프로그램이 보입니다";

/** 줄 끝 상태 칩 — 「로그인 확인 안 됨」(auth unknown)은 칩 없이 판 줄에 */
const ROW_CHIP: Record<Exclude<ProgramRowState, "unknown-auth">, { tone: StateTone; label: string }> = {
  available: { tone: "success", label: "쓸 수 있음" },
  login: { tone: "warning", label: "로그인 필요" },
  "not-installed": { tone: "muted", label: "설치 안 됨" },
  unsupported: { tone: "muted", label: "지원 예정" },
};

/** 붙은 러너의 머리 값 줄 — 판본·루트(연결 재설계 스펙 목표 2). 끊기면 루트를 모른다 */
export function runnerFacts(runner: RunnerSummary): ReactNode[] {
  if (!runner.connected) return [];
  return [
    runner.runnerVersion ? `dodok-runner ${runner.runnerVersion}` : null,
    <span key="roots">
      루트 {runner.roots.length === 0 ? "없음" : runner.roots.map((r) => r.label).join(" · ")}
      {runner.browse === false && " (둘러보기 꺼짐)"}
    </span>,
  ];
}

/**
 * 「에이전트 프로그램」 카드(연결 재설계 스펙 목표 4) — `RunnerProgram` 의 프로그램마다 한 줄: 배지 · 이름 · 판·로그인·권한 상한 요약 ·
 * 상태 칩. 러너가 알리지 않은 프로그램은 「지원 예정」(이 러너 판은 아직 모름). 끊긴 러너는 한 줄 안내만
 */
export function ProgramsCard({ runner }: { runner: RunnerSummary }) {
  const rows = programRows(runner.programs, runner.connected && !runner.revoked);
  return (
    <DetailCard title="에이전트 프로그램">
      {rows.kind === "disconnected" ? (
        <p className="text-sm text-muted-foreground">{PROGRAMS_DISCONNECTED}</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {rows.rows.map((row) => (
            <ProgramRow key={row.program} program={row.program} state={row.state} status={row.status} />
          ))}
        </ul>
      )}
    </DetailCard>
  );
}

/**
 * 판·로그인·권한 상한 요약 — 「2.1.283 (설치본) · 로그인됨 (평소 로그인) · 권한 상한 acceptEdits · 허용 도구 상한 … · 작업 디렉터리 밖 접근
 * 허용」(마지막은 그 상한을 연 러너만)
 */
function summaryOf(status: RunnerProgramStatus): ReactNode {
  const tools = status.ceiling.allowedToolsCeiling;
  return (
    <>
      {status.version}
      {status.cli && <> ({CLI_LABEL[status.cli]})</>} ·{" "}
      {status.auth === "unknown" ? "로그인 확인 안 됨" : AUTH_LABEL[status.auth]}
      {status.login && <> ({LOGIN_LABEL[status.login]})</>} · 권한 상한{" "}
      <code className="font-mono text-xs">{status.ceiling.maxPermissionMode}</code>
      {tools !== null && <> · 허용 도구 상한 {tools.length === 0 ? "없음" : tools.join(", ")}</>}
      {status.ceiling.allowOutsideWorkdir === true && <> · 작업 디렉터리 밖 접근 허용</>}
    </>
  );
}

function ProgramRow({
  program,
  state,
  status,
}: {
  program: RunnerProgram;
  state: ProgramRowState;
  status?: RunnerProgramStatus;
}) {
  const name = PROGRAM_META[program].name;
  const chip = state === "unknown-auth" ? undefined : ROW_CHIP[state];
  const dim = state === "not-installed" || state === "unsupported";
  return (
    <li aria-label={name} className="flex items-start gap-3 px-3 py-2.5 text-sm">
      <ProgramBadge program={program} size="md" className={dim ? "opacity-60" : undefined} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="break-words">
          <span className={dim ? "font-medium text-muted-foreground" : "font-medium"}>{name}</span>{" "}
          <span className="text-muted-foreground">
            {state === "unsupported"
              ? // hello 에 실린 프로그램이면 러너는 그 프로그램을 안다 — 드라이버가 없다는 사유만 아래에 둔다
                status
                ? null
                : "이 러너 판은 아직 모릅니다"
              : status && state !== "not-installed"
                ? summaryOf(status)
                : null}
          </span>
        </p>
        {status?.reason && <p className="text-xs break-words text-muted-foreground">{status.reason}</p>}
        {state === "not-installed" && (
          <details className="text-xs">
            <summary className="cursor-pointer text-primary underline-offset-4 hover:underline">
              설치 방법
            </summary>
            <p className="mt-1 text-muted-foreground">
              러너 머신에 {name} 을(를) 설치한 뒤 러너를 다시 띄우면 이 줄이 「쓸 수 있음」으로 바뀝니다. 러너
              설정의 프로그램 목록에서 켜져 있는지도 확인하세요.
            </p>
          </details>
        )}
      </div>
      {chip && <StatusChip tone={chip.tone} label={chip.label} />}
    </li>
  );
}
