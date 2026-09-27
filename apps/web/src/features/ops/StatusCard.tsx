import type { OpsStatus } from "@dodok/shared";
import type { ReactNode } from "react";
import { useAdapterStatus } from "@/api/queries";
import { formatSize } from "@/features/attachments/format";
import { Section } from "@/features/setup/sections";
import { cn } from "@/lib/utils";
import { useWireStatus } from "@/realtime/wire";

const WHEN = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

const GATEWAY_STATE: Record<OpsStatus["gateway"]["state"], string> = {
  connected: "연결됨",
  reconnecting: "다시 연결하는 중",
  down: "연결 안 됨",
};
const PLUGIN_STATE: Record<OpsStatus["plugin"]["state"], string> = {
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

/**
 * 연결 줄의 값 — wire 가 붙어 있으면 어댑터 캐시(REST 로 받고 wire `adapter.status` 가 곧바로 고친다, 배너·연결 점과 같은 출처).
 * 끊김 사건은 60초를 넘겨야 열리므로 그 안의 깜빡임은 이것만 따라간다(브라우저 검증 D1). wire 가 끊겼으면 캐시가 멈춰 있어
 * 운영 상태 응답의 값을 쓴다
 */
function useLiveConnection(status: OpsStatus) {
  const { data: adapter } = useAdapterStatus();
  const live = useWireStatus((s) => s.status) === "connected";
  // 캐시에는 OpenClaw 어댑터 상태만 담긴다(handlers.ts) — 그래도 좁혀 읽는다
  if (adapter?.provider === "openclaw" && live) return { gateway: adapter.gateway, plugin: adapter.bridge };
  return { gateway: status.gateway.state, plugin: status.plugin.state };
}

/**
 * 상태 카드(스펙 7장): 연결(Gateway·플러그인), 버전(드리프트 한 줄), 디스크 여유, 직전 종료. 문제가 있는 줄만 강조한다 —
 * 모르는 값(디스크를 못 잼·종료 표지 없음)은 문제로 보지 않는다
 */
export function StatusCard({ status }: { status: OpsStatus }) {
  const { gateway, disk, server } = status;
  const connection = useLiveConnection(status);
  return (
    <Section title="상태">
      <dl className="flex flex-col gap-0.5">
        <Row name="Gateway" problem={connection.gateway !== "connected"}>
          {GATEWAY_STATE[connection.gateway]}
        </Row>
        <Row name="플러그인" problem={connection.plugin !== "connected"}>
          {PLUGIN_STATE[connection.plugin]}
        </Row>
        <Row name="Gateway 버전" problem={gateway.drift}>
          {gateway.version ?? "모름"}
          {gateway.drift && <> — 저장소가 검증한 버전({gateway.pinned})과 다릅니다</>}
        </Row>
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
