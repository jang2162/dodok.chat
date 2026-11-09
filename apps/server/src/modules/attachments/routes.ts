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
import { type AgentTokenGuard, requireAgentToken } from "../../http/agent-token";
import { apiError } from "../../http/errors";
import { parseParams, parseQuery } from "../../http/validate";
import { assertChannelWritable, loadReadableChannel } from "../channels/service";
import { assertDmWritable } from "../dms/service";
import { getConversation } from "../conversations/store";
import {
  type AttachmentDeps,
  findReadable,
  sizeLimitError,
  type Uploader,
  uploadAttachment,
} from "./service";
import type { BlobLocks } from "./store";

/** locks 는 정리 타이머와 같은 객체여야 한다(app.ts 가 하나를 만들어 둘에 준다) */
export type AttachmentRouteContext = {
  auth: Auth;
  db: Db;
  workspaceId: string;
  dir: string;
  /**
   * 브리지 핸드셰이크와 같은 검증(DB 브리지 토큰) — 던지면 401. 통과면 그 토큰의 Gateway 로 올린 첨부를 표시하고, GET 은 그
   * Gateway 의 범위만 준다(멀티 Gateway 스펙 「브리지 첨부 범위」 절 — 범위 밖은 없는 id 와 같은 404)
   */
  verifyBridgeToken: (presented: unknown) => { tokenId: string; gatewayId: string } | null;
  /**
   * 그 Gateway 가 켜져 있는가 — 꺼진 Gateway 의 토큰은 핸드셰이크처럼 401 로 거절하고 실패로 세지 않는다(끈 것은 고장이 아니다,
   * 멀티 Gateway 스펙 「오류 처리」 절). 검증(verifyBridgeToken)에 넣지 않는 것은 그쪽의 null 이 실패 카운터에 들어가기 때문이다
   */
  acceptBridgeGateway: (gatewayId: string) => boolean;
  /**
   * 있으면 러너 첨부 경로(RUNNER_ATTACHMENTS_PATH)를 연다. verifyToken 은 `/runner` 핸드셰이크와 같은 검증(DB 러너 토큰 — 던지면 401).
   * GET 은 그 토큰이 올린 첨부와 mayRead(러너 어댑터의 mayReadAttachment — 그 토큰의 러너에 열린 런의 deliver 첨부)만 준다(판정 R5)
   */
  runner?: {
    verifyToken: (presented: unknown) => { tokenId: string } | null;
    mayRead: (tokenId: string, attachmentId: string) => boolean;
  };
  /** 브리지·러너 핸드셰이크와 같은 실패 카운터 인스턴스(app.ts 가 하나를 만들어 핸드셰이크·첨부·설치 파일에 준다 — 러너 스펙 5장) */
  bridgeGuard: AgentTokenGuard;
  locks: BlobLocks;
  /** true 면 업로드(사람·브리지)를 507 INSUFFICIENT_STORAGE 로 거절한다 — 디스크 여유 error(운영 보강 스펙 5.4). 없으면 막지 않는다 */
  diskFull?: () => boolean;
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

export function registerAttachmentRoutes(fastify: FastifyInstance, ctx: AttachmentRouteContext): void {
  void fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    // 라우트 bodyLimit 이 서비스의 판별 전 상한(사람은 파일 상한)과 같아 Fastify 의 413 이 서비스 검사보다 먼저 난다 — 그 일반 문구를 서비스와 같은 문구·maxBytes 로
    // 다시 씌워 바깥 오류 처리기로 넘긴다(던지면 부모 처리기가 받는다)
    scope.setErrorHandler((error, request) => {
      if ((error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
        throw sizeLimitError(request.routeOptions.bodyLimit ?? 0, 413);
      throw error;
    });
    const deps: AttachmentDeps = { db: ctx.db, dir: ctx.dir, locks: ctx.locks };
    const session = requireSession(ctx);
    const verified = new WeakMap<FastifyRequest, unknown>();
    const bridge = requireAgentToken({
      verify: ctx.verifyBridgeToken,
      guard: ctx.bridgeGuard,
      path: "bridge",
      route: "attachments",
      verified,
      accept: (result) => ctx.acceptBridgeGateway((result as { gatewayId: string }).gatewayId),
    });
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
      { onRequest: [session, uploadLimit, storage], bodyLimit: ATTACHMENT_LIMITS.userFileMaxBytes },
      async (request) => {
        const { channelId } = parseQuery(UploadQuery, request.query);
        const user = sessionUser(request);
        // 남의 DM 은 없는 채널과 같은 404(auth/channel-access.ts), 보관한 채널로는 올리지 않는다(계획 판정 PC1). 에이전트 쪽 경로는
        // 막지 않는다 — 보관 직전에 시작한 런의 늦은 정본이 파일을 싣고 와도 저장만 하는 규칙(runs/orchestrator.ts onCanonical)을 따른다
        loadReadableChannel(ctx.db, channelId, user.workspaceId, user.id);
        assertDmWritable(ctx.db, assertChannelWritable(ctx.db, channelId, user.workspaceId), user.role);
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
    // uploader 는 bridge(에이전트 쪽)다 — 정본 저장이 같은 claimBridgeAttachments 로 묶는다. 러너는 uploader_id 에 토큰 id 를,
    // 플러그인은 gateway_id 에 토큰의 Gateway 를 남기고, 읽기는 그 토큰·Gateway 의 범위로 좁힌다(판정 R5·멀티 Gateway 스펙 「브리지 첨부 범위」 절 —
    // 범위 밖은 없는 id 와 같은 404)
    type AgentPath = {
      path: string;
      auth: ReturnType<typeof requireAgentToken>;
      uploader: (request: FastifyRequest) => Uploader;
      viewer: (request: FastifyRequest) => Parameters<typeof findReadable>[2];
    };
    const gatewayIdOf = (request: FastifyRequest): string => {
      const gatewayId = (verified.get(request) as { gatewayId?: unknown } | undefined)?.gatewayId;
      // 인증 훅이 통과시킨 요청에는 늘 있다 — 없으면 배선 버그라 거절로 떨어진다
      if (typeof gatewayId !== "string") throw apiError("UNAUTHORIZED", "bridge 토큰이 틀렸다");
      return gatewayId;
    };
    const agentPaths: AgentPath[] = [
      {
        path: BRIDGE_ATTACHMENTS_PATH,
        auth: bridge,
        uploader: (request) => ({ type: "bridge", gatewayId: gatewayIdOf(request) }),
        viewer: (request) => ({ type: "bridge", gatewayId: gatewayIdOf(request) }),
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
        auth: requireAgentToken({
          verify: runner.verifyToken,
          guard: ctx.bridgeGuard,
          path: "runner",
          route: "attachments",
          verified,
        }),
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
          // 첨부는 그 대화의 채널로 묶는다(채널 세션 계획 판정 PS2)
          const conversationId = Id.safeParse(request.headers[H.conversationId]);
          if (!conversationId.success) throw apiError("VALIDATION", `${H.conversationId} 헤더가 필요하다`);
          const conversation = getConversation(ctx.db, conversationId.data, ctx.workspaceId);
          if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
          return uploadAttachment(deps, {
            channelId: conversation.channelId,
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
