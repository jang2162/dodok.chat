import type { OpenClawGatewayStatus, OpsGatewayStatus, OpsStatus } from "@dodok/shared";
import type { ReactNode } from "react";
import { useAdapterStatus, useRunnerAdapterStatus } from "@/api/queries";
import { formatSize } from "@/features/attachments/format";
import { Section } from "@/features/setup/sections";
import { cn } from "@/lib/utils";
import { useWireStatus } from "@/realtime/wire";
import { OPS_STATUS_POLL_MS } from "./queries";

const WHEN = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

/** 켜진 Gateway 의 상태만 줄로 그린다 — 꺼진 것은 줄이 없다. 낱말은 연결 페이지 카드(멀티 Gateway 스펙 「웹」 절)와 같다 */
const GATEWAY_STATE: Record<Exclude<OpenClawGatewayStatus["gateway"], "disabled">, string> = {
  connected: "연결됨",
  reconnecting: "재연결 중",
  down: "연결 안 됨",
};
const PLUGIN_STATE: Record<OpenClawGatewayStatus["bridge"], string> = {
  connected: "연결됨",
  down: "연결 안 됨",
};

/** 이름·값 한 줄. `problem` 이면 강조한다 — 스크린 리더에는 값 앞의 「문제」로 알린다 */
function Row({ name, problem = false, children }: { name: string; problem?: boolean; children: ReactNode }) {
  return (
    <div
      data-status-row
      data-problem={problem || undefined}
      className={cn(
        "flex flex-wrap gap-x-2 rounded-md px-2 py-1 text-sm",
        problem && "bg-destructive/10 font-medium text-destructive",
      )}
    >
      <dt className={cn(!problem && "text-muted-foreground")}>{name}</dt>
      <dd className="min-w-0 break-words">
        {problem && <span className="sr-only">문제: </span>}
        {children}
      </dd>
    </div>
  );
}

function Disk({ disk }: { disk: OpsStatus["disk"] }) {
  if (disk.level === "unknown") return <>알 수 없음</>;
  const pct = disk.totalBytes > 0 ? Math.round((disk.freeBytes / disk.totalBytes) * 100) : 0;
  return (
    <>
      {formatSize(disk.freeBytes)} 남음 / {formatSize(disk.totalBytes)} ({pct}%)
    </>
  );
}

const SHUTDOWN = (clean: boolean | null) =>
  clean === null ? "알 수 없음" : clean ? "정상" : "비정상 종료 — 서버 로그를 확인하세요";

/** 상태 카드의 Gateway 묶음 하나 — 연결 상태와 버전 */
type GatewayLine = {
  id: string;
  name: string;
  gateway: Exclude<OpenClawGatewayStatus["gateway"], "disabled">;
  plugin: OpenClawGatewayStatus["bridge"];
  version: Pick<OpsGatewayStatus["gateway"], "version" | "pinned" | "drift">;
};

const NO_VERSION: GatewayLine["version"] = { version: null, pinned: "", drift: false };

/**
 * 켜진 Gateway 마다의 줄 값 — wire 가 붙어 있으면 어댑터 캐시(REST 로 받고 wire `adapter.status` 가 곧바로 고친다, 배너·연결 점과
 * 같은 출처)의 목록과 상태. 끊김 사건은 60초를 넘겨야 열리므로 그 안의 깜빡임은 이것만 따라간다(브라우저 검증 D1). wire 가 끊겼으면
 * 캐시가 멈춰 있어 운영 상태 응답의 값을 쓴다. 버전은 늘 운영 상태 응답에서 Gateway id 로 찾는다(새로 더한 Gateway 는 다음 응답까지 모름)
 */
