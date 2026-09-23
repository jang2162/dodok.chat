// apps/server/scripts/build.mjs — 운영 번들(스펙 2.1). 사용: pnpm -F @dodok/server build
import { build } from "esbuild";

// 네이티브 애드온(.node)이라 묶을 수 없다 — 실행 이미지가 lockfile 로 설치한다.
// 번들이 런타임에 node_modules 에서 찾는 것이 external 말고 하나 더 있다: ws. @openclaw/gateway-client 가
// createRequire(import.meta.url) 로 "ws/package.json" 을 resolve 하는데, 번들 뒤 import.meta.url 은 dist/main.js 라
// 실행 자리의 node_modules 에서 찾는다 — 그래서 ws 는 @dodok/server 의 dependencies 여야 한다(devDependency 면 프로드 설치에서 부팅 실패).
// 번들에 남는 나머지 require/import 는 전부 try/catch 안의 선택 의존성(ws 의 bufferutil·utf-8-validate,
// debug 의 supports-color, better-auth 의 @opentelemetry/api), 쓰지 않는 가지(pino transport 의 createRequire —
// transport 를 안 쓴다), 내장 모듈(node:sqlite·node:async_hooks)이나 코드 생성 문자열(ajv·fast-json-stringify standalone)이다.
// 의존성을 올린 뒤 다시 재려면 dist/main.js 에서 비내장 require("…")·import("…") 와 함께 createRequire·.resolve( 를 찾는다 —
// 번들러가 이름을 require2 처럼 바꾸므로 \brequire\( 로는 못 센다. 빠진 것은 bundle-smoke(프로드 설치 위에서 띄운다)가 잡는다 —
// 단 부팅 경로에서 찾는 것만(ws 는 부팅 때 Gateway 클라이언트가 적재한다). 요청 경로 안의 런타임 해석은 위 전수 재기로만 찾는다
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
  // __dirname 이 없으면 socket.io 의 클라이언트 파일 서빙이 요청 하나로 ReferenceError 를 내 프로세스를 죽였다 — 지금은
  // app.ts 가 serveClient: false 로 그 경로를 끄지만, 다른 CommonJS 의존성(thread-stream·pino transport)도 __dirname 을 참조하므로 남긴다.
  // 그 경로들은 transport 를 안 써서 실행되지 않는다 — 이 두 줄을 지워도 bundle-smoke 는 초록이다(방어일 뿐, 검사가 없다).
  // 값은 dist/ 기준이다 — 그 자리에 패키지 파일은 없다
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
