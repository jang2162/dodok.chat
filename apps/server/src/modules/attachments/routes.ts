/**
 * 첨부 HTTP(스펙 4.3). 이 스코프는 모든 content-type 을 **원시 버퍼**로 받는다 — 바깥 JSON 파서를 지우고 다시 단다
 * (스코프 안에서만 — 다른 경로의 JSON 파싱은 그대로). 인증은 onRequest 라 본문을 받기 전에 거절한다.
 * 응답 헤더는 받은 파일이 무엇이든 브라우저가 문서로 실행하지 못하게 한다(nosniff·CSP sandbox·image 만 inline)
 */
import {
  ATTACHMENT_LIMITS,
  type Attachment,
  BRIDGE_ATTACHMENT_HEADERS as H,
  BRIDGE_ATTACHMENTS_PATH,
  type BridgeAuthGuard,
  Id,
  RUNNER_ATTACHMENTS_PATH,
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
import { type AttachmentDeps, findReadable, type Uploader, uploadAttachment } from "./service";
import type { BlobLocks } from "./store";

/** locks 는 정리 타이머와 같은 객체여야 한다(app.ts 가 하나를 만들어 둘에 준다) */
export type AttachmentRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  dir: string;
  /** 브리지 핸드셰이크와 같은 검증(DB 브리지 토큰) — 던지면 401 */
  verifyBridgeToken: TokenVerifier;
  /**
   * 있으면 러너 첨부 경로(RUNNER_ATTACHMENTS_PATH)를 연다. verifyToken 은 `/runner` 핸드셰이크와 같은 검증(DB 러너 토큰 — 던지면 401).
   * GET 은 그 토큰이 올린 첨부와 mayRead(러너 어댑터의 mayReadAttachment — 그 토큰의 러너에 열린 런의 deliver 첨부)만 준다(판정 R5)
   */
  runner?: {
    verifyToken: (presented: unknown) => { tokenId: string } | null;
    mayRead: (tokenId: string, attachmentId: string) => boolean;
  };
  /**
   * 브리지·러너 핸드셰이크와 같은 실패 카운터 인스턴스(app.ts 가 하나를 만들어 넷에 준다 — 러너 스펙 5장). 주소는 request.ip —
   * TRUST_PROXY 일 때 X-Forwarded-For 를 따르는 것이 핸드셰이크의 bridgeClientAddress 와 같다. onBlocked 의 path 는 막히게 한 쪽
   */
  bridgeGuard: {
    guard: BridgeAuthGuard;
    now: () => number;
    onBlocked: (address: string, path: TokenPath) => void;
  };
  locks: BlobLocks;
  /** true 면 업로드(사람·브리지)를 507 INSUFFICIENT_STORAGE 로 거절한다 — 디스크 여유 error(운영 보강 스펙 5.4). 없으면 막지 않는다 */
  diskFull?: () => boolean;
};

/** 외부 입력(Bearer 값) 그대로 받아 통과면 무엇이든, 아니면 null */
type TokenVerifier = (presented: unknown) => unknown;
type TokenPath = "bridge" | "runner";

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

/**
 * 에이전트 쪽(브리지·러너) 토큰 인증 — 두 경로가 같은 가드를 지나므로 한쪽에서 막힌 주소는 다른 쪽에서도 막힌다.
 * 통과한 검증 결과는 verified 에 요청별로 남긴다(러너 GET·POST 가 토큰 id 를 읽는다)
 */
function requireToken(
  verify: TokenVerifier,
  bridgeGuard: AttachmentRouteContext["bridgeGuard"],
  path: TokenPath,
  verified: WeakMap<FastifyRequest, unknown>,
) {
  return async (request: FastifyRequest): Promise<void> => {
    const { guard, now, onBlocked } = bridgeGuard;
    const address = request.ip;
    const at = now();
    // 막힌 주소는 토큰을 보지 않는다 — 성공도 카운터를 비우지 않으므로 정상 토큰도 막힌 동안은 429
    if (guard.isBlocked(address, at)) throw apiError("RATE_LIMITED", "인증 실패가 너무 많습니다");
    const header = request.headers.authorization;
    const provided = header?.slice(0, 7).toLowerCase() === "bearer " ? header.slice(7).trim() : undefined;
    let result: unknown;
    try {
      result = verify(provided);
    } catch (err) {
      // 검증 오류(저장소 등)는 통과가 아니라 거절이다(fail-closed) — 원인만 남기고 토큰은 싣지 않는다.
      // 플러그인·러너 잘못이 아니라 실패로 세지 않는다(핸드셰이크와 같다)
      request.log.error({ err }, `${path} token verification failed`);
      throw apiError("UNAUTHORIZED", `${path} 토큰이 틀렸다`);
    }
    if (result) {
      verified.set(request, result);
      return;
    }
    if (guard.fail(address, at)) onBlocked(address, path);
    throw apiError("UNAUTHORIZED", `${path} 토큰이 틀렸다`);
  };
}

