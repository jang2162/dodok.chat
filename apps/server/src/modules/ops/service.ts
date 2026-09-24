import type { OpsEvent, OpsEventKind, OpsSeverity, OpsUnacked } from "@dodok/shared";
import type { Db } from "../../db/client";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import * as store from "./store";

export type OpsRecordInput = {
  kind: OpsEventKind;
  /** 라우트 패턴·wire 이벤트 이름처럼 고정된 값. 쿼리 문자열·토큰·IP 전체를 넣지 않는다(IP 는 detail.ipPrefix). ≤200자 */
  key: string;
  severity: OpsSeverity;
  /** 평평한 원시값만(문자열 ≤200자) — 어기면 저장하지 않는다 */
  detail?: OpsEvent["detail"];
};

/**
 * 같은 줄의 ops.event·로그를 모으는 창. 줄마다 첫 기록은 즉시 보내고, 그 뒤 창 안의 묶임은 창이 끝날 때
 * 마지막 상태 한 번으로 보낸다(로그에는 모은 수 coalesced). 레이트리밋 폭주에서도 record 한 번의 비용이
 * DB 쓰기 1회 + 상수가 되게(o3-t1 리뷰 D2). DB count 는 매번 정확히 오른다 — 늦는 것은 화면 갱신 최대 1초뿐이다
 */
export const OPS_EMIT_COALESCE_MS = 1_000;

/** 다른 모듈이 운영 사건을 남기는 입구(스펙 2.1). 바뀐 줄은 owner 소켓에 ops.event 로 가고 로그에 ops.<kind> 줄이 남는다 */
export interface OpsService {
  /**
   * 묶기 규칙을 적용해 열린 줄 또는 새 줄을 돌려준다. key·detail 이 shared 모양을 어기거나 DB 가 실패하면
   * logger.error 후 null(던지지 않는다). 같은 줄이 창 안에 다시 묶이면 emit·로그는 창 끝에 한 번(OPS_EMIT_COALESCE_MS)
   */
  record(input: OpsRecordInput): OpsEvent | null;
  /** 열린 끊김 사건을 닫는다(resolved_at·detail.downMs). 열린 줄이 없으면 null */
  resolve(kind: "gateway_down" | "plugin_down", key: string, at?: Date): OpsEvent | null;
  ack(upTo?: Date): number;
  list(opts: { cursor?: string; severity?: OpsSeverity; limit?: number }): {
    events: OpsEvent[];
    nextCursor?: string;
  };
  /** 메모리 캐시 — 생성 때 한 번 세고, 새 줄·severity 상승·ack·sweep 때만 다시 센다 */
  unacked(): OpsUnacked;
  sweep(now?: Date): number; // last_at 이 30일 지난 줄 삭제
  /**
   * 모으던 emit·로그를 내보내고 창 타이머를 끈다(앱 종료). 그 뒤의 record 도 DB 에 쓰고 로그·emit 을 즉시 하지만
   * 창을 다시 열지 않는다 — 종료 도중(uncaughtException 등)의 기록이 타이머를 남기지 않게(o3-t1 N3)
   */
  close(): void;
}

/** 줄 하나의 모음 창 — 있으면 창이 열려 있다. pending 은 창 안에서 묶인 마지막 상태와 모은 기록 수 */
type EmitWindow = { timer: NodeJS.Timeout; pending?: { event: OpsEvent; coalesced: number } };

