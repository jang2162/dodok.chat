// dist/index.js 단일 번들. openclaw·openclaw/*·node 내장은 Gateway 런타임 것을 쓰고, @dodok/shared·zod·socket.io-client 는 넣는다.
import { readFileSync, rmSync } from "node:fs";
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
  // CJS 로 바꾸면 import.meta 가 빈 객체가 된다 — 경고로 두면 번들 해시가 조용히 사라지므로 빌드를 멈춘다
  logOverride: { "empty-import-meta": "error" },
});

// 설정 마법사 결정 5 — 번들 해시는 테스트·typecheck 로 안 잡히는 두 자리(모듈 스코프 import.meta.url, hello 필드)에
// 달려 있다. define 치환이나 hello 줄 삭제는 esbuild 도 경고하지 않으니 산출물 글자로 확인한다
// 실패하면 이미 쓴 dist/ 를 지운다 — 남겨 두면 다음 pnpm pack 이 해시 없는 번들을 싼다
const out = readFileSync("dist/index.js", "utf8");
const missing = ["computeBundleSha256(import.meta.url)", "bundleSha256: BUNDLE_SHA256"].filter(
  (needle) => !out.includes(needle),
);
if (missing.length > 0) {
  rmSync("dist", { recursive: true, force: true });
  throw new Error(
    `dist/index.js 에 ${missing.map((n) => `「${n}」`).join("·")} 가 없다 — hello 의 bundleSha256 이 조용히 사라진다. ` +
      "dist/ 는 지웠다. 고칠 자리: src/channel.ts 의 모듈 스코프 `const BUNDLE_SHA256 = computeBundleSha256(import.meta.url)` 와 " +
      "hello 필드 `bundleSha256: BUNDLE_SHA256`",
  );
}
