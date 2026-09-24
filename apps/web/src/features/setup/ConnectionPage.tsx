import type { SetupStatus } from "@dodok/shared";
import { useRef } from "react";
import { useIsOwner } from "@/api/queries";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { Button } from "@/ui/button";
import { IssueTokenDialog } from "./IssueTokenDialog";
import { useBridgeTokens, useSetupStatus } from "./queries";
import { GatewaySection, PluginSection, Section, ServerSection } from "./sections";
import { TokenList } from "./TokenList";

/** `.env` 의 BRIDGE_TOKEN 을 고쳐 교체하려는 사람이 「왜 안 붙지?」 대신 보게 할 문장(스펙 「오류 처리」) */
export const ENV_TOKEN_IGNORED = ".env 의 BRIDGE_TOKEN 은 더 이상 쓰지 않습니다 — 연결 페이지에서 발급하세요";

/** 받은 값이 없을 때만 그리는 불러오기·실패 자리 — 이미 받은 값은 다시 불러오기가 실패해도 그대로 그린다 */
function Pending({ what, query }: { what: string; query: { isPending: boolean; refetch: () => unknown } }) {
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

function BridgeTokenSection({ status }: { status: SetupStatus | undefined }) {
  const tokens = useBridgeTokens();
  const issueButton = useRef<HTMLButtonElement>(null);
  const none = tokens.data !== undefined && tokens.data.every((t) => t.revokedAt !== null);
  return (
    <Section title="브리지 토큰">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-muted-foreground">
          플러그인이 이 서버에 붙을 때 쓰는 토큰입니다. 새 토큰을 넣고 다시 붙은 뒤 옛 토큰을 폐기하면
          에이전트가 멈추지 않습니다.
          {status && (
            <>
              {" "}
              브리지 주소 <code className="font-mono break-all">{status.bridge.publicUrl}</code>
            </>
          )}
        </p>
        <IssueTokenDialog triggerRef={issueButton} />
      </div>
      {status?.envTokenIgnored && (
        <p role="note" className="text-sm font-medium text-amber-700 dark:text-amber-400">
          {ENV_TOKEN_IGNORED}
        </p>
      )}
      {none && <p className="text-sm font-medium text-destructive">토큰이 없습니다 — 발급하세요</p>}
      {tokens.data ? (
        tokens.data.length > 0 && <TokenList tokens={tokens.data} status={status} issueButton={issueButton} />
      ) : (
        <Pending what="토큰 목록" query={tokens} />
      )}
    </Section>
  );
}

function OwnerContent() {
  const status = useSetupStatus();
  return (
    <>
      {status.data ? (
        <>
          <ServerSection status={status.data} />
          <GatewaySection status={status.data} />
          <PluginSection status={status.data} />
        </>
      ) : (
        <Pending what="연결 상태" query={status} />
      )}
      <BridgeTokenSection status={status.data} />
    </>
  );
}

/**
 * 연결 페이지(스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md` 「연결 페이지」): 서버·Gateway·플러그인·
 * 브리지 토큰의 상태와 다음에 할 일. owner 만 본다 — 아니면 setup API 를 부르지 않고 「권한이 없습니다」. role 이 없는 옛 me 도 owner 가 아니다
 */
export function ConnectionPage() {
  const owner = useIsOwner();
  return (
    <section
      data-testid="page-connection"
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <OpenSidebarButton />
          <h1 className="text-xl font-semibold">연결</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          OpenClaw Gateway·플러그인과 이 서버가 어떻게 붙어 있는지 보고, 할 일과 명령을 복사합니다.
        </p>
      </header>
      {owner ? (
        <OwnerContent />
      ) : (
        <p className="text-sm text-muted-foreground">
          권한이 없습니다 — 연결 설정은 워크스페이스 owner 만 볼 수 있습니다.
        </p>
      )}
    </section>
  );
}
