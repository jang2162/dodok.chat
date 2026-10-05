import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "../../../test/fixtures";
import { FakeXhr, makeFakeXhr, pngFile, uploaded } from "../../../test/fakeXhr";
import { checkImageFile, DISK_FULL, ONLY_IMAGES, TOO_BIG, UPLOAD_FAILED, uploadImage } from "./upload";

beforeEach(() => FakeXhr.reset());

describe("checkImageFile", () => {
  it("SVG·이미지 아닌 것은 「이미지만 올릴 수 있습니다」", () => {
    expect(ONLY_IMAGES).toBe("이미지만 올릴 수 있습니다");
    expect(checkImageFile({ type: "image/svg+xml", size: 1 })).toBe(ONLY_IMAGES);
    expect(checkImageFile({ type: "application/pdf", size: 1 })).toBe(ONLY_IMAGES);
    expect(checkImageFile({ type: "", size: 1 })).toBe(ONLY_IMAGES);
  });

  it("5 MiB 를 넘으면 「5 MB 를 넘습니다」, 딱 5 MiB 는 된다", () => {
    expect(TOO_BIG).toBe("5 MB 를 넘습니다");
    const max = ATTACHMENT_LIMITS.userImageMaxBytes;
    expect(checkImageFile({ type: "image/png", size: max + 1 })).toBe(TOO_BIG);
    expect(checkImageFile({ type: "image/png", size: max })).toBeUndefined();
  });

  it("네 형식은 통과", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      expect(checkImageFile({ type, size: 10 })).toBeUndefined();
    }
  });
});

describe("uploadImage", () => {
  const start = (name = '보고서 "최종" 😀.png', onProgress = vi.fn()) => {
    const file = pngFile(name);
    const up = uploadImage(file, CH, onProgress, makeFakeXhr);
    const xhr = FakeXhr.all[0] as FakeXhr;
    return { file, up, xhr, onProgress };
  };

  it("POST /api/v1/attachments?channelId=<id>, content-type 은 파일 타입, 이름은 퍼센트 인코딩, 본문은 파일", () => {
    const { file, xhr } = start();
    expect(xhr.method).toBe("POST");
    expect(xhr.url).toBe(`/api/v1/attachments?channelId=${CH}`);
    expect(xhr.headers["content-type"]).toBe("image/png");
    expect(xhr.headers["x-dodok-file-name"]).toBe(encodeURIComponent('보고서 "최종" 😀.png'));
    expect(decodeURIComponent(xhr.headers["x-dodok-file-name"] ?? "")).toBe('보고서 "최종" 😀.png');
    expect(xhr.body).toBe(file);
  });

  it("upload.onprogress → onProgress(loaded/total), 길이를 모르면 부르지 않는다", () => {
    const { xhr, onProgress } = start();
    xhr.progress(25, 100);
    xhr.progress(5, 0, false);
    expect(onProgress.mock.calls).toEqual([[0.25]]);
  });

  it("200 → Attachment 로 파싱", async () => {
    const { up, xhr } = start();
    const a = uploaded(1);
    xhr.respond(200, a);
    await expect(up.promise).resolves.toEqual(a);
  });

  it("200 인데 모양이 틀리면 「올리지 못했습니다」", async () => {
    const { up, xhr } = start();
    xhr.respond(200, "<html>");
    await expect(up.promise).rejects.toThrow(UPLOAD_FAILED);
    expect(UPLOAD_FAILED).toBe("올리지 못했습니다");
  });

  it("413 → 「5 MB 를 넘습니다」", async () => {
    const { up, xhr } = start();
    xhr.respond(413, { code: "VALIDATION", message: "너무 큼" });
    await expect(up.promise).rejects.toThrow(TOO_BIG);
  });

  it("409 CHANNEL_ARCHIVED(보관한 채널) → 「보관된 채널입니다」", async () => {
    const { up, xhr } = start();
    xhr.respond(409, { code: "CHANNEL_ARCHIVED", message: "channel is archived" });
    await expect(up.promise).rejects.toThrow("보관된 채널입니다");
  });

  it("400 → 서버 message", async () => {
    const { up, xhr } = start();
    xhr.respond(400, { code: "VALIDATION", message: "이미지만 올릴 수 있습니다" });
    await expect(up.promise).rejects.toThrow("이미지만 올릴 수 있습니다");
  });

  it("507(서버 디스크 부족)이면 원인을 말한다 — 본문이 없어도(프록시가 바꿔도) 상태로 가른다", async () => {
    for (const body of [
      { code: "INSUFFICIENT_STORAGE", message: "서버 디스크 여유가 부족합니다" },
      "",
    ] as const) {
      FakeXhr.reset();
      const { up, xhr } = start();
      xhr.respond(507, body);
      await expect(up.promise).rejects.toThrow(DISK_FULL);
    }
    expect(DISK_FULL).toBe("서버 디스크 여유가 부족해 올리지 못했습니다");
  });

  it("그 밖의 상태(403·500)나 본문 없는 400 은 「올리지 못했습니다」", async () => {
    for (const [status, body] of [
      [403, { code: "FORBIDDEN", message: "안 됨" }],
      [500, { code: "INTERNAL", message: "터짐" }],
      [400, ""],
    ] as const) {
      FakeXhr.reset();
      const { up, xhr } = start();
      xhr.respond(status, body);
      await expect(up.promise).rejects.toThrow(UPLOAD_FAILED);
    }
  });

  it("네트워크 오류 → 「올리지 못했습니다」", async () => {
    const { up, xhr } = start();
    xhr.fail();
    await expect(up.promise).rejects.toThrow(UPLOAD_FAILED);
  });

  it("abort() → 요청을 끊고 AbortError 이름의 오류", async () => {
    const { up, xhr } = start();
    up.abort();
    expect(xhr.aborted).toBe(true);
    await expect(up.promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
