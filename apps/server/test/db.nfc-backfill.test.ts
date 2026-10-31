/**
 * 첨부 이름 NFC 백필(db/nfc-backfill) — NFD 로 저장된 옛 첨부 행과 그 메시지의 attachments_json 을 NFC 로 고쳐 NFC 검색어로 찾히게 한다.
 * createDb 가 migrate 뒤 부팅마다 부르고, 고칠 행이 없으면 아무것도 쓰지 않는다
 */
import { type Attachment, SearchQuery } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../src/db/client";
import { backfillNfcAttachmentNames } from "../src/db/nfc-backfill";
import { attachments, messages } from "../src/db/schema.sqlite";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { searchMessages } from "../src/modules/search/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { channelConversation, seedWorkspace } from "./helpers/seed";

const NFC_NAME = "회의록.pdf";
const NFD_NAME = NFC_NAME.normalize("NFD");

/** 저장 경계가 NFC 로 바꾸기 전에 저장된 꼴 — 첨부 행과 메시지 attachments_json 모두 NFD. 묶이지 않은 NFD 첨부 하나도 */
function seedNfd(db: Db) {
  const { workspaceId, userId } = seedWorkspace(db);
  const channel = createChannel(db, { workspaceId, createdBy: userId, name: "general" });
  const message = createUserMessage(db, new ServerBus(), {
    conversationId: channelConversation(db, channel.id),
    authorId: userId,
    bodyMd: "파일 올림",
    clientMsgId: uuid(),
  });
  const row = (messageId: string | null) => ({
    id: uuid(),
    channelId: channel.id,
    uploaderType: "user",
    uploaderId: userId,
    kind: "file",
    name: NFD_NAME,
    mime: "application/pdf",
    size: 10,
    sha256: "0".repeat(64),
    messageId,
    createdAt: new Date(),
  });
  const bound = row(message.id);
  const unbound = row(null);
  const ascii = { ...row(message.id), name: "plain.pdf" };
  db.insert(attachments).values([bound, unbound, ascii]).run();
  const json = (r: typeof bound): Attachment => ({
    id: r.id,
    kind: "file",
    url: `artifact://${r.id}`,
    name: r.name,
    mime: r.mime,
    size: r.size,
  });
  db.update(messages)
    .set({ attachments: [json(bound), json(ascii)] })
    .where(eq(messages.id, message.id))
    .run();
  const search = (q: string) =>
    searchMessages(db, workspaceId, userId, SearchQuery.parse({ q }), new Date()).hits.map(
      (h) => h.messageId,
    );
  return { message, bound, unbound, ascii, search };
}

const nameOf = (db: Db, id: string) =>
  db.select().from(attachments).where(eq(attachments.id, id)).get()?.name;
const jsonNames = (db: Db, messageId: string) =>
  db
    .select()
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
    ?.attachments.map((a) => a.name);

describe("첨부 이름 NFC 백필", () => {
  it("NFD 행을 고친다 — 첨부 행·attachments_json 이 NFC 가 되고 NFC 검색어로 찾힌다, 다시 돌리면 0", () => {
    const db = newTestDb();
    const t = seedNfd(db);
    expect(t.search("회의록")).toEqual([]);

    expect(backfillNfcAttachmentNames(db)).toBe(2);
    expect(nameOf(db, t.bound.id)).toBe(NFC_NAME);
    expect(nameOf(db, t.unbound.id)).toBe(NFC_NAME);
    expect(nameOf(db, t.ascii.id)).toBe("plain.pdf");
    expect(jsonNames(db, t.message.id)).toEqual([NFC_NAME, "plain.pdf"]);
    expect(t.search("회의록")).toEqual([t.message.id]);

    expect(backfillNfcAttachmentNames(db)).toBe(0);
  });

  describe("파일 DB — createDb 가 부팅 때 돈다", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    it("NFD 행을 넣고 닫은 DB 를 다시 열면 고쳐져 있고, 그다음 부팅은 고칠 행 0", () => {
      dir = mkdtempSync(join(tmpdir(), "dodok-nfc-"));
      const file = join(dir, "dodok.sqlite");
      const first = createDb(file);
      const t = seedNfd(first);
      expect(t.search("회의록")).toEqual([]);
      first.$client.close();

      const fixed: number[] = [];
      const second = createDb(file, { onBackfill: (n) => fixed.push(n) });
      expect(fixed).toEqual([2]);
      expect(nameOf(second, t.bound.id)).toBe(NFC_NAME);
      expect(jsonNames(second, t.message.id)).toEqual([NFC_NAME, "plain.pdf"]);
      expect(backfillNfcAttachmentNames(second)).toBe(0);
      second.$client.close();

      const third = createDb(file, { onBackfill: (n) => fixed.push(n) });
      expect(fixed).toEqual([2, 0]);
      third.$client.close();
    });
  });
});
