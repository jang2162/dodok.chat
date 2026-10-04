/**
 * Gateway 연결 목록 — 멀티 Gateway 스펙 「연결 관리자」 절. 연결을 만들고·바꾸고·지우고, 연결 id 로 찾는다. 브리지는 어댑터가 쥐고 넘겨준다.
 */
import { join } from "node:path";
import type { OutboundMessage } from "@dodok/shared";
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterLogger,
} from "../adapter-types";
import type { BridgeHandle } from "../bridge/server";
import type { GatewayConnector, RecoverTarget } from "../gateway/connection-manager";
import {
  createGatewayConnection,
  type GatewayConnection,
  type GatewayConnectionConfig,
} from "./gateway-connection";

export type GatewayManagerOptions = {
  dataDir: string;
  bridge: BridgeHandle;
  connector: GatewayConnector;
  logger: AdapterLogger;
  backoff?: { initialMs?: number; maxMs?: number; pairingRetryMs?: number };
  sessionKeysToRecover?: (connectionId: string) => RecoverTarget[];
  frameDumpPath?: string;
  onCanonical: (message: OutboundMessage, connectionId: string) => Promise<{ messageId?: string }>;
  emit: (event: AdapterEvent) => void;
  onStatusChange: () => void;
  onDetailChange: () => void;
  onForbidden: (capability: keyof AdapterCapabilities) => void;
};

export type GatewayManager = {
  /** 같은 id 를 지우는 중이면 지우기가 끝난 뒤에 적용한다(그동안 그 id 는 없는 연결이다) */
  upsert(config: GatewayConnectionConfig): void;
  remove(id: string): Promise<void>;
  get(id: string): GatewayConnection | undefined;
  /** 켜진 연결. null·모르는 id·꺼진 연결이면 ADAPTER_UNAVAILABLE */
  require(connectionId: string | null): GatewayConnection;
  /** 더한 차례대로 */
  all(): GatewayConnection[];
  start(): void;
  close(): Promise<void>;
};

// 연결 id 는 디바이스 디렉터리 이름이 된다 — 경로 구분자·`.`·`..` 를 막는다(서버는 uuid 를 준다)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 그 Gateway 의 WS 루프 줄에 gatewayId 를 붙인다 — 재접속·페어링 줄이 어느 Gateway 의 것인지 가른다 */
function withGateway(logger: AdapterLogger, gatewayId: string): AdapterLogger {
  return {
    ...(logger.level === undefined ? {} : { level: logger.level }),
    info: (obj, msg) => logger.info({ ...obj, gatewayId }, msg),
    warn: (obj, msg) => logger.warn({ ...obj, gatewayId }, msg),
    error: (obj, msg) => logger.error({ ...obj, gatewayId }, msg),
    debug: (obj, msg) => logger.debug({ ...obj, gatewayId }, msg),
  };
}

export function createGatewayManager(opts: GatewayManagerOptions): GatewayManager {
  const connections = new Map<string, GatewayConnection>();
  // 지우는 중인 id — 같은 id 의 새 연결이 같은 디바이스 디렉터리를 쓰므로, 옛 remove 가 디렉터리를 지운 뒤에 만든다(리뷰 M2)
  const removing = new Map<string, Promise<void>>();
  let started = false;
  let closed = false;

  function create(config: GatewayConnectionConfig): GatewayConnection {
    const { id } = config;
    const recover = opts.sessionKeysToRecover;
    return createGatewayConnection({
      config,
      deviceDir: join(opts.dataDir, "gateways", id),
      bridge: opts.bridge,
      connector: opts.connector,
      gatewayLogger: withGateway(opts.logger, id),
      ...(opts.backoff ? { backoff: opts.backoff } : {}),
      ...(recover ? { sessionKeysToRecover: () => recover(id) } : {}),
      ...(opts.frameDumpPath === undefined ? {} : { frameDumpPath: opts.frameDumpPath }),
      onCanonical: (message) => opts.onCanonical(message, id),
      emit: opts.emit,
      onStatusChange: opts.onStatusChange,
      onDetailChange: opts.onDetailChange,
      onForbidden: opts.onForbidden,
    });
  }

  function apply(config: GatewayConnectionConfig) {
    const existing = connections.get(config.id);
    if (existing) {
      existing.update(config);
      return;
    }
    const connection = create(config);
    connections.set(config.id, connection);
    opts.logger.info({ gatewayId: config.id, enabled: config.enabled }, "gateway connection added");
    if (started) connection.start();
    opts.onStatusChange();
    opts.onDetailChange();
  }

  return {
    upsert(config) {
      if (!SAFE_ID.test(config.id)) throw new Error(`invalid gateway id: ${JSON.stringify(config.id)}`);
      const pending = removing.get(config.id);
      if (!pending) {
        apply(config);
        return;
      }
      // 같은 id 의 upsert 여럿은 약속 차례대로 붙어 부른 차례대로 적용된다
      // 지우기가 실패해도 적용한다(그 실패는 remove 를 부른 쪽이 받는다)
      void pending
        .catch(() => undefined)
        .then(() => {
          if (closed) return;
          try {
            apply(config);
          } catch (error) {
            opts.logger.error({ err: error, gatewayId: config.id }, "deferred gateway upsert failed");
          }
        });
    },

    async remove(id) {
      const connection = connections.get(id);
      if (!connection) {
        await removing.get(id);
        return;
      }
      // 먼저 목록에서 뺀다 — 지우는 사이 들어온 send·핸드셰이크는 모르는 연결로 거절된다
      connections.delete(id);
      const done = connection.remove().finally(() => {
        if (removing.get(id) === done) removing.delete(id);
      });
      removing.set(id, done);
      await done;
      opts.logger.info({ gatewayId: id }, "gateway connection removed");
      opts.onStatusChange();
      opts.onDetailChange();
    },

    get: (id) => connections.get(id),

    require(connectionId) {
      const connection = connectionId === null ? undefined : connections.get(connectionId);
      if (!connection) throw new AdapterError("ADAPTER_UNAVAILABLE", "unknown gateway connection");
      if (!connection.config().enabled) throw new AdapterError("ADAPTER_UNAVAILABLE", "gateway is disabled");
      return connection;
    },

    all: () => [...connections.values()],

    start() {
      started = true;
      for (const connection of connections.values()) connection.start();
    },

    async close() {
      closed = true;
      await Promise.all([...connections.values()].map((connection) => connection.close()));
    },
  };
}
