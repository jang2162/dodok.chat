import { OpsStatus } from "@dodok/shared";
import type { AgentAdapter, OpenClawGateways } from "../../adapters/types";
import type { Db } from "../../db/client";
import { parseStored } from "../../http/validate";
import { countRunsTodayInWorkspace } from "../runs/store";
import { type DiskState, gatewayPin } from "./health";
import type { OpsService } from "./service";
import { getOpsSettings } from "./settings";

// 운영 상태 요약(운영 보강 스펙 6장) — REST GET /ops/status 와 제어 도구 ops_status 가 같은 함수로 만든다

export type OpsStatusContext = {
  db: Db;
  workspaceId: string;
  /** OpenClaw 어댑터 — Gateway 줄은 Gateway 별 상태와 상세(버전)에서 만든다 */
  adapter: Pick<AgentAdapter, "status"> & Pick<OpenClawGateways, "gatewaySetupDetails">;
  ops: Pick<OpsService, "unacked" | "countsSince">;
  disk(): DiskState;
  serverVersion: string;
  startedAt: Date;
  /** 직전 종료 표지(main 이 startRunState 뒤에 넘긴다) — 넘기기 전이나 표지가 없으면 null */
  previousClean(): boolean | null;
  now?: () => Date;
};

/** shared 스키마로 한 번 파싱해서 돌려준다 — 어기면 서버 버그라 500 INTERNAL */
export function buildOpsStatus(ctx: OpsStatusContext): OpsStatus {
  const at = (ctx.now ?? (() => new Date()))();
  const adapter = ctx.adapter.status();
  // Gateway 줄은 OpenClaw 어댑터의 것(멀티 Gateway 스펙 「운영」 절) — 다른 어댑터면 빈 목록. 꺼진 Gateway 는 버전을 싣지 않는다
  const versions = new Map(ctx.adapter.gatewaySetupDetails().map((d) => [d.id, d.gateway.version]));
  const gateways = (adapter.provider === "openclaw" ? adapter.gateways : []).map((g) => {
    const version = g.enabled ? (versions.get(g.id) ?? null) : null;
    return {
      id: g.id,
      name: g.name,
      enabled: g.enabled,
      gateway: { state: g.gateway, version, ...gatewayPin(version) },
      plugin: { state: g.bridge },
    };
  });
  const midnight = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const settings = getOpsSettings(ctx.db, ctx.workspaceId);
  const status: OpsStatus = {
    workspaceId: ctx.workspaceId,
    server: {
      version: ctx.serverVersion,
      startedAt: ctx.startedAt.toISOString(),
      previousClean: ctx.previousClean(),
    },
    db: { bytes: dbBytes(ctx.db) },
    disk: ctx.disk(),
    adapter,
    gateways,
    runsToday: countRunsTodayInWorkspace(ctx.db, at),
    dailyRunLimit: settings.dailyRunLimit,
    timeZone: settings.timeZone,
    blockedToday: ctx.ops.countsSince("run_limit", midnight).get("workspace") ?? 0,
    unacked: ctx.ops.unacked(),
  };
  return parseStored(OpsStatus, status, "ops status");
}

/** SQLite 가 보는 DB 크기(page_count × page_size) — 체크포인트 전 WAL 파일은 따로 세지 않는다 */
function dbBytes(db: Db): number {
  const pages = db.$client.pragma("page_count", { simple: true }) as number;
  const pageSize = db.$client.pragma("page_size", { simple: true }) as number;
  return pages * pageSize;
}
