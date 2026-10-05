import { ApiError, ATTACHMENT_LIMITS, Attachment, isImageMime } from "@dodok/shared";
import { CHANNEL_ARCHIVED_TEXT } from "@/api/formErrors";

export const ONLY_IMAGES = "이미지만 올릴 수 있습니다";
export const TOO_BIG = "5 MB 를 넘습니다";
export const UPLOAD_FAILED = "올리지 못했습니다";
/** 서버 디스크 여유가 부족해 거절(507) — 사람이 고칠 수 없는 원인이라 따로 말한다(운영 보강 브라우저 검증 O1) */
export const DISK_FULL = "서버 디스크 여유가 부족해 올리지 못했습니다";

/** 올리기 전 검사(스펙 6.1) — 틀리면 칩에 쓸 이유, 맞으면 undefined. SVG 는 이미지가 아니다(스펙 결정 8) */
export function checkImageFile(file: Pick<File, "type" | "size">): string | undefined {
  if (!isImageMime(file.type)) return ONLY_IMAGES;
  if (file.size > ATTACHMENT_LIMITS.userImageMaxBytes) return TOO_BIG;
  return undefined;
}

/**
 * 이미지 한 장을 올린다 — XHR 인 까닭은 `fetch` 가 업로드 진행을 주지 않아서다(스펙 6.1). 쿠키 인증, 같은 출처.
 * 413 은 상한 문구, 400 은 서버 문구, 507 은 디스크 문구, 409 CHANNEL_ARCHIVED 는 보관 문구, 그 밖·네트워크 오류는 「올리지 못했습니다」. `abort()` 는 `AbortError` 로 끝낸다
 */
export function uploadImage(
  file: File,
  channelId: string,
  onProgress: (ratio: number) => void,
  makeXhr: () => XMLHttpRequest = () => new XMLHttpRequest(),
): { promise: Promise<Attachment>; abort(): void } {
  const xhr = makeXhr();
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open("POST", `/api/v1/attachments?channelId=${encodeURIComponent(channelId)}`);
    xhr.setRequestHeader("content-type", file.type);
    xhr.setRequestHeader("x-dodok-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const parsed = Attachment.safeParse(safeJson(xhr.responseText));
        return parsed.success ? resolve(parsed.data) : reject(new Error(UPLOAD_FAILED));
      }
      if (xhr.status === 413) return reject(new Error(TOO_BIG));
      if (xhr.status === 507) return reject(new Error(DISK_FULL));
      const body = ApiError.safeParse(safeJson(xhr.responseText));
      if (body.success && body.data.code === "CHANNEL_ARCHIVED")
        return reject(new Error(CHANNEL_ARCHIVED_TEXT));
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
