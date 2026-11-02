import type { SetupStatus } from "@dodok/shared";
import { Link } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useRef } from "react";
import { ApiRequestError } from "@/api/http";
import { Button } from "@/ui/button";
import { IssueRunnerTokenDialog } from "./IssueRunnerTokenDialog";
import { publicOriginOf } from "./llms";
import { useDownloadRunner } from "./mutations";
import { useRunnerTokens } from "./queries";
import { RUNNER_CLAUDE_DIR, RUNNER_CONFIG_PATH, runnerConfigExample } from "./runnerConfig";
import { RunnerTokenList } from "./RunnerTokenList";
import { CopyBlock, Section } from "./sections";

/** 러너 tgz 를 만드는 명령 — 서버에 파일이 없을 때 */
export const RUNNER_PACK_COMMAND = "pnpm -F @dodok/runner run pack:runner";
/** 평소 Claude Code 로그인 — 러너는 기본으로 이 머신의 `~/.claude` 로그인을 쓴다(설정에 configDir 이 없을 때) */
export const RUNNER_LOGIN_COMMAND = "claude";
/** 러너가 품은 번들 CLI — `claude` 가 PATH 에 없을 때. 플랫폼별 패키지 디렉터리 이름은 SDK 판에 따라 다를 수 있다(docker-deploy.md 「러너 설치」) */
const RUNNER_BUNDLED_CLI = `"$(npm root -g)/@dodok/runner/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')/claude"`;
/** `claude` 가 PATH 에 없을 때 — 번들 CLI 로 같은 평소 자리에 로그인(docker-deploy.md 「러너 설치」와 같은 명령) */
export const RUNNER_LOGIN_BUNDLED_COMMAND = RUNNER_BUNDLED_CLI;
/** 러너 전용 로그인을 원할 때 — 그 디렉터리에 로그인하고 설정에 configDir 을 적는다 */
export const RUNNER_DEDICATED_LOGIN_COMMAND = `CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} claude`;
/** 전용 로그인의 번들 CLI 판 */
const RUNNER_DEDICATED_LOGIN_BUNDLED_COMMAND = `CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} ${RUNNER_BUNDLED_CLI}`;
/** npm 레지스트리 설치 명령 — 설치의 기본 길 */
export const RUNNER_NPM_INSTALL_COMMAND = "npm i -g @dodok/runner";
/** 받은 tgz 설치 명령(「서버와 같은 빌드로 설치」) */
export const runnerInstallCommand = (fileName: string) => `npm install -g ./${fileName}`;
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

/**
 * 서버가 품은 tgz 로 설치 — npm 판은 태그를 민 커밋의 빌드라 서버와 다를 수 있다. 서버와 같은 커밋의 빌드가 필요할 때의 대안이라
 * 접어 둔다(받기·파일 sha256·크기·설치 명령, 서버에 파일이 없으면 만드는 명령)
 */
function SameBuildInstall({ file }: { file: SetupStatus["runners"]["runnerFile"] }) {
  const download = useDownloadRunner();
  const fileName = file.available ? `dodok-claude-runner-${file.sha256.slice(0, 12)}.tgz` : "";
  return (
    <details aria-label="서버와 같은 빌드로 설치" className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer select-none">서버와 같은 빌드로 설치</summary>
      <div className="mt-2 flex flex-col gap-1.5">
        <p className="text-muted-foreground">
          npm 판은 서버와 다른 커밋의 빌드일 수 있습니다. 서버와 같은 빌드가 필요하면 서버가 품은 러너 파일을
          받아 설치합니다.
        </p>
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
            <CopyBlock text={runnerInstallCommand(fileName)} label="파일 설치 명령 복사" />
          </>
        ) : (
          <>
            <p className="text-muted-foreground">
              서버에 러너 파일이 없습니다. 저장소에서 만든 뒤 서버를 재시작하세요.
            </p>
            <CopyBlock text={RUNNER_PACK_COMMAND} label="만드는 명령 복사" />
          </>
        )}
      </div>
    </details>
  );
}

/**
 * 전용 로그인 — 원하는 사람만(러너 평소 로그인 스펙 4.4). 접어 둔다: 그 디렉터리에 로그인하고 설정에 configDir 을 적는다
 */
function DedicatedLogin() {
  return (
    <details aria-label="러너 전용 로그인을 따로 쓰려면" className="rounded-md border px-3 py-2">
      <summary className="cursor-pointer select-none">러너 전용 로그인을 따로 쓰려면</summary>
      <div className="mt-2 flex flex-col gap-1.5">
        <CopyBlock text={RUNNER_DEDICATED_LOGIN_COMMAND} label="전용 로그인 명령 복사" />
        <CopyBlock text={RUNNER_DEDICATED_LOGIN_BUNDLED_COMMAND} label="전용 로그인 번들 CLI 명령 복사" />
        <p className="text-muted-foreground">
          설정의 <code className="font-mono">programs.claude</code> 에{" "}
          <code className="font-mono">"configDir": "{RUNNER_CLAUDE_DIR}"</code> 를 적습니다. 전용 로그인이면
          대화 기록도 그 디렉터리에 따로 남습니다.
        </p>
      </div>
    </details>
  );
}

