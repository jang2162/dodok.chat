/**
 * 첨부 HTTP(스펙 4.3). 이 스코프는 모든 content-type 을 **원시 버퍼**로 받는다 — 바깥 JSON 파서를 지우고 다시 단다
 * (스코프 안에서만 — 다른 경로의 JSON 파싱은 그대로). 인증은 onRequest 라 본문을 받기 전에 거절한다.
 * 응답 헤더는 받은 파일이 무엇이든 브라우저가 문서로 실행하지 못하게 한다(nosniff·CSP sandbox·image 만 inline)
 */
import type { BridgeAuthGuard, BridgeTokenVerifier } from "@dodok/openclaw-adapter";
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  BRIDGE_ATTACHMENT_HEADERS as H,
  BRIDGE_ATTACHMENTS_PATH,
  Id,
} from "@dodok/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { open } from "node:fs/promises";
import { validateHeaderValue } from "node:http";
import { z } from "zod";
import type { Auth } from "../../auth";
import { requireSession, sessionUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { parseParams, parseQuery } from "../../http/validate";
import { getChannel } from "../channels/service";
import { type AttachmentDeps, findReadable, uploadAttachment } from "./service";
import type { BlobLocks } from "./store";

/** locks 는 정리 타이머와 같은 객체여야 한다(app.ts 가 하나를 만들어 둘에 준다) */
export type AttachmentRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  dir: string;
  /** 브리지 핸드셰이크와 같은 검증(DB 브리지 토큰) — 던지면 401 */
  verifyBridgeToken: BridgeTokenVerifier;
  /**
   * 브리지 핸드셰이크와 같은 실패 카운터 인스턴스(app.ts 가 하나를 만들어 둘에 준다). 주소는 request.ip — TRUST_PROXY 일 때
   * X-Forwarded-For 를 따르는 것이 핸드셰이크의 bridgeClientAddress 와 같다
   */
  bridgeGuard: { guard: BridgeAuthGuard; now: () => number; onBlocked: (address: string) => void };
  locks: BlobLocks;
};

const IdParams = z.object({ id: Id });
const UploadQuery = z.object({ channelId: Id });
const DownloadQuery = z.object({ download: z.literal("1").optional() });

function fileNameHeader(request: FastifyRequest): string | undefined {
  const raw = request.headers[H.fileName];
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined; // 망가진 인코딩 — 서비스가 기본 이름을 쓴다
  }
}

function contentTypeHint(request: FastifyRequest): string | undefined {
  const v = request.headers["content-type"];
  return typeof v === "string" ? v : undefined;
}

function bodyBytes(request: FastifyRequest): Buffer {
  const bytes = request.body;
  if (!Buffer.isBuffer(bytes)) throw apiError("VALIDATION", "빈 파일이다"); // 본문 없는 POST
  return bytes;
}

