/**
 * 첨부 형식 판별(스펙 4.2). **매직 바이트만** 믿는다 — 힌트(클라이언트·플러그인 Content-Type)는 이미지 판정에 쓰지 않는다.
 * image 는 PNG·JPEG·GIF·WebP 넷뿐이고 가로·세로를 못 읽으면 file 로 내린다(망가진 이미지를 <img> 로 그리지 않는다)
 */
import { imageSize } from "image-size";

export type Sniffed = { kind: "image" | "file"; mime: string; width?: number; height?: number };

const TEXT_HINTS = new Set(["text/plain", "application/json", "text/csv", "application/zip"]);
const OCTET = "application/octet-stream";

function startsWith(buf: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  return sig.every((b, i) => buf[offset + i] === b);
}
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

function imageMime(buf: Uint8Array): string | undefined {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, ascii("GIF87a")) || startsWith(buf, ascii("GIF89a"))) return "image/gif";
  if (startsWith(buf, ascii("RIFF")) && startsWith(buf, ascii("WEBP"), 8)) return "image/webp";
  return undefined;
}

export function sniff(bytes: Uint8Array, hint?: string): Sniffed {
  const img = imageMime(bytes);
  if (img) {
    try {
      const { width, height } = imageSize(bytes);
      if (width && height) return { kind: "image", mime: img, width, height };
    } catch {
      // 머리만 맞고 몸이 망가졌다 — 아래로
    }
    return { kind: "file", mime: OCTET };
  }
  if (startsWith(bytes, ascii("%PDF-"))) return { kind: "file", mime: "application/pdf" };
  const h = hint?.split(";")[0]?.trim().toLowerCase();
  return { kind: "file", mime: h && TEXT_HINTS.has(h) ? h : OCTET };
}
