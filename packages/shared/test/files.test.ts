import { describe, expect, it } from "vitest";
import { FILE_PAGE_MAX, FILE_PAGE_SIZE, FileList, FileListItem, FileListQuery } from "../src/files";
import * as root from "../src/index";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";

describe("FileListQuery (파일함 스펙 4.1)", () => {
  it("limit 이 없으면 FILE_PAGE_SIZE(50), 쿼리 문자열 숫자를 받는다", () => {
    expect(FILE_PAGE_SIZE).toBe(50);
    expect(FILE_PAGE_MAX).toBe(100);
    expect(FileListQuery.parse({}).limit).toBe(50);
    expect(FileListQuery.parse({ limit: "100" }).limit).toBe(100);
  });

  it("limit 101·0 은 실패", () => {
    expect(FileListQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(FileListQuery.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("q 는 trim 뒤 1~100 코드 포인트", () => {
    expect(FileListQuery.safeParse({ q: "  " }).success).toBe(false);
    expect(FileListQuery.parse({ q: " a " }).q).toBe("a");
    // 코드 포인트로 잰다 — 서로게이트 쌍 이모지 100개는 UTF-16 으로 200 이지만 받는다
    expect(FileListQuery.safeParse({ q: "😀".repeat(100) }).success).toBe(true);
    expect(FileListQuery.safeParse({ q: "가".repeat(101) }).success).toBe(false);
  });

  it("kind 는 image·file 만", () => {
    expect(FileListQuery.parse({ kind: "image" }).kind).toBe("image");
    expect(FileListQuery.safeParse({ kind: "video" }).success).toBe(false);
  });

  it("channelId·authorId 는 Id, authorType 은 셋 중 하나", () => {
    expect(FileListQuery.safeParse({ channelId: "x" }).success).toBe(false);
    expect(FileListQuery.safeParse({ authorType: "bridge" }).success).toBe(false);
    expect(FileListQuery.parse({ channelId: ID, authorType: "agent", authorId: ID })).toMatchObject({
      channelId: ID,
      authorType: "agent",
      authorId: ID,
    });
  });
});

describe("FileList", () => {
  it("항목 하나와 nextCursor 를 받고, 루트에서 다시 내보낸다", () => {
    const item = {
      attachment: {
        id: ID,
        kind: "file",
        url: `artifact://${ID}`,
        name: "a.pdf",
        mime: "application/pdf",
        size: 3,
      },
      messageId: ID,
      channelId: ID,
      conversationId: ID,
      conversationTitle: "세션",
      seq: 1,
      authorType: "user",
      authorId: ID,
      createdAt: "2026-11-09T00:00:00.000Z",
      channelArchived: false,
    };
    expect(FileListItem.parse(item)).toEqual(item);
    expect(FileList.parse({ items: [item], nextCursor: "abc" }).nextCursor).toBe("abc");
    expect(FileListItem.safeParse({ ...item, seq: 0 }).success).toBe(false);
    expect(root.FileListQuery).toBe(FileListQuery);
    expect(root.FILE_PAGE_SIZE).toBe(50);
  });
});
