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
  type S3ClientConfig,
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

/** TCP 연결이 이 안에 서지 않으면 오류 */
export const S3_CONNECTION_TIMEOUT_MS = 5_000;
/**
 * 요청을 만들 때부터 응답 헤더를 받기까지의 상한 — 요청 본문을 보내는 시간도 그 안이다. SDK 기본은 둘 다 0(무한)이라 멈춘
 * 엔드포인트에서 부팅 check 가 끝나지 않고, 업로드가 sha 잠금을 쥔 채 멈춰 정리 전체가 그 뒤에 묶였다. 헤더를 받은 뒤의 본문(큰
 * 내려받기)에는 걸리지 않는다 — 내려받기 도중 멈춘 본문은 클라이언트가 끊을 때 닫는다(routes.ts sendBlob). SDK 의 재시도(기본 3회)마다
 * 다시 재므로 한 호출의 최악은 그 곱에 백오프를 더한 것이다. PutObject 만은 본문 크기에 비례해 늘린다(putRequestTimeout)
 */
export const S3_REQUEST_TIMEOUT_MS = 30_000;
/** PutObject 상한을 셀 때 가정하는 가장 느린 업로드 속도 — 이보다 느린 업링크면 큰 업로드가 상한에 걸린다 */
export const S3_PUT_MIN_BYTES_PER_SECOND = 64 * 1024;

/** PutObject 한 번의 상한 — 요청 상한에 본문을 가장 느린 속도로 보내는 시간을 더한다(20 MiB 면 약 6분) */
export function putRequestTimeout(
  size: number,
  base = S3_REQUEST_TIMEOUT_MS,
  minBytesPerSecond = S3_PUT_MIN_BYTES_PER_SECOND,
): number {
  return base + Math.ceil((size / minBytesPerSecond) * 1000);
}

/** 저장소가 PutObject 상한을 셀 때 쓰는 값 — 시험이 줄인다. 클라이언트의 requestTimeout 과 같은 값을 준다 */
export type S3PutTimeout = { requestTimeout: number; minBytesPerSecond: number };

export type S3Timeouts = { connectionTimeout: number; requestTimeout: number };

/** S3Client 설정 — 시험이 타임아웃을 줄여 멈춘 서버에 붙인다 */
export function s3ClientConfig(
  cfg: S3Config,
  timeouts: S3Timeouts = {
    connectionTimeout: S3_CONNECTION_TIMEOUT_MS,
    requestTimeout: S3_REQUEST_TIMEOUT_MS,
  },
): S3ClientConfig {
  return {
    region: cfg.region,
    ...(cfg.endpoint === undefined ? {} : { endpoint: cfg.endpoint }),
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // S3 호환 저장소(MinIO·R2 등) 일부가 SDK 기본 체크섬 헤더(CRC32)를 모른다 — 요구될 때만 붙인다
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    // NodeHttpHandler 옵션 객체 꼴 — requestTimeout 은 throwOnRequestTimeout 이 없으면 경고만 찍고 계속 기다린다
    requestHandler: { ...timeouts, throwOnRequestTimeout: true },
  };
}

export function createS3BlobStore(
  cfg: S3Config,
  client?: S3Client,
  putTimeout: S3PutTimeout = {
    requestTimeout: S3_REQUEST_TIMEOUT_MS,
    minBytesPerSecond: S3_PUT_MIN_BYTES_PER_SECOND,
  },
): BlobStore {
  const s3 = client ?? new S3Client(s3ClientConfig(cfg));
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
          // 요청별 requestTimeout 이 클라이언트 값보다 앞선다 — 본문을 보내는 동안에도 상한이 흐르므로 크기만큼 늘린다
          {
            requestTimeout: putRequestTimeout(
              bytes.length,
              putTimeout.requestTimeout,
              putTimeout.minBytesPerSecond,
            ),
          },
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
