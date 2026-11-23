/**
 * S3 호환 저장소의 블롭(S3 스펙 S2~S6). 키는 `<prefix><sha 앞 2자>/<sha>` — 같은 바이트는 한 번만 쓴다(HeadObject 로 있으면 건너뜀).
 * SDK 오류는 이름·HTTP 상태만 남긴 새 오류로 바꿔 던진다 — 서명 오류 응답 본문(AWSAccessKeyId·StringToSign)이 오류 객체에 실려
 * 로그로 나가지 않게
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { S3Config } from "../../config";
import { type BlobStore, BlobStoreCheckError } from "./blob-store";

const KEY_TAIL = /^([0-9a-f]{2})\/(\1[0-9a-f]{62})$/;

type SdkError = { name?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } };

function statusOf(err: unknown): number | undefined {
  const status = (err as SdkError | undefined)?.$metadata?.httpStatusCode;
  return typeof status === "number" ? status : undefined;
}

function isNotFound(err: unknown): boolean {
  const name = (err as SdkError | undefined)?.name;
  return name === "NotFound" || name === "NoSuchKey" || statusOf(err) === 404;
}

/** 실패 종류만 — 오류 이름(또는 네트워크 code)과 HTTP 상태. 메시지·본문·요청 정보는 싣지 않는다 */
function describe(err: unknown): string {
  const e = err as SdkError | undefined;
  const kind = typeof e?.code === "string" ? e.code : typeof e?.name === "string" ? e.name : "UnknownError";
  const status = statusOf(err);
  return status === undefined ? kind : `${kind} (HTTP ${status})`;
}

export function createS3BlobStore(cfg: S3Config, client?: S3Client): BlobStore {
  const s3 =
    client ??
    new S3Client({
      region: cfg.region,
      ...(cfg.endpoint === undefined ? {} : { endpoint: cfg.endpoint }),
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
      // S3 호환 저장소(MinIO·R2 등) 일부가 SDK 기본 체크섬 헤더(CRC32)를 모른다 — 요구될 때만 붙인다
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
  const Bucket = cfg.bucket;
  const keyOf = (sha: string) => `${cfg.prefix}${sha.slice(0, 2)}/${sha}`;
  const fail = (op: string, err: unknown): Error => new Error(`S3 ${op} 실패: ${describe(err)}`);

  return {
    kind: "s3",
    async put(sha, bytes) {
      const Key = keyOf(sha);
      try {
        await s3.send(new HeadObjectCommand({ Bucket, Key }));
        return;
      } catch (err) {
        if (!isNotFound(err)) throw fail("HeadObject", err);
      }
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body: bytes,
            ContentLength: bytes.length,
            ContentType: "application/octet-stream",
          }),
        );
      } catch (err) {
        throw fail("PutObject", err);
      }
    },
    async open(sha) {
      let out: { Body?: unknown; ContentLength?: number };
      try {
        out = await s3.send(new GetObjectCommand({ Bucket, Key: keyOf(sha) }));
      } catch (err) {
        if (isNotFound(err)) return undefined;
        throw fail("GetObject", err);
      }
      // Node 에서 Body 는 http.IncomingMessage(Readable) — destroy 하면 그 응답 소켓을 놓는다
      const stream = out.Body as Readable | undefined;
      if (!stream || typeof stream.pipe !== "function") throw new Error("S3 GetObject 실패: 본문이 없다");
      return { size: out.ContentLength ?? -1, stream, close: () => stream.destroy() };
    },
    async remove(sha) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket, Key: keyOf(sha) }));
      } catch (err) {
        if (!isNotFound(err)) throw fail("DeleteObject", err);
      }
    },
    async removeTemp() {
      // S3 PutObject 는 원자적이라 반쯤 쓴 객체가 없다
    },
    async *list() {
      let ContinuationToken: string | undefined;
      do {
        let page: {
          Contents?: { Key?: string; LastModified?: Date }[];
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        try {
          page = await s3.send(
            new ListObjectsV2Command({
              Bucket,
              ...(cfg.prefix === "" ? {} : { Prefix: cfg.prefix }),
              ...(ContinuationToken === undefined ? {} : { ContinuationToken }),
            }),
          );
        } catch (err) {
          throw fail("ListObjectsV2", err);
        }
        for (const obj of page.Contents ?? []) {
          if (obj.Key === undefined || !obj.Key.startsWith(cfg.prefix)) continue;
          const tail = obj.Key.slice(cfg.prefix.length);
          const m = KEY_TAIL.exec(tail);
          // 다른 이름의 객체(같은 버킷을 나눠 쓰는 것·사람이 둔 것)는 건드리지 않는다
          const sha = m?.[2];
          if (sha === undefined) continue;
          // 수정 시각이 없으면 막 올린 것으로 본다 — 정리가 지우지 않는다
          yield { sha, modifiedAt: obj.LastModified ?? new Date(), key: tail };
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken !== undefined);
    },
    async check() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch (err) {
        throw new BlobStoreCheckError(
          `설정 오류: 첨부 저장소(S3)에 닿을 수 없다 — HeadBucket ${describe(err)}. S3_ENDPOINT·S3_REGION·S3_BUCKET·키를 확인한다`,
        );
      }
    },
  };
}
