/**
 * 첨부 올리기·잡기·묶기·읽기 권한·정리(스펙 4장). 묶기는 메시지 저장 트랜잭션 안에서 돈다 — claim 으로 검사하고
 * 메시지 행을 넣은 뒤 markBound 로 message_id 를 채운다(메시지 id 는 insert 때 정해진다)
 */
import { ATTACHMENT_LIMITS, type Attachment, artifactUrl, sanitizeAttachmentName } from "@dodok/shared";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { attachments, runs } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { getChannel } from "../channels/service";
import { TERMINAL_STATUSES } from "../runs/machine";
import { sniff } from "./sniff";
import {
  type BlobLocks,
  blobPath,
  defaultBlobLocks,
  removeBlob,
  sha256Of,
  TMP_SUFFIX,
  writeBlob,
} from "./store";

/** locks 는 없으면 모듈 하나(defaultBlobLocks) — 같은 dir 을 쓰는 업로드·정리는 같은 잠금을 지나야 한다 */
export type AttachmentDeps = { db: Db; dir: string; now?: () => Date; locks?: BlobLocks };
/**
 * 러너가 올린 것도 에이전트 쪽(bridge)이다 — runnerTokenId 는 uploader_id 에 남아 그 러너의 읽기 범위가 된다(판정 R5). 플러그인이
 * 올린 것은 gatewayId(그 브리지 토큰의 Gateway)가 gateway_id 에 남아 그 Gateway 의 읽기·묶기 범위가 된다(멀티 Gateway 스펙 6.4)
 */
export type Uploader =
  | { type: "user"; userId: string }
  | { type: "bridge"; runnerTokenId?: string; gatewayId?: string };
/**
 * 러너 토큰 뷰어(판정 R5) — 자기 토큰이 올린 것과, mayRead 가 허락한 것(그 러너에 열린 런의 deliver 첨부)만 본다.
 * 브리지 뷰어와 달리 「묶였다」는 것만으로는 못 본다
 */
export type RunnerViewer = { type: "runner"; tokenId: string; mayRead: (attachmentId: string) => boolean };
/**
 * 브리지 토큰 뷰어(멀티 Gateway 스펙 6.4 — 러너 R5 와 같게) — 그 Gateway 가 올린 것과, 그 Gateway 에서 열린 런(runs.connection_id)의
 * 트리거 메시지에 묶인 것만 본다. 「묶였다」는 것만으로는 못 본다
 */
export type BridgeViewer = { type: "bridge"; gatewayId: string };
type Row = typeof attachments.$inferSelect;

export const UNBOUND_TTL_MS = 24 * 3600_000;
/** 이보다 오래된 `.tmp` 는 죽은 쓰기의 잔재다(스펙 4.7) */
export const STALE_TMP_MS = 3600_000;
const SHA_NAME = /^[0-9a-f]{64}$/;
const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function toAttachment(row: Row): Attachment {
  return {
    id: row.id,
    kind: row.kind as Attachment["kind"],
    url: artifactUrl(row.id),
    name: row.name,
    mime: row.mime,
    size: row.size,
    ...(row.width === null ? {} : { width: row.width }),
    ...(row.height === null ? {} : { height: row.height }),
  };
}

