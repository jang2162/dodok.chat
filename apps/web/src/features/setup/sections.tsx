import type { SetupStatus } from "@dodok/shared";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useNowTick } from "@/hooks/useNowTick";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { useDownloadPlugin } from "./mutations";

/** 페어링 승인을 이만큼 넘게 기다리면 강조한다(스펙 「연결 페이지」) */
export const PAIRING_STALE_MS = 5 * 60_000;
/** 플러그인을 만드는 명령(스펙 「오류 처리」 — 서버에 파일이 없을 때) */
export const PACK_COMMAND = "pnpm -F @dodok/openclaw-plugin run pack:plugin";

/** 연결 페이지의 한 섹션 — 제목(h2)이 이름인 region. 설정 패널의 `Section` 과 같은 꼴에 페이지 제목(h1) 아래 단계 */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id={id} className="text-sm font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** 이름·값 한 줄 */
function Field({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <dt className="text-muted-foreground">{name}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </div>
  );
}

/**
 * 복사 버튼 — `navigator.clipboard.writeText`. 실패(권한·비보안 출처)하면 옆의 텍스트를 직접 선택해 복사하라고 알린다.
 * 결과 문구는 비어 있는 채로 늘 두는 라이브 영역에 쓴다(새로 끼운 영역은 스크린 리더가 놓칠 수 있다)
 */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button type="button" size="xs" variant="outline" aria-label={label} onClick={() => void copy()}>
        {state === "copied" ? <CheckIcon /> : <CopyIcon />}
        복사
      </Button>
      <span aria-live="polite" className="text-xs text-muted-foreground">
        {state === "copied"
          ? "복사됨"
          : state === "failed"
            ? "복사하지 못했습니다 — 직접 선택해 복사하세요"
            : ""}
      </span>
    </span>
  );
}

/**
 * 복사할 명령·설정 — 선택 가능한 고정폭 블록과 복사 버튼. 원문은 한 글자도 가리지 않는다: 기본은 줄 구조를 지키고 넘치는 폭을
 * 블록 안에서 가로로 스크롤한다(명령·JSON 은 줄바꿈이 뜻을 바꾼다). `wrap` 이면 아무 글자 사이에서나 줄을 바꿔 전부 보인다
 * (공백 없는 한 줄 — 토큰). 래퍼의 `min-w-0` 은 grid 트랙 안에서 원문 폭이 트랙을 넓혀 대화상자 밖으로 삐져나가지 않게 한다
 */
export function CopyBlock({
  text,
  label,
  testId,
  wrap = false,
}: {
  text: string;
  label: string;
  testId?: string;
  wrap?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1.5">
      <pre
        data-testid={testId}
        className={cn(
          "w-full rounded-md bg-muted px-3 py-2 font-mono text-xs select-all",
          wrap ? "break-all whitespace-pre-wrap" : "overflow-x-auto whitespace-pre",
        )}
      >
        {text}
      </pre>
      <CopyButton text={text} label={label} />
    </div>
  );
}

export function ServerSection({ status }: { status: SetupStatus }) {
  return (
    <Section title="서버">
      <dl>
        <Field name="버전">{status.server.version}</Field>
      </dl>
    </Section>
  );
}

const GATEWAY_STATE: Record<SetupStatus["gateway"]["state"], string> = {
  connected: "연결됨",
  reconnecting: "다시 연결하는 중",
  down: "연결 안 됨",
};

/**
 * Gateway — 상태·호스트·버전과 다음에 할 일(스펙 「연결 페이지」). 페어링 대기면 승인 명령(요청 id 를 못 받았으면 목록 명령)을,
 * 대기가 5분을 넘으면 강조한다. 그 밖에 `down` 이면 `.env`·서버 로그를 보라고 한다
 */
export function GatewaySection({ status }: { status: SetupStatus }) {
  const { gateway } = status;
  const pairing = gateway.pairing;
  // 기다리는 동안만 1초마다 다시 본다 — 5분 경계를 넘는 순간 강조가 켜진다
  const now = useNowTick(pairing !== null);
  const stale = pairing !== null && now - Date.parse(pairing.since) > PAIRING_STALE_MS;
  return (
    <Section title="Gateway">
      <dl className="flex flex-col gap-1">
        <Field name="상태">{GATEWAY_STATE[gateway.state]}</Field>
        <Field name="호스트">{gateway.host}</Field>
        <Field name="버전">{gateway.version ?? "모름"}</Field>
      </dl>
      {pairing ? (
        <div
          data-stale={stale || undefined}
          className={cn(
            "flex flex-col gap-2 rounded-md border p-3 text-sm",
            stale && "border-destructive bg-destructive/10",
          )}
        >
          <p>
            Gateway 가 이 서버의 기기 페어링 승인을 기다립니다
            {pairing.requestId && (
              <>
                {" "}
                (요청 id <code className="font-mono">{pairing.requestId}</code>)
              </>
            )}
            .
          </p>
          {stale && <p className="font-medium text-destructive">5분 넘게 승인을 기다리고 있습니다.</p>}
          {pairing.requestId ? (
            <>
              <p className="text-muted-foreground">Gateway 호스트에서 승인하세요.</p>
              <CopyBlock text={`openclaw devices approve ${pairing.requestId}`} label="승인 명령 복사" />
            </>
          ) : (
            <>
              <p className="text-muted-foreground">
                요청 id 를 받지 못했습니다 — Gateway 호스트에서 목록을 보고 이 서버의 요청을 승인하세요.
              </p>
              <CopyBlock text="openclaw devices list" label="목록 명령 복사" />
            </>
          )}
        </div>
      ) : (
        gateway.state === "down" && (
          <p className="text-sm text-muted-foreground">
            서버의 <code className="font-mono">.env</code> 에 있는{" "}
            <code className="font-mono">OPENCLAW_GATEWAY_URL</code>·
            <code className="font-mono">OPENCLAW_GATEWAY_TOKEN</code> 과 서버 로그를 확인하세요.
          </p>
        )
      )}
    </Section>
  );
}

