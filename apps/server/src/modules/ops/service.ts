import type { OpsEvent, OpsEventKind, OpsSeverity, OpsUnacked } from "@dodok/shared";
import type { Db } from "../../db/client";
import type { Logger } from "../../logger";
import type { ServerBus } from "../../realtime/bus";
import * as store from "./store";

export type OpsRecordInput = {
  kind: OpsEventKind;
  key: string;
  severity: OpsSeverity;
  detail?: OpsEvent["detail"];
};

/** 다른 모듈이 운영 사건을 남기는 입구(스펙 2.1). 바뀐 줄은 owner 소켓에 ops.event 로 가고 로그에 ops.<kind> 줄이 남는다 */
export interface OpsService {
  /** 묶기 규칙을 적용해 열린 줄 또는 새 줄을 돌려준다. 실패하면 logger.error 후 null(던지지 않는다) */
  record(input: OpsRecordInput): OpsEvent | null;
  /** 열린 끊김 사건을 닫는다(resolved_at·detail.downMs). 열린 줄이 없으면 null */
  resolve(kind: "gateway_down" | "plugin_down", key: string, at?: Date): OpsEvent | null;
  ack(upTo?: Date): number;
  list(opts: { cursor?: string; severity?: OpsSeverity; limit?: number }): {
    events: OpsEvent[];
    nextCursor?: string;
  };
  unacked(): OpsUnacked;
  sweep(now?: Date): number; // last_at 이 30일 지난 줄 삭제
}

export function createOpsService(deps: {
  db: Db;
  bus: ServerBus;
  logger: Logger;
  workspaceId: string;
  now?: () => Date;
}): OpsService {
  const { db, bus, logger, workspaceId } = deps;
  const now = deps.now ?? (() => new Date());

  // 팬아웃이 던져도(owner 조회 실패 등) 기록은 이미 끝났다 — 부른 쪽의 동작을 막지 않는다
  const emit = (events: OpsEvent[]) => {
    if (events.length === 0) return;
    try {
      const unacked = store.unackedCounts(db, workspaceId);
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

  return {
    record(input) {
      let event: OpsEvent;
      try {
        event = store.recordEvent(db, workspaceId, input, now());
      } catch (err) {
        logger.error({ err, kind: input.kind, key: input.key }, "ops record failed");
        return null;
      }
      log(event);
      emit([event]);
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
      emit([event]);
      return event;
    },

    ack(upTo) {
      const at = now();
      const acked = store.ackEvents(db, workspaceId, upTo ?? at, at);
      if (acked.length > 0) logger.info({ event: "ops.ack", acked: acked.length }, "ops events acked");
      emit(acked);
      return acked.length;
    },

    list: (opts) => store.listEvents(db, workspaceId, opts),

    unacked: () => store.unackedCounts(db, workspaceId),

    sweep(at = now()) {
      const removed = store.sweepEvents(db, workspaceId, at);
      if (removed > 0) logger.info({ event: "ops.sweep", removed }, "ops events swept");
      return removed;
    },
  };
}