export async function uploadAttachment(
  deps: AttachmentDeps,
  input: { channelId: string; uploader: Uploader; bytes: Uint8Array; nameHint?: string; mimeHint?: string },
): Promise<Attachment> {
  const max =
    input.uploader.type === "user"
      ? ATTACHMENT_LIMITS.userImageMaxBytes
      : ATTACHMENT_LIMITS.agentFileMaxBytes;
  if (input.bytes.length > max) throw apiError("VALIDATION", "크기 상한을 넘는다", { maxBytes: max });
  if (input.bytes.length === 0) throw apiError("VALIDATION", "빈 파일이다");
  const s = sniff(input.bytes, input.mimeHint);
  if (input.uploader.type === "user" && s.kind !== "image")
    throw apiError("VALIDATION", "이미지만 올릴 수 있습니다");
  const sha = sha256Of(input.bytes);
  const fallback = s.kind === "image" ? `image.${EXT[s.mime] ?? "bin"}` : "file";
  const row = await (deps.locks ?? defaultBlobLocks).run(sha, async () => {
    await writeBlob(deps.dir, sha, input.bytes);
    return deps.db
      .insert(attachments)
      .values({
        id: uuidv7(),
        channelId: input.channelId,
        uploaderType: input.uploader.type,
        uploaderId:
          input.uploader.type === "user" ? input.uploader.userId : (input.uploader.runnerTokenId ?? null),
        gatewayId: input.uploader.type === "bridge" ? (input.uploader.gatewayId ?? null) : null,
        kind: s.kind,
        name: sanitizeAttachmentName(input.nameHint ?? fallback),
        mime: s.mime,
        size: input.bytes.length,
        width: s.width ?? null,
        height: s.height ?? null,
        sha256: sha,
        messageId: null,
        createdAt: (deps.now ?? (() => new Date()))(),
      })
      .returning()
      .get();
  });
  return toAttachment(row);
}

function rowsInOrder(tx: DbOrTx, ids: string[]): Map<string, Row> {
  if (ids.length === 0) return new Map();
  const rows = tx.select().from(attachments).where(inArray(attachments.id, ids)).all();
  return new Map(rows.map((r) => [r.id, r]));
}

export function claimUserAttachments(
  tx: DbOrTx,
  input: { ids: string[]; channelId: string; userId: string },
): Attachment[] {
  if (new Set(input.ids).size !== input.ids.length) throw apiError("VALIDATION", "같은 첨부를 두 번 넣었다");
  const byId = rowsInOrder(tx, input.ids);
  return input.ids.map((id) => {
    const r = byId.get(id);
    if (
      !r ||
      r.uploaderType !== "user" ||
      r.uploaderId !== input.userId ||
      r.channelId !== input.channelId ||
      r.messageId !== null
    )
      throw apiError("VALIDATION", "쓸 수 없는 첨부다", { attachmentId: id });
    return toAttachment(r);
  });
}

/**
 * 정본을 낸 쪽 — OpenClaw 면 그 Gateway, 러너면 그 러너 토큰. 그쪽이 올린 첨부만 묶는다(멀티 Gateway 스펙 6.4·러너 판정 R5).
 * 러너 쪽을 「gateway_id 가 빈 행」으로 가르지 않는다 — Gateway 를 지우면 그 Gateway 가 올린 행도 비어 러너 정본에 묶이게 된다
 */
export type UploadedBy = { gatewayId: string } | { runnerTokenId: string };

/**
 * 에이전트 정본에 묶을 첨부를 고른다 — 같은 채널·미묶음·에이전트 쪽(bridge)이 올린 것 가운데 by 가 올린 것만. by 가 없으면(정본이
 * 아닌 스냅숏 답) 아무것도 묶지 않는다
 */
export function claimBridgeAttachments(
  tx: DbOrTx,
  input: { ids: string[]; channelId: string; by: UploadedBy | undefined },
): { accepted: Attachment[]; dropped: string[] } {
  const { by } = input;
  const uploadedByOwner = (r: Row) =>
    by !== undefined &&
    ("gatewayId" in by
      ? r.gatewayId === by.gatewayId
      : r.gatewayId === null && r.uploaderId === by.runnerTokenId);
  const byId = rowsInOrder(tx, input.ids);
  const accepted: Attachment[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const id of input.ids) {
    const r = byId.get(id);
    if (
      !r ||
      seen.has(id) ||
      r.uploaderType !== "bridge" ||
      !uploadedByOwner(r) ||
      r.channelId !== input.channelId ||
      r.messageId !== null
    ) {
      dropped.push(id);
      continue;
    }
    seen.add(id);
    accepted.push(toAttachment(r));
  }
  return { accepted, dropped };
}

