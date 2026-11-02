import { AVATAR_MAX_BYTES, Id } from "@dodok/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Auth } from "../../auth";
import { authorizeAgentPatch } from "../../auth/policies";
import { requireSession, sessionUser } from "../../auth/roles";
import { loadUser } from "../../auth/routes";
import type { Db } from "../../db/client";
import { users } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { parseParams } from "../../http/validate";
import type { ServerBus } from "../../realtime/bus";
import { setAgentAvatarAndNotify } from "../agents/actions";
import { agentForRole, getAgent } from "../agents/service";
import { broadcastPeople } from "../members/people";
import { recordRateLimit } from "../ops/http-limits";
import { KeyedLimiter } from "../ops/ratelimit";
import type { OpsService } from "../ops/service";
import {
  AVATAR_FILE,
  AVATAR_MIME,
  type AvatarExt,
  avatarLocks,
  prepareAvatar,
  releaseAvatar,
  writeAvatarFile,
} from "./avatars";

export type AvatarRouteContext = {
  auth: Auth;
  db: Db;
  bus: ServerBus;
  workspaceId: string;
  /** `<DATA_DIR>/avatars` — 첨부 디렉터리와 따로 */
  dir: string;
  /** 사람마다 분당 업로드 상한(LIMITS.avatarUploadPerMin) */
  perMin: number;
  limitNow: () => number;
  ops: Pick<OpsService, "record">;
};

const AgentParams = z.object({ id: Id });
const FileParams = z.object({ file: z.string() });

/** 사람·에이전트 사진(프로필 스펙 3.6) — 본문은 그림 바이트 그대로, 서버는 형식·크기·가로세로만 본다 */
export function registerAvatarRoutes(fastify: FastifyInstance, ctx: AvatarRouteContext): void {
  void fastify.register(async (scope) => {
    // 이 경로들만 본문을 바이트로 받는다 — 형식은 Content-Type 이 아니라 바이트로 가른다(gif 를 png 라고 보내도 400)
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    // 상한을 넘는 본문은 Fastify 413 이 아니라 다른 조건과 같은 400 VALIDATION
    scope.setErrorHandler((error) => {
      if ((error as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
        throw apiError("VALIDATION", `아바타는 ${AVATAR_MAX_BYTES / 1024}KB 이하여야 한다`, {
          maxBytes: AVATAR_MAX_BYTES,
        });
      throw error;
    });
    const session = requireSession(ctx);
    // 에이전트 수정(PATCH /agents/:id)과 같은 정책 — 세션 뒤, 본문을 받기 전에
    const agentPolicy = async (request: FastifyRequest): Promise<void> =>
      authorizeAgentPatch(sessionUser(request).role);
    const limiter = new KeyedLimiter({ perMin: ctx.perMin, now: ctx.limitNow });
    // 본문을 받기 전에 — 세션(REST 상한) 뒤에 한 번 더
    const uploadLimit = async (request: FastifyRequest): Promise<void> => {
      if (limiter.take(sessionUser(request).id)) return;
      recordRateLimit(ctx.ops, request);
      throw apiError("RATE_LIMITED", "아바타 업로드가 너무 많습니다");
    };
    const bytesOf = (request: FastifyRequest): Buffer => {
      if (!Buffer.isBuffer(request.body)) throw apiError("VALIDATION", "아바타 본문이 비었다");
      return request.body;
    };
    const upload = { onRequest: [session, uploadLimit], bodyLimit: AVATAR_MAX_BYTES };

    /** 사람 행을 바꾼다 — 파일을 먼저 쓰고 성공한 뒤 행을 바꾼다(쓰기 실패면 행은 그대로). 옛 파일은 참조가 없으면 지운다 */
    async function setUserAvatar(userId: string, bytes: Buffer | null) {
      const previous = ctx.db
        .select({ url: users.avatarUrl })
        .from(users)
        .where(eq(users.id, userId))
        .get()?.url;
      if (bytes === null) {
        ctx.db.update(users).set({ avatarUrl: null }).where(eq(users.id, userId)).run();
      } else {
        const { file, url } = prepareAvatar(bytes);
        // 쓰기와 행 바꾸기를 그 파일의 잠금 안에서 — 같은 그림을 놓는 정리(releaseAvatar)가 사이에 끼어 지우지 않게
        await avatarLocks.run(file, async () => {
          await writeAvatarFile(ctx.dir, file, bytes);
          ctx.db.update(users).set({ avatarUrl: url }).where(eq(users.id, userId)).run();
        });
      }
      if (previous) await releaseAvatar(ctx.db, ctx.dir, previous);
      broadcastPeople(ctx.bus, ctx.db, ctx.workspaceId);
      return { user: loadUser(ctx.db, userId) };
    }

    async function setAgentAvatar(request: FastifyRequest, bytes: Buffer | null) {
      const { id } = parseParams(AgentParams, request.params);
      const me = sessionUser(request);
      let result: ReturnType<typeof setAgentAvatarAndNotify>;
      if (bytes === null) {
        result = setAgentAvatarAndNotify(ctx, id, null, ctx.workspaceId);
      } else {
        // 파일을 쓰기 전에 — 없는 에이전트면 404 만 내고 디스크에 아무것도 남기지 않는다
        if (!getAgent(ctx.db, id, ctx.workspaceId)) throw apiError("NOT_FOUND", "agent not found");
        const { file, url } = prepareAvatar(bytes);
        result = await avatarLocks.run(file, async () => {
          await writeAvatarFile(ctx.dir, file, bytes);
          return setAgentAvatarAndNotify(ctx, id, url, ctx.workspaceId);
        });
      }
      if (result.previous) await releaseAvatar(ctx.db, ctx.dir, result.previous);
      return { agent: agentForRole(result.agent, me.role) };
    }

    scope.put("/api/v1/me/avatar", upload, async (request) =>
      setUserAvatar(sessionUser(request).id, bytesOf(request)),
    );
    scope.delete("/api/v1/me/avatar", { onRequest: session }, async (request) =>
      setUserAvatar(sessionUser(request).id, null),
    );
    scope.put(
      "/api/v1/agents/:id/avatar",
      { onRequest: [session, agentPolicy, uploadLimit], bodyLimit: AVATAR_MAX_BYTES },
      async (request) => setAgentAvatar(request, bytesOf(request)),
    );
    scope.delete("/api/v1/agents/:id/avatar", { onRequest: [session, agentPolicy] }, async (request) =>
      setAgentAvatar(request, null),
    );

    // 내용 주소라 바뀌지 않는다 — 오래 캐시. 로그인한 세션만(워크스페이스 하나)
    scope.get("/api/v1/avatars/:file", { onRequest: session }, async (request, reply) => {
      const { file } = parseParams(FileParams, request.params);
      if (!AVATAR_FILE.test(file)) throw apiError("NOT_FOUND", "avatar not found");
      const bytes = await readFile(join(ctx.dir, file)).catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") throw apiError("NOT_FOUND", "avatar not found");
        throw err;
      });
      const ext = file.slice(file.lastIndexOf(".") + 1) as AvatarExt;
      return reply
        .headers({
          "content-type": AVATAR_MIME[ext],
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        })
        .send(bytes);
    });
  });
}
