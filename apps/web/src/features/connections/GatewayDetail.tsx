import { type Agent, type ConnectionsResponse, type GatewaySetup, roleAtLeast } from "@dodok/shared";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PencilIcon, PowerIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useAdapterStatus, useAgents } from "@/api/queries";
import { DiscoverDialog } from "@/features/agents/DiscoverDialog";
import { DeleteGatewayConfirm } from "@/features/setup/DeleteGatewayConfirm";
import {
  BridgeTokensCard,
  GatewayStatusCard,
  gatewayFacts,
  gatewayStateLabel,
} from "@/features/setup/GatewayCard";
import { GatewayForm } from "@/features/setup/GatewayForm";
import {
  GATEWAY_URL_CHANGED,
  isUrlChanged,
  useApproveGateway,
  useUpdateGateway,
} from "@/features/setup/mutations";
import { useSetupStatus } from "@/features/setup/queries";
import { Button } from "@/ui/button";
import { AgentLinks } from "./ConnectionTreeList";
import { useConnections } from "./context";
import { DetailCard, OverflowMenu } from "./DetailCard";
import { DetailHeader } from "./DetailHeader";
import { DetailPending, NotFoundDetail } from "./NotFoundDetail";
import { canManageConnection, useViewer } from "./permissions";
import { useConnectionList } from "./queries";
import { stateTone, wireGatewayStateLabel } from "./tree";

type ListedGateway = ConnectionsResponse["gateways"][number];

/**
 * Gateway 상세(연결 탭 통합 스펙 3.3·5장, 연결 재설계 스펙 목표 2·3). 관리할 수 있는 사람(그 Gateway 의 주인·admin 이상): 머리(아이콘·이름·
 * 상태 칩·값 줄 — 주인·주소·판, 「이름·주소 수정」, 「⋯」 메뉴의 끄기/켜기·삭제)·승인 대기 줄·카드 「상태」(Gateway·플러그인)·「에이전트」
 * (머리 동작 「가져오기」가 이 Gateway 로 고정)·「브리지 토큰」. 그 밖의 사람은 머리(이름·상태·주인)와 「에이전트」만 — 주소·토큰·설치
 * 명령은 걸러진 설정 상태에만 있다. 없는 id·지워진 Gateway 는 「이 연결을 찾을 수 없습니다」
 */
export function GatewayDetail() {
  const { gatewayId } = useParams({ strict: false });
  const id = gatewayId ?? "";
  const { role, meId } = useViewer();
  const list = useConnectionList();
  // 주인을 가르기 전에 읽기 전용을 잠깐 보이지 않게 — 목록을 못 받으면(옛 서버) 역할만으로 가른다
  // admin 이상은 주인과 상관없이 관리한다 — 목록을 기다리지 않는다
  if (list.isPending && !roleAtLeast(role, "admin"))
    return <DetailPending failed={false} retry={() => void list.refetch()} />;
  const entry = list.data?.gateways.find((g) => g.id === id);
  return canManageConnection(role, meId, entry?.owner?.id ?? null) ? (
    <ManagedGateway id={id} entry={entry} />
  ) : (
    <WireGateway id={id} entry={entry} />
  );
}

function ManagedGateway({ id, entry }: { id: string; entry: ListedGateway | undefined }) {
  const status = useSetupStatus();
  const navigate = useNavigate();
  const { announce, focusTree } = useConnections();
  const toggle = useUpdateGateway(id);
  const [confirming, setConfirming] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const confirmId = useId();
  if (status.isPending) return <DetailPending failed={false} retry={() => void status.refetch()} />;
  const gateway = status.data?.gateways.find((g) => g.id === id);
  // 설정 상태에 없으면(받지 못했거나 막 지워졌다) 누구나 보는 꼴로 — 거기에도 없으면 「찾을 수 없습니다」
  if (!status.data || !gateway) return <WireGateway id={id} entry={entry} canManage />;
  const label = gatewayStateLabel(gateway);
  return (
    <div data-testid="gateway-detail" className="flex flex-col gap-4">
      <DetailHeader
        icon={<ServerIcon />}
        title={gateway.name}
        state={{ tone: stateTone(label), label }}
        facts={gatewayFacts(gateway, entry?.owner?.name)}
        primary={
          <GatewayForm
            gateway={gateway}
            trigger={
              <Button type="button" size="sm" variant="outline">
                <PencilIcon />
                이름·주소 수정
              </Button>
            }
          />
        }
        menu={
          <OverflowMenu
            label={`${gateway.name} 더 보기`}
            triggerRef={menuButton}
            controls={confirming ? confirmId : undefined}
            items={[
              {
                label: gateway.enabled ? "끄기" : "켜기",
                icon: <PowerIcon />,
                disabled: toggle.isPending,
                onSelect: () => toggle.mutate({ enabled: !gateway.enabled }),
              },
              { label: "삭제", icon: <Trash2Icon />, danger: true, onSelect: () => setConfirming(true) },
            ]}
          />
        }
      />
      {!gateway.approved && <Approval gateway={gateway} />}
      {confirming && (
        <DeleteGatewayConfirm
          id={confirmId}
          gateway={gateway}
          onCancel={() => {
            setConfirming(false);
            menuButton.current?.focus();
          }}
          onDeleted={() => {
            // 상세가 사라진다 — 알림은 트리 머리의 라이브 영역에, 초점은 「연결 추가」로
            announce(`「${gateway.name}」 Gateway 를 삭제했습니다`);
            focusTree("add");
            void navigate({ to: "/settings/connection" });
          }}
        />
      )}
      <GatewayStatusCard gateway={gateway} status={status.data} />
      <GatewayAgents gateway={gateway} canManage />
      <BridgeTokensCard gateway={gateway} status={status.data} />
    </div>
  );
}

