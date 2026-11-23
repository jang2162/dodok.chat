/**
 * 메모리 흉내 S3Client — send 를 명령 이름으로 갈라 Map 에 둔다(새 dev 의존성 없이 S3 블롭 저장소를 시험한다).
 * 실제 S3 의 모양만 흉내 낸다: 없는 키는 HeadObject NotFound·GetObject NoSuchKey(404), 목록은 Prefix·페이지(pageSize)·키 순서.
 * 시험이 고장을 심는 자리: fail(명령 이름 → 던질 오류), body(sha 키 → 응답 본문을 대신 만들 함수)
 */
import type { S3Client } from "@aws-sdk/client-s3";
import { Readable } from "node:stream";

export type MemoryObject = { bytes: Uint8Array; lastModified: Date };

export type MemoryS3 = {
  client: S3Client;
  objects: Map<string, MemoryObject>;
  /** 받은 명령 이름 순서 — PutObject 횟수 같은 것을 센다 */
  calls: string[];
  count(command: string): number;
  /** 명령 이름 → 던질 오류(한 번 쓰고 지우지 않는다 — 시험이 지운다) */
  fail: Map<string, unknown>;
  /** 키 → 응답 본문을 만들 함수(끊기는 스트림 등) */
  body: Map<string, (bytes: Uint8Array) => Readable>;
  /** 새로 쓰는 객체의 LastModified(기본 지금) */
  clock: () => Date;
  pageSize: number;
};

const sdkError = (name: string, status: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

export function memoryS3(opts: { bucket?: string } = {}): MemoryS3 {
  const bucket = opts.bucket ?? "dodok-test";
  const state: MemoryS3 = {
    client: undefined as unknown as S3Client,
    objects: new Map(),
    calls: [],
    count: (command) => state.calls.filter((c) => c === command).length,
    fail: new Map(),
    body: new Map(),
    clock: () => new Date(),
    pageSize: 1000,
  };
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name.replace(/Command$/, "");
    state.calls.push(name);
    // 실제 SDK 처럼 다음 틱에 답한다 — 동시성 시험이 끼어들 틈
    await new Promise((r) => setImmediate(r));
    const injected = state.fail.get(name);
    if (injected !== undefined) throw injected;
    const input = command.input;
    if (input.Bucket !== bucket) throw sdkError(name === "HeadBucket" ? "NotFound" : "NoSuchBucket", 404);
    const key = input.Key as string;
    switch (name) {
      case "HeadBucket":
        return {};
      case "HeadObject": {
        const o = state.objects.get(key);
        if (!o) throw sdkError("NotFound", 404);
        return { ContentLength: o.bytes.length, LastModified: o.lastModified };
      }
      case "PutObject": {
        const body = input.Body as Uint8Array;
        state.objects.set(key, { bytes: new Uint8Array(body), lastModified: state.clock() });
        return {};
      }
      case "GetObject": {
        const o = state.objects.get(key);
        if (!o) throw sdkError("NoSuchKey", 404);
        const make = state.body.get(key);
        return {
          Body: make ? make(o.bytes) : Readable.from([Buffer.from(o.bytes)]),
          ContentLength: o.bytes.length,
        };
      }
      case "DeleteObject":
        state.objects.delete(key);
        return {};
      case "ListObjectsV2": {
        const prefix = (input.Prefix as string | undefined) ?? "";
        const keys = [...state.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = input.ContinuationToken === undefined ? 0 : Number(input.ContinuationToken);
        const page = keys.slice(start, start + state.pageSize);
        const next = start + page.length;
        return {
          Contents: page.map((k) => ({ Key: k, LastModified: state.objects.get(k)?.lastModified })),
          IsTruncated: next < keys.length,
          ...(next < keys.length ? { NextContinuationToken: String(next) } : {}),
        };
      }
      default:
        throw new Error(`memoryS3: 모르는 명령 ${name}`);
    }
  };
  state.client = { send } as unknown as S3Client;
  return state;
}

export const MEMORY_S3_CONFIG = {
  region: "us-east-1",
  bucket: "dodok-test",
  prefix: "",
  accessKeyId: "AKIA-TEST-ACCESS-KEY",
  secretAccessKey: "test-secret-access-key-do-not-log",
  forcePathStyle: true,
};