export function registerAttachmentRoutes(fastify: FastifyInstance, ctx: AttachmentRouteContext): void {
  void fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    const deps: AttachmentDeps = { db: ctx.db, dir: ctx.dir, locks: ctx.locks };
    const session = requireSession(ctx);
    const verified = new WeakMap<FastifyRequest, unknown>();
    const bridge = requireToken(ctx.verifyBridgeToken, ctx.bridgeGuard, "bridge", verified);
    // 업로드 상한은 본문을 받기 전에 — 세션(REST 상한) 뒤에 한 번 더
    const uploadLimit = async (request: FastifyRequest): Promise<void> =>
      request.server.restLimits?.upload(request, sessionUser(request).id);
    // 디스크 검사도 본문을 받기 전에(최대 20 MiB 를 받고 버리지 않게), 인증·업로드 상한 **뒤에** 둔다 — 인증 전이면 누구에게나
    // 디스크 상태를 알려 주고, 상한 앞이면 507 을 받고 곧바로 다시 보내는 클라이언트가 상한을 소모하지 않고 되풀이한다
    const storage = async (): Promise<void> => {
      if (ctx.diskFull?.()) throw apiError("INSUFFICIENT_STORAGE", "서버 디스크 여유가 부족합니다");
    };

    scope.post(
      "/api/v1/attachments",
      { onRequest: [session, uploadLimit, storage], bodyLimit: ATTACHMENT_LIMITS.userImageMaxBytes },
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

    // 에이전트 쪽 경로 둘 — 브리지(플러그인)와 러너가 같은 규칙(20 MiB·매직 바이트·디스크 여유 507). 러너가 올린 파일도
    // uploader 는 bridge(에이전트 쪽)다 — 정본 저장이 같은 claimBridgeAttachments 로 묶는다. 러너는 uploader_id 에 토큰 id 를
    // 남기고, 읽기는 그 토큰의 범위로 좁힌다(판정 R5 — 범위 밖은 없는 id 와 같은 404)
    type AgentPath = {
      path: string;
      auth: ReturnType<typeof requireToken>;
      uploader: (request: FastifyRequest) => Uploader;
      viewer: (request: FastifyRequest) => Parameters<typeof findReadable>[2];
    };
    const agentPaths: AgentPath[] = [
      {
        path: BRIDGE_ATTACHMENTS_PATH,
        auth: bridge,
        uploader: () => ({ type: "bridge" }),
        viewer: () => ({ type: "bridge" }),
      },
    ];
    const { runner } = ctx;
    if (runner) {
      const tokenIdOf = (request: FastifyRequest): string => {
        const tokenId = (verified.get(request) as { tokenId?: unknown } | undefined)?.tokenId;
        // 인증 훅이 통과시킨 요청에는 늘 있다 — 없으면 배선 버그라 거절로 떨어진다
        if (typeof tokenId !== "string") throw apiError("UNAUTHORIZED", "runner 토큰이 틀렸다");
        return tokenId;
      };
      agentPaths.push({
        path: RUNNER_ATTACHMENTS_PATH,
        auth: requireToken(runner.verifyToken, ctx.bridgeGuard, "runner", verified),
        uploader: (request) => ({ type: "bridge", runnerTokenId: tokenIdOf(request) }),
        viewer: (request) => {
          const tokenId = tokenIdOf(request);
          return { type: "runner", tokenId, mayRead: (id) => runner.mayRead(tokenId, id) };
        },
      });
    }
    for (const { path, auth: agent, uploader, viewer } of agentPaths) {
      scope.post(
        path,
        { onRequest: [agent, storage], bodyLimit: ATTACHMENT_LIMITS.agentFileMaxBytes },
        async (request) => {
          const channelId = Id.safeParse(request.headers[H.channelId]);
          if (!channelId.success) throw apiError("VALIDATION", `${H.channelId} 헤더가 필요하다`);
          if (!getChannel(ctx.db, channelId.data, ctx.workspaceId))
            throw apiError("NOT_FOUND", "channel not found");
          return uploadAttachment(deps, {
            channelId: channelId.data,
            uploader: uploader(request),
            bytes: bodyBytes(request),
            nameHint: fileNameHeader(request),
            mimeHint: contentTypeHint(request),
          });
        },
      );

      scope.get(`${path}/:id`, { onRequest: agent }, async (request, reply) => {
        const { id } = parseParams(IdParams, request.params);
        const found = findReadable(deps, id, viewer(request));
        if (!found) throw apiError("NOT_FOUND", "attachment not found");
        return sendBlob(reply, found, true);
      });
    }
  });
}
