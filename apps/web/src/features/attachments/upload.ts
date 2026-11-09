import { ApiError, ATTACHMENT_LIMITS, Attachment, isImageMime } from "@dodok/shared";
import { CHANNEL_ARCHIVED_TEXT } from "@/api/formErrors";
import { DM_READ_ONLY_TEXT, dmReadOnlyReasonOf } from "@/features/dms/queries";

/** 사진 상한(`ATTACHMENT_LIMITS.userImageMaxBytes`)을 넘음 */
export const TOO_BIG = "5 MB 를 넘습니다";
/** 사진이 아닌 파일의 상한(`ATTACHMENT_LIMITS.userFileMaxBytes`)을 넘음 */
export const TOO_BIG_FILE = "20 MB 를 넘습니다";
export const UPLOAD_FAILED = "올리지 못했습니다";
/** 0 B 파일 — 서버가 400 으로 거절한다(그 원문을 칩에 그대로 쓰지 않게 먼저 막는다) */
export const EMPTY_FILE = "빈 파일은 보낼 수 없습니다";
/** 서버 디스크 여유가 부족해 거절(507) — 사람이 고칠 수 없는 원인이라 따로 말한다(운영 보강 브라우저 검증 O1) */
export const DISK_FULL = "서버 디스크 여유가 부족해 올리지 못했습니다";
/** 읽기 전용 DM 이라 거절(409 DM_READ_ONLY)된 오류의 `name` — 부르는 쪽이 DM 목록을 다시 받아 작성기 자리를 사유 줄로 바꾼다 */
export const DM_READ_ONLY_ERROR = "DmReadOnlyError";

/**
 * 올리기 전 검사(파일함 스펙 6장) — 넘거나 비었으면 칩에 쓸 이유, 맞으면 undefined. 형식은 막지 않는다.
 * 이미지 MIME 이면 사진 상한, 그 밖(SVG 포함 — 첨부 스펙 결정 8)은 파일 상한. 브라우저의 `type` 은 확장자에서 온 힌트라
 * 서버가 내용으로 다시 판별하고, 갈리면 서버가 이긴다
 */
export function checkAttachmentFile(file: Pick<File, "type" | "size">): string | undefined {
  if (file.size === 0) return EMPTY_FILE;
  if (isImageMime(file.type)) return file.size > ATTACHMENT_LIMITS.userImageMaxBytes ? TOO_BIG : undefined;
  return file.size > ATTACHMENT_LIMITS.userFileMaxBytes ? TOO_BIG_FILE : undefined;
}

/** 서버가 알린 상한(`details.maxBytes`) → 칩 문구. 사진 상한 이하면 사진 문구 */
const sizeText = (maxBytes: number) =>
  maxBytes <= ATTACHMENT_LIMITS.userImageMaxBytes ? TOO_BIG : TOO_BIG_FILE;

function maxBytesOf(details: unknown): number | undefined {
  const v = (details as { maxBytes?: unknown } | undefined)?.maxBytes;
  return typeof v === "number" ? v : undefined;
}

/**
 * 파일 하나를 올린다 — XHR 인 까닭은 `fetch` 가 업로드 진행을 주지 않아서다(스펙 6.1). 쿠키 인증, 같은 출처.
 * 413(본문 상한 — 파일 상한)과 `maxBytes` 를 실은 400(서버가 사진으로 판별해 사진 상한)은 상한 문구, 그 밖의 400 은 서버 문구, 507 은 디스크 문구, 409 CHANNEL_ARCHIVED 는 보관 문구, 409 DM_READ_ONLY 는 그 사유 문구(`name` 은
 * `DM_READ_ONLY_ERROR`), 그 밖·네트워크 오류는 「올리지 못했습니다」. `abort()` 는 `AbortError` 로 끝낸다
 */
export function uploadAttachment(
  file: File,
  channelId: string,
  onProgress: (ratio: number) => void,
  makeXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): { promise: Promise<Attachment>; abort(): void } {
  const xhr = makeXhr();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open("POST", `/api/v1/attachments?channelId=${encodeURIComponent(channelId)}`);
    // 브라우저가 형식을 모르면 `type` 이 빈 문자열이다 — 빈 헤더 대신 일반 바이너리로 보내고 판별은 서버가 한다
    xhr.setRequestHeader("content-type", file.type || "application/octet-stream");
    xhr.setRequestHeader("x-dodok-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const parsed = Attachment.safeParse(safeJson(xhr.responseText));
        return parsed.success ? resolve(parsed.data) : reject(new Error(UPLOAD_FAILED));
      }
      if (xhr.status === 507) return reject(new Error(DISK_FULL));
      const body = ApiError.safeParse(safeJson(xhr.responseText));
      const maxBytes = body.success ? maxBytesOf(body.data.details) : undefined;
      if (xhr.status === 413)
        return reject(new Error(sizeText(maxBytes ?? ATTACHMENT_LIMITS.userFileMaxBytes)));
      if (xhr.status === 400 && maxBytes !== undefined) return reject(new Error(sizeText(maxBytes)));
      if (body.success && body.data.code === "CHANNEL_ARCHIVED")
        return reject(new Error(CHANNEL_ARCHIVED_TEXT));
      if (body.success && body.data.code === "DM_READ_ONLY") {
        const text = DM_READ_ONLY_TEXT[dmReadOnlyReasonOf(body.data.details)];
        return reject(Object.assign(new Error(text), { name: DM_READ_ONLY_ERROR }));
      }
      reject(new Error(body.success && xhr.status === 400 ? body.data.message : UPLOAD_FAILED));
    };
    xhr.onerror = () => reject(new Error(UPLOAD_FAILED));
    xhr.onabort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
