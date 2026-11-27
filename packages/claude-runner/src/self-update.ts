import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  compareVersions,
  REMOTE_UPDATE_VERSION_PATTERN,
  RUNNER_NPM_INSTALL_TIMEOUT_MS,
  type RunnerUpdateResult,
} from "@dodok/shared";
import { serviceRestartCommand } from "./service";

// 원격 업데이트(원격 업데이트 스펙 U3) — 서버의 runner.update 에 따라 npm 레지스트리의 그 판을 이 러너가 설치된 npm 전역 자리에 깔고,
// 같은 인자·같은 env 로 스스로 다시 띄운 뒤 끝난다. 판은 정확한 semver 만(범위·태그·경로·URL 은 npm 이 레지스트리 밖에서 받는다),
// 레지스트리는 그 머신의 npm 설정 그대로. 서버로 가는 message 에는 호스트 경로를 싣지 않는다

export const RUNNER_PACKAGE = "@dodok/runner";
export const DISABLED_MESSAGE = "이 머신의 러너 설정에서 원격 업데이트를 껐습니다(remoteUpdate: false)";
export const BUSY_MESSAGE = "런이 끝난 뒤 다시 시도하세요";
export const UNSUPPORTED_MESSAGE = "이 설치 방식은 원격 업데이트를 지원하지 않습니다";
export const INVALID_VERSION_MESSAGE = "정확한 판(예: 0.9.0)만 받습니다";
/** 새 판 검사(설정만 읽고 끝나는 모드)의 상한 */
export const CHECK_TIMEOUT_MS = 20_000;
/** 새 판 검사의 인자 — main.ts 가 이 플래그면 설정만 읽고 0/1 로 끝난다 */
export const CHECK_CONFIG_FLAG = "--check-config";

export type Runner = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<{ stdout: string }>;
export type Spawner = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => void;

/** 실패한 실행 — 종료 코드와 출력(npm 의 `code E404` 줄을 찾는 데만 쓴다) */
export class RunFailure extends Error {
  constructor(
    readonly exitCode: number | null,
    readonly output: string,
  ) {
    super(`exit ${exitCode ?? "?"}`);
  }
}

export const nodeRunner: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          reject(new RunFailure(code, `${String(stdout)}\n${String(stderr)}`));
          return;
        }
        resolve({ stdout: String(stdout) });
      },
    );
  });

/**
 * 분리된 자식 — 부모가 끝나도 남는다. 출력은 지금 터미널로 잇는다(그 터미널이 닫혀 있으면 자식 출력은 버려진다). 다시 띄운 러너는
 * 같은 토큰으로 붙고, 서버는 같은 토큰의 새 hello 로 이 연결을 대신한다
 */
export const nodeSpawner: Spawner = (file, args, opts) => {
  const child = spawn(file, args, { env: opts.env, detached: true, stdio: "inherit" });
  child.unref();
};

/** 서비스 관리자의 다시 시작 명령 — 0 으로 끝나면 풀리고, 띄우지 못했거나 0 이 아니게 끝나면 거절한다 */
export type ServiceRestarter = (
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv },
) => Promise<void>;

/** 다시 시작 명령 뒤 이 러너가 끝나기를 기다리는 상한 — 넘으면 지금 판으로 다시 붙는다 */
export const SERVICE_RESTART_TIMEOUT_MS = 60_000;

/** 분리된 자식으로 띄운다 — 관리자가 이 프로세스를 끝내도 명령은 남는다 */
export const nodeServiceRestarter: ServiceRestarter = (file, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: opts.env, detached: true, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new RunFailure(code, signal ? `signal ${signal}` : ""));
    });
    child.unref();
  });

/** npm 에 넘기지 않는 env — 러너 토큰과 모델 자격 증명(npm 의 설치 스크립트가 읽을 까닭이 없다) */
export function npmEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== "DODOK_RUNNER_TOKEN" && !key.startsWith("ANTHROPIC_") && !key.startsWith("CLAUDE_"),
    ),
  );
}