/** 설치 안내(러너 스펙 5장) — npm 설치(서버와 같은 빌드는 접힌 대안) → 로그인(평소, 전용은 접힌 선택) → 설정 파일 → 실행 */
function InstallSteps({ status }: { status: SetupStatus }) {
  const config = runnerConfigExample({
    serverUrl: publicOriginOf(status.bridge.publicUrl),
    tokenFile: RUNNER_TOKEN_FILE,
  });
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">설치</h3>
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li className="flex flex-col gap-1.5">
          <p>러너를 돌릴 머신에 npm 으로 설치합니다. Claude Agent SDK 도 이때 npm 에서 받습니다.</p>
          <CopyBlock text={RUNNER_NPM_INSTALL_COMMAND} label="설치 명령 복사" />
          <SameBuildInstall file={status.runners.runnerFile} />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>
            러너는 이 머신의 평소 Claude Code 로그인을 씁니다. <code className="font-mono">claude</code> 로
            로그인돼 있으면 건너뜁니다. 아니면 <code className="font-mono">claude</code> 를 열어{" "}
            <code className="font-mono">/login</code> 을 마치고 나옵니다.
          </p>
          <CopyBlock text={RUNNER_LOGIN_COMMAND} label="로그인 명령 복사" />
          <p className="text-muted-foreground">
            <code className="font-mono">claude</code> 명령이 없으면 러너가 품은 번들 CLI 로 로그인합니다.
          </p>
          <CopyBlock text={RUNNER_LOGIN_BUNDLED_COMMAND} label="번들 CLI 로그인 명령 복사" />
          <p className="text-muted-foreground">
            러너 런은 평소 계정으로 돌기 때문에 계정 이메일이 에이전트에게 보이고, 대화 기록이 이 머신의{" "}
            <code className="font-mono">claude --resume</code> 목록에도 남습니다.
          </p>
          <DedicatedLogin />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>
            위에서 러너 토큰을 발급해 <code className="font-mono">{RUNNER_TOKEN_FILE}</code> 에 저장하고, 설정
            파일을 <code className="font-mono">{RUNNER_CONFIG_PATH}</code> 에 둡니다.{" "}
            <code className="font-mono">roots</code> 는 에이전트가 돌 수 있는 디렉터리(좁게)이고, 루트의{" "}
            <code className="font-mono">label</code> 을 꼭 적습니다 — 안 적으면 디렉터리 이름이 서버로 갑니다.{" "}
            <code className="font-mono">programs</code> 의 권한 상한(
            <code className="font-mono">maxPermissionMode</code>) 위로는 앱에서도 고를 수 없습니다. 예시:
          </p>
          <CopyBlock text={config} label="설정 예시 복사" />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>
            러너를 실행합니다. 붙으면 토큰 줄에 「지금 접속 중」이 붙고, 러너 탭에서 프로젝트를 더할 수
            있습니다.
          </p>
          <CopyBlock text="dodok-runner" label="실행 명령 복사" />
        </li>
      </ol>
    </div>
  );
}

/**
 * 연결 페이지 러너 블록(러너 일반화 스펙 7장, owner): 러너 토큰(목록·발급·다시 발급·폐기), 설치 안내, 드러나는 것 넷. 러너의 연결 상태·
 * 프로그램·프로젝트는 설정의 「러너」 탭(admin 이상)이 맡는다. 토큰 줄의 「지금 접속 중」은 `setup.status` 를 믿는다 — 토큰 수 같은
 * wire `adapter.status` 는 발급·폐기 때 바로 안 나갈 수 있다
 */
export function RunnerSection({ status }: { status: SetupStatus | undefined }) {
  const tokens = useRunnerTokens();
  const issueButton = useRef<HTMLButtonElement>(null);
  return (
    <Section title="러너">
      <p className="text-sm text-muted-foreground">
        러너는 사람의 머신에서 에이전트(지금은 Claude Code)를 돌리고, 이 서버로 나가는 연결 하나로 붙습니다.
        러너의 상태와 프로젝트는{" "}
        <Link to="/settings/runners" className="underline underline-offset-4">
          러너 탭
        </Link>
        에서 봅니다.
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
            토큰 하나가 그 러너의 모든 에이전트를 맡습니다. 토큰은 믿는 머신에만 주십시오 — 새는 것이 걱정되면
            「다시 발급」으로 원문을 바꿉니다(프로젝트·에이전트는 그대로).
          </li>
          <li>
            서버 쪽 admin(과 서버를 손에 넣은 사람)은 루트 안 아무 디렉터리에서, 권한 상한까지의 도구로
            에이전트를 돌릴 수 있습니다. 루트는 좁게, 상한은 낮게 둡니다.
          </li>
        </ul>
      </div>
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
