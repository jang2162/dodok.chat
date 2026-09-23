/**
 * 첨부 HTTP(스펙 4.3). 이 스코프는 모든 content-type 을 **원시 버퍼**로 받는다 — 바깥 JSON 파서를 지우고 다시 단다
 * (스코프 안에서만 — 다른 경로의 JSON 파싱은 그대로). 인증은 onRequest 라 본문을 받기 전에 거절한다.
 * 응답 헤더는 받은 파일이 무엇이든 브라우저가 문서로 실행하지 못하게 한다(nosniff·CSP sandbox·image 만 inline)
 */
import { verifyBridgeToken } from "@dodok/openclaw-adapter";
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  BRIDGE_ATTACHMENT_HEADERS as H,
  BRIDGE_ATTACHMENTS_PATH,
  Id,
} from "@dodok/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { open } from "node:fs/promises";
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
  bridgeToken: string;
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
 * 파일을 먼저 열어 보고(없으면 404 — 정리와 스친 행) 스트림으로 보낸다. 스트림은 autoClose 라 다 보내거나,
 * 요청이 끊겨 Fastify 가 destroy 하면 fd 를 닫는다
 */
async function sendBlob(
  reply: FastifyReply,
  found: NonNullable<ReturnType<typeof findReadable>>,
  forceDownload: boolean,
) {
  const { attachment: a, path } = found;
  const handle = await open(path, "r").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") throw apiError("NOT_FOUND", "attachment not found");
    throw err;
  });
  reply
    .header("content-type", a.mime)
    .header("content-length", String(a.size))
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox")
    .header("cache-control", "private, max-age=31536000, immutable")
    .header("content-disposition", contentDisposition(a, forceDownload));
  return reply.send(handle.createReadStream());
}

function requireBridge(token: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const header = request.headers.authorization;
    const provided = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : undefined;
    if (!verifyBridgeToken(token, provided)) throw apiError("UNAUTHORIZED", "브리지 토큰이 틀렸다");
  };
}

export function registerAttachmentRoutes(fastify: FastifyInstance, ctx: AttachmentRouteContext): void {
  void fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const deps: AttachmentDeps = { db: ctx.db, dir: ctx.dir, locks: ctx.locks };
    const session = requireSession(ctx);
    const bridge = requireBridge(ctx.bridgeToken);

    scope.post(
      "/api/v1/attachments",
      { onRequest: session, bodyLimit: ATTACHMENT_LIMITS.userImageMaxBytes },
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
