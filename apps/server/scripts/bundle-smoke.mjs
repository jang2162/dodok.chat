// apps/server/scripts/bundle-smoke.mjs — 운영 번들을 실행 이미지와 같은 배치로 띄워 본다(스펙 8장). 사용: build 뒤 pnpm -F @dodok/server bundle:smoke
// 배치: `pnpm deploy --prod` 산출물을 scripts/prune-runtime-deps.mjs 로 dist/runtime-deps.json 의 닫힘만 남긴 node_modules 위에
// dist/·drizzle/ 을 놓는다 — infra/Dockerfile.server 의 runtime 이미지와 같은 명령·같은 배치다. 그래서 build.mjs 의 runtimeDeps 에
// 빠진 것이 있으면 여기서 부팅이 깨진다.
// 저장소 밖 임시 디렉터리에서 띄운다 — 저장소 안이면 워크스페이스 node_modules(devDependency 포함)가 모든 것을 해석해
// 빠진 prod 의존성이 가려진다(번들이 런타임에 찾는 ws 가 devDependency 였던 결함을 그렇게 놓쳤다).
// 단계 1: 정상 env 로 /healthz 200 · GET /socket.io/socket.io.js 400(serveClient: false) 뒤에도 살아 있음 · SIGTERM 이면 exit 0 과
//   DATA_DIR/run-state.json clean:true(종료 표지 — 처리기가 번들 main 에 걸렸는지)
// 단계 2: DODOK_MIGRATIONS_DIR 없이 띄우면 설정 오류로 죽는다 — 번들이 자기를 번들로 알아보는지(define·isBundled)를 이것으로 본다
// 단계 3: dist/backup.js — 단계 1 서버가 떠 있는 동안 그 DATA_DIR 을 백업하면 exit 0·한 줄·사본, DB 없는 디렉터리면 exit 1·사유 한 줄.
//   better-sqlite3 가 external 이라 번들 혼자로는 모른다 — 프로드 설치 위에서 실제로 적재되는지를 본다
// 네트워크 밖으로 나가지 않는다(deploy 는 --offline 으로 로컬 스토어만 쓴다)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
// 태스크 3 Dockerfile 이 같은 명령을 쓴다 — 바꾸면 거기도 함께
const deployArgs = ["--filter", "@dodok/server", "deploy", "--prod", "--legacy", "--offline"];

// 중단(Ctrl-C·SIGTERM·터미널 닫힘 SIGHUP)에도 자식을 멈추고 work(deploy 산출물 약 260 MB)를 지운다. 처리기가 없으면 신호 기본 동작으로
// 즉사해 finally 가 돌지 않는다. 자식을 먼저 멈추는 것은 pnpm 이 쓰고 있는 디렉터리를 지우다 경합하지 않게
const children = new Set();
let interrupted = false;
function track(child) {
  if (interrupted) {
    child.kill("SIGKILL");
    throw new Error("중단됨");
  }
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
async function abort(signal) {
  interrupted = true;
  await Promise.all(
    [...children].map(
      (c) =>
        new Promise((r) => {
          c.once("exit", r);
          c.kill("SIGTERM");
          setTimeout(() => c.kill("SIGKILL"), 5_000).unref();
        }),
    ),
  );
  rmSync(work, { recursive: true, force: true });
  console.log(`bundle smoke: ${signal} 로 중단 — 임시 디렉터리를 지웠다`);
  process.exit(signal === "SIGINT" ? 130 : signal === "SIGHUP" ? 129 : 143);
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => {
    if (!interrupted) void abort(signal);
  });

function runChild(cmd, args, opts) {
  const child = track(spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] }));
  let output = "";
  child.stdout.on("data", (b) => (output += b));
  child.stderr.on("data", (b) => (output += b));
  return new Promise((r) => child.once("close", (code, signal) => r({ code, signal, output })));
}

