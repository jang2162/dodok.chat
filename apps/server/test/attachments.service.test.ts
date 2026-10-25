import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { eq } from "drizzle-orm";
import { v7 as uuid } from "uuid";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client";
import { attachments, users } from "../src/db/schema.sqlite";
import {
  claimBridgeAttachments,
  claimUserAttachments,
  findReadable,
  markBound,
  sweepAttachments,
  type UploadedBy,
  type Uploader,
  uploadAttachment,
} from "../src/modules/attachments/service";
import { type BlobLocks, blobPath, createBlobLocks } from "../src/modules/attachments/store";
import { createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { ServerBus } from "../src/realtime/bus";
import { newTestDb } from "./helpers/db";
import { insertGateway } from "./helpers/gateways";
import { makePng, PDF_BYTES, SVG_BYTES } from "./helpers/png";
import { channelConversation, seedWorkspace } from "./helpers/seed";

const RUNNER = "runner-token-1";
const sha256Of = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("attachments service", () => {
  let db: Db;
  let dir: string;
  let ws: string;
  let chA: string;
  let chB: string;
  let alice: string;
  let bob: string;
  let msgInA: string;

  beforeEach(async () => {
    db = newTestDb();
    dir = await mkdtemp(join(tmpdir(), "dodok-attachments-"));
    const seeded = seedWorkspace(db, { userHandle: "alice" });
    ws = seeded.workspaceId;
    alice = seeded.userId;
    bob = uuid();
    db.insert(users)
      .values({
        id: bob,
        workspaceId: ws,
        handle: "bob",
        displayName: "bob",
        authProvider: "local",
        createdAt: new Date(),
      })
      .run();
    chA = createChannel(db, { workspaceId: ws, createdBy: alice, name: "a" }).id;
    chB = createChannel(db, { workspaceId: ws, createdBy: alice, name: "b" }).id;
    msgInA = createUserMessage(db, new ServerBus(), {
      conversationId: channelConversation(db, chA),
      authorId: alice,
      bodyMd: "hi",
      clientMsgId: "c1",
    }).id;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("사람 업로드: PNG → image, artifact URL, 가로·세로", async () => {
    const a = await uploadAttachment(
      { db, dir },
      {
        channelId: chA,
        uploader: { type: "user", userId: alice },
        bytes: makePng(4, 3),
        nameHint: "shot.png",
      },
    );
    expect(a).toMatchObject({
      kind: "image",
      mime: "image/png",
      name: "shot.png",
      width: 4,
      height: 3,
      url: `artifact://${a.id}`,
    });
    expect(a.thumbUrl).toBeUndefined();
  });

  it("이름이 없으면 이미지는 image.<확장자>, 이름은 정리된다", async () => {
    const a = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) },
    );
    expect(a.name).toBe("image.png");
    const b = await uploadAttachment(
      { db, dir },
      {
        channelId: chA,
        uploader: { type: "bridge" },
        bytes: PDF_BYTES,
        nameHint: "../../etc/보고서\r\n.pdf",
      },
    );
    expect(b.name).toBe("etc보고서.pdf");
  });

  it("사람은 이미지가 아니면 VALIDATION(이미지만 올릴 수 있습니다), SVG 도", async () => {
    for (const bytes of [PDF_BYTES, SVG_BYTES])
      await expect(
        uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "user", userId: alice }, bytes }),
      ).rejects.toMatchObject({ body: { code: "VALIDATION", message: "이미지만 올릴 수 있습니다" } });
  });

  it("빈 파일은 VALIDATION", async () => {
    await expect(
      uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ body: { code: "VALIDATION" } });
  });

  it("상한을 넘으면 VALIDATION — 사람 5 MiB, 브리지 20 MiB", async () => {
    const big = Buffer.concat([makePng(1, 1), Buffer.alloc(ATTACHMENT_LIMITS.userImageMaxBytes)]);
    await expect(
      uploadAttachment(
        { db, dir },
        { channelId: chA, uploader: { type: "user", userId: alice }, bytes: big },
      ),
    ).rejects.toMatchObject({ body: { code: "VALIDATION" } });
    await expect(
      uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: big }),
    ).resolves.toMatchObject({ kind: "image" });
    const huge = Buffer.alloc(ATTACHMENT_LIMITS.agentFileMaxBytes + 1);
    await expect(
      uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: huge }),
    ).rejects.toMatchObject({ body: { code: "VALIDATION" } });
  });

  it("브리지 업로드: PDF 는 file, 이름이 없으면 file", async () => {
    const a = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge" }, bytes: PDF_BYTES },
    );
    expect(a).toMatchObject({ kind: "file", mime: "application/pdf", name: "file" });
  });

  it("[Review Focus 2] 같은 바이트 두 번 → 행 둘, 블롭 하나. 한 행이 정리돼도 다른 행은 열린다", async () => {
    const png = makePng(2, 2);
    const a = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: png },
    );
    const b = await uploadAttachment(
      { db, dir, now: () => new Date(Date.now() + 1) },
      { channelId: chA, uploader: { type: "user", userId: bob }, bytes: png },
    );
    expect(a.id).not.toBe(b.id);
    expect(db.select().from(attachments).all()).toHaveLength(2);
    // b 를 메시지에 묶고, a 는 미묶음인 채 25시간 뒤 정리
    db.transaction((tx) => markBound(tx, [b.id], msgInA));
    const later = () => new Date(Date.now() + 25 * 3600_000);
    expect(await sweepAttachments({ db, dir, now: later })).toEqual({ rows: 1, blobs: 0 });
    const readable = findReadable({ db, dir }, b.id, { type: "user", userId: bob, workspaceId: ws });
    expect(readable?.path).toBe(blobPath(dir, sha256Of(png)));
    expect(readable && existsSync(readable.path)).toBe(true); // 같은 sha 를 b 가 쓰므로 블롭이 남는다
  });

  it("정리: 첨부 디렉터리 맨 위에 파일(.DS_Store 등)이 있어도 던지지 않고 고아 블롭을 지운다", async () => {
    await writeFile(join(dir, ".DS_Store"), "x");
    await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(7, 7) },
    );
    const path = blobPath(dir, createHash("sha256").update(makePng(7, 7)).digest("hex"));
    const res = await sweepAttachments({ db, dir, now: () => new Date(Date.now() + 25 * 3600_000) });
    expect(res).toEqual({ rows: 1, blobs: 1 });
    expect(existsSync(path)).toBe(false);
    expect(existsSync(join(dir, ".DS_Store"))).toBe(true);
  });

  it("정리: 아무도 안 가리키는 블롭은 지우고, 24시간 안 된 미묶음은 남긴다", async () => {
    const old = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(5, 5) },
    );
    const oldPath = blobPath(dir, sha256Of(makePng(5, 5)));
    expect(existsSync(oldPath)).toBe(true);
    const fresh = await uploadAttachment(
      { db, dir, now: () => new Date(Date.now() + 24 * 3600_000) },
      { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(6, 6) },
    );
    const res = await sweepAttachments({ db, dir, now: () => new Date(Date.now() + 25 * 3600_000) });
    expect(res).toEqual({ rows: 1, blobs: 1 });
    expect(existsSync(oldPath)).toBe(false);
    expect(
      findReadable({ db, dir }, old.id, { type: "user", userId: alice, workspaceId: ws }),
    ).toBeUndefined();
    expect(
      db
        .select()
        .from(attachments)
        .all()
        .map((r) => r.id),
    ).toEqual([fresh.id]);
  });

  it("claimUserAttachments: 올린 사람·같은 채널·미묶음만, 하나라도 틀리면 VALIDATION", async () => {
    const mine = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) },
    );
    const bobs = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: bob }, bytes: makePng(1, 2) },
    );
    const otherCh = await uploadAttachment(
      { db, dir },
      { channelId: chB, uploader: { type: "user", userId: alice }, bytes: makePng(2, 1) },
    );
    const bridged = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(2, 2) },
    );
    expect(
      db.transaction((tx) => claimUserAttachments(tx, { ids: [mine.id], channelId: chA, userId: alice })),
    ).toEqual([mine]);
    for (const ids of [
      [bobs.id],
      [otherCh.id],
      [bridged.id],
      [mine.id, mine.id],
      [mine.id, "01a0cc16-0000-7000-8000-000000000000"],
    ])
      expect(() =>
        db.transaction((tx) => claimUserAttachments(tx, { ids, channelId: chA, userId: alice })),
      ).toThrowError(expect.objectContaining({ body: expect.objectContaining({ code: "VALIDATION" }) }));
    db.transaction((tx) => markBound(tx, [mine.id], msgInA));
    expect(() =>
      db.transaction((tx) => claimUserAttachments(tx, { ids: [mine.id], channelId: chA, userId: alice })),
    ).toThrow();
  });

  it("claimBridgeAttachments: 틀린 것은 빼고 순서를 지킨다", async () => {
    const f1 = await uploadAttachment(
      { db, dir },
      {
        channelId: chA,
        uploader: { type: "bridge", runnerTokenId: RUNNER },
        bytes: PDF_BYTES,
        nameHint: "a.pdf",
      },
    );
    const f2 = await uploadAttachment(
      { db, dir },
      {
        channelId: chA,
        uploader: { type: "bridge", runnerTokenId: RUNNER },
        bytes: makePng(1, 1),
        nameHint: "b.png",
      },
    );
    const wrongCh = await uploadAttachment(
      { db, dir },
      { channelId: chB, uploader: { type: "bridge", runnerTokenId: RUNNER }, bytes: PDF_BYTES },
    );
    const human = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) },
    );
    const r = db.transaction((tx) =>
      claimBridgeAttachments(tx, {
        ids: [f2.id, wrongCh.id, human.id, f1.id, f2.id],
        channelId: chA,
        by: { runnerTokenId: RUNNER },
      }),
    );
    expect(r.accepted.map((a) => a.name)).toEqual(["b.png", "a.pdf"]);
    expect(r.dropped).toEqual([wrongCh.id, human.id, f2.id]);
    db.transaction((tx) => markBound(tx, [f1.id], msgInA));
    expect(
      db.transaction((tx) =>
        claimBridgeAttachments(tx, { ids: [f1.id], channelId: chA, by: { runnerTokenId: RUNNER } }),
      ),
    ).toEqual({
      accepted: [],
      dropped: [f1.id],
    });
  });

  it("claimBridgeAttachments: 정본을 낸 Gateway 가 올린 것만 — 다른 Gateway·러너의 정본은 묶지 못한다(멀티 Gateway 스펙 「브리지 첨부 범위」 절)", async () => {
    const [office, home] = [uuid(), uuid()];
    for (const id of [office, home]) insertGateway(db, ws, { id, name: id.slice(-6) });
    const fromOffice = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge", gatewayId: office }, bytes: PDF_BYTES },
    );
    const claim = (by: UploadedBy | undefined) =>
      db.transaction((tx) => claimBridgeAttachments(tx, { ids: [fromOffice.id], channelId: chA, by }));
    expect(claim({ gatewayId: home })).toEqual({ accepted: [], dropped: [fromOffice.id] });
    expect(claim({ runnerTokenId: RUNNER })).toEqual({ accepted: [], dropped: [fromOffice.id] });
    expect(claim(undefined)).toEqual({ accepted: [], dropped: [fromOffice.id] });
    expect(claim({ gatewayId: office }).accepted.map((a) => a.id)).toEqual([fromOffice.id]);
  });

  it("claimBridgeAttachments: 러너 정본은 자기 토큰이 올린 것만 — 다른 러너·Gateway 가 비어 버린 업로드는 묶지 못한다", async () => {
    const upload = (uploader: Uploader) =>
      uploadAttachment({ db, dir }, { channelId: chA, uploader, bytes: PDF_BYTES });
    const own = await upload({ type: "bridge", runnerTokenId: RUNNER });
    const otherRunner = await upload({ type: "bridge", runnerTokenId: "other-runner" });
    const orphan = await upload({ type: "bridge" }); // Gateway 를 지워 gateway_id 가 빈 플러그인 업로드와 같은 행
    const r = db.transaction((tx) =>
      claimBridgeAttachments(tx, {
        ids: [orphan.id, otherRunner.id, own.id],
        channelId: chA,
        by: { runnerTokenId: RUNNER },
      }),
    );
    expect(r.accepted.map((a) => a.id)).toEqual([own.id]);
    expect(r.dropped).toEqual([orphan.id, otherRunner.id]);
  });

  it("findReadable: 묶인 것은 같은 워크스페이스 채널 사용자, 미묶음은 올린 사람만", async () => {
    const a = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) },
    );
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: alice, workspaceId: ws })).toBeDefined();
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: bob, workspaceId: ws })).toBeUndefined();
    db.transaction((tx) => markBound(tx, [a.id], msgInA));
    expect(findReadable({ db, dir }, a.id, { type: "user", userId: bob, workspaceId: ws })).toBeDefined();
    expect(
      findReadable({ db, dir }, a.id, { type: "user", userId: bob, workspaceId: "other-ws" }),
    ).toBeUndefined();
  });

  it("findReadable 브리지: 그 Gateway 가 올린 것(묶이기 전후)만 — 묶였다는 것만으로는 못 본다(트리거 첨부는 attachments.bridge-scope)", async () => {
    const [office, home] = [uuid(), uuid()];
    for (const id of [office, home]) insertGateway(db, ws, { id, name: id.slice(-6) });
    const bridge = (gatewayId: string) => ({ type: "bridge", gatewayId }) as const;
    const own = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge", gatewayId: office }, bytes: PDF_BYTES },
    );
    const human = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(1, 1) },
    );
    expect(findReadable({ db, dir }, own.id, bridge(office))).toBeDefined();
    expect(findReadable({ db, dir }, own.id, bridge(home))).toBeUndefined();
    db.transaction((tx) => markBound(tx, [own.id, human.id], msgInA));
    expect(findReadable({ db, dir }, own.id, bridge(office))).toBeDefined();
    expect(findReadable({ db, dir }, own.id, bridge(home))).toBeUndefined();
    expect(findReadable({ db, dir }, human.id, bridge(office))).toBeUndefined();
    expect(findReadable({ db, dir }, "01a0cc16-0000-7000-8000-000000000000", bridge(office))).toBeUndefined();
  });

  it("findReadable 러너: 자기 토큰이 올린 것(묶이기 전후)과 mayRead 가 허락한 것만 — 묶였어도 나머지는 못 본다(판정 R5)", async () => {
    const [tokenA, tokenB] = ["runner-token-a", "runner-token-b"];
    const runner = (tokenId: string, allowed: string[] = []) =>
      ({ type: "runner", tokenId, mayRead: (id: string) => allowed.includes(id) }) as const;
    const own = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge", runnerTokenId: tokenA }, bytes: makePng(3, 1) },
    );
    expect(db.select().from(attachments).where(eq(attachments.id, own.id)).get()).toMatchObject({
      uploaderType: "bridge",
      uploaderId: tokenA,
    });
    expect(findReadable({ db, dir }, own.id, runner(tokenA))).toBeDefined();
    expect(findReadable({ db, dir }, own.id, runner(tokenB))).toBeUndefined();
    // 러너가 올린 것은 어느 Gateway 의 것도 아니다 — 묶여도 브리지 뷰어는 못 본다
    const gateway = insertGateway(db, ws, { id: uuid() });
    expect(findReadable({ db, dir }, own.id, { type: "bridge", gatewayId: gateway.id })).toBeUndefined();
    db.transaction((tx) => markBound(tx, [own.id], msgInA));
    expect(findReadable({ db, dir }, own.id, runner(tokenA))).toBeDefined();
    expect(findReadable({ db, dir }, own.id, runner(tokenB))).toBeUndefined();
    expect(findReadable({ db, dir }, own.id, { type: "bridge", gatewayId: gateway.id })).toBeUndefined();

    const human = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "user", userId: alice }, bytes: makePng(3, 2) },
    );
    const bridged = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge" }, bytes: makePng(3, 3) },
    );
    db.transaction((tx) => markBound(tx, [human.id, bridged.id], msgInA));
    for (const id of [human.id, bridged.id]) {
      expect(findReadable({ db, dir }, id, runner(tokenA))).toBeUndefined();
      expect(findReadable({ db, dir }, id, runner(tokenA, [id]))).toBeDefined();
    }
    // 허락은 행이 있을 때만 뜻이 있다 — 없는 id 는 허락돼도 undefined
    const missing = "01a0cc16-0000-7000-8000-000000000000";
    expect(findReadable({ db, dir }, missing, runner(tokenA, [missing]))).toBeUndefined();
  });

  it("[결함 3] 정리가 블롭을 지우는 사이 같은 바이트 업로드가 끼어도 새 행의 블롭은 남는다", async () => {
    const png = makePng(7, 7);
    await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: png });
    const later = () => new Date(Date.now() + 25 * 3600_000);
    // 정리를 먼저 시작하고(동기 부분에서 행 삭제), 끝나기 전에 같은 바이트를 올린다
    const sweeping = sweepAttachments({ db, dir, now: later });
    const uploading = uploadAttachment(
      { db, dir, now: later },
      { channelId: chA, uploader: { type: "bridge" }, bytes: png },
    );
    const [swept, b] = await Promise.all([sweeping, uploading]);
    expect(swept.rows).toBe(1);
    expect(db.select().from(attachments).all()).toHaveLength(1);
    db.transaction((tx) => markBound(tx, [b.id], msgInA));
    const readable = findReadable({ db, dir }, b.id, { type: "user", userId: alice, workspaceId: ws });
    expect(readable && existsSync(readable.path)).toBe(true);
  });

  it("[결함 3] 업로드가 먼저 시작해도 같은 sha 의 정리가 그 블롭을 지우지 않는다", async () => {
    const png = makePng(8, 8);
    await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: png });
    const later = () => new Date(Date.now() + 25 * 3600_000);
    const uploading = uploadAttachment(
      { db, dir, now: later },
      { channelId: chA, uploader: { type: "bridge" }, bytes: png },
    );
    const sweeping = sweepAttachments({ db, dir, now: later });
    const [b, swept] = await Promise.all([uploading, sweeping]);
    expect(swept).toEqual({ rows: 1, blobs: 0 });
    expect(existsSync(blobPath(dir, sha256Of(png)))).toBe(true);
    expect(
      db
        .select()
        .from(attachments)
        .all()
        .map((r) => r.id),
    ).toEqual([b.id]);
  });

  it("[결함 3] 정리가 행 없음을 확인하고 블롭을 지우는 바로 그 순간 같은 바이트 업로드가 와도 블롭은 남는다(잠금이 직렬화)", async () => {
    const png = makePng(10, 10);
    const sha = sha256Of(png);
    await uploadAttachment({ db, dir }, { channelId: chA, uploader: { type: "bridge" }, bytes: png });
    const later = () => new Date(Date.now() + 25 * 3600_000);
    const real = createBlobLocks();
    let started = false;
    let uploading: Promise<unknown> | undefined;
    // 정리가 sha 잠금 안에 들어온 그 틱에 업로드를 시작한다 — 잠금이 없으면 업로드는 「블롭이 있다」고 보고 행만 넣고,
    // 정리의 rm 이 그 뒤에 끝나 새 행이 없는 블롭을 가리킨다
    const locks: BlobLocks = {
      run: (key, fn) =>
        real.run(key, () => {
          if (key === sha && !started) {
            started = true;
            uploading = uploadAttachment(
              { db, dir, now: later, locks },
              { channelId: chA, uploader: { type: "bridge" }, bytes: png },
            );
          }
          return fn();
        }),
    };
    const swept = await sweepAttachments({ db, dir, now: later, locks });
    await uploading;
    expect(swept).toEqual({ rows: 1, blobs: 1 }); // 정리가 먼저 잠금을 잡아 지웠고
    expect(db.select().from(attachments).all()).toHaveLength(1);
    expect(existsSync(blobPath(dir, sha))).toBe(true); // 업로드가 그 뒤에 다시 썼다
  });

  it("[결함 4] 어느 행도 안 가리키는 블롭과 1시간 넘은 .tmp 를 지우고, 새 .tmp·쓰이는 블롭은 남긴다", async () => {
    const kept = await uploadAttachment(
      { db, dir },
      { channelId: chA, uploader: { type: "bridge" }, bytes: PDF_BYTES },
    );
    const keptPath = blobPath(dir, sha256Of(PDF_BYTES));
    // 행 없는 블롭 — 채널 cascade·insert 실패·쓰기와 넣기 사이 프로세스 죽음이 남기는 모양
    const orphanBytes = makePng(9, 9);
    const orphanPath = blobPath(dir, sha256Of(orphanBytes));
    await mkdir(join(orphanPath, ".."), { recursive: true });
    await writeFile(orphanPath, orphanBytes);
    const oldTmp = `${orphanPath}.old.tmp`;
    const newTmp = `${keptPath}.new.tmp`;
    await writeFile(oldTmp, "x");
    await writeFile(newTmp, "y");
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3600_000);
    await utimes(oldTmp, twoHoursAgo, twoHoursAgo);
    const halfHourAgo = new Date(now - 30 * 60_000);
    await utimes(newTmp, halfHourAgo, halfHourAgo);
    const res = await sweepAttachments({ db, dir, now: () => new Date(now) });
    expect(res).toEqual({ rows: 0, blobs: 1 });
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(newTmp)).toBe(true); // 1시간 안 된 .tmp 는 쓰는 중일 수 있다
    expect(existsSync(keptPath)).toBe(true);
    expect(
      db
        .select()
        .from(attachments)
        .all()
        .map((r) => r.id),
    ).toEqual([kept.id]);
    expect((await readdir(join(orphanPath, ".."))).sort()).toEqual([]);
  });

  it("[결함 4] 첨부 디렉터리가 아직 없어도 정리는 돈다", async () => {
    await rm(dir, { recursive: true, force: true });
    expect(await sweepAttachments({ db, dir })).toEqual({ rows: 0, blobs: 0 });
  });
});
