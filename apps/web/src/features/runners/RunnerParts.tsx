import { RUNNER_PROGRAM_NAME, type RunnerProgramStatus, type RunnerSummary } from "@dodok/shared";
import { AUTH_LABEL, LOGIN_LABEL } from "./copy";

/** 붙은 러너의 판본·루트·프로그램 — 러너 상세 머리 아래(연결 탭 통합 스펙 3.3) */
export function RunnerFacts({ runner }: { runner: RunnerSummary }) {
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
export function ProgramLine({ program }: { program: RunnerProgramStatus }) {
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
      {program.version && <> {program.version}</>} · {AUTH_LABEL[program.auth]}
      {program.login && <> ({LOGIN_LABEL[program.login]})</>} · 권한 상한{" "}
      <code className="font-mono text-xs">{program.ceiling.maxPermissionMode}</code>
      {tools !== null && <> · 허용 도구 상한 {tools.length === 0 ? "없음" : tools.join(", ")}</>}
      {program.reason && <span className="text-muted-foreground"> · {program.reason}</span>}
    </li>
  );
}