// deploy 는 실행한 워크스페이스의 node_modules/.pnpm-workspace-state-v1.json 을 dev:false 로 덮어쓴다 — 원본이면 다음
// `pnpm run` 이 의존성 확인에서 `pnpm install --production` 을 시도하고, CI=true 셸에서는 확인 없이 devDependency 를 전부 지운다.
// 저장·되돌림은 신호가 쓰기와 되돌림 사이에 떨어지면 못 되돌리므로, 매니페스트만 복사한 사본에서 deploy 해 원본을 아예 안 만진다.
// 사본에 필요한 것: 루트 package.json(packageManager 핀)·pnpm-workspace.yaml(allowBuilds)·pnpm-lock.yaml·.npmrc 와 워크스페이스
// 패키지마다 package.json — 번들이 @dodok/* 를 품으므로 deploy 가 옮기는 @dodok/* 는 package.json 뿐인 껍데기여도 된다
function copyManifests(dest) {
  for (const f of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", ".npmrc"])
    if (existsSync(join(repoRoot, f))) cpSync(join(repoRoot, f), join(dest, f));
  // pnpm-workspace.yaml 의 packages 글롭(apps/*·packages/*)과 맞춘다
  for (const group of ["apps", "packages"])
    for (const name of readdirSync(join(repoRoot, group))) {
      const manifest = join(repoRoot, group, name, "package.json");
      if (!existsSync(manifest)) continue;
      mkdirSync(join(dest, group, name), { recursive: true });
      cpSync(manifest, join(dest, group, name, "package.json"));
    }
}

async function prepareApp() {
  if (!existsSync(join(serverDir, "dist/main.js")))
    throw new Error("dist/main.js 가 없다 — 먼저 pnpm -F @dodok/server build");
  const src = join(work, "src");
  copyManifests(src);
  // pnpm 11 은 inject-workspace-packages 가 없는 워크스페이스에서 --legacy 없이는 deploy 를 거부한다(ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE)
  const r = await runChild("pnpm", [...deployArgs, join(work, "deploy")], { cwd: src });
  if (r.code !== 0) {
    process.stderr.write(r.output);
    throw new Error(`pnpm deploy 가 exit ${r.code ?? r.signal}`);
  }
  // 이미지 배치(/app/node_modules·/app/dist·/app/drizzle)와 같게 — deploy 가 복사한 나머지는 쓰지 않는다
  mkdirSync(appDir);
  const pruned = await runChild(
    process.execPath,
    [
      "scripts/prune-runtime-deps.mjs",
      join(work, "deploy"),
      join(appDir, "node_modules"),
      "dist/runtime-deps.json",
    ],
    { cwd: serverDir },
  );
  if (pruned.code !== 0) {
    process.stderr.write(pruned.output);
    throw new Error(`prune-runtime-deps 가 exit ${pruned.code ?? pruned.signal}`);
  }
  cpSync(join(work, "deploy/package.json"), join(appDir, "package.json"));
  rmSync(join(work, "deploy"), { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
  cpSync(join(serverDir, "dist"), join(appDir, "dist"), { recursive: true });
  cpSync(join(serverDir, "drizzle"), join(appDir, "drizzle"), { recursive: true });
  // 조상 디렉터리에 node_modules 가 있으면 Node 가 거기까지 올라가 해석하므로 격리가 깨진다
  for (let d = dirname(appDir); ; d = dirname(d)) {
    if (existsSync(join(d, "node_modules"))) throw new Error(`격리 불가: ${d}/node_modules 가 있다`);
    if (dirname(d) === d) break;
  }
}

function startBundle(port, extraEnv) {
  mkdirSync(dataDir, { recursive: true });
  const secret = () => randomBytes(24).toString("hex");
  const child = track(
    spawn(process.execPath, ["dist/main.js"], {
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
    }),
  );
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
    await backupLive();
  }
  await stop(run);
  if (ok) {
    if (run.code !== 0) failures.push(`단계 1: SIGTERM 뒤 exit ${run.code}(0 이어야 한다)`);
    const marker = join(dataDir, "run-state.json");
    const clean = existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")).clean : "파일 없음";
    if (clean !== true) failures.push(`단계 1: SIGTERM 뒤 run-state.json clean 이 true 가 아니라 ${clean}`);
  }
}

// 단계 3 앞 절반 — 운영에서처럼 서버가 쓰고 있는 DB 를 다른 프로세스가 백업한다
async function backupLive() {
  const r = await runChild(process.execPath, ["dist/backup.js"], {
    cwd: appDir,
    env: { PATH: process.env.PATH, DATA_DIR: dataDir },
  });
  const copies = existsSync(join(dataDir, "backups"))
    ? readdirSync(join(dataDir, "backups")).map((d) => join(dataDir, "backups", d, "dodok.sqlite"))
    : [];
  if (r.code !== 0)
    failures.push(`단계 3: 떠 있는 서버의 DB 백업이 exit ${r.code ?? r.signal} — ${r.output.trim()}`);
  else if (!/^백업 완료: \S+ \(\d+ bytes, \d+ ms, 지움 0\)\n$/.test(r.output))
    failures.push(`단계 3: 백업 출력이 한 줄 형식이 아니다 — ${JSON.stringify(r.output)}`);
  else if (copies.length !== 1 || !existsSync(copies[0]) || statSync(copies[0]).size === 0)
    failures.push(`단계 3: backups/ 에 사본이 하나 있어야 하는데 ${copies.length}개`);
}

async function stage3() {
  const empty = join(work, "empty-data");
  mkdirSync(empty);
  const r = await runChild(process.execPath, ["dist/backup.js"], {
    cwd: appDir,
    env: { PATH: process.env.PATH, DATA_DIR: empty },
  });
  if (r.code !== 1) failures.push(`단계 3: DB 없는 디렉터리에서 exit ${r.code ?? r.signal}(1 이어야 한다)`);
  if (r.output !== `백업 실패: 백업할 DB 가 없다: ${join(empty, "dodok.sqlite")}\n`)
    failures.push(`단계 3: DB 없음의 출력이 사유 한 줄이 아니다 — ${JSON.stringify(r.output)}`);
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
  await prepareApp();
  await stage1();
  rmSync(dataDir, { recursive: true, force: true });
  await stage2();
  await stage3();
} catch (e) {
  failures.push(e instanceof Error ? e.message : String(e));
} finally {
  rmSync(work, { recursive: true, force: true });
}
// 중단됐으면 판정과 종료 코드는 abort 가 낸다 — 자식이 죽어 생긴 실패를 결과로 보고하지 않게
if (!interrupted) {
  console.log(
    failures.length === 0
      ? "bundle smoke: 1) /healthz 200 · /socket.io/socket.io.js 400 · SIGTERM exit 0·clean 표지  2) DODOK_MIGRATIONS_DIR 없으면 설정 오류로 종료  3) backup.js 떠 있는 DB exit 0 · DB 없음 exit 1"
      : `bundle smoke: FAILED — ${failures.join(", ")}`,
  );
  process.exit(failures.length === 0 ? 0 : 1);
}
