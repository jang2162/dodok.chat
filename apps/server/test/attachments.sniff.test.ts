import { describe, expect, it } from "vitest";
import { sniff } from "../src/modules/attachments/sniff";
import { HTML_BYTES, makePng, PDF_BYTES, SVG_BYTES } from "./helpers/png";

// 3×2 샘플. makePng(3, 2) 를 in.png 로 쓴 뒤
//   JPEG: sips -s format jpeg -s formatOptions low in.png --out s.jpg
//   WebP: cwebp -quiet -lossless in.png -o s.webp  (sips 는 WebP 를 쓰지 못한다 — "Can't write format")
// 로 만들고 base64 로 옮겼다
const JPEG_3x2 = Buffer.from(
  "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAA6ADAAQAAAABAAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgADAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAExMTExMTIBMTIC0gICAtPS0tLS09TT09PT09TV1NTU1NTU1dXV1dXV1dXXBwcHBwcIODg4ODk5OTk5OTk5OTk//bAEMBFxgYJSMlQCMjQJloVWiZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmf/dAAQAAf/aAAwDAQACEQMRAD8AqUUUV6Z5p//Z",
  "base64",
);
const WEBP_3x2 = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAkAAAAdQvHoUuf+BiOh/AAA=", "base64");

/** JPEG 의 APPn 묶음 바로 뒤에 EXIF Orientation 만 담은 APP1 을 끼운다 — 뒤 APP1 이 앞 값을 덮으므로 sips 의 APP1 뒤에 둔다 */
function withOrientation(jpeg: Uint8Array, orientation: number): Uint8Array {
  let at = 2;
  while (jpeg[at] === 0xff && jpeg[at + 1]! >= 0xe0 && jpeg[at + 1]! <= 0xef)
    at += 2 + ((jpeg[at + 2]! << 8) | jpeg[at + 3]!);
  const body = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]), // 빅엔디언 TIFF, IFD0 은 8
    Buffer.from([0x00, 0x01]), // 항목 1개
    Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00]), // Orientation SHORT×1
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // 다음 IFD 없음
  ]);
  const len = body.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, len >> 8, len & 0xff]), body]);
  return Buffer.concat([jpeg.subarray(0, at), app1, jpeg.subarray(at)]);
}

/** 앞뒤를 0x7f 로 채운 큰 ArrayBuffer 한가운데에 bytes 를 두고 그 자리만 보는 뷰 — Node 의 Buffer 풀과 같은 모양을 결정적으로 만든다 */
function viewInsideFilledBuffer(bytes: Uint8Array): Uint8Array {
  const backing = new Uint8Array(4096).fill(0x7f);
  backing.set(bytes, 1024);
  return backing.subarray(1024, 1024 + bytes.length);
}

describe("sniff — 매직 바이트가 힌트를 이긴다", () => {
  it("PNG 는 image 이고 가로·세로를 읽는다", () => {
    expect(sniff(makePng(3, 2), "application/octet-stream")).toEqual({
      kind: "image",
      mime: "image/png",
      width: 3,
      height: 2,
    });
  });
  it("JPEG·GIF·WebP 머리", () => {
    const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    expect(sniff(gif)).toMatchObject({ kind: "image", mime: "image/gif", width: 1, height: 1 });
    expect(sniff(JPEG_3x2, "text/plain")).toEqual({ kind: "image", mime: "image/jpeg", width: 3, height: 2 });
    expect(sniff(WEBP_3x2)).toEqual({ kind: "image", mime: "image/webp", width: 3, height: 2 });
  });
  it("PDF 는 file/application/pdf", () => {
    expect(sniff(PDF_BYTES, "image/png")).toEqual({ kind: "file", mime: "application/pdf" });
  });
  it("SVG 는 어떤 힌트로도 image 가 아니고 image/svg+xml 로도 나가지 않는다", () => {
    for (const hint of [undefined, "image/svg+xml", "image/png", "text/html"])
      expect(sniff(SVG_BYTES, hint)).toEqual({ kind: "file", mime: "application/octet-stream" });
  });
  it("PNG 라고 한 HTML 은 file/octet-stream", () => {
    expect(sniff(HTML_BYTES, "image/png")).toEqual({ kind: "file", mime: "application/octet-stream" });
    expect(sniff(HTML_BYTES, "text/html; charset=utf-8")).toEqual({
      kind: "file",
      mime: "application/octet-stream",
    });
  });
  it("허용된 텍스트 힌트는 살린다(매개변수는 뗀다)", () => {
    expect(sniff(Buffer.from("a,b\n1,2\n"), "text/csv; charset=utf-8")).toEqual({
      kind: "file",
      mime: "text/csv",
    });
    expect(sniff(Buffer.from("hi"), "TEXT/PLAIN")).toEqual({ kind: "file", mime: "text/plain" });
  });
  it("PNG 머리만 있고 몸이 망가지면 file 로 내린다", () => {
    expect(sniff(makePng(3, 2).subarray(0, 12))).toEqual({ kind: "file", mime: "application/octet-stream" });
  });
  it("JPEG·WebP 도 머리만 맞고 몸이 망가지면 file", () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toEqual({
      kind: "file",
      mime: "application/octet-stream",
    });
    expect(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"))).toEqual({
      kind: "file",
      mime: "application/octet-stream",
    });
  });
  it("잘린 이미지를 담은 뷰 밖(바탕 ArrayBuffer 의 이웃 바이트)을 치수로 읽지 않는다", () => {
    const truncated = [
      Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1"),
      Buffer.from("RIFF\0\0\0\0WEBPVP8X", "latin1"),
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11]),
      makePng(3, 2).subarray(0, 18),
    ];
    for (const bytes of truncated)
      expect(sniff(viewInsideFilledBuffer(bytes))).toEqual({
        kind: "file",
        mime: "application/octet-stream",
      });
    // 멀쩡한 이미지는 뷰로 줘도 제 치수
    expect(sniff(viewInsideFilledBuffer(WEBP_3x2))).toEqual({
      kind: "image",
      mime: "image/webp",
      width: 3,
      height: 2,
    });
    expect(sniff(viewInsideFilledBuffer(JPEG_3x2))).toEqual({
      kind: "image",
      mime: "image/jpeg",
      width: 3,
      height: 2,
    });
  });
  it("Node Buffer 풀 위의 잘린 WebP 도 file (풀을 채운 뒤 수백 번)", () => {
    for (let i = 0; i < 500; i++) {
      Buffer.allocUnsafe(2048).fill(0x5a); // 풀에 이웃 바이트를 깐다
      const bytes = Buffer.from("RIFF\0\0\0\0WEBPVP8 ", "latin1");
      expect(sniff(bytes)).toEqual({ kind: "file", mime: "application/octet-stream" });
    }
  });
  it("EXIF Orientation 5~8 이면 가로·세로를 바꿔 저장한다(브라우저가 돌려 그린 모양), 1~4 는 그대로", () => {
    for (const o of [5, 6, 7, 8])
      expect(sniff(withOrientation(JPEG_3x2, o))).toEqual({
        kind: "image",
        mime: "image/jpeg",
        width: 2,
        height: 3,
      });
    for (const o of [1, 2, 3, 4])
      expect(sniff(withOrientation(JPEG_3x2, o))).toEqual({
        kind: "image",
        mime: "image/jpeg",
        width: 3,
        height: 2,
      });
  });
});
