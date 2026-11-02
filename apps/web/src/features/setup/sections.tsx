import { PLUGIN_INSTALL_SCRIPT_PATH, type SetupStatus } from "@dodok/shared";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";

/** 페어링 승인을 이만큼 넘게 기다리면 강조한다(스펙 「연결 페이지」) */
export const PAIRING_STALE_MS = 5 * 60_000;
/** 플러그인을 만드는 명령(스펙 「오류 처리」 — 서버에 파일이 없을 때) */
export const PACK_COMMAND = "pnpm -F @dodok/openclaw-plugin run pack:plugin";

/**
 * 연결 페이지의 한 섹션 — 제목이 이름인 region. 설정 패널의 `Section` 과 같은 꼴에 페이지 제목(h1) 아래 단계(h2).
 * Gateway 카드처럼 섹션 안에 섹션을 둘 때는 `level` 로 제목 단계를 내리고 테두리를 뺀다(`bare`)
 */
export function Section({
  title,
  level = 2,
  bare = false,
  className,
  children,
}: {
  title: string;
  level?: 2 | 3 | 4;
  bare?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const Heading = `h${level}` as const;
  return (
    <section
      aria-labelledby={id}
      className={cn("flex flex-col gap-3", !bare && "rounded-lg border p-4", className)}
    >
      <Heading id={id} className="text-sm font-semibold">
        {title}
      </Heading>
      {children}
    </section>
  );
}

/** 받은 값이 없을 때만 그리는 불러오기·실패 자리 — 이미 받은 값은 다시 불러오기가 실패해도 그대로 그린다 */
export function Pending({
  what,
  query,
}: {
  what: string;
  query: { isPending: boolean; refetch: () => unknown };
}) {
  if (query.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        불러오는 중…
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm text-muted-foreground">{what}을 불러오지 못했습니다</p>
      <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
        다시 시도
      </Button>
    </div>
  );
}

/** 이름·값 한 줄 */
export function Field({ name, children }: { name: string; children: ReactNode }) {
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

/** Gateway 가 없을 때(멀티 Gateway 스펙 「웹」 절의 빈 상태) */
export const NO_GATEWAY = "OpenClaw Gateway 를 추가하면 그 안의 에이전트를 채널에 데려올 수 있습니다";

/**
 * Gateway 호스트에 붙여 넣는 설치·업데이트 한 줄(설치 한 줄 명령 스펙 2026-11-02 「3. 웹」) — 서버의 설치 스크립트가 받기·sha256 대조·
 * Gateway 내리기·설치·계정 설정·올리기를 다 한다. 맨 앞 공백 한 칸은 우분투 기본 bash(`HISTCONTROL=ignoreboth`)가 이 줄을 히스토리에
 * 남기지 않게 한다. 토큰은 bash 의 환경 변수로만 간다(curl·스크립트의 argv 에 없다). `docs/guides/docker-deploy.md` 의 예시 줄과
 * `connection.test.tsx` 가 대조한다
 */
export function pluginInstallCommand(origin: string, token: string): string {
  return ` curl -fsS ${origin}${PLUGIN_INSTALL_SCRIPT_PATH} | DODOK_BRIDGE_TOKEN='${token}' bash`;
}

/**
 * 「플러그인 설치」 — OpenClaw 블록 머리에 한 번(멀티 Gateway 스펙 결정 10 — tgz 는 서버에 하나다). 설치·업데이트는 Gateway 카드의
 * 「새 토큰 발급」이 주는 한 줄로 하므로 여기는 그 안내만 둔다. 서버에 파일이 없으면 만드는 법을 보인다
 */
export function PluginInstall({ status }: { status: SetupStatus }) {
  return (
    <Section title="플러그인 설치" level={3} bare>
      {status.pluginFile.available ? (
        <p className="text-sm text-muted-foreground">
          설치·업데이트는 각 Gateway 카드의 「새 토큰 발급」이 주는 명령 한 줄로 합니다. Gateway 가 여럿이면
          호스트마다 그 카드에서 발급해 돌립니다.
        </p>
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