/**
 * Gateway 호스트에서 돌릴 설치 명령 — `docs/guides/deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」 절의 [B] 블록이 정본이다.
 * 그 블록의 줄을 글자 그대로 옮기고 계정 설정 패치 줄만 뺀다(토큰은 「새 토큰 발급」이 따로 준다). 다른 것은 둘뿐이다 —
 * 받은 파일 이름, 번들 sha256 을 대조할 값(deploy.md 는 [PC] 에서 잰 값, 여기는 서버가 품은 번들의 값 — 스펙 「결정」 번들 파일 sha256).
 * `connection.test.tsx` 가 그 블록과 대조하므로 문서가 바뀌면 테스트가 알린다
 */
export function installCommands(fileName: string, bundleSha256: string): string {
  return [
    "# Gateway 를 내린다(호스트가 Gateway 를 돌리는 방식대로)",
    `openclaw plugins install /tmp/${fileName} --force --accept-capabilities`,
    `openclaw plugins inspect dodok --json | jq '.plugin.status, .plugin.channelIds'   # "loaded", ["dodok"]`,
    `sha256sum ~/.openclaw/extensions/dodok/dist/index.js      # 기본 상태 디렉터리일 때. ${bundleSha256} 이어야 한다(macOS 는 shasum -a 256)`,
    "# Gateway 를 올린다",
  ].join("\n");
}

/** 받기 실패 문구 — 서버 메시지 앞머리로 가른다(api/http 의 봉투 message) */
function downloadError(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.message === "PLUGIN_FILE_MISSING")
      return `서버에서 플러그인 파일을 찾지 못했습니다 — 저장소에서 ${PACK_COMMAND} 로 만든 뒤 서버를 재시작하세요.`;
    if (e.message.startsWith("PLUGIN_FILE_CHANGED"))
      return "플러그인 파일이 그새 다시 빌드됐습니다 — 서버를 재시작하면 새 파일을 받습니다.";
    return e.message;
  }
  return "플러그인 파일을 받지 못했습니다 — 서버 연결을 확인하세요.";
}

/** 접속 플러그인이 서버가 품은 파일과 같은 빌드인가(스펙 「연결 페이지」·「오류 처리」) */
function BuildMatch({ status }: { status: SetupStatus }) {
  const plugin = status.bridge.plugin;
  if (!plugin) return null;
  if (status.pluginMatches === true)
    return <p className="text-sm text-muted-foreground">서버와 같은 빌드입니다</p>;
  if (status.pluginMatches === false)
    return (
      <p role="alert" className="text-sm font-medium text-destructive">
        다른 빌드입니다 — 받아서 다시 설치하세요
      </p>
    );
  // 모름 — 플러그인이 번들 sha 를 안 보냈거나(옛 빌드) 서버에 비교할 파일이 없다
  if (plugin.bundleSha256 === null)
    return <p className="text-sm text-muted-foreground">빌드를 알 수 없습니다 — 새로 받아 설치하세요</p>;
  return (
    <p className="text-sm text-muted-foreground">서버에 플러그인 파일이 없어 같은 빌드인지 알 수 없습니다</p>
  );
}

/**
 * 플러그인 — 접속 여부·버전·같은 빌드인가, 「플러그인 받기」(sha256)와 설치 명령. 받기는 `pluginFile.available` 로만 그리고,
 * 없으면 만드는 법을 보인다
 */
export function PluginSection({ status }: { status: SetupStatus }) {
  const plugin = status.bridge.plugin;
  const file = status.pluginFile;
  const download = useDownloadPlugin();
  const fileName = file.available ? `dodok-openclaw-plugin-${file.sha256.slice(0, 12)}.tgz` : "";
  return (
    <Section title="플러그인">
      {plugin ? (
        <dl className="flex flex-col gap-1">
          <Field name="상태">접속됨</Field>
          <Field name="플러그인">{plugin.version}</Field>
          <Field name="SDK">{plugin.sdkVersion}</Field>
          <Field name="Gateway">{plugin.gatewayVersion ?? "모름"}</Field>
        </dl>
      ) : (
        <p className="text-sm">접속한 플러그인이 없습니다.</p>
      )}
      <BuildMatch status={status} />
      {file.available ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col items-start gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={download.isPending}
              onClick={() => download.mutate(fileName)}
            >
              <DownloadIcon />
              플러그인 받기
            </Button>
            <dl className="flex flex-col gap-1 text-xs">
              <Field name="파일 sha256">
                <code className="font-mono">{file.sha256}</code>
              </Field>
              <Field name="번들 sha256">
                <code className="font-mono">{file.bundleSha256}</code>
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
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="text-sm text-muted-foreground">
              받은 파일을 Gateway 호스트의 <code className="font-mono">/tmp</code> 로 옮긴 뒤 그 호스트에서
              돌립니다. 떠 있는 Gateway 에 설치하면 파일이 바뀌지 않을 수 있어 먼저 내립니다.
            </p>
            <CopyBlock
              text={installCommands(fileName, file.bundleSha256)}
              label="설치 명령 복사"
              testId="plugin-install-commands"
            />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <p className="text-sm text-muted-foreground">
            서버에 플러그인 파일이 없습니다. 저장소에서 만든 뒤 서버를 재시작하세요.
          </p>
          <CopyBlock text={PACK_COMMAND} label="만드는 명령 복사" />
        </div>
      )}
    </Section>
  );
}