/** 이 node 옆의 npm — 서비스 관리자가 좁은 PATH 로 띄웠어도 같은 설치의 npm 을 쓴다. 없으면 PATH 의 npm */
export function npmBesideNode(execPath: string, exists: (p: string) => boolean = existsSync): string {
  const beside = join(dirname(execPath), "npm");
  return exists(beside) ? beside : "npm";
}

/** npm 오류 출력의 `code E404` 같은 코드 — 경로가 든 나머지 줄은 서버로 보내지 않는다 */
function npmErrorCode(output: string): string | null {
  return /npm (?:ERR!|error) code (E[A-Z0-9_]+)/.exec(output)?.[1] ?? null;
}

/** 서버로 보내는 출력 조각 — 절대 경로·홈 경로는 가리고 앞 200자만 */
export function maskedSnippet(output: string): string {
  return output
    .replace(/(?:~|\/)[^\s'"`()<>,;:]*/g, (m) => (m === "/" ? m : "<경로>"))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/** `<prefix>/lib/node_modules/@dodok/runner/package.json` 의 판 — 읽지 못하면 null */
export function readInstalledVersion(prefix: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "lib", "node_modules", ...RUNNER_PACKAGE.split("/"), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** npm 전역 설치의 꼴 — `<prefix>/lib/node_modules/@dodok/runner/dist/main.js`(macOS·Linux) */
const GLOBAL_ENTRY = /^(.+)\/lib\/node_modules\/@dodok\/runner\/dist\/main\.js$/;

/** 러너 진입 파일(링크를 푼 자리)이 npm 전역 설치 안이면 그 prefix, 아니면 null */
export function globalPrefixOf(entry: string | undefined, realpath: (p: string) => string): string | null {
  if (entry === undefined) return null;
  try {
    return GLOBAL_ENTRY.exec(realpath(entry))?.[1] ?? null;
  } catch {
    return null;
  }
}

export type SelfUpdateOptions = {
  version: string;
  /** 지금 이 러너의 판(빌드가 채운 값 — 소스 실행이면 dev) */
  currentVersion: string;
  /** 도는·기다리는 런이 있는가 */
  busy: () => boolean;
  /** 로컬 설정 remoteUpdate */
  enabled: boolean;
  /** process.argv — [node, 러너 진입 파일, ...인자] */
  argv: string[];
  /** process.execPath */
  execPath: string;
  /** process.execArgv — node 플래그(있으면 다시 띄울 때도 같게) */
  execArgv?: string[];
  env: NodeJS.ProcessEnv;
  npm?: Runner;
  /** 새 판 검사 실행 — 시험이 바꾼다(기본 nodeRunner) */
  check?: Runner;
  spawn?: Spawner;
  realpath?: (p: string) => string;
  npmPath?: string;
  /** prefix 에 깔린 러너 판(없으면 null) — 시험이 바꾼다 */
  installedVersion?: (prefix: string) => string | null;
  /** 설치가 끝나고 다시 띄우기 직전 — 서버에 ok 를 답하고 연결을 닫는다 */
  beforeRestart?: () => Promise<void>;
  exit?: (code: number) => void;
  /** 서비스 모드의 launchd 도메인(gui/<uid>) — 시험이 바꾼다(기본 process.getuid()) */
  uid?: number;
  /** 서비스 모드의 다시 시작 명령 실행 — 시험이 바꾼다(기본 nodeServiceRestarter) */
  serviceRestart?: ServiceRestarter;
};

/**
 * 원격 업데이트 한 번. 실패면 사유와 함께 돌려주고 아무것도 다시 띄우지 않는다. 설치 뒤 새 진입 파일을 지금 설정으로
 * `--check-config` 로 돌려 보고(설정 거절·Node 하한 등으로 새 판이 못 뜨면 러너가 내려간 채로 남는다 — 리뷰 M1), 0 이 아니면 옛 판으로
 * 되돌려 깔고 failed. 통과면 beforeRestart → 같은 argv 로 분리된 자식 → exit(0) 를 차례로 부르고 ok 를 돌려준다. env
 * DODOK_RUNNER_SERVICE(launchd·systemd)면 분리된 자식 대신 서비스 관리자의 다시 시작 명령을 분리해 띄우고 끝내지 않는다(관리자가
 * SIGTERM 으로 끝낸다). 그 명령이 곧바로 실패하거나 SERVICE_RESTART_TIMEOUT_MS 안에 끝나지 않으면 던진다. spawn 이 던지면 그대로
 * 던진다 — 둘 다 부르는 쪽(connection)이 연결을 되살린다
 */
export async function selfUpdate(opts: SelfUpdateOptions): Promise<RunnerUpdateResult> {
  if (!opts.enabled) return { ok: false, reason: "disabled", message: DISABLED_MESSAGE };
  if (!REMOTE_UPDATE_VERSION_PATTERN.test(opts.version) || opts.version.length > 64)
    return { ok: false, reason: "invalid_version", message: INVALID_VERSION_MESSAGE };
  // 소스 실행(dev)은 npm 판이 아니다
  if (!REMOTE_UPDATE_VERSION_PATTERN.test(opts.currentVersion))
    return { ok: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };
  if (!(compareVersions(opts.version, opts.currentVersion) > 0))
    return {
      ok: false,
      reason: "invalid_version",
      message: `지금 판(${opts.currentVersion})보다 높은 판만 설치합니다`,
    };
  if (opts.busy()) return { ok: false, reason: "busy", message: BUSY_MESSAGE };

  const run = opts.npm ?? nodeRunner;
  const realpath = opts.realpath ?? ((p: string) => realpathSync.native(p));
  const npm = opts.npmPath ?? npmBesideNode(opts.execPath);
  const env = npmEnv(opts.env);

  // 이 러너가 npm 전역 자리(<prefix>/lib/node_modules/@dodok/runner) 안에서 도는가 — 아니면 소스·tgz 압축 풀기 등 다른 설치 방식이다.
  // `npm root -g` 의 출력은 읽지 않는다 — npm 이 UUID 꼴 글자를 `***` 로 가려 그런 글자가 든 경로가 깨진다(손 확인에서 겪었다). 진입 파일의
  // 실제 자리에서 prefix 를 구해 그 prefix 에 설치한다(같은 자리를 덮는다)
  const prefix = globalPrefixOf(opts.argv[1], realpath);
  if (prefix === null) return { ok: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };

  try {
    await run(npm, ["install", "--global", "--prefix", prefix, `${RUNNER_PACKAGE}@${opts.version}`], {
      env,
      timeoutMs: RUNNER_NPM_INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    // npm 을 감싼 실행 파일(mise·asdf 등)은 설치 뒤 단계(reshim)가 실패해도 0 이 아니게 끝난다 — 그 자리에 목표 판이 깔렸으면 성공이다
    // (손 확인에서 겪었다: 설치는 끝났는데 `mise: command not found` 로 127)
    const installed = (opts.installedVersion ?? readInstalledVersion)(prefix);
    if (installed !== opts.version) {
      const code = error instanceof RunFailure ? npmErrorCode(error.output) : null;
      return {
        ok: false,
        reason: "failed",
        message: `npm 설치에 실패했습니다${code ? `(${code})` : ""} — 그 머신에서 npm i -g ${RUNNER_PACKAGE}@${opts.version} 을 돌려 보세요`,
      };
    }
  }

  // 새 판 검사 — 진입 파일 자리(argv[1])는 npm 이 같은 자리를 덮었으므로 이제 새 판이다. 같은 인자(--config 등)·같은 env 로
  const entryArgs = [...(opts.execArgv ?? []), ...opts.argv.slice(1)];
  try {
    await (opts.check ?? nodeRunner)(opts.execPath, [...entryArgs, CHECK_CONFIG_FLAG], {
      env: opts.env,
      timeoutMs: CHECK_TIMEOUT_MS,
    });
  } catch (error) {
    const output = error instanceof RunFailure ? error.output : error instanceof Error ? error.message : "";
    let reverted = true;
    try {
      await run(
        npm,
        ["install", "--global", "--prefix", prefix, `${RUNNER_PACKAGE}@${opts.currentVersion}`],
        {
          env,
          timeoutMs: RUNNER_NPM_INSTALL_TIMEOUT_MS,
        },
      );
    } catch {
      reverted = (opts.installedVersion ?? readInstalledVersion)(prefix) === opts.currentVersion;
    }
    const snippet = maskedSnippet(output);
    const message =
      `새 판(${opts.version}) 검사에 실패했습니다${snippet ? ` — ${snippet}` : ""}` +
      (reverted
        ? ` · ${opts.currentVersion} 로 되돌렸습니다`
        : ` · ${opts.currentVersion} 로 되돌리지 못했습니다 — 그 머신에서 npm i -g ${RUNNER_PACKAGE}@${opts.currentVersion} 을 돌려 보세요`);
    // ack 의 message 상한(400자)
    return { ok: false, reason: "failed", message: message.slice(0, 400) };
  }

  await opts.beforeRestart?.();
  // 서비스로 떴으면(dodok-runner service install 이 env 에 싣는다) 다시 시작을 서비스 관리자에게 맡긴다 — 분리된 자식으로 띄우면 새 판이
  // 서비스 밖에서 돈다. 관리자가 이 프로세스에 SIGTERM 을 보내 끝내고 같은 서비스로 새 판을 띄우므로 여기서 끝내지 않는다(exit 0 이면
  // 관리자가 다시 띄우지 않는다)
  const restart = serviceRestartCommand(opts.env.DODOK_RUNNER_SERVICE, opts.uid ?? process.getuid?.());
  if (restart) await restartByService(opts, restart, `${restart.file} ${restart.args.join(" ")}`);
  (opts.spawn ?? nodeSpawner)(opts.execPath, entryArgs, { env: opts.env });
  (opts.exit ?? ((code: number) => process.exit(code)))(0);
  return { ok: true };
}

/**
 * 서비스 관리자에게 다시 시작을 맡기고 이 프로세스가 끝나기를 기다린다 — 정상이면 기다리는 중에 관리자의 SIGTERM 으로 끝나므로 풀리지
 * 않는다. 명령이 곧바로 실패하거나 SERVICE_RESTART_TIMEOUT_MS 안에 끝나지 않으면(손으로 쓴 서비스 파일의 라벨·유닛 이름이 다름,
 * SSH 세션이라 gui 도메인이 다름 등) 던진다 — 부르는 쪽(connection)이 spawn 이 던졌을 때처럼 지금 판으로 다시 붙는다
 */
async function restartByService(
  opts: SelfUpdateOptions,
  restart: { file: string; args: string[] },
  shown: string,
): Promise<never> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), SERVICE_RESTART_TIMEOUT_MS);
  });
  const failed = (opts.serviceRestart ?? nodeServiceRestarter)(restart.file, restart.args, {
    env: opts.env,
  }).then(
    // 0 으로 끝났으면 관리자가 끝내 주기를 계속 기다린다
    () => new Promise<never>(() => {}),
    (error: unknown) => error,
  );
  const outcome = await Promise.race([timedOut, failed]);
  clearTimeout(timer);
  const why =
    outcome === "timeout"
      ? `서비스 다시 시작(${shown})이 ${SERVICE_RESTART_TIMEOUT_MS / 1000}초 안에 이 러너를 끝내지 않았습니다`
      : `서비스 다시 시작(${shown})에 실패했습니다(${outcome instanceof Error ? outcome.message : String(outcome)})`;
  throw new Error(
    `${why} — 새 판(${opts.version})은 깔렸으니 다음 다시 시작 때 새 판으로 뜹니다. ` +
      "지금 바꾸려면 그 머신에서 dodok-runner service restart 를 돌려 보세요",
  );
}
