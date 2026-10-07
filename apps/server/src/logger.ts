import { type FastifyReply, type FastifyRequest, LogController } from "fastify";
import pino, { type DestinationStream, type Logger } from "pino";
import { ipPrefix } from "./modules/ops/ip";

// x-*-token 꼴 요청 헤더는 지금 쓰는 곳이 없다(브리지 토큰은 Authorization·핸드셰이크 auth 로 온다) — 토큰을 싣는
// 헤더를 새로 만들면 이름을 여기에 적는다. pino redact 는 헤더 이름 와일드카드를 받지 못한다.
// 토큰을 URL 경로에 싣는 라우트를 새로 만들면 redactUrl 에 그 경로를 더한다 — Fastify 의 `incoming request` 줄이 req.url 을
// info 로 남긴다(지금은 웹훅 /hooks/<token>)
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

/** whk_ 와 그 뒤 6자 — 자동화 목록의 tokenPrefix(whk_ 뒤 6자, modules/automations/tokens.ts)만큼만 보인다 */
const HOOK_SHOWN = "whk_".length + 6;

/**
 * 로그에 싣는 요청 URL — 웹훅 토큰을 앞부분만 남기고 「…」로 가린다. 대상은 둘: /hooks/ 다음 경로 조각(대소문자 무관, 퍼센트
 * 인코딩한 조각도 앞 10자만)과 그 밖 어디든 whk_ 토큰 꼴(/hooks%2F…·쿼리 — 라우트에 안 맞아 404 여도 요청 줄은 남는다). 다른
 * 경로·쿼리는 그대로다
 */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/hooks\/)([^/?#]+)/gi, (_m, head: string, segment: string) =>
      segment.length > HOOK_SHOWN ? `${head}${segment.slice(0, HOOK_SHOWN)}…` : `${head}${segment}`,
    )
    .replace(/whk_([\w-]{6})[\w-]+/g, "whk_$1…");
}

/**
 * Fastify 요청 로그(`incoming request` 줄의 req) — Fastify 기본 직렬화와 같은 필드에 원격 주소(IPv4 /24·IPv6 /48, 운영 사건
 * detail.ipPrefix 와 같은 값)와 URL 속 웹훅 토큰(redactUrl)만 가린다. 로그에만 쓴다 — 레이트리밋·인증 실패 가드는 request.ip
 * 전체를 그대로 키로 쓴다
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
    url: redactUrl(req.url),
    version: req.headers?.["accept-version"],
    host: req.host,
    remoteAddress: ipPrefix(req.ip ?? ""),
    remotePort: req.socket?.remotePort,
  };
}

/**
 * Fastify 기본 404 처리기의 「Route <method>:<url> not found」 줄은 직렬화기를 거치지 않고 URL 을 글로 싣는다 — 같은 가림을
 * 거치게 한다(GET /hooks/<token> 처럼 라우트가 없는 꼴). 나머지 줄은 Fastify 그대로다
 */
export class RedactingLogController extends LogController {
  override routeNotFound(request: FastifyRequest, _reply: FastifyReply): void {
    if (this.isLogDisabled(request)) return;
    request.log.info(`Route ${request.raw.method}:${redactUrl(request.raw.url ?? "")} not found`);
  }
}

export type { Logger };
