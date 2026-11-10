import type { SetupStatus } from "@dodok/shared";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ApiRequestError } from "@/api/http";
import { Button } from "@/ui/button";
import { publicOriginOf } from "./llms";
import { useDownloadRunner } from "./mutations";
import { RUNNER_CLAUDE_DIR, RUNNER_CONFIG_PATH, runnerConfigExample } from "./runnerConfig";
import { CopyBlock } from "./sections";

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
          <code className="font-mono">"configDir": "{RUNNER_CLAUDE_DIR}"</code> 를 적습니다.
        </p>
      </div>
    </details>
  );
}

/**
 * 설치 안내(러너 스펙 5장) — npm 설치(서버와 같은 빌드는 접힌 대안) → 로그인(평소, 전용은 접힌 선택) → 설정 파일 → 실행. 러너 상세의
 * 「설치 안내」가 그린다(연결 탭 통합 스펙 3.3). 2단계(로그인)의 명령·문구는 러너 평소 로그인 작업의 것 그대로
 */
export function InstallSteps({ status }: { status: SetupStatus }) {
  const config = runnerConfigExample({
    serverUrl: publicOriginOf(status.bridge.publicUrl),
    tokenFile: RUNNER_TOKEN_FILE,
  });
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">설치</h3>
      <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
        <li className="flex flex-col gap-1.5">
          <p>npm 으로 설치</p>
          <CopyBlock text={RUNNER_NPM_INSTALL_COMMAND} label="설치 명령 복사" />
          <SameBuildInstall file={status.runners.runnerFile} />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>
            Claude Code 로그인(<code className="font-mono">/login</code>, 돼 있으면 건너뜀)
          </p>
          <CopyBlock text={RUNNER_LOGIN_COMMAND} label="로그인 명령 복사" />
          <p className="text-muted-foreground">
            <code className="font-mono">claude</code> 가 없으면 번들 CLI
          </p>
          <CopyBlock text={RUNNER_LOGIN_BUNDLED_COMMAND} label="번들 CLI 로그인 명령 복사" />
          <DedicatedLogin />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>
            러너 토큰을 <code className="font-mono">{RUNNER_TOKEN_FILE}</code> 에 저장하고, 설정 파일을{" "}
            <code className="font-mono">{RUNNER_CONFIG_PATH}</code> 에 둡니다.
          </p>
          <CopyBlock text={config} label="설정 예시 복사" />
        </li>
        <li className="flex flex-col gap-1.5">
          <p>실행</p>
          <CopyBlock text="dodok-runner" label="실행 명령 복사" />
        </li>
      </ol>
    </div>
  );
}
