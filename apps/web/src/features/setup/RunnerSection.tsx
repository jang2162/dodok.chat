import type { RunnerConnection, RunnerTokenRecord, SetupStatus } from "@dodok/shared";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { ApiRequestError } from "@/api/http";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import {
  IssueRunnerTokenDialog,
  RUNNER_CLAUDE_DIR,
  RUNNER_CONFIG_PATH,
  runnerConfigExample,
} from "./IssueRunnerTokenDialog";
import { publicOriginOf } from "./llms";
import { useBindRunnerAgent, useDownloadRunner } from "./mutations";
import { useRunnerTokens } from "./queries";
import { RunnerTokenList } from "./RunnerTokenList";
import { CopyBlock, Section } from "./sections";
import { when } from "./TokenList";

/** 러너 tgz 를 만드는 명령 — 서버에 파일이 없을 때 */
export const RUNNER_PACK_COMMAND = "pnpm -F @dodok/claude-runner run pack:runner";
/** 러너 전용 로그인(러너 스펙 5장 설치 안내) — 사람의 `~/.claude` 와 섞지 않는다 */
export const RUNNER_LOGIN_COMMAND = `CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} claude`;
/** 러너 토큰 파일의 권장 자리 — 서버 RUNNER_TOKEN_FILE 과 같다 */
const RUNNER_TOKEN_FILE = "~/.dodok-runner/token";

/** 이름·값 한 줄 */
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  );
}

/** 붙은 러너가 서버가 품은 러너 파일과 같은 빌드인가(러너 스펙 5장 「같은 빌드」) — hello 의 bundleSha256 으로 가른다 */
function RunnerBuild({
  runner,
  file,
}: {
  runner: RunnerConnection;
  file: SetupStatus["runners"]["runnerFile"];
}) {
  if (runner.bundleSha256 === null || !file.available)
    return <p className="text-sm text-muted-foreground">같은 빌드인지 알 수 없습니다</p>;
  if (runner.bundleSha256 === file.bundleSha256)
    return <p className="text-sm text-muted-foreground">서버와 같은 빌드입니다</p>;
  return (
    <p role="alert" className="text-sm font-medium text-destructive">
      다른 빌드입니다 — 러너를 받아서 다시 설치하세요
    </p>
  );
}

/**
 * 충돌 에이전트 한 줄의 사유 — 다른 토큰에 묶인 등록 에이전트면 그 토큰 이름과 「이 러너로 묶기」, 묶임이 없으면 id 가 겹친 것이다
 * (먼저 붙은 러너가 맡는다)
 */
function AgentConflict({
  runner,
  agent,
  tokens,
}: {
  runner: RunnerConnection;
  agent: RunnerConnection["agents"][number];
  tokens: RunnerTokenRecord[] | undefined;
}) {
  const bind = useBindRunnerAgent();
  if (agent.boundTokenId === null || agent.boundTokenId === runner.tokenId)
    return <p className="text-xs font-medium text-destructive">다른 러너와 id 가 겹쳐 배정되지 않습니다</p>;
  const token = tokens?.find((t) => t.id === agent.boundTokenId);
  const name = token ? `${token.label}${token.revokedAt === null ? "" : "(폐기됨)"}` : "다른 러너 토큰";
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-xs font-medium text-destructive">{name}에 묶여 있어 배정되지 않습니다</p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          aria-label={`${agent.name} 이 러너로 묶기`}
          disabled={bind.isPending}
          onClick={() => bind.mutate({ tokenId: runner.tokenId, agentId: agent.id })}
        >
          이 러너로 묶기
        </Button>
      </div>
      {bind.isError && (
        <p role="alert" className="text-xs text-destructive">
          묶지 못했습니다 — 토큰이 폐기됐거나 에이전트가 등록돼 있지 않습니다. 새로고침한 뒤 다시 시도하세요.
        </p>
      )}
    </div>
  );
}

