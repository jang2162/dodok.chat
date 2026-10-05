import type { GatewaySetup, SetupStatus } from "@dodok/shared";
import { PencilIcon, PowerIcon, Trash2Icon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useNowTick } from "@/hooks/useNowTick";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { DeleteGatewayConfirm } from "./DeleteGatewayConfirm";
import { GatewayForm } from "./GatewayForm";
import { IssueTokenDialog } from "./IssueTokenDialog";
import { publicOriginOf } from "./llms";
import { useUpdateGateway } from "./mutations";
import { useBridgeTokens } from "./queries";
import { CopyBlock, Field, PAIRING_STALE_MS, Pending, Section } from "./sections";
import { TokenList } from "./TokenList";

/** 카드 머리의 상태(멀티 Gateway 스펙 「웹」 절 — 연결됨·재연결 중·페어링 대기·꺼짐). 페어링 대기는 상태 값이 아니라 `pairing` 으로 안다 */
export function gatewayStateLabel(g: GatewaySetup): string {
  if (!g.enabled || g.gateway.state === "disabled") return "꺼짐";
  if (g.gateway.pairing) return "페어링 대기";
  if (g.gateway.state === "connected") return "연결됨";
  if (g.gateway.state === "reconnecting") return "재연결 중";
  return "연결 안 됨";
}

/**
 * Gateway 하나(멀티 Gateway 스펙 「웹」 절의 「연결 페이지」) — 상태·플러그인·이 Gateway 의 브리지 토큰과 메뉴(수정·끄기/켜기·삭제).
 * 삭제는 카드 안에서 한 번 더 묻고(`DeleteGatewayConfirm`), 지운 뒤에는 카드가 사라지므로 `onDeleted` 가 초점을 옮긴다
 */
export function GatewayCard({
  gateway,
  status,
  onDeleted,
}: {
  gateway: GatewaySetup;
  status: SetupStatus;
  onDeleted: (name: string) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  const toggle = useUpdateGateway(gateway.id);
  const label = gatewayStateLabel(gateway);

  return (
    <Section level={3} title={gateway.name}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={label === "연결됨" ? "default" : "outline"}>{label}</Badge>
        <span className="flex-1" />
        <GatewayForm
          gateway={gateway}
          trigger={
            <Button type="button" size="xs" variant="outline" aria-label={`${gateway.name} 수정`}>
              <PencilIcon />
              수정
            </Button>
          }
        />
        <Button
          type="button"
          size="xs"
          variant="outline"
          aria-label={`${gateway.name} ${gateway.enabled ? "끄기" : "켜기"}`}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ enabled: !gateway.enabled })}
        >
          <PowerIcon />
          {gateway.enabled ? "끄기" : "켜기"}
        </Button>
        <Button
          ref={deleteButton}
          type="button"
          size="xs"
          variant="outline"
          aria-label={`${gateway.name} 삭제`}
          aria-expanded={confirming}
          aria-controls={confirming ? confirmId : undefined}
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon />
          삭제
        </Button>
      </div>
      {confirming && (
        <DeleteGatewayConfirm
          id={confirmId}
          gateway={gateway}
          onCancel={() => {
            setConfirming(false);
            deleteButton.current?.focus();
          }}
          onDeleted={() => onDeleted(gateway.name)}
        />
      )}
      <GatewayStatus gateway={gateway} />
      <PluginStatus gateway={gateway} />
      <BridgeTokens gateway={gateway} status={status} />
    </Section>
  );
}

/**
 * 상태·호스트·버전(핀과 다르면 드리프트 한 줄 — 운영 보강 스펙 7장)과 다음에 할 일(설정 마법사 스펙 「연결 페이지」). 페어링 대기면
 * 승인 명령(요청 id 를 못 받았으면 목록 명령)을, 대기가 5분을 넘으면 강조한다. 켜진 채 `down` 이면 주소·토큰·서버 로그를 보라고 한다
 */
function GatewayStatus({ gateway: g }: { gateway: GatewaySetup }) {
  const { gateway } = g;
  const pairing = gateway.pairing;
  // 기다리는 동안만 1초마다 다시 본다 — 5분 경계를 넘는 순간 강조가 켜진다
  const now = useNowTick(pairing !== null);
  const stale = pairing !== null && now - Date.parse(pairing.since) > PAIRING_STALE_MS;
  return (
    <>
      <dl className="flex flex-col gap-1">
        <Field name="주소">{g.url}</Field>
        <Field name="호스트">{gateway.host}</Field>
        <Field name="버전">
          {gateway.version ?? "모름"}
          {gateway.drift && (
            <span className="font-medium text-destructive">
              {" "}
              — 저장소가 검증한 버전({gateway.pinned})과 다릅니다
            </span>
          )}
        </Field>
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
        g.enabled &&
        gateway.state === "down" && (
          <p className="text-sm text-muted-foreground">Gateway 주소·토큰과 서버 로그를 확인하세요.</p>
        )
      )}
    </>
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

/** 이 Gateway 에 붙은 플러그인 — 접속 여부·버전·같은 빌드인가. 받기는 블록 머리(`PluginDownload`)에 한 번 */
function PluginStatus({ gateway }: { gateway: GatewaySetup }) {
  const plugin = gateway.bridge.plugin;
  return (
    <Section title="플러그인" level={4} bare className="border-t pt-3">
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
      <BuildMatch gateway={gateway} />
    </Section>
  );
}

/** 이 Gateway 의 브리지 토큰 — 토큰은 Gateway 에 묶인다(멀티 Gateway 스펙 「바뀌는 표」 절). 발급 대화상자는 그대로 */
function BridgeTokens({ gateway, status }: { gateway: GatewaySetup; status: SetupStatus }) {
  const tokens = useBridgeTokens(gateway.id);
  const issueButton = useRef<HTMLButtonElement>(null);
  const none = tokens.data !== undefined && tokens.data.every((t) => t.revokedAt !== null);
  return (
    <Section title="브리지 토큰" level={4} bare className="border-t pt-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 text-sm text-muted-foreground">
          이 Gateway 의 플러그인이 이 서버에 붙을 때 쓰는 토큰입니다. 새 토큰을 넣고 다시 붙은 뒤 옛 토큰을
          폐기하면 에이전트가 멈추지 않습니다. 브리지 주소{" "}
          <code className="font-mono break-all">{status.bridge.publicUrl}</code>
        </p>
        <IssueTokenDialog
          gatewayId={gateway.id}
          origin={publicOriginOf(status.bridge.publicUrl)}
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
