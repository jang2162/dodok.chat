/**
 * 첨부 올리기·잡기·묶기·읽기 권한·정리(스펙 4장). 묶기는 메시지 저장 트랜잭션 안에서 돈다 — claim 으로 검사하고
 * 메시지 행을 넣은 뒤 markBound 로 message_id 를 채운다(메시지 id 는 insert 때 정해진다)
 */
import { ATTACHMENT_LIMITS, type Attachment, artifactUrl, sanitizeAttachmentName } from "@dodok/shared";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { attachments } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { getChannel } from "../channels/service";
import { sniff } from "./sniff";
import { blobPath, removeBlob, writeBlob } from "./store";

export type AttachmentDeps = { db: Db; dir: string; now?: () => Date };
export type Uploader = { type: "user"; userId: string } | { type: "bridge" };
type Row = typeof attachments.$inferSelect;

export const UNBOUND_TTL_MS = 24 * 3600_000;
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
  const sha = await writeBlob(deps.dir, input.bytes);
  const fallback = s.kind === "image" ? `image.${EXT[s.mime] ?? "bin"}` : "file";
  const row = deps.db
    .insert(attachments)
    .values({
      id: uuidv7(),
      channelId: input.channelId,
      uploaderType: input.uploader.type,
      uploaderId: input.uploader.type === "user" ? input.uploader.userId : null,
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

export function claimBridgeAttachments(
  tx: DbOrTx,
  input: { ids: string[]; channelId: string },
): { accepted: Attachment[]; dropped: string[] } {
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
  viewer: { type: "user"; userId: string; workspaceId: string } | { type: "bridge" },
): { attachment: Attachment; path: string } | undefined {
  const row = deps.db.select().from(attachments).where(eq(attachments.id, id)).get();
  if (!row) return undefined;
  const ok =
    viewer.type === "bridge"
      ? row.messageId !== null // 브리지는 묶인 첨부만 — 사람이 올리고 아직 안 보낸 것은 못 본다
      : row.messageId === null
        ? row.uploaderType === "user" && row.uploaderId === viewer.userId
        : getChannel(deps.db, row.channelId, viewer.workspaceId) !== undefined;
  return ok ? { attachment: toAttachment(row), path: blobPath(deps.dir, row.sha256) } : undefined;
}

export async function sweepAttachments(
  deps: AttachmentDeps,
  opts: { unboundTtlMs?: number } = {},
): Promise<{ rows: number; blobs: number }> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = new Date(now.getTime() - (opts.unboundTtlMs ?? UNBOUND_TTL_MS));
  const stale = deps.db
    .delete(attachments)
    .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
    .returning({ sha: attachments.sha256 })
    .all();
  let blobs = 0;
  for (const sha of new Set(stale.map((s) => s.sha))) {
    const still = deps.db
      .select({ n: sql<number>`count(*)` })
      .from(attachments)
      .where(eq(attachments.sha256, sha))
      .get();
    if ((still?.n ?? 0) === 0) {
      await removeBlob(deps.dir, sha);
      blobs++;
    }
  }
  return { rows: stale.length, blobs };
}
