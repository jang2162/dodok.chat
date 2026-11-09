import { z } from "zod";
import { Id, IsoDateTime } from "../common";
import { Attachment, ConversationTitle } from "../domain";

// GET /api/v1/attachments — 파일함 목록(파일함 스펙 4.1)

export const FILE_PAGE_SIZE = 50;
export const FILE_PAGE_MAX = 100;

export const FileListQuery = z.object({
  /** 주면 그 대화 하나 — 읽을 수 없으면 서버가 404(빈 목록이 아니다) */
  channelId: Id.optional(),
  kind: z.enum(["image", "file"]).optional(),
  /** 첨부 이름 부분 일치. 1글자부터 받는다 — 파일함은 읽을 수 있는 첨부 표만 훑어 ⌘K 의 2글자 문턱이 필요 없다 */
  q: z.string().trim().min(1).max(100).optional(),
  /** 그 첨부가 묶인 메시지의 작성자 — 에이전트가 올린 첨부 행은 「어느 에이전트」를 메시지에만 갖는다 */
  authorType: z.enum(["user", "agent", "automation"]).optional(),
  authorId: Id.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(FILE_PAGE_MAX).default(FILE_PAGE_SIZE),
});
export type FileListQuery = z.infer<typeof FileListQuery>;

/** SearchHit 와 겹치는 필드는 같은 이름·뜻이다 — 메시지로 가기가 검색 결과 가기와 같은 길을 탄다 */
export const FileListItem = z.object({
  attachment: Attachment,
  messageId: Id,
  channelId: Id,
  conversationId: Id,
  conversationTitle: ConversationTitle,
  seq: z.number().int().min(1),
  threadRootId: Id.optional(),
  authorType: z.enum(["user", "agent", "automation"]),
  authorId: Id.optional(),
  /** 메시지 시각 */
  createdAt: IsoDateTime,
  channelArchived: z.boolean(),
});
export type FileListItem = z.infer<typeof FileListItem>;

export const FileList = z.object({ items: z.array(FileListItem), nextCursor: z.string().optional() });
export type FileList = z.infer<typeof FileList>;
