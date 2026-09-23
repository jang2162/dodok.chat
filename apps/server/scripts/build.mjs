// apps/server/scripts/build.mjs — 운영 번들(스펙 2.1). 사용: pnpm -F @dodok/server build
import { build } from "esbuild";

// 네이티브 애드온(.node)이라 묶을 수 없다 — 실행 이미지가 lockfile 로 설치한다.
// 번들에 남는 나머지 require/import 는 전부 try/catch 안의 선택 의존성(ws 의 bufferutil·utf-8-validate,
// debug 의 supports-color, better-auth 의 @opentelemetry/api)이나 코드 생성 문자열(ajv·fast-json-stringify standalone)이다.
// 의존성을 올린 뒤 다시 재려면 dist/main.js 에서 비내장 require("…")·import("…") 를 찾아 try/catch 안인지 본다
const external = ["better-sqlite3"];

await build({
  entryPoints: { main: "src/main.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  external,
  define: { __DODOK_BUNDLED__: "true" },
  // ESM 번들 안의 CommonJS 의존성이 require·__filename·__dirname 을 쓸 수 있게.
  // __dirname 이 없으면 socket.io 의 클라이언트 파일 서빙(GET /socket.io/socket.io.js)이 ReferenceError 로 프로세스를 죽인다.
  // 값은 dist/ 기준이라 그 파일은 없다 — socket.io 가 읽기 오류를 스스로 받아 응답만 끝낸다(bundle-smoke 가 확인)
  banner: {
    js: [
      "import { createRequire as __dodokCreateRequire } from 'node:module';",
      "import { fileURLToPath as __dodokFileURLToPath } from 'node:url';",
      "import { dirname as __dodokDirname } from 'node:path';",
      "const require = __dodokCreateRequire(import.meta.url);",
      "const __filename = __dodokFileURLToPath(import.meta.url);",
      "const __dirname = __dodokDirname(__filename);",
    ].join(" "),
  },
  logLevel: "info",
});
