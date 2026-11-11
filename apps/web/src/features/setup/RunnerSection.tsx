import type { SetupStatus } from "@dodok/shared";
import { DownloadIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ApiRequestError } from "@/api/http";
import { Button } from "@/ui/button";
import { publicOriginOf } from "./llms";
import { useDownloadRunner } from "./mutations";
import { CopyBlock } from "./sections";

/** 러너 tgz 를 만드는 명령 — 서버에 파일이 없을 때 */
export const RUNNER_PACK_COMMAND = "pnpm -F @dodok/runner run pack:runner";
/** npm 레지스트리 설치 명령 — 설치의 기본 길 */
export const RUNNER_NPM_INSTALL_COMMAND = "npm i -g @dodok/runner";
/** 받은 tgz 설치 명령(「서버와 같은 빌드로 설치」) */
export const runnerInstallCommand = (fileName: string) => `npm install -g ./${fileName}`;
/** 실행 명령 — 설정 파일이 없으면 러너가 터미널에서 서버 주소·토큰·루트를 묻고 설정을 만든다 */
export const RUNNER_RUN_COMMAND = "dodok-runner";
/** 다시 발급한 토큰을 넣을 때 — 설정이 이미 있으니 마법사를 다시 연다(덮기 전에 묻고 옛 파일은 .bak) */
export const RUNNER_SETUP_COMMAND = "dodok-runner setup";

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

/** 라벨과 복사 블록 한 칸 — 토큰 대화상자의 칸과 같은 꼴 */
function CopyField({
  name,
  text,
  label,
  testId,
}: {
  name: string;
  text: string;
  label: string;
  testId?: string;
}) {
  return (
    <div className="grid min-w-0 gap-1.5">
      <p className="text-sm font-medium">{name}</p>
      <CopyBlock text={text} label={label} testId={testId} />
    </div>
  );
}

/**
 * 토큰 발급·다시 발급 대화상자의 러너 안내 — 원문(「토큰」 칸) 아래에 설치·실행·서버 주소. 실행하면 러너가 서버 주소와 토큰을 묻는다.
 * 다시 발급이면 이미 설치·설정한 러너라 설치를 빼고 마법사를 다시 여는 명령을 보인다
 */
export function RunnerQuickStart({ serverUrl, reissue = false }: { serverUrl: string; reissue?: boolean }) {
  return (
    <>
      {!reissue && <CopyField name="설치" text={RUNNER_NPM_INSTALL_COMMAND} label="설치 명령 복사" />}
      <CopyField
        name="실행"
        text={reissue ? RUNNER_SETUP_COMMAND : RUNNER_RUN_COMMAND}
        label="실행 명령 복사"
        testId="runner-run-command"
      />
      <CopyField name="서버 주소" text={serverUrl} label="서버 주소 복사" testId="runner-server-url" />
    </>
  );
}

/**
 * 설치 안내(러너 스펙 5장) — npm 설치(서버와 같은 빌드는 접힌 대안) → 실행 → 실행하면 묻는 값. 러너 상세의 「설치 안내」가 그린다
 * (연결 탭 통합 스펙 3.3). 토큰 원문은 발급 대화상자에서만 보인다
 */
export function InstallSteps({ status }: { status: SetupStatus }) {
  const serverUrl = publicOriginOf(status.bridge.publicUrl);
  return (
    <ol className="flex list-decimal flex-col gap-4 pl-5 text-sm">
      <li className="flex flex-col gap-1.5">
        <p>설치</p>
        <CopyBlock text={RUNNER_NPM_INSTALL_COMMAND} label="설치 명령 복사" />
        <SameBuildInstall file={status.runners.runnerFile} />
      </li>
      <li className="flex flex-col gap-1.5">
        <p>실행</p>
        <CopyBlock text={RUNNER_RUN_COMMAND} label="실행 명령 복사" />
      </li>
      <li className="flex flex-col gap-1.5">
        <p>실행하면 묻는 값</p>
        <dl className="flex flex-col gap-1.5">
          <div className="flex flex-col gap-1.5">
            <dt className="text-muted-foreground">서버 주소</dt>
            <dd>
              <CopyBlock text={serverUrl} label="서버 주소 복사" />
            </dd>
          </div>
          <div className="flex flex-wrap gap-x-2">
            <dt className="text-muted-foreground">러너 토큰</dt>
            <dd>발급할 때 받은 원문</dd>
          </div>
        </dl>
      </li>
    </ol>
  );
}
