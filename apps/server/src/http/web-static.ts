import { createReadStream, realpathSync, type Stats, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Logger } from "../logger";

/**
 * 빌드된 웹(apps/web/dist)을 서버가 낸다 — 앱 컨테이너 하나 스펙 3.2. 예전 Caddyfile 이 하던 규칙을 값까지 그대로 옮겼다:
 * 백엔드 경로는 SPA 폴백을 타지 않고, /assets/* 는 있는 파일만 1년 immutable(없는 청크는 404 — 옛 버전을 든 탭이 index.html 을
 * 1년 캐시하면 안 된다), 나머지는 파일 아니면 index.html 이고 둘 다 no-cache(sw.js 가 캐시되면 새 버전이 영영 안 뜬다).
 * 압축은 이미지 빌드가 미리 만든 .br·.gz(scripts/precompress-web.mjs)를 Accept-Encoding 에 맞춰 고른다
 */

/**
 * 모든 응답의 보안 헤더. CSP — 스크립트는 이 오리진의 파일만(인라인·eval 없음 — zod 는 웹이 jitless 로 둔다, apps/web/src/lib/zodJitless.ts).
 * 스타일만 'unsafe-inline': 라이브러리가 런타임에 <style> 을 꽂는다(Tiptap·sonner·스크롤 잠금 — 내용이 달라져 해시로 못 막는다).
 * img https: 는 components media 블록의 외부 이미지, blob: 은 작성기 첨부 미리보기, data: 는 인라인 이미지.
 * connect 'self' 가 같은 오리진의 wss(Socket.IO)도 덮는다. worker 는 /sw.js, frame-ancestors 로 다른 사이트의 틀 안에 못 넣는다
 */
export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
} as const;

/** APP_ORIGIN 이 https 일 때만 — http 로 띄운 로컬에서 브라우저가 그 호스트를 1년 https 로 묶지 않게 */
export const HSTS_VALUE = "max-age=31536000";

/**
 * 서버 라우트 몫 — 없는 경로도 서버 404 이고 index.html 로 떨어지지 않는다. 끝이 / 인 것은 그 아래 전부, 아닌 것은 그 경로 하나.
 * /hooks/* 가 빠지면 바깥 서비스의 웹훅 POST 가 아니라 GET 이 SPA 로 떨어지고, /bridge/*·/runner/* 는 첨부 HTTP 다
 */
export const BACKEND_PREFIXES = [
  "/api/",
  "/socket.io/",
  "/bridge/",
  "/runner/",
  "/hooks/",
  "/mcp",
  "/healthz",
  "/llms.txt",
] as const;

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/** 미리 압축한 형제 파일 — 앞이 우선 */
const ENCODINGS = [
  { name: "br", suffix: ".br" },
  { name: "gzip", suffix: ".gz" },
] as const;

/** Caddy 의 path 매처처럼 대소문자를 가리지 않는다 */
export function isBackendPath(path: string): boolean {
  const p = path.toLowerCase();
  return BACKEND_PREFIXES.some((b) => (b.endsWith("/") ? p.startsWith(b) : p === b));
}

