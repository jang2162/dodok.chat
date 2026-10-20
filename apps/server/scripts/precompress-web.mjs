// apps/server/scripts/precompress-web.mjs — 빌드된 웹의 텍스트 파일 옆에 .br·.gz 를 쓴다. 사용: node apps/server/scripts/precompress-web.mjs <dir>
// 서버(src/http/web-static.ts)는 요청마다 압축하지 않고 Accept-Encoding 에 맞는 이 형제 파일을 고른다 — 이미지 빌드(루트 Dockerfile 의 web 단계)가 부른다.
// 이미지·글꼴은 이미 압축돼 있어 건너뛰고, 1 KiB 미만은 머리 값이 이득을 넘는다. 압축본이 원본보다 크면 쓰지 않는다
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const TEXT = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".webmanifest", ".txt", ".map"]);
const MIN_BYTES = 1024;

const dir = process.argv[2];
if (!dir) {
  console.error("사용: node apps/server/scripts/precompress-web.mjs <dir>");
  process.exit(2);
}

let written = 0;
const walk = (d) => {
  for (const entry of readdirSync(d, { withFileTypes: true })) {
    const path = join(d, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (
      entry.isFile() &&
      TEXT.has(extname(entry.name).toLowerCase()) &&
      statSync(path).size >= MIN_BYTES
    ) {
      const raw = readFileSync(path);
      const br = brotliCompressSync(raw, {
        params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length },
      });
      const gz = gzipSync(raw, { level: 9 });
      if (br.length < raw.length) {
        writeFileSync(`${path}.br`, br);
        written++;
      }
      if (gz.length < raw.length) {
        writeFileSync(`${path}.gz`, gz);
        written++;
      }
    }
  }
};
walk(dir);
console.log(`precompress-web: ${written} files written under ${dir}`);
