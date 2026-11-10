import type { GatewaySetup, SetupStatus } from "@dodok/shared";
import { useRef } from "react";
import { useNowTick } from "@/hooks/useNowTick";
import { cn } from "@/lib/utils";
import { IssueTokenDialog } from "./IssueTokenDialog";
import { publicOriginOf } from "./llms";
import { useBridgeTokens } from "./queries";
import { CopyBlock, PAIRING_STALE_MS, Pending, PluginInstall, Section } from "./sections";
import { TokenList } from "./TokenList";

/** 카드 머리의 상태(멀티 Gateway 스펙 「웹」 절 — 연결됨·재연결 중·페어링 대기·꺼짐). 페어링 대기는 상태 값이 아니라 `pairing` 으로 안다 */
export function gatewayStateLabel(g: GatewaySetup): string {
  // 승인 전이면 켜져 있어도 서버가 접속하지 않는다(연결 탭 통합 스펙 5.4) — 꺼짐보다 앞선다
  if (!g.approved) return "승인 대기";
  if (!g.enabled || g.gateway.state === "disabled") return "꺼짐";
  if (g.gateway.pairing) return "페어링 대기";
  if (g.gateway.state === "connected") return "연결됨";
  if (g.gateway.state === "reconnecting") return "재연결 중";
  return "연결 안 됨";
}

/**
 * 한 줄 메타 — 「OpenClaw Gateway · 주인 <이름> · <주소> · <버전>」(주인을 모르면 그 칸은 빠진다). 핀과 다르면 드리프트를 늘 보인다
 * (운영 보강 스펙 7장)
 */
export function GatewayMeta({ gateway: g, owner }: { gateway: GatewaySetup; owner?: string | null }) {
  return (
    <>
      OpenClaw Gateway{owner ? <> · 주인 {owner}</> : null} · <span className="break-all">{g.url}</span> ·{" "}
      {g.gateway.version ?? "버전 모름"}
      {g.gateway.drift && (
        <span className="font-medium text-destructive">
          {" "}
          — 저장소가 검증한 버전({g.gateway.pinned})과 다릅니다
        </span>
      )}
    </>
  );
}

/**
 * 다음에 할 일(설정 마법사 스펙 「연결 페이지」) — 페어링 대기면 승인 명령(요청 id 를 못 받았으면 목록 명령)을, 대기가 5분을 넘으면
 * 강조한다. 켜진 채 `down` 이면 주소·토큰·서버 로그를 보라고 한다
 */
export function PairingNotice({ gateway: g }: { gateway: GatewaySetup }) {
  const { gateway } = g;
  const pairing = gateway.pairing;
  // 기다리는 동안만 1초마다 다시 본다 — 5분 경계를 넘는 순간 강조가 켜진다
  const now = useNowTick(pairing !== null);
  const stale = pairing !== null && now - Date.parse(pairing.since) > PAIRING_STALE_MS;
  if (!pairing)
    return g.enabled && gateway.state === "down" ? (
      <p className="text-sm text-muted-foreground">Gateway 주소·토큰과 서버 로그를 확인하세요.</p>
    ) : null;
  return (
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
  );
}

/** 접속 플러그인이 서버가 품은 파일과 같은 빌드인가(설정 마법사 스펙 「연결 페이지」·「오류 처리」) */
function BuildMatch({ gateway }: { gateway: GatewaySetup }) {
  const plugin = gateway.bridge.plugin;
  if (!plugin) return null;
  if (gateway.pluginMatches === true)
    return <p className="text-sm text-muted-foreground">서버와 같은 빌드입니다</p>;
  if (gateway.pluginMatches === false)
    return (
      <p role="alert" className="text-sm font-medium text-destructive">
        다른 빌드입니다 — 「새 토큰 발급」의 설치 명령을 다시 돌리세요
      </p>
    );
  // 모름 — 플러그인이 번들 sha 를 안 보냈거나(옛 빌드) 서버에 비교할 파일이 없다
  if (plugin.bundleSha256 === null)
    return (
      <p className="text-sm text-muted-foreground">
        빌드를 알 수 없습니다 — 「새 토큰 발급」의 설치 명령을 다시 돌리세요
      </p>
    );
  return (
    <p className="text-sm text-muted-foreground">서버에 플러그인 파일이 없어 같은 빌드인지 알 수 없습니다</p>
  );
}

/**
 * 「플러그인」 섹션(연결 탭 통합 스펙 3.3) — 페어링 대기면 승인 블록이 맨 위, 접속 상태 한 줄과 같은 빌드인가, 그 아래 설치 상자.
 * 플러그인이 아직 안 붙었으면 상자를 펼쳐 두고, 붙어 있으면 「다시 설치」로 접는다
 */
export function PluginStatus({ gateway, status }: { gateway: GatewaySetup; status: SetupStatus }) {
  const plugin = gateway.bridge.plugin;
  return (
    <Section title="플러그인" bare>
      <PairingNotice gateway={gateway} />
      <p className="text-sm">
        {plugin ? (
          <>
            접속됨 · 플러그인 {plugin.version} · SDK {plugin.sdkVersion} · Gateway{" "}
            {plugin.gatewayVersion ?? "모름"}
          </>
        ) : (
          "접속한 플러그인이 없습니다."
        )}
      </p>
      <BuildMatch gateway={gateway} />
      <PluginInstall status={status} open={plugin === null} />
    </Section>
  );
}

/**
 * 「브리지 토큰」 섹션 — 토큰은 Gateway 에 묶인다(멀티 Gateway 스펙 「바뀌는 표」 절). 쓸 수 있는 토큰이 없으면
 * 늘 보이는 경고. 발급 대화상자는 그대로
 */
export function BridgeTokens({ gateway, status }: { gateway: GatewaySetup; status: SetupStatus }) {
  const tokens = useBridgeTokens(gateway.id);
  const issueButton = useRef<HTMLButtonElement>(null);
  const none = tokens.data !== undefined && tokens.data.every((t) => t.revokedAt !== null);
  return (
    <Section title="브리지 토큰" bare>
      <div>
        <IssueTokenDialog
          gatewayId={gateway.id}
          origin={publicOriginOf(status.bridge.publicUrl)}
          pluginFileAvailable={status.pluginFile.available}
          triggerRef={issueButton}
        />
      </div>
      {/* 「쓸 수 있는」 — 폐기된 줄이 아래 목록에 함께 보여도 모순되지 않게 */}
      {none && (
        <p className="text-sm font-medium text-destructive">쓸 수 있는 토큰이 없습니다 — 발급하세요</p>
      )}
      {tokens.data ? (
        tokens.data.length > 0 && (
          <TokenList
            gatewayId={gateway.id}
            tokens={tokens.data}
            gateway={gateway}
            issueButton={issueButton}
          />
        )
      ) : (
        <Pending what="토큰 목록" query={tokens} />
      )}
    </Section>
  );
}
