import { type FastifyReply, type FastifyRequest, LogController } from "fastify";
import pino, { type DestinationStream, type Logger } from "pino";
import { ipPrefix } from "./modules/ops/ip";

// x-*-token 꼴 요청 헤더는 지금 쓰는 곳이 없다(브리지 토큰은 Authorization·핸드셰이크 auth 로 온다) — 토큰을 싣는
// 헤더를 새로 만들면 이름을 여기에 적는다. pino redact 는 헤더 이름 와일드카드를 받지 못한다.
// 토큰을 URL 경로에 싣는 라우트를 새로 만들면 redactUrl 에 그 경로를 더한다 — Fastify 의 `incoming request` 줄이 req.url 을
// info 로 남긴다(지금은 웹훅 /hooks/<token>). 앞단 리버스 프록시도 접근·오류 로그에 URI 를 원문으로 남긴다 — 앱이 막을 수
// 없으니 docs/guides/docker-deploy.md 「프록시 접근 로그」의 Caddy 필터 조각에도 같은 경로를 더한다. 토큰 접두(whk_·dpt_)는
// 쿼리 등에 잘못 실려 와도 두 자리가 모두 가린다 — 접두가 붙은 토큰을 새로 만들면 그 접두도 두 자리에 더한다
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
  return pino(
    { level, redact: { paths: REDACT_PATHS, censor: "***" }, serializers: { err: serializeErr } },
    destination,
  );
}

/**
 * pino 기본 err 직렬화에서 Buffer 값 속성을 뗀다. redact 의 와일드카드 경로가 로그 객체 깊이 1~2 의 Buffer 안을 걷다 던져 로그 호출이
 * 예외가 된다 — Node HTTP 파서 오류의 rawPacket(받은 요청 바이트 — URL 속 웹훅 토큰 포함)이 그 꼴이고, Fastify 기본
 * clientErrorHandler 가 그 오류를 trace 로 남기므로, 떼지 않으면 LOG_LEVEL=trace 에서 잘못된 요청 하나가 서버를 죽인다. err 밖의
 * 키에는 Buffer 를 싣지 않는다. Fastify 는 이 로거의 직렬화기를 자기 기본보다 앞세운다(loggerInstance)
 */
function serializeErr(err: Error): unknown {
  const out: unknown = pino.stdSerializers.err(err);
  // 오류가 아니면 받은 값 그대로 온다 — 부른 쪽 객체를 고치지 않는다
  if (out === err || out === null || typeof out !== "object") return out;
  for (const [key, value] of Object.entries(out)) {
    if (Buffer.isBuffer(value)) delete (out as Record<string, unknown>)[key];
  }
  return out;
}

/** whk_ 와 그 뒤 6자 — 자동화 목록의 tokenPrefix(whk_ 뒤 6자, modules/automations/tokens.ts)만큼만 보인다 */
const HOOK_SHOWN = "whk_".length + 6;

/**
 * 로그에 싣는 요청 URL — 웹훅 토큰을 앞부분만 남기고 「…」로 가린다. 대상은 셋: /hooks/ 다음 경로 조각(대소문자 무관, 퍼센트
 * 인코딩한 조각도 앞 10자만)과 그 밖 어디든 whk_ 토큰 꼴(/hooks%2F…·쿼리 — 라우트에 안 맞아 404 여도 요청 줄은 남는다), 그리고
 * 개인 토큰 dpt_ 꼴(/mcp 는 Authorization 머리로만 받지만 URL 만 받는 MCP 클라이언트에 ?token= 으로 넣어 보는 오설정이 있다 —
 * 401 이어도 토큰은 유효한 채다. dpt_ 뒤 6자는 토큰 목록의 prefix). 넷째로 쿼리 relPath 의 값(러너 디렉터리 둘러보기 — 사람
 * 머신의 디렉터리 구조라 운영 로그에 남기지 않는다, 러너 일반화 스펙 6장)은 통째로 「…」. 다른 경로·쿼리는 그대로다
 */
export function redactUrl(url: string): string {
  return url
    .replace(/(\/hooks\/)([^/?#]+)/gi, (_m, head: string, segment: string) =>
      segment.length > HOOK_SHOWN ? `${head}${segment.slice(0, HOOK_SHOWN)}…` : `${head}${segment}`,
    )
    .replace(/whk_([\w-]{6})[\w-]+/g, "whk_$1…")
    .replace(/dpt_([\w-]{6})[\w-]+/g, "dpt_$1…")
    .replace(/\?[^#]*/, redactRelPath);
}

/**
 * 쿼리(「?」부터 「#」 앞까지)에서 키가 relPath 인 값을 「…」로. 키는 디코드해서 본다 — Fastify 쿼리 파서(fast-querystring)가 키도
 * 퍼센트 디코드하므로 rel%50ath=… 도 relPath 로 받는다(태스크 4 리뷰 L3). 디코드 못 하는 키는 날 글자 그대로 견준다
 */
function redactRelPath(query: string): string {
  return query.replace(/([?&])([^=&]*)=[^&]*/g, (part, sep: string, rawKey: string) => {
    let key = rawKey.replace(/\+/g, " ");
    try {
      key = decodeURIComponent(key);
    } catch {
      // 잘못된 퍼센트 인코딩 — 파서도 날 글자로 둔다
    }
    return key.toLowerCase() === "relpath" ? `${sep}${rawKey}=…` : part;
  });
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
