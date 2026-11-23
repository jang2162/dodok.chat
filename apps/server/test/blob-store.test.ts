import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import {
  type BlobEntry,
  type BlobStore,
  BlobStoreCheckError,
  createBlobStore,
  createLocalBlobStore,
} from "../src/modules/attachments/blob-store";
import {
  createS3BlobStore,
  putRequestTimeout,
  S3_CONNECTION_TIMEOUT_MS,
  S3_PUT_MIN_BYTES_PER_SECOND,
  S3_REQUEST_TIMEOUT_MS,
  s3ClientConfig,
} from "../src/modules/attachments/s3-store";
import { createBlobLocks } from "../src/modules/attachments/store";
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

/** 접속은 받고 한 바이트도 답하지 않는 엔드포인트 — 멈춘 S3 를 흉내 낸다 */
async function silentServer(): Promise<{ endpoint: string; close(): Promise<void> }> {
  const sockets: Socket[] = [];
  const server: Server = createServer((sock) => {
    sockets.push(sock);
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(r));
    },
  };
}

describe("S3 BlobStore — 타임아웃(멈춘 엔드포인트)", () => {
  const short = { connectionTimeout: 200, requestTimeout: 300 };
  let silent: Awaited<ReturnType<typeof silentServer>> | undefined;
  afterEach(async () => {
    await silent?.close();
    silent = undefined;
  });
  async function stalledStore(): Promise<BlobStore> {
    silent = await silentServer();
    const cfg = { ...MEMORY_S3_CONFIG, endpoint: silent.endpoint };
    // 재시도는 1회로 — 상한(요청 타임아웃)이 걸리는지만 본다
    return createS3BlobStore(cfg, new S3Client({ ...s3ClientConfig(cfg, short), maxAttempts: 1 }));
  }
  /** 정해진 시간 안에 끝나는지 — 끝나지 않으면 "hang" */
  const within = (p: Promise<unknown>, ms = 5_000) =>
    Promise.race([
      p.then(
        () => "resolved" as const,
        (e: unknown) => e,
      ),
      new Promise<"hang">((r) => setTimeout(() => r("hang"), ms)),
    ]);

  it("기본 설정은 연결 5초·요청(헤더까지) 30초, 넘으면 오류로 던진다", () => {
    expect(S3_CONNECTION_TIMEOUT_MS).toBe(5_000);
    expect(S3_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(s3ClientConfig(MEMORY_S3_CONFIG).requestHandler).toEqual({
      connectionTimeout: 5_000,
      requestTimeout: 30_000,
      throwOnRequestTimeout: true,
    });
  });

  it("부팅 check 는 상한 안에 BlobStoreCheckError 로 끝난다", async () => {
    const store = await stalledStore();
    const err = await within(store.check());
    expect(err).toBeInstanceOf(BlobStoreCheckError);
    expect((err as Error).message).toMatch(/HeadBucket TimeoutError|HeadBucket ETIMEDOUT/);
  });

  it.each([
    ["put", (s: BlobStore) => s.put(sha("t"), bytes("t")), /S3 HeadObject 실패/],
    ["remove", (s: BlobStore) => s.remove(sha("t")), /S3 DeleteObject 실패/],
    ["list", (s: BlobStore) => listAll(s), /S3 ListObjectsV2 실패/],
    ["open", (s: BlobStore) => s.open(sha("t")), /S3 GetObject 실패/],
  ] as const)("%s 도 상한 안에 오류로 끝난다", async (_name, op, message) => {
    const store = await stalledStore();
    const err = await within(op(store));
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(message);
  });

  it("업로드가 sha 잠금을 쥔 채 멈추지 않는다 — 실패 뒤 같은 sha 의 정리가 잠금을 얻는다", async () => {
    const store = await stalledStore();
    const locks = createBlobLocks();
    const s = sha("lock");
    const upload = locks.run(s, () => store.put(s, bytes("lock")));
    const sweep = locks.run(s, async () => "swept");
    expect(await within(upload)).toBeInstanceOf(Error);
    expect(await within(sweep)).toBe("resolved");
    await expect(sweep).resolves.toBe("swept");
  });
});

/**
 * HeadObject 에는 404, PutObject 본문은 bytesPerSecond 로만 읽고 다 읽으면 200 — 느린 업링크를 흉내 낸다. 0 이면 본문을 읽지도
 * 답하지도 않는다
 */
async function slowPutServer(bytesPerSecond: number): Promise<{ endpoint: string; close(): Promise<void> }> {
  const server = createHttpServer((req, res) => {
    if (req.method === "HEAD") {
      res.writeHead(404).end();
      return;
    }
    if (bytesPerSecond === 0) {
      req.pause();
      return;
    }
    req.on("data", (chunk: Buffer) => {
      req.pause();
      setTimeout(() => req.resume(), (chunk.length / bytesPerSecond) * 1000);
    });
    req.on("end", () => res.writeHead(200, { ETag: '"slow"' }).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    endpoint: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

describe("S3 BlobStore — PutObject 상한은 본문 크기에 비례한다", () => {
  // 시험용으로 줄인 값 — 요청 상한 300ms, 가장 느린 업로드 256 KiB/s
  const short = { connectionTimeout: 200, requestTimeout: 300 };
  const putTimeout = { requestTimeout: 300, minBytesPerSecond: 256 * 1024 };
  let slow: Awaited<ReturnType<typeof slowPutServer>> | undefined;
  afterEach(async () => {
    await slow?.close();
    slow = undefined;
  });
  async function slowStore(bytesPerSecond: number): Promise<BlobStore> {
    slow = await slowPutServer(bytesPerSecond);
    const cfg = { ...MEMORY_S3_CONFIG, endpoint: slow.endpoint };
    return createS3BlobStore(
      cfg,
      new S3Client({ ...s3ClientConfig(cfg, short), maxAttempts: 1 }),
      putTimeout,
    );
  }

  it("기본 상한은 30초 + 바이트 / 64 KiB/s — 20 MiB 면 약 6분", () => {
    expect(S3_PUT_MIN_BYTES_PER_SECOND).toBe(64 * 1024);
    expect(putRequestTimeout(0)).toBe(30_000);
    expect(putRequestTimeout(3 * 1024 * 1024)).toBe(30_000 + 48_000);
    expect(putRequestTimeout(20 * 1024 * 1024)).toBe(30_000 + 320_000);
  });

  it("본문을 천천히 받는 서버에도 요청 상한보다 오래 걸리는 업로드가 성공한다", async () => {
    const store = await slowStore(512 * 1024);
    const body = new Uint8Array(1024 * 1024).fill(7);
    const started = Date.now();
    await store.put(sha("slow"), body);
    // 요청 상한(300ms)보다 오래 걸렸다 — 그 상한만 걸었다면 실패했을 업로드다
    expect(Date.now() - started).toBeGreaterThan(short.requestTimeout);
  }, 15_000);

  it("아무것도 받지 않는 서버면 상한 안에 PutObject 오류로 끝난다", async () => {
    const store = await slowStore(0);
    const body = new Uint8Array(64 * 1024).fill(7);
    const limit = putRequestTimeout(body.length, putTimeout.requestTimeout, putTimeout.minBytesPerSecond);
    const started = Date.now();
    await expect(store.put(sha("never"), body)).rejects.toThrow(/S3 PutObject 실패/);
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(limit - 50);
    expect(took).toBeLessThan(limit + 2_000);
  }, 15_000);
});

describe("createBlobStore — local 모드는 S3 SDK 를 읽지 않는다", () => {
  afterEach(() => {
    vi.doUnmock("@aws-sdk/client-s3");
    vi.resetModules();
  });

  it("SDK 적재가 실패해도 local 저장소는 만들고 쓴다", async () => {
    vi.resetModules();
    vi.doMock("@aws-sdk/client-s3", () => {
      throw new Error("S3 SDK 를 읽었다");
    });
    const fresh = await import("../src/modules/attachments/blob-store");
    const dir = mkdtempSync(join(tmpdir(), "dodok-blob-lazy-"));
    try {
      const store = fresh.createBlobStore(loadConfig({ ...testEnv, ATTACHMENTS_DIR: dir }));
      await store.check();
      await store.put(sha("l"), bytes("l"));
      expect(store.kind).toBe("local");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("s3 모드는 처음 쓸 때 SDK 를 읽어 실제 저장소에 넘긴다(닫힌 포트 → BlobStoreCheckError)", async () => {
    const closed = await silentServer();
    const endpoint = closed.endpoint;
    await closed.close();
    const store = createBlobStore(
      loadConfig({
        ...testEnv,
        ATTACHMENTS_STORAGE: "s3",
        S3_ENDPOINT: endpoint,
        S3_FORCE_PATH_STYLE: "true",
        S3_REGION: "us-east-1",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret",
      }),
    );
    expect(store.kind).toBe("s3");
    // 앞 시험의 resetModules 로 s3-store 가 새 blob-store 를 읽어 클래스가 다를 수 있다 — 이름으로 본다
    await expect(store.check()).rejects.toMatchObject({ name: "BlobStoreCheckError" });
  });
});