export function markBound(tx: DbOrTx, ids: string[], messageId: string): void {
  if (ids.length === 0) return;
  tx.update(attachments).set({ messageId }).where(inArray(attachments.id, ids)).run();
}

export function findReadable(
  deps: AttachmentDeps,
  id: string,
  viewer: { type: "user"; userId: string; workspaceId: string } | BridgeViewer | RunnerViewer,
): { attachment: Attachment; path: string } | undefined {
  const row = deps.db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!row) return undefined;
  const ok =
    viewer.type === "runner"
      ? (row.uploaderType === "bridge" && row.uploaderId === viewer.tokenId) || viewer.mayRead(row.id)
      : viewer.type === "bridge"
        ? (row.uploaderType === "bridge" && row.gatewayId === viewer.gatewayId) ||
          (row.messageId !== null && triggersOpenRun(deps.db, row.messageId, viewer.gatewayId))
        : row.messageId === null
          ? row.uploaderType === "user" && row.uploaderId === viewer.userId
          : getChannel(deps.db, row.channelId, viewer.workspaceId) !== undefined;
  return ok ? { attachment: toAttachment(row), path: blobPath(deps.dir, row.sha256) } : undefined;
}

/** 그 메시지를 트리거로 그 연결에서 열린 런이 있는가 — 런의 연결은 맡을 때 정해져 플러그인이 deliver 를 받기 전에 있다 */
function triggersOpenRun(db: DbOrTx, messageId: string, connectionId: string): boolean {
  return (
    db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.connectionId, connectionId),
          eq(runs.triggerMessageId, messageId),
          notInArray(runs.status, [...TERMINAL_STATUSES]),
        ),
      )
      .get() !== undefined
  );
}

function countRows(db: Db, sha: string): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(attachments)
      .where(eq(attachments.sha256, sha))
      .get()?.n ?? 0
  );
}

async function listDir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/**
 * 오래된 미묶음 행을 지운 뒤 dir 을 훑어 어느 행도 안 가리키는 블롭과 STALE_TMP_MS 넘은 `.tmp` 를 지운다(스펙 4.7).
 * 채널 cascade·insert 실패·쓰기와 넣기 사이 프로세스 죽음이 남긴 것도 여기서 치운다. 지우기는 sha 잠금 안에서만
 */
export async function sweepAttachments(
  deps: AttachmentDeps,
  opts: { unboundTtlMs?: number } = {},
): Promise<{ rows: number; blobs: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const locks = deps.locks ?? defaultBlobLocks;
  const cutoff = new Date(now.getTime() - (opts.unboundTtlMs ?? UNBOUND_TTL_MS));
  const stale = deps.db
    .delete(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .returning({ sha: attachments.sha256 })
    .all();
  let blobs = 0;
  for (const prefix of await listDir(deps.dir)) {
    // 블롭 하위 디렉터리는 sha 앞 2자(hex)뿐이다 — 맨 위의 다른 항목(.DS_Store·사람이 둔 파일)은 건너뛴다
    if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
    const sub = join(deps.dir, prefix);
    for (const name of await listDir(sub)) {
      const sha = name.slice(0, 64);
      if (!SHA_NAME.test(sha)) continue;
      if (name === sha) {
        await locks.run(sha, async () => {
          if (countRows(deps.db, sha) > 0) return;
          await removeBlob(deps.dir, sha);
          blobs++;
        });
      } else if (name.endsWith(TMP_SUFFIX)) {
        await locks.run(sha, async () => {
          const path = join(sub, name);
          const st = await stat(path).catch(() => undefined);
          if (st && now.getTime() - st.mtimeMs > STALE_TMP_MS) await rm(path, { force: true });
        });
      }
    }
  }
  return { rows: stale.length, blobs };
}