function useGatewayLines(status: OpsStatus): GatewayLine[] {
  const { data: adapter } = useAdapterStatus();
  const live = useWireStatus((s) => s.status) === "connected";
  const versionOf = (id: string) => status.gateways.find((g) => g.id === id)?.gateway ?? NO_VERSION;
  // 캐시에는 OpenClaw 어댑터 상태만 담긴다(handlers.ts) — 그래도 좁혀 읽는다
  const links =
    adapter?.provider === "openclaw" && live
      ? adapter.gateways
      : status.gateways.map((g) => ({
          id: g.id,
          name: g.name,
          enabled: g.enabled,
          gateway: g.gateway.state,
          bridge: g.plugin.state,
        }));
  return links.flatMap((g) =>
    g.enabled && g.gateway !== "disabled"
      ? [{ id: g.id, name: g.name, gateway: g.gateway, plugin: g.bridge, version: versionOf(g.id) }]
      : [],
  );
}

/**
 * 러너 줄의 값(러너 스펙 5장) — 운영 상태 응답에는 러너가 없어 어댑터 목록의 runner 줄을 본다. wire `adapter.status` 가 곧바로
 * 고치고, wire 가 끊긴 동안은 운영 상태와 같은 주기로 다시 받는다. 러너 어댑터가 없는 서버면 null(줄을 그리지 않는다)
 */
function useRunners() {
  const live = useWireStatus((s) => s.status) === "connected";
  return useRunnerAdapterStatus({ poll: live ? undefined : OPS_STATUS_POLL_MS }).data ?? null;
}

/**
 * 상태 카드(스펙 7장): 연결(켜진 OpenClaw Gateway 마다 Gateway·플러그인·버전 줄, 러너), 디스크 여유, 직전 종료. 문제가 있는
 * 줄만 강조한다 — 모르는 값(디스크를 못 잼·종료 표지 없음)은 문제로 보지 않는다. Gateway 가 없거나 모두 꺼졌으면 Gateway 줄이 없다
 * (멀티 Gateway 스펙 「웹」 절 — 끊긴 연결이 없다). 러너가 덜 붙은 것은 문제로 보지 않는다 — 러너는 사람의 PC 라 꺼져 있을 수 있고,
 * 60초 넘는 끊김은 사건(runner_down)이 알린다
 */
export function StatusCard({ status }: { status: OpsStatus }) {
  const { disk, server } = status;
  const gateways = useGatewayLines(status);
  const runners = useRunners();
  return (
    <Section title="상태">
      <dl className="flex flex-col gap-0.5">
        {gateways.map((g) => (
          <GatewayRows key={g.id} line={g} />
        ))}
        {runners && (
          <Row name="러너">
            {runners.connected}대 붙음 / 토큰 {runners.tokens}개
          </Row>
        )}
        <Row name="디스크 여유" problem={disk.level === "warn" || disk.level === "error"}>
          <Disk disk={disk} />
        </Row>
        <Row name="직전 종료" problem={server.previousClean === false}>
          {SHUTDOWN(server.previousClean)}
        </Row>
        <Row name="서버">
          {server.version} · {WHEN.format(new Date(server.startedAt))}부터 가동
        </Row>
        <Row name="DB">{formatSize(status.db.bytes)}</Row>
      </dl>
    </Section>
  );
}

/** Gateway 하나의 세 줄 — 줄 이름에 Gateway 이름을 넣어 묶음을 가른다 */
function GatewayRows({ line }: { line: GatewayLine }) {
  const label = `「${line.name}」`;
  const { version, pinned, drift } = line.version;
  return (
    <>
      <Row name={`Gateway ${label}`} problem={line.gateway !== "connected"}>
        {GATEWAY_STATE[line.gateway]}
      </Row>
      <Row name={`플러그인 ${label}`} problem={line.plugin !== "connected"}>
        {PLUGIN_STATE[line.plugin]}
      </Row>
      <Row name={`Gateway ${label} 버전`} problem={drift}>
        {version ?? "모름"}
        {drift && <> — 저장소가 검증한 버전({pinned})과 다릅니다</>}
      </Row>
    </>
  );
}
