// dist/index.js 단일 번들. openclaw·openclaw/*·node 내장은 Gateway 런타임 것을 쓰고, @dodok/shared·zod·socket.io-client 는 넣는다.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  // ws 의 선택 네이티브 가속 모듈 — try/require 로 감싸져 있어 없어도 된다
  external: ["openclaw", "openclaw/*", "bufferutil", "utf-8-validate"],
  // 번들된 CJS 의존성(ws 등)의 require() 를 ESM 출력에서 살린다
  banner: {
    js: "import { createRequire as __dodokCreateRequire } from 'node:module'; const require = __dodokCreateRequire(import.meta.url);",
  },
  define: {
    __DODOK_PLUGIN_VERSION__: JSON.stringify(pkg.version),
    __OPENCLAW_SDK_VERSION__: JSON.stringify(pkg.devDependencies.openclaw),
  },
  legalComments: "none",
  logLevel: "info",
});