/** Accept-Encoding 이 그 이름을 q>0 으로 받는가 */
function accepts(header: string | undefined, name: string): boolean {
  if (!header) return false;
  return header.split(",").some((part) => {
    const [token, ...params] = part.trim().split(";");
    if (token?.trim().toLowerCase() !== name) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

function statFile(path: string): Stats | null {
  try {
    const s = statSync(path);
    return s.isFile() ? s : null;
  } catch {
    return null;
  }
}

export function registerWebStatic(
  fastify: FastifyInstance,
  opts: { webDir: string | undefined; httpsOrigin: boolean; logger: Logger },
): { enabled: boolean } {
  // 개발(pnpm -F @dodok/server dev)은 Vite 가 웹을 낸다 — 정적 서빙도 헤더도 지금처럼 없다
  if (!opts.webDir) return { enabled: false };
  let root: string;
  try {
    root = realpathSync(opts.webDir);
  } catch {
    root = "";
  }
  const indexPath = root ? join(root, "index.html") : "";
  if (!root || !statFile(indexPath)) {
    // 조용히 꺼지면 모든 경로가 JSON 404 라 원인이 안 보인다
    opts.logger.error(
      { webDir: opts.webDir },
      "DODOK_WEB_DIR 에 index.html 이 없다 — 웹을 내지 않는다(이미지면 웹 빌드 단계를 확인)",
    );
    return { enabled: false };
  }

  // 라우트가 이미 정한 값은 덮지 않는다 — 첨부 받기의 `default-src 'none'; sandbox` 가 앱 CSP 로 바뀌면 사용자가 올린 SVG·HTML 이
  // 이 오리진의 스크립트 권한으로 열린다. 예전 Caddy 는 두 줄을 함께 보내 둘 다 걸렸고, 여기서는 라우트 값 하나가 그보다 좁다
  fastify.addHook("onSend", (_request, reply, payload, done) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (opts.httpsOrigin && !reply.hasHeader("strict-transport-security"))
      reply.header("strict-transport-security", HSTS_VALUE);
    done(null, payload);
  });

  /** 웹 디렉터리 안의 파일만 — 디코드한 경로의 ..·백슬래시·NUL, 밖을 가리키는 심볼릭 링크는 없는 것으로 본다 */
  const resolveFile = (decoded: string): string | null => {
    if (decoded.includes("\0") || decoded.includes("\\")) return null;
    const abs = resolve(root, `.${decoded}`);
    if (!abs.startsWith(root + sep)) return null;
    if (!statFile(abs)) return null;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return null;
    }
    return real.startsWith(root + sep) ? real : null;
  };

  const sendFile = (request: FastifyRequest, reply: FastifyReply, path: string, cacheControl: string) => {
    let body = path;
    let stat = statFile(path) as Stats;
    let encoding: string | undefined;
    let hasVariant = false;
    for (const e of ENCODINGS) {
      const variant = statFile(path + e.suffix);
      if (!variant) continue;
      hasVariant = true;
      if (!encoding && accepts(request.headers["accept-encoding"], e.name)) {
        encoding = e.name;
        body = path + e.suffix;
        stat = variant;
      }
    }
    // 조건부 요청 — no-cache 는 매번 재검증이라 바뀌지 않았으면 304 로 본문을 아낀다(Caddy file_server 처럼)
    const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${encoding ? `-${encoding}` : ""}"`;
    reply.header("cache-control", cacheControl).header("etag", etag);
    reply.header("last-modified", stat.mtime.toUTCString());
    if (hasVariant) reply.header("vary", "Accept-Encoding");
    if (request.headers["if-none-match"] === etag) return reply.status(304).send();
    reply.header("content-type", MIME[extname(path).toLowerCase()] ?? "application/octet-stream");
    if (encoding) reply.header("content-encoding", encoding);
    reply.header("content-length", stat.size);
    return reply.send(createReadStream(body));
  };

  // GET 만 등록한다 — Fastify 가 HEAD 를 같이 연다. 그 밖 메서드는 지금처럼 404
  fastify.get("/*", (request, reply) => {
    const pathname = request.url.split("?")[0] ?? "/";
    let decoded: string | null;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      decoded = null;
    }
    if (isBackendPath(decoded ?? pathname)) return reply.callNotFound();
    const asset = (decoded ?? pathname).toLowerCase().startsWith("/assets/");
    const file = decoded === null ? null : resolveFile(decoded);
    if (file) return sendFile(request, reply, file, asset ? IMMUTABLE : NO_CACHE);
    if (asset) return reply.callNotFound();
    return sendFile(request, reply, indexPath, NO_CACHE);
  });
  opts.logger.info({ webDir: root }, "web static on");
  return { enabled: true };
}
