import type { SetupStatus } from "@dodok/shared";
import { PlusIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useIsOwner } from "@/api/queries";
import { OpenSidebarButton } from "@/app/layout/sidebarSheet";
import { Button } from "@/ui/button";
import { GatewayCard } from "./GatewayCard";
import { GatewayForm } from "./GatewayForm";
import { useSetupStatus } from "./queries";
import { RunnerSection } from "./RunnerSection";
import { NO_GATEWAY, Pending, PluginDownload, Section, ServerSection } from "./sections";

/**
 * OpenClaw 블록(멀티 Gateway 스펙 「웹」 절의 「연결 페이지」) — 머리에 「플러그인 받기」와 「Gateway 추가」, 그 아래 Gateway 카드 목록.
 * 카드를 지우면 그 자리가 사라지므로 초점을 「Gateway 추가」로 옮기고 결과를 늘 두는 라이브 영역에 알린다
 */
function OpenClawSection({ status }: { status: SetupStatus }) {
  const addButton = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState("");
  const add = (
    <GatewayForm
      trigger={
        <Button ref={addButton} type="button" size="sm">
          <PlusIcon />
          Gateway 추가
        </Button>
      }
    />
  );
  return (
    <Section title="OpenClaw Gateway">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          Gateway 마다 플러그인을 설치하고 그 Gateway 의 브리지 토큰을 넣습니다.
        </p>
        {add}
      </div>
      <PluginDownload status={status} />
      <p aria-live="polite" className="text-sm text-muted-foreground empty:hidden">
        {notice}
      </p>
      {status.gateways.length === 0 ? (
        <p className="text-sm text-muted-foreground">{NO_GATEWAY}</p>
      ) : (
        status.gateways.map((g) => (
          <GatewayCard
            key={g.id}
            gateway={g}
            status={status}
            onDeleted={(name) => {
              setNotice(`「${name}」 Gateway 를 삭제했습니다`);
              addButton.current?.focus();
            }}
          />
        ))
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
          <OpenClawSection status={status.data} />
        </>
      ) : (
        <Pending what="연결 상태" query={status} />
      )}
      <RunnerSection status={status.data} />
    </>
  );
}

/**
 * 연결 페이지(스펙 `docs/superpowers/specs/2026-09-24-setup-wizard-design.md` 「연결 페이지」): 서버·OpenClaw Gateway 카드
 * (`docs/superpowers/specs/2026-10-04-multi-gateway-design.md` 7장)·Claude 러너(러너 스펙 5장)의 상태와 다음에 할 일. owner 만 본다 — 아니면 setup API 를 부르지 않고 「권한이 없습니다」. role 이 없는 옛 me 도 owner 가 아니다
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
          OpenClaw Gateway·플러그인과 Claude 러너가 이 서버에 어떻게 붙어 있는지 보고, 할 일과 명령을
          복사합니다.
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
