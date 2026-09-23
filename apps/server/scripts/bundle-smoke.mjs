// apps/server/scripts/bundle-smoke.mjs — 운영 번들을 실행 이미지와 같은 배치로 띄워 본다(스펙 8장). 사용: build 뒤 pnpm -F @dodok/server bundle:smoke
// 배치: `pnpm deploy --prod` 산출물의 node_modules 위에 dist/·drizzle/ 을 놓는다(태스크 3 Dockerfile 과 같은 명령).
// 저장소 밖 임시 디렉터리에서 띄운다 — 저장소 안이면 워크스페이스 node_modules(devDependency 포함)가 모든 것을 해석해
// 빠진 prod 의존성이 가려진다(번들이 런타임에 찾는 ws 가 devDependency 였던 결함을 그렇게 놓쳤다).
// 단계 1: 정상 env 로 /healthz 200 · GET /socket.io/socket.io.js 400(serveClient: false) 뒤에도 살아 있음
// 단계 2: DODOK_MIGRATIONS_DIR 없이 띄우면 설정 오류로 죽는다 — 번들이 자기를 번들로 알아보는지(define·isBundled)를 이것으로 본다
// 네트워크 밖으로 나가지 않는다(deploy 는 --offline 으로 로컬 스토어만 쓴다)
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const serverDir = process.cwd(); // pnpm -F @dodok/server 이 apps/server 에서 부른다
const repoRoot = resolve(serverDir, "../..");

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

const work = mkdtempSync(join(tmpdir(), "dodok-bundle-"));
const appDir = join(work, "app");
const dataDir = join(work, "data");
const failures = [];

function prepareApp() {
  if (!existsSync(join(serverDir, "dist/main.js")))
    throw new Error("dist/main.js 가 없다 — 먼저 pnpm -F @dodok/server build");
  // 조상 디렉터리에 node_modules 가 있으면 Node 가 거기까지 올라가 해석하므로 격리가 깨진다
  for (let d = work; ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules"))) throw new Error(`격리 불가: ${d}/node_modules 가 있다`);
    if (dirname(d) === d) break;
  }
  // pnpm 11 은 inject-workspace-packages 가 없는 워크스페이스에서 --legacy 없이는 deploy 를 거부한다(ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE).
  // deploy 는 원본 워크스페이스의 node_modules/.pnpm-workspace-state-v1.json 을 dev:false 로 덮어쓴다 — 그대로 두면 다음
  // `pnpm run` 이 의존성 확인에서 `pnpm install --production` 을 시도한다(TTY 가 없으면 실패). 그래서 앞뒤로 되돌린다
  const statePath = join(repoRoot, "node_modules/.pnpm-workspace-state-v1.json");
  const state = existsSync(statePath) ? readFileSync(statePath) : undefined;
  let r;
  try {
    r = spawnSync(
      "pnpm",
      ["--filter", "@dodok/server", "deploy", "--prod", "--legacy", "--offline", join(work, "deploy")],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
  } finally {
    if (state) writeFileSync(statePath, state);
  }
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr);
    throw new Error(`pnpm deploy 가 exit ${r.status ?? r.error}`);
  }
  // 이미지 배치(/app/node_modules·/app/dist·/app/drizzle)와 같게 — deploy 가 복사한 src/·test/ 는 쓰지 않는다
  mkdirSync(appDir);
  renameSync(join(work, "deploy/node_modules"), join(appDir, "node_modules"));
  cpSync(join(work, "deploy/package.json"), join(appDir, "package.json"));
  rmSync(join(work, "deploy"), { recursive: true, force: true });
  cpSync(join(serverDir, "dist"), join(appDir, "dist"), { recursive: true });
  cpSync(join(serverDir, "drizzle"), join(appDir, "drizzle"), { recursive: true });
}

function startBundle(port, extraEnv) {
  mkdirSync(dataDir, { recursive: true });
  const secret = () => randomBytes(24).toString("hex");
  const child = spawn(process.execPath, ["dist/main.js"], {
    cwd: appDir,
    env: {
      PATH: process.env.PATH,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_ORIGIN: `http://localhost:${port}`,
      LOCAL_AUTH_TOKEN: secret(),
      BETTER_AUTH_SECRET: secret(),
      BRIDGE_TOKEN: secret(),
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:9", // 닿지 않는다 — 부팅을 막지 않는다(app.ts)
      OPENCLAW_GATEWAY_TOKEN: secret(),
      VAPID_SUBJECT: "mailto:smoke@example.com",
      LOG_LEVEL: "warn",
      ...extraEnv,
    },
    stdio: ["ignore", "inherit", "pipe"],
  });
  const run = { child, exited: false, code: null, stderr: "" };
  child.stderr.on("data", (b) => {
    run.stderr += b;
    process.stderr.write(b);
  });
  run.done = new Promise((r) =>
    child.once("exit", (code) => {
      run.exited = true;
      run.code = code;
      r();
    }),
  );
  return run;
}

async function stop(run) {
  if (!run.exited) {
    run.child.kill("SIGTERM");
    await run.done;
  }
}

async function stage1() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const run = startBundle(port, { DODOK_MIGRATIONS_DIR: join(appDir, "drizzle") });
  const healthz = () =>
    fetch(`${base}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
  let ok = false;
  for (let i = 0; i < 60 && !ok && !run.exited; i++) {
    await new Promise((r) => setTimeout(r, 250));
    ok = await healthz();
  }
  if (!ok) failures.push("단계 1: /healthz 가 200 이 되지 않았다");
  if (ok) {
    // serveClient: false 면 engine.io 가 400 Transport unknown 으로 답한다. 켜져 있으면 번들에는 client-dist 가 없어 머리만 보내고 끊긴다
    const status = await fetch(`${base}/socket.io/socket.io.js`).then(
      async (r) => (await r.arrayBuffer(), r.status),
      (e) => `요청 실패(${e.cause?.code ?? e.message})`,
    );
    if (status !== 400) failures.push(`단계 1: GET /socket.io/socket.io.js 가 400 이 아니라 ${status}`);
    await new Promise((r) => setTimeout(r, 300));
    if (run.exited || !(await healthz()))
      failures.push("단계 1: GET /socket.io/socket.io.js 뒤 서버가 죽었다");
  }
  await stop(run);
}

async function stage2() {
  const run = startBundle(await freePort(), {});
  const timeout = setTimeout(() => run.child.kill("SIGKILL"), 15_000);
  await run.done;
  clearTimeout(timeout);
  if (run.code === 0 || run.code === null)
    failures.push(`단계 2: DODOK_MIGRATIONS_DIR 없이 exit ${run.code}(0 이 아니어야 한다)`);
  if (!run.stderr.includes("설정 오류: 운영 번들에는 DODOK_MIGRATIONS_DIR"))
    failures.push("단계 2: stderr 에 「설정 오류: 운영 번들에는 DODOK_MIGRATIONS_DIR」 가 없다");
}

try {
  prepareApp();
  await stage1();
  rmSync(dataDir, { recursive: true, force: true });
  await stage2();
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(
  failures.length === 0
    ? "bundle smoke: 1) /healthz 200 · /socket.io/socket.io.js 400  2) DODOK_MIGRATIONS_DIR 없으면 설정 오류로 종료"
    : `bundle smoke: FAILED — ${failures.join(", ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
