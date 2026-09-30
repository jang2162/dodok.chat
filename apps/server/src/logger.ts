import pino, { type DestinationStream, type Logger } from "pino";
import { ipPrefix } from "./modules/ops/ip";

// x-*-token 꼴 요청 헤더는 지금 쓰는 곳이 없다(브리지 토큰은 Authorization·핸드셰이크 auth 로 온다) — 토큰을 싣는
// 헤더를 새로 만들면 이름을 여기에 적는다. pino redact 는 헤더 이름 와일드카드를 받지 못한다
const SECRET_KEYS = new Set([
  "token",
  "LOCAL_AUTH_TOKEN",
  "BRIDGE_TOKEN",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_DEV_GATEWAY_TOKEN",
  "BETTER_AUTH_SECRET",
  "VAPID_PRIVATE_KEY",
  "privateKey",
  "password",
  "authorization",
  "cookie",
  "set-cookie",
]);

/** 식별자가 아닌 키(set-cookie)는 괄호 표기로 — pino redact 경로 문법 */
const segment = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `["${key}"]`);

/** 키마다 깊이 0~3(`k`·`*.k`·`*.*.k`·`*.*.*.k`) — req.headers.cookie·err.config.headers.authorization 류까지 */
const REDACT_PATHS = [...SECRET_KEYS].flatMap((k) =>
  ["", "*", "*.*", "*.*.*"].map((prefix) => `${prefix}${segment(k)}`.replace(/^\./, "")),
);

/** destination 은 테스트가 줄을 모을 때만 준다(기본 stdout) */
export function createLogger(level: string, destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "***" } }, destination);
}

/**
 * Fastify 요청 로그(`incoming request` 줄의 req) — Fastify 기본 직렬화와 같은 필드에 원격 주소만 가린다(IPv4 /24·IPv6 /48,
 * 운영 사건 detail.ipPrefix 와 같은 값). 로그에만 쓴다 — 레이트리밋·인증 실패 가드는 request.ip 전체를 그대로 키로 쓴다
 */
export function requestLogSerializer(req: {
  method: string;
  url: string;
  host?: string;
  ip: string;
  headers?: Record<string, unknown>;
  socket?: { remotePort?: number };
}) {
  return {
    method: req.method,
    url: req.url,
    version: req.headers?.["accept-version"],
    host: req.host,
    remoteAddress: ipPrefix(req.ip ?? ""),
    remotePort: req.socket?.remotePort,
  };
}

export type { Logger };