/** RFC 5987 ext-value — encodeURIComponent 가 남기는 ' ( ) * 도 퍼센트로 */
const rfc5987 = (s: string): string =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function contentDisposition(a: Attachment, forceDownload: boolean): string {
  if (a.kind === "image" && !forceDownload) return "inline";
  // 따옴표 안 대체 이름은 인쇄 가능한 ASCII 만(따옴표·역슬래시 제외). 제어 문자는 저장 때 이미 빠졌다
  const ascii = a.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987(a.name)}`;
}

/**
 * 블롭 응답 헤더 값을 파일을 열기 전에 만들고 검사한다 — 보낼 때(setHeader) 던질 값이면 여기서 던져 fd 를 열지 않는다.
 * 설정은 연 뒤에 한다(오류 응답에 1년 immutable 캐시·내려받기 헤더가 남지 않게)
 */
function blobHeaders(a: Attachment, forceDownload: boolean): Record<string, string> {
  const headers = {
    "content-type": a.mime,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cache-control": "private, max-age=31536000, immutable",
    "content-disposition": contentDisposition(a, forceDownload),
  };
  for (const [name, value] of Object.entries(headers)) validateHeaderValue(name, value);
  return headers;
}

/**
 * 파일을 열어 보고(없으면 404 — 정리와 스친 행) 스트림으로 보낸다. 연 파일의 실제 크기가 저장값과 다르면(디스크 손상·손 조작)
 * 틀린 content-length 로 보내다 끊기지 않게 500 으로 떨어진다. 스트림은 autoClose 라 다 보내거나, 요청이 끊겨 Fastify 가
 * destroy 하면 fd 를 닫는다
 */
async function sendBlob(
  reply: FastifyReply,
  found: NonNullable<ReturnType<typeof findReadable>>,
  forceDownload: boolean,
) {
  const { attachment: a, path } = found;
  const headers = blobHeaders(a, forceDownload);
  const handle = await open(path, "r").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw apiError("NOT_FOUND", "attachment not found");
    throw err;
  });
  try {
    const { size } = await handle.stat();
    if (size !== a.size) {
      // 로그에는 id·크기만 — 블롭 경로는 남기지 않는다
      const error = apiError("INTERNAL", "internal error");
      error.cause = { attachmentId: a.id, storedSize: a.size, blobSize: size };
      throw error;
    }
    reply.headers({ ...headers, "content-length": String(size) });
  } catch (err) {
    await handle.close();
    throw err;
  }
  return reply.send(handle.createReadStream());
}

function requireBridge(verify: BridgeTokenVerifier, bridgeGuard: AttachmentRouteContext["bridgeGuard"]) {
  return async (request: FastifyRequest): Promise<void> => {
    const { guard, now, onBlocked } = bridgeGuard;
    const address = request.ip;
    const at = now();
    // 막힌 주소는 토큰을 보지 않는다 — 성공도 카운터를 비우지 않으므로 정상 토큰도 막힌 동안은 429
    if (guard.isBlocked(address, at)) throw apiError("RATE_LIMITED", "인증 실패가 너무 많습니다");
    const header = request.headers.authorization;
    const provided = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : undefined;
    let verified: { tokenId: string } | null;
    try {
      verified = verify(provided);
    } catch (err) {
      // 검증 오류(저장소 등)는 통과가 아니라 거절이다(fail-closed) — 원인만 남기고 토큰은 싣지 않는다.
      // 플러그인 잘못이 아니라 실패로 세지 않는다(핸드셰이크와 같다)
      request.log.error({ err }, "bridge token verification failed");
      throw apiError("UNAUTHORIZED", "브리지 토큰이 틀렸다");
    }
    if (verified) return;
    if (guard.fail(address, at)) onBlocked(address);
    throw apiError("UNAUTHORIZED", "브리지 토큰이 틀렸다");
  };
}

export function registerAttachmentRoutes(fastify: FastifyInstance, ctx: AttachmentRouteContext): void {
  void fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const deps: AttachmentDeps = { db: ctx.db, dir: ctx.dir, locks: ctx.locks };
    const session = requireSession(ctx);
    const bridge = requireBridge(ctx.verifyBridgeToken, ctx.bridgeGuard);
    // 업로드 상한은 본문을 받기 전에 — 세션(REST 상한) 뒤에 한 번 더
    const uploadLimit = async (request: FastifyRequest): Promise<void> =>
      request.server.restLimits?.upload(request, sessionUser(request).id);

    scope.post(
      "/api/v1/attachments",
      { onRequest: [session, uploadLimit], bodyLimit: ATTACHMENT_LIMITS.userImageMaxBytes },
      async (request) => {
        const { channelId } = parseQuery(UploadQuery, request.query);
        const user = sessionUser(request);
        if (!getChannel(ctx.db, channelId, user.workspaceId))
          throw apiError("NOT_FOUND", "channel not found");
        return uploadAttachment(deps, {
          channelId,
          uploader: { type: "user", userId: user.id },
          bytes: bodyBytes(request),
          nameHint: fileNameHeader(request),
          mimeHint: contentTypeHint(request),
        });
      },
    );

    scope.get("/api/v1/attachments/:id", { onRequest: session }, async (request, reply) => {
      const { id } = parseParams(IdParams, request.params);
      const { download } = parseQuery(DownloadQuery, request.query);
      const user = sessionUser(request);
      const found = findReadable(deps, id, { type: "user", userId: user.id, workspaceId: user.workspaceId });
      if (!found) throw apiError("NOT_FOUND", "attachment not found");
      return sendBlob(reply, found, download === "1");
    });

    scope.post(
      BRIDGE_ATTACHMENTS_PATH,
      { onRequest: bridge, bodyLimit: ATTACHMENT_LIMITS.agentFileMaxBytes },
      async (request) => {
        const channelId = Id.safeParse(request.headers[H.channelId]);
        if (!channelId.success) throw apiError("VALIDATION", `${H.channelId} 헤더가 필요하다`);
        if (!getChannel(ctx.db, channelId.data, ctx.workspaceId))
          throw apiError("NOT_FOUND", "channel not found");
        return uploadAttachment(deps, {
          channelId: channelId.data,
          uploader: { type: "bridge" },
          bytes: bodyBytes(request),
          nameHint: fileNameHeader(request),
          mimeHint: contentTypeHint(request),
        });
      },
    );

    scope.get(`${BRIDGE_ATTACHMENTS_PATH}/:id`, { onRequest: bridge }, async (request, reply) => {
      const { id } = parseParams(IdParams, request.params);
      const found = findReadable(deps, id, { type: "bridge" });
      if (!found) throw apiError("NOT_FOUND", "attachment not found");
      return sendBlob(reply, found, true);
    });
  });
}
