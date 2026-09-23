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
});
