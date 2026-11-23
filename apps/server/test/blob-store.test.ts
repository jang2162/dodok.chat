import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import {
  type BlobEntry,
  type BlobStore,
  BlobStoreCheckError,
  createBlobStore,
  createLocalBlobStore,
} from "../src/modules/attachments/blob-store";
import { createS3BlobStore } from "../src/modules/attachments/s3-store";
import { testEnv } from "./helpers/env";
import { MEMORY_S3_CONFIG, type MemoryS3, memoryS3 } from "./helpers/memory-s3";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

async function listAll(store: BlobStore): Promise<BlobEntry[]> {
  const out: BlobEntry[] = [];
  for await (const e of store.list()) out.push(e);
  return out;
}

type Backend = { name: string; store: BlobStore; writes(): number; cleanup(): void; s3?: MemoryS3 };

const backends: Array<{ name: string; make(): Backend }> = [
  {
    name: "local",
    make() {
      const dir = mkdtempSync(join(tmpdir(), "dodok-blob-store-"));
      const store = createLocalBlobStore(dir);
      return {
        name: "local",
        store,
        // 로컬의 「쓰기」는 sha 디렉터리 안의 파일 수로 센다(임시 파일은 rename 으로 사라진다)
        writes: () =>
          readdirSync(dir)
            .filter((d) => /^[0-9a-f]{2}$/.test(d))
            .reduce((n, d) => n + readdirSync(join(dir, d)).length, 0),
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
      };
    },
  },
  {
    name: "s3",
    make() {
      const s3 = memoryS3();
      return {
        name: "s3",
        store: createS3BlobStore(MEMORY_S3_CONFIG, s3.client),
        writes: () => s3.count("PutObject"),
        cleanup: () => undefined,
        s3,
      };
    },
  },
];

describe.each(backends)("BlobStore — $name", ({ make }) => {
  let b: Backend;
  afterEach(() => b?.cleanup());

  it("put 두 번 → 한 번만 쓴다", async () => {
    b = make();
    const s = sha("a");
    await b.store.check();
    await b.store.put(s, bytes("a"));
    await b.store.put(s, bytes("a"));
    expect(b.writes()).toBe(1);
  });

  it("없는 sha 를 열면 undefined", async () => {
    b = make();
    await b.store.check();
    expect(await b.store.open(sha("none"))).toBeUndefined();
  });

  it("연 것의 크기·바이트가 쓴 것과 같다", async () => {
    b = make();
    await b.store.check();
    const s = sha("hello");
    await b.store.put(s, bytes("hello"));
    const opened = await b.store.open(s);
    expect(opened?.size).toBe(5);
    expect(await readAll(opened!.stream)).toBe("hello");
  });

  it("remove 뒤에는 open 이 undefined — 없는 것을 지워도 던지지 않는다", async () => {
    b = make();
    await b.store.check();
    const s = sha("bye");
    await b.store.put(s, bytes("bye"));
    await b.store.remove(s);
    expect(await b.store.open(s)).toBeUndefined();
    await expect(b.store.remove(s)).resolves.toBeUndefined();
  });

  it("list 는 쓴 블롭의 sha·수정 시각을 돌려준다", async () => {
    b = make();
    await b.store.check();
    const one = sha("1");
    const two = sha("2");
    await b.store.put(one, bytes("1"));
    await b.store.put(two, bytes("2"));
    const entries = await listAll(b.store);
    expect(entries.map((e) => e.sha).sort()).toEqual([one, two].sort());
    for (const e of entries) {
      expect(e.temp).toBeUndefined();
      expect(e.modifiedAt).toBeInstanceOf(Date);
    }
  });

  it("close() 는 읽지 않은 스트림을 닫는다", async () => {
    b = make();
    await b.store.check();
    const s = sha("close");
    await b.store.put(s, bytes("close"));
    const opened = await b.store.open(s);
    opened!.close();
    opened!.close();
    expect((opened!.stream as unknown as { destroyed: boolean }).destroyed).toBe(true);
  });
});

describe("로컬 BlobStore", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("check 는 디렉터리를 만들고, 임시 파일은 temp 로 나온다(removeTemp 로 지운다)", async () => {
    dir = join(mkdtempSync(join(tmpdir(), "dodok-blob-local-")), "nested");
    const store = createLocalBlobStore(dir);
    await store.check();
    expect(existsSync(dir)).toBe(true);
    const s = sha("t");
    await store.put(s, bytes("t"));
    const tmp = `${s}.0190-dead.tmp`;
    writeFileSync(join(dir, s.slice(0, 2), tmp), "half");
    writeFileSync(join(dir, "notes.txt"), "사람이 둔 파일");
    const entries = await listAll(store);
    expect(entries.map((e) => [e.sha, e.temp ?? false]).sort()).toEqual(
      [
        [s, false],
        [s, true],
      ].sort(),
    );
    await store.removeTemp(entries.find((e) => e.temp)!.key);
    expect(existsSync(join(dir, s.slice(0, 2), tmp))).toBe(false);
    expect(existsSync(join(dir, s.slice(0, 2), s))).toBe(true);
  });
});

