// prepublishOnly — 빌드한 뒤 올리기 전에 꾸러미에 들어갈 것을 확인한다. 빌드 안 된 번들·빠진 README/LICENSE·판본이 다른 번들이
// 올라가지 않게 한다
import { existsSync, readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const fail = (msg) => {
  throw new Error(`publish 전 확인 실패 — ${msg}`);
};

for (const file of pkg.files) {
  if (!existsSync(new URL(`../${file}`, import.meta.url))) fail(`${file} 가 없다`);
}
const bundle = readFileSync(new URL("../dist/main.js", import.meta.url), "utf8");
if (!bundle.startsWith("#!/usr/bin/env node")) fail("dist/main.js 첫 줄이 shebang 이 아니다");
if (!bundle.includes(JSON.stringify(pkg.version))) {
  fail(`dist/main.js 에 판본 ${pkg.version} 이 없다 — 판본을 올린 뒤 다시 빌드하라`);
}
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (String(range).startsWith("workspace:")) fail(`dependencies ${name} 가 workspace 프로토콜이다`);
}
