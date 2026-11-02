import type { Agent, GatewaySetup } from "@dodok/shared";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PencilIcon, PowerIcon, Trash2Icon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useAdapterStatus, useAgents, useCanManage, useIsOwner } from "@/api/queries";
import { DiscoverDialog } from "@/features/agents/DiscoverDialog";
import { DeleteGatewayConfirm } from "@/features/setup/DeleteGatewayConfirm";
import { BridgeTokens, GatewayMeta, PluginStatus, gatewayStateLabel } from "@/features/setup/GatewayCard";
import { GatewayForm } from "@/features/setup/GatewayForm";
import { useUpdateGateway } from "@/features/setup/mutations";
import { useSetupStatus } from "@/features/setup/queries";
import { Section } from "@/features/setup/sections";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { AgentLinks } from "./ConnectionTreeList";
import { useConnections } from "./context";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { wireGatewayStateLabel } from "./tree";

/**
 * Gateway 상세(연결 탭 통합 스펙 3.3). owner: 머리(이름·상태·수정/끄기/삭제)·한 줄 메타·「플러그인」·「브리지 토큰」·「에이전트 N」.
 * owner 가 아니면 머리(이름·wire 상태)와 「에이전트 N」만 — 주소·토큰·설치 명령은 setup API(owner)에만 있다(1단계는 지금 권한 그대로).
 * admin 이상이면 「에이전트 가져오기」가 이 Gateway 로 고정돼 열린다. 없는 id·지워진 Gateway 는 「이 연결을 찾을 수 없습니다」
 */
export function GatewayDetail() {
  const { gatewayId } = useParams({ strict: false });
  const owner = useIsOwner();
  return owner ? <OwnerGateway id={gatewayId ?? ""} /> : <WireGateway id={gatewayId ?? ""} />;
}

function OwnerGateway({ id }: { id: string }) {
  const status = useSetupStatus();
  const navigate = useNavigate();
  const { announce, focusTree } = useConnections();
  const toggle = useUpdateGateway(id);
  const [confirming, setConfirming] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  if (!status.data) return <DetailPending failed={status.isError} retry={() => void status.refetch()} />;
  const gateway = status.data.gateways.find((g) => g.id === id);
  if (!gateway) return <NotFoundDetail />;
  const label = gatewayStateLabel(gateway);
  return (
    <div data-testid="gateway-detail" className="flex flex-col gap-6">
      <DetailHeader
        title={gateway.name}
        badge={<Badge variant={label === "연결됨" ? "default" : "outline"}>{label}</Badge>}
        actions={
          <>
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
          </>
        }
        meta={<GatewayMeta gateway={gateway} />}
      />
      {confirming && (
        <DeleteGatewayConfirm
          id={confirmId}
          gateway={gateway}
          onCancel={() => {
            setConfirming(false);
            deleteButton.current?.focus();
          }}
          onDeleted={() => {
            // 상세가 사라진다 — 알림은 트리 머리의 라이브 영역에, 초점은 「연결 추가」로
            announce(`「${gateway.name}」 Gateway 를 삭제했습니다`);
            focusTree("add");
            void navigate({ to: "/settings/connection" });
          }}
        />
      )}
      <PluginStatus gateway={gateway} status={status.data} />
      <BridgeTokens gateway={gateway} status={status.data} />
      <GatewayAgents gateway={gateway} />
    </div>
  );
}

/** owner 아님 — wire Gateway 목록(누구나 읽는다)의 이름·상태만 */
function WireGateway({ id }: { id: string }) {
  const adapter = useAdapterStatus();
  if (adapter.data === undefined)
    return <DetailPending failed={adapter.isError} retry={() => void adapter.refetch()} />;
  const gateway = adapter.data?.gateways.find((g) => g.id === id);
  if (!gateway) return <NotFoundDetail />;
  const label = wireGatewayStateLabel(gateway);
  return (
    <div data-testid="gateway-detail" className="flex flex-col gap-6">
      <DetailHeader
        title={gateway.name}
        badge={<Badge variant={label === "연결됨" ? "default" : "outline"}>{label}</Badge>}
        meta="OpenClaw Gateway"
      />
      <GatewayAgents gateway={gateway} />
    </div>
  );
}

/** 「에이전트 N」 — 줄은 트리와 같다. admin 이상이면 이 Gateway 로 고정한 「에이전트 가져오기」 */
function GatewayAgents({ gateway }: { gateway: Pick<GatewaySetup, "id" | "name"> }) {
  const agents = useAgents();
  const canManage = useCanManage();
  const here = (agents.data ?? []).filter(
    (a: Agent) => a.provider === "openclaw" && a.gateway?.id === gateway.id && a.archivedAt === null,
  );
  return (
    <Section title={`에이전트 ${here.length}`} bare>
      {canManage && (
        <div>
          <DiscoverDialog
            agents={agents.data ?? []}
            gatewayId={gateway.id}
            gatewayName={gateway.name}
            disabled={!agents.data}
          />
        </div>
      )}
      {here.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {canManage
            ? "아직 에이전트가 없습니다. 「에이전트 가져오기」로 데려오세요."
            : "아직 에이전트가 없습니다."}
        </p>
      ) : (
        <AgentLinks agents={here} />
      )}
    </Section>
  );
}