/** 러너 하나 — 판본·붙은 시각·같은 빌드·알린 에이전트(충돌이면 배정되지 않는다고, 다른 토큰에 묶였으면 다시 묶기) */
function RunnerCard({
  runner,
  file,
  tokens,
}: {
  runner: RunnerConnection;
  file: SetupStatus["runners"]["runnerFile"];
  tokens: RunnerTokenRecord[] | undefined;
}) {
  return (
    <article aria-label={runner.label} className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{runner.label}</span>
        <Badge>연결됨</Badge>
      </div>
      <dl className="flex flex-col gap-1">
        <Field name="러너">{runner.runnerVersion}</Field>
        <Field name="SDK">{runner.sdkVersion}</Field>
        <Field name="Claude Code">{runner.claudeCodeVersion}</Field>
        <Field name="붙은 시각">{when(runner.connectedAt)}</Field>
      </dl>
      <RunnerBuild runner={runner} file={file} />
      {runner.agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          알린 에이전트가 없습니다 — 러너 설정의 agents 를 확인하세요.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {runner.agents.map((agent) => (
            <li key={agent.id} aria-label={agent.name} className="flex flex-col gap-0.5 text-sm">
              <div className="flex flex-wrap items-center gap-x-2">
                <span className="font-medium">{agent.name}</span>
                <code className="font-mono text-xs text-muted-foreground">{agent.id}</code>
                <span className="text-xs text-muted-foreground">
                  {agent.workdirLabel} · {agent.model}
                </span>
              </div>
              {agent.conflict && <AgentConflict runner={runner} agent={agent} tokens={tokens} />}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** 받기 실패 문구 — 서버 메시지 앞머리로 가른다. 서버 문구를 그대로 보이지 않는다 */
function downloadError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.message === "RUNNER_FILE_MISSING")
      return `서버에서 러너 파일을 찾지 못했습니다 — 저장소에서 ${RUNNER_PACK_COMMAND} 로 만든 뒤 서버를 재시작하세요.`;
    if (e.message.startsWith("RUNNER_FILE_CHANGED"))
      return "러너 파일이 그새 다시 빌드됐습니다 — 서버를 재시작하면 새 파일을 받습니다.";
  }
  return "러너 파일을 받지 못했습니다 — 서버 연결을 확인하세요.";
}

/** 설치 안내(러너 스펙 5장) — tgz 받기 → 전용 로그인 → 설정 파일 → 실행 */
function InstallSteps({ status }: { status: SetupStatus }) {
  const file = status.runners.runnerFile;
  const download = useDownloadRunner();
  const fileName = file.available ? `dodok-claude-runner-${file.sha256.slice(0, 12)}.tgz` : "";
  const config = runnerConfigExample({
    serverUrl: publicOriginOf(status.bridge.publicUrl),
    tokenFile: RUNNER_TOKEN_FILE,
  });
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">설치</h3>
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li className="flex flex-col gap-1.5">
          <p>러너를 받아 러너를 돌릴 머신에 설치합니다. Claude Agent SDK 는 설치할 때 npm 에서 받습니다.</p>
          {file.available ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                disabled={download.isPending}
                onClick={() => download.mutate(fileName)}
              >
                <DownloadIcon />
                러너 받기
              </Button>
              <dl className="flex flex-col gap-1 text-xs">
                <Field name="파일 sha256">
                  <code className="font-mono">{file.sha256}</code>
                </Field>
                <Field name="크기">{file.bytes.toLocaleString("ko-KR")} 바이트</Field>
              </dl>
              <div aria-live="polite">
                {download.isError && (
                  <p role="alert" className="text-sm text-destructive">
                    {downloadError(download.error)}
                  </p>
                )}
              </div>
              <CopyBlock text={`npm install -g ./${fileName}`} label="설치 명령 복사" />
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                서버에 러너 파일이 없습니다. 저장소에서 만든 뒤 서버를 재시작하세요.
              </p>
              <CopyBlock text={RUNNER_PACK_COMMAND} label="만드는 명령 복사" />
            </>
          )}
        </li>
        <li className="flex flex-col gap-1.5">
          <p>러너 전용 Claude 계정으로 로그인합니다. 로그인을 마치면 나옵니다.</p>
          <CopyBlock text={RUNNER_LOGIN_COMMAND} label="로그인 명령 복사" />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>
            위에서 러너 토큰을 발급해 <code className="font-mono">{RUNNER_TOKEN_FILE}</code> 에 저장하고, 설정
            파일을 <code className="font-mono">{RUNNER_CONFIG_PATH}</code> 에 둡니다. 예시:
          </p>
          <CopyBlock text={config} label="설정 예시 복사" />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>러너를 실행합니다. 붙으면 위 목록에 나타납니다.</p>
          <CopyBlock text="dodok-runner" label="실행 명령 복사" />
        </li>
      </ol>
    </div>
  );
}

/**
 * 연결 페이지 러너 블록(러너 스펙 5장·7장, owner): 붙은 러너, 러너 토큰(목록·발급·폐기), 설치 안내, 그리고 드러나는 것 셋.
 * 연결 여부·러너 목록은 `setup.status` 를 믿는다 — 토큰 수 같은 wire `adapter.status` 는 발급·폐기 때 바로 안 나갈 수 있다
 */
export function RunnerSection({ status }: { status: SetupStatus | undefined }) {
  const tokens = useRunnerTokens();
  const issueButton = useRef<HTMLButtonElement>(null);
  return (
    <Section title="Claude 러너">
      <p className="text-sm text-muted-foreground">
        러너는 사람의 PC 에서 Claude Code 에이전트를 돌리고, 이 서버로 나가는 연결 하나로 붙습니다.
      </p>
      <div role="note" className="flex flex-col gap-1 rounded-md border border-amber-600/40 p-3 text-sm">
        <p className="font-medium">러너를 붙이면 드러나는 것</p>
        <ul className="flex list-disc flex-col gap-1 pl-5">
          <li>
            러너 계정의 이메일이 에이전트 문맥에 들어갑니다(끌 방법이 없습니다). 러너 전용 계정을 권합니다.
          </li>
          <li>
            채널 멤버는 에이전트를 통해 러너 작업 디렉터리 안의 파일을 읽을 수 있습니다. 그 에이전트를 어느
            채널에 둘지는 admin 이 판단합니다.
          </li>
          <li>
            에이전트는 러너 토큰에 묶여 그 토큰의 러너만 맡습니다 — 등록할 때 그 id 를 알리던 러너, 그때
            없었으면 처음 알리는 러너에 묶입니다. 러너 없이 등록한 에이전트는 먼저 붙은 러너가 가져가니 토큰은
            믿는 머신에만 주십시오. 토큰을 폐기해도 묶임은 남습니다 — 새 러너로 옮길 때는 그 러너 카드의 「이
            러너로 묶기」를 누릅니다.
          </li>
        </ul>
      </div>
      {status &&
        (status.runners.list.length === 0 ? (
          <p className="text-sm">연결된 러너가 없습니다.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {status.runners.list.map((runner) => (
              <RunnerCard
                key={runner.tokenId}
                runner={runner}
                file={status.runners.runnerFile}
                tokens={tokens.data}
              />
            ))}
          </div>
        ))}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-medium">러너 토큰</h3>
          <IssueRunnerTokenDialog triggerRef={issueButton} />
        </div>
        {tokens.data ? (
          tokens.data.length > 0 && (
            <RunnerTokenList tokens={tokens.data} status={status} issueButton={issueButton} />
          )
        ) : tokens.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            불러오는 중…
          </p>
        ) : (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">러너 토큰 목록을 불러오지 못했습니다</p>
            <Button variant="outline" size="sm" onClick={() => void tokens.refetch()}>
              다시 시도
            </Button>
          </div>
        )}
      </div>
      {status && <InstallSteps status={status} />}
    </Section>
  );
}
