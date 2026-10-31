import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { findReadable, uploadAttachment } from "../src/modules/attachments/service";
import { createChannel } from "../src/modules/channels/service";
import { newTestDb } from "./helpers/db";
import { makePng } from "./helpers/png";
import { seedWorkspace } from "./helpers/seed";

// 러너 토큰의 「자기 업로드」 판정(attachments/service.ts findReadable 의 러너 갈래) — uploaderId 만이 아니라 uploaderType 도 본다
describe("findReadable 러너 — 자기 업로드는 러너(bridge)가 올린 행만", () => {
  let db: Db;
  let dir: string;
  let channelId: string;
  let userId: string;

  beforeEach(async () => {
    db = newTestDb();
    dir = await mkdtemp(join(tmpdir(), "dodok-runner-attachments-"));
    const seeded = seedWorkspace(db, { userHandle: "alice" });
    userId = seeded.userId;
    channelId = createChannel(db, { workspaceId: seeded.workspaceId, createdBy: userId, name: "a" }).id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("사람 행의 uploaderId 가 러너 토큰 id 와 같은 글자여도 러너는 못 본다 — 사용자 id 와 토큰 id 가 겹친다고 자기 업로드가 아니다", async () => {
    // 실제로는 사용자 id(Better Auth)와 토큰 id(uuidv7)가 겹치지 않는다 — 방어 겹이 혼자 서 있게 일부러 같은 글자로 만든다
    const tokenId = userId;
    const human = await uploadAttachment(
      { db, dir },
      { channelId, uploader: { type: "user", userId }, bytes: makePng(2, 2) },
    );
    expect(
      findReadable({ db, dir }, human.id, { type: "runner", tokenId, mayRead: () => false }),
    ).toBeUndefined();
  });
});