export function createOpsService(deps: {
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  now?: () => Date;
}): OpsService {
  const { db, bus, logger, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());

  // unacked 는 이 서비스만 바꾼다(ops_events 를 쓰는 곳이 여기뿐) — 바뀔 수 있는 때만 다시 센다.
  // 세기가 실패하면 null 로 두고 다음에 필요할 때 다시 센다
  let unackedCache: OpsUnacked | null = null;
  const recount = (): OpsUnacked => {
    unackedCache = null;
    unackedCache = store.unackedCounts(db, workspaceId);
    return unackedCache;
  };
  const currentUnacked = (): OpsUnacked => unackedCache ?? recount();
  /** 쓰기가 끝난 뒤 다시 센다 — 실패해도 부른 쪽을 막지 않는다(캐시는 비워 두고 다음에 센다) */
  const refreshUnacked = () => {
    try {
      recount();
    } catch (err) {
      logger.error({ err }, "ops unacked count failed");
    }
  };
  refreshUnacked();

  // 팬아웃이 던져도(owner 조회 실패 등) 기록은 이미 끝났다 — 부른 쪽의 동작을 막지 않는다
  const emit = (events: OpsEvent[]) => {
    if (events.length === 0) return;
    try {
      const unacked = currentUnacked();
      for (const event of events) bus.emit("ops.event", { event, unacked });
    } catch (err) {
      logger.error({ err }, "ops event emit failed");
    }
  };

  const log = (event: OpsEvent, extra: Record<string, unknown> = {}) =>
    logger[event.severity](
      { ...event.detail, ...extra, event: `ops.${event.kind}`, key: event.key, count: event.count },
      "ops event",
    );

  const windows = new Map<string, EmitWindow>();
  let closed = false;
  const openWindow = (id: string) => {
    if (closed) return;
    const timer = setTimeout(() => flushWindow(id), OPS_EMIT_COALESCE_MS);
    timer.unref();
    windows.set(id, { timer });
  };
  /** 창 끝 — 모은 것이 있으면 내보내고 창을 한 번 더 연다(폭주 중에는 창마다 한 번). 없으면 창을 닫는다 */
  const flushWindow = (id: string) => {
    const pending = windows.get(id)?.pending;
    windows.delete(id);
    if (!pending) return;
    log(pending.event, { coalesced: pending.coalesced });
    emit([pending.event]);
    openWindow(id);
  };
  /** resolve·ack 가 그 줄의 새 상태를 즉시 보냈다 — 모은 옛 상태를 창 끝에 다시 보내지 않는다 */
  const dropPending = (id: string) => {
    const window = windows.get(id);
    if (window) window.pending = undefined;
  };

  return {
    record(input) {
      let recorded: { event: OpsEvent; change: store.OpsRecordChange };
      try {
        recorded = store.recordEventChange(db, workspaceId, input, now());
      } catch (err) {
        if (err instanceof store.OpsShapeError) {
          // key 는 싣지 않는다 — 어긴 key 에 토큰·쿼리가 들어 있을 수 있다
          logger.error({ kind: input.kind, issues: err.issues }, "ops record rejected");
        } else {
          logger.error({ err, kind: input.kind, key: input.key }, "ops record failed");
        }
        return null;
      }
      const { event, change } = recorded;
      const window = windows.get(event.id);
      if (change === "grouped" && window) {
        window.pending = { event, coalesced: (window.pending?.coalesced ?? 0) + 1 };
        return event;
      }
      if (change !== "grouped") refreshUnacked();
      // 새 줄·severity 상승·창 밖의 묶임은 즉시 — 그 뒤 창 안의 묶임은 모은다
      if (window) {
        clearTimeout(window.timer);
        windows.delete(event.id);
      }
      log(event);
      emit([event]);
      openWindow(event.id);
      return event;
    },

    resolve(kind, key, at = now()) {
      let event: OpsEvent | null;
      try {
        event = store.resolveEvent(db, workspaceId, kind, key, at);
      } catch (err) {
        logger.error({ err, kind, key }, "ops resolve failed");
        return null;
      }
      if (!event) return null;
      // 복구는 알림거리가 아니다 — 끊김 줄의 severity 와 상관없이 info 로 남긴다
      logger.info(
        { ...event.detail, resolved: true, event: `ops.${event.kind}`, key: event.key, count: event.count },
        "ops event",
      );
      dropPending(event.id);
      emit([event]);
      return event;
    },

    ack(upTo) {
      const at = now();
      const acked = store.ackEvents(db, workspaceId, upTo ?? at, at);
      if (acked.length > 0) {
        logger.info({ event: "ops.ack", acked: acked.length }, "ops events acked");
        refreshUnacked();
      }
      for (const event of acked) dropPending(event.id);
      emit(acked);
      return acked.length;
    },

    list: (opts) => store.listEvents(db, workspaceId, opts),

    unacked: currentUnacked,

    sweep(at = now()) {
      const removed = store.sweepEvents(db, workspaceId, at);
      if (removed > 0) {
        logger.info({ event: "ops.sweep", removed }, "ops events swept");
        refreshUnacked();
      }
      return removed;
    },

    close() {
      closed = true;
      for (const [id, window] of windows) {
        clearTimeout(window.timer);
        windows.delete(id);
        if (window.pending) {
          log(window.pending.event, { coalesced: window.pending.coalesced });
          emit([window.pending.event]);
        }
      }
    },
  };
}