describe("S3 BlobStore", () => {
  it("키는 <S3_PREFIX><sha 앞 2자>/<sha>, PutObject 는 HeadObject 로 있으면 건너뛴다", async () => {
    const s3 = memoryS3();
    const store = createS3BlobStore({ ...MEMORY_S3_CONFIG, prefix: "dodok/" }, s3.client);
    const s = sha("k");
    await store.put(s, bytes("k"));
    expect([...s3.objects.keys()]).toEqual([`dodok/${s.slice(0, 2)}/${s}`]);
    await store.put(s, bytes("k"));
    expect(s3.calls).toEqual(["HeadObject", "PutObject", "HeadObject"]);
  });

  it("list 는 S3_PREFIX 아래 블롭 키만 — 다른 접두사·다른 이름의 객체는 무시하고 페이지를 넘긴다", async () => {
    const s3 = memoryS3();
    s3.pageSize = 2;
    const store = createS3BlobStore({ ...MEMORY_S3_CONFIG, prefix: "dodok/" }, s3.client);
    const shas = ["x", "y", "z"].map(sha);
    for (const s of shas) await store.put(s, bytes(s));
    const now = new Date();
    const other = sha("other");
    s3.objects.set(`elsewhere/${other.slice(0, 2)}/${other}`, { bytes: bytes("o"), lastModified: now });
    s3.objects.set("dodok/readme.txt", { bytes: bytes("r"), lastModified: now });
    s3.objects.set(`dodok/00/${other}`, { bytes: bytes("o"), lastModified: now });
    const entries = await listAll(store);
    expect(entries.map((e) => e.sha).sort()).toEqual([...shas].sort());
    expect(s3.count("ListObjectsV2")).toBeGreaterThan(1);
  });

  it("check: HeadBucket 이 실패하면 BlobStoreCheckError — 문구에 키·시크릿이 없다", async () => {
    const s3 = memoryS3({ bucket: "other-bucket" });
    const store = createS3BlobStore(MEMORY_S3_CONFIG, s3.client);
    const err = await store.check().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BlobStoreCheckError);
    const message = (err as Error).message;
    expect(message).toMatch(/HeadBucket NotFound \(HTTP 404\)/);
    expect(message).not.toContain(MEMORY_S3_CONFIG.accessKeyId);
    expect(message).not.toContain(MEMORY_S3_CONFIG.secretAccessKey);
  });

  it("check: 서명 오류(본문에 접근 키가 실린 SDK 오류)도 이름·상태만 남긴다", async () => {
    const s3 = memoryS3();
    s3.fail.set(
      "HeadBucket",
      Object.assign(new Error(`The request signature … AWSAccessKeyId ${MEMORY_S3_CONFIG.accessKeyId}`), {
        name: "SignatureDoesNotMatch",
        AWSAccessKeyId: MEMORY_S3_CONFIG.accessKeyId,
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const store = createS3BlobStore(MEMORY_S3_CONFIG, s3.client);
    const err = (await store.check().catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("SignatureDoesNotMatch (HTTP 403)");
    expect(err.message).not.toContain(MEMORY_S3_CONFIG.accessKeyId);
    expect(JSON.stringify(err)).not.toContain(MEMORY_S3_CONFIG.accessKeyId);
    expect(err.cause).toBeUndefined();
  });

  it("런타임 오류(PutObject 403)도 이름·상태만 — 원래 SDK 오류를 싣지 않는다", async () => {
    const s3 = memoryS3();
    s3.fail.set(
      "PutObject",
      Object.assign(new Error("denied"), {
        name: "AccessDenied",
        AWSAccessKeyId: MEMORY_S3_CONFIG.accessKeyId,
        $metadata: { httpStatusCode: 403 },
      }),
    );
    const store = createS3BlobStore(MEMORY_S3_CONFIG, s3.client);
    const err = (await store.put(sha("p"), bytes("p")).catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("S3 PutObject 실패: AccessDenied (HTTP 403)");
    expect(JSON.stringify(err)).not.toContain(MEMORY_S3_CONFIG.accessKeyId);
  });
});

describe("createBlobStore", () => {
  it("기본(local)은 ATTACHMENTS_DIR 의 로컬 저장소, s3 면 S3 저장소", () => {
    expect(createBlobStore(loadConfig({ ...testEnv, ATTACHMENTS_DIR: "/tmp/x" })).kind).toBe("local");
    const s3 = loadConfig({
      ...testEnv,
      ATTACHMENTS_STORAGE: "s3",
      S3_REGION: "us-east-1",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "id",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(createBlobStore(s3).kind).toBe("s3");
  });
});
