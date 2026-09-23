// apps/server/scripts/bundle-smoke.mjs — dist/main.js 를 임시 DATA_DIR 로 띄워 /healthz 200 을 본다(스펙 8장). 네트워크 밖으로 나가지 않는다
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// 6000~6999 에서 비어 있는 포트 — 3000·5173 을 피하고, 이미 떠 있는 다른 앱의 /healthz 를 잘못 보지 않게
async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = 6000 + Math.floor(Math.random() * 1000);
    const free = await new Promise((r) => {
      const s = createServer().once("error", () => r(false));
      s.listen(port, "127.0.0.1", () => s.close(() => r(true)));
    });
    if (free) return port;
  }
  throw new Error("bundle smoke: 6000~6999 에 빈 포트가 없다");
}

const dataDir = mkdtempSync(join(tmpdir(), "dodok-bundle-"));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const secret = () => randomBytes(24).toString("hex");
const child = spawn(process.execPath, ["dist/main.js"], {
  env: {
    PATH: process.env.PATH,
    HOST: "127.0.0.1",
    PORT: String(port),
    DATA_DIR: dataDir,
    DODOK_MIGRATIONS_DIR: resolve("drizzle"),
    APP_ORIGIN: `http://localhost:${port}`,
    LOCAL_AUTH_TOKEN: secret(),
    BETTER_AUTH_SECRET: secret(),
    BRIDGE_TOKEN: secret(),
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9", // 닿지 않는다 — 부팅을 막지 않는다(app.ts)
    OPENCLAW_GATEWAY_TOKEN: secret(),
    VAPID_SUBJECT: "mailto:smoke@example.com",
    LOG_LEVEL: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let exited = false;
child.once("exit", () => (exited = true));
const healthz = () =>
  fetch(`${base}/healthz`).then(
    (r) => r.ok,
    () => false,
  );

let ok = false;
for (let i = 0; i < 60 && !ok && !exited; i++) {
  await new Promise((r) => setTimeout(r, 250));
  ok = await healthz();
}
const failures = [];
if (!ok) failures.push("/healthz 가 200 이 되지 않았다");
if (ok) {
  // socket.io 의 클라이언트 파일 서빙은 CommonJS 의 __dirname 을 쓴다 — 번들에 없으면 이 요청 하나로 프로세스가 죽는다
  // 파일이 없어 응답이 중간에 끊긴다 — 요청이 실패해도 괜찮고, 서버가 살아 있는지만 본다
  await fetch(`${base}/socket.io/socket.io.js`)
    .then((r) => r.arrayBuffer())
    .catch(() => undefined);
  await new Promise((r) => setTimeout(r, 300));
  if (exited || !(await healthz())) failures.push("GET /socket.io/socket.io.js 뒤 서버가 죽었다");
}

if (!exited) {
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}
rmSync(dataDir, { recursive: true, force: true });
console.log(
  failures.length === 0 ? "bundle smoke: /healthz 200" : `bundle smoke: FAILED — ${failures.join(", ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
