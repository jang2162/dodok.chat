// dist/main.js 단일 번들(bin dodok-runner). @dodok/shared 는 넣고, package.json dependencies(SDK·socket.io-client·zod)는
// 설치된 것을 쓴다 — SDK 는 오픈소스가 아니라 번들에 품지 않는다(ADR 0007 2절 라이선스)
import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const SDK = "@anthropic-ai/claude-agent-sdk";
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const sdkPkg = JSON.parse(
  readFileSync(new URL(`../node_modules/${SDK}/package.json`, import.meta.url), "utf8"),
);
// 내장 CLI 판본이 SDK 판본에 묶인다 — 머신에 claude 가 없어 내장 CLI 로 돌 때 hello 가 싣는 판본이다(정확 핀이 풀리면 실제와 어긋난다)
if (pkg.dependencies[SDK] !== sdkPkg.version) {
  throw new Error(
    `${SDK} 는 정확 핀이어야 한다 — package.json ${pkg.dependencies[SDK]}, 설치본 ${sdkPkg.version}`,
  );
}

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: Object.keys(pkg.dependencies),
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __DODOK_RUNNER_VERSION__: JSON.stringify(pkg.version),
    __CLAUDE_AGENT_SDK_VERSION__: JSON.stringify(sdkPkg.version),
    __CLAUDE_CODE_VERSION__: JSON.stringify(sdkPkg.claudeCodeVersion ?? "unknown"),
  },
  legalComments: "none",
  logLevel: "info",
  // CJS 로 바꾸면 import.meta 가 빈 객체가 된다 — 경고로 두면 번들 해시가 조용히 사라지므로 빌드를 멈춘다
  logOverride: { "empty-import-meta": "error" },
});
chmodSync("dist/main.js", 0o755);

// 번들 해시는 테스트·typecheck 로 안 잡히는 두 자리(모듈 스코프 import.meta.url, hello 필드)에 달려 있다 — 산출물 글자로 확인
const out = readFileSync("dist/main.js", "utf8");
for (const needle of ["computeBundleSha256(import.meta.url)", "bundleSha256: BUNDLE_SHA256"]) {
  if (!out.includes(needle)) {
    throw new Error(`dist/main.js 에 「${needle}」 가 없다 — hello 의 bundleSha256 이 조용히 사라진다`);
  }
}
if (out.includes("claude-agent-sdk/sdk.mjs") || out.includes("createSdkMcpServer=")) {
  throw new Error("dist/main.js 에 SDK 본문이 들어갔다 — external 을 확인하라");
}