/**
 * 승인 대기 줄(스펙 5.4) — admin 이상에게는 무엇을 승인하는지(주소)를 한 줄로 크게 보이고 「승인」. 주인(member)에게는 그리지 않는다(머리의 「승인 대기」).
 * 승인 전에도 플러그인 설치·브리지 토큰은 그대로 보인다 — 플러그인은 브리지로 이 서버에 붙는 쪽이라 미리 준비해도 된다
 */
function Approval({ gateway }: { gateway: GatewaySetup }) {
  const admin = roleAtLeast(useViewer().role, "admin");
  const approve = useApproveGateway(gateway.id);
  if (!admin) return null;
  return (
    <div role="group" aria-label="승인 대기" className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-medium">승인 대기 — 승인하면 서버가 이 주소에 접속합니다</p>
      <code className="font-mono text-base break-all">{gateway.url}</code>
      {isUrlChanged(approve.error) && (
        <p role="alert" className="text-sm text-destructive">
          {GATEWAY_URL_CHANGED}
        </p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          aria-label={`${gateway.name} 승인`}
          disabled={approve.isPending}
          onClick={() => approve.mutate(gateway.url)}
        >
          승인
        </Button>
      </div>
    </div>
  );
}

/**
 * 관리할 수 없는 사람 — 연결 목록(이름·승인·주인)과 wire Gateway 목록(상태)만. 관리할 수 있는데 설정 상태에 그 Gateway 가 없을 때도
 * 이 꼴로 그리고(`canManage` — 「에이전트 가져오기」는 남긴다), 주소·토큰 섹션은 그리지 않는다
 */
function WireGateway({
  id,
  entry,
  canManage = false,
}: {
  id: string;
  entry: ListedGateway | undefined;
  canManage?: boolean;
}) {
  const adapter = useAdapterStatus();
  if (adapter.data === undefined && !entry)
    return <DetailPending failed={adapter.isError} retry={() => void adapter.refetch()} />;
  const wire = adapter.data?.gateways.find((g) => g.id === id);
  const name = entry?.name ?? wire?.name;
  if (name === undefined) return <NotFoundDetail />;
  const label = entry && !entry.approved ? "승인 대기" : wire ? wireGatewayStateLabel(wire) : null;
  return (
    <div data-testid="gateway-detail" className="flex flex-col gap-4">
      <DetailHeader
        icon={<ServerIcon />}
        title={name}
        state={label === null ? undefined : { tone: stateTone(label), label }}
        facts={["OpenClaw Gateway", entry?.owner ? `주인 ${entry.owner.name}` : null]}
      />
      <GatewayAgents gateway={{ id, name }} canManage={canManage} />
    </div>
  );
}

/** 「에이전트」 카드 — 줄은 트리와 같다(누르면 그 에이전트 상세). 관리할 수 있으면 머리 동작이 이 Gateway 로 고정한 「가져오기」 */
function GatewayAgents({
  gateway,
  canManage,
}: {
  gateway: Pick<GatewaySetup, "id" | "name">;
  canManage: boolean;
}) {
  const agents = useAgents();
  const here = (agents.data ?? []).filter(
    (a: Agent) => a.provider === "openclaw" && a.gateway?.id === gateway.id && a.archivedAt === null,
  );
  return (
    <DetailCard
      title="에이전트"
      count={here.length}
      action={
        canManage && (
          <DiscoverDialog agents={agents.data ?? []} gatewayId={gateway.id} disabled={!agents.data} compact />
        )
      }
    >
      {here.length === 0 ? (
        <p className="text-sm text-muted-foreground">아직 에이전트가 없습니다.</p>
      ) : (
        <AgentLinks agents={here} />
      )}
    </DetailCard>
  );
}
