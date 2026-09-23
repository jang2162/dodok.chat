import { crc32, deflateSync } from "node:zlib";

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

type Rgb = [number, number, number];

/**
 * RGB PNG — 기본은 단색. `image-size` 와 브라우저가 둘 다 읽는 실제 PNG 다.
 * `stripes` 를 주면 그 색의 대각선 줄무늬(폭 `every` px)를 섞는다 — 화면에서 그려졌는지·비율이 맞는지 눈으로 가린다
 */
export function makePng(
  width: number,
  height: number,
  rgb: Rgb = [30, 120, 200],
  stripes?: { rgb: Rgb; every: number },
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(2, 9); // RGB
  const rowAt = (y: number) =>
    Buffer.concat([
      Buffer.from([0]),
      Buffer.from(
        Array.from({ length: width }, (_, x) =>
          stripes && Math.floor((x + y) / stripes.every) % 2 === 1 ? stripes.rgb : rgb,
        ).flat(),
      ),
    ]);
  const plain = stripes ? undefined : rowAt(0);
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => plain ?? rowAt(y)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
export const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);
export const HTML_BYTES = Buffer.from("<!doctype html><script>alert(1)</script>");
