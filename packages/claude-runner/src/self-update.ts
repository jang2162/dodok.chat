import { execFile, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import {
  compareVersions,
  REMOTE_UPDATE_VERSION_PATTERN,
  RUNNER_NPM_INSTALL_TIMEOUT_MS,
  type RunnerUpdateResult,
} from "@dodok/shared";

// 원격 업데이트(원격 업데이트 스펙 U3) — 서버의 runner.update 에 따라 npm 레지스트리의 그 판을 이 러너가 설치된 npm 전역 자리에 깔고,
// 같은 인자·같은 env 로 스스로 다시 띄운 뒤 끝난다. 판은 정확한 semver 만(범위·태그·경로·URL 은 npm 이 레지스트리 밖에서 받는다),
// 레지스트리는 그 머신의 npm 설정 그대로. 서버로 가는 message 에는 호스트 경로를 싣지 않는다

export const RUNNER_PACKAGE = "@dodok/runner";
export const DISABLED_MESSAGE = "이 머신의 러너 설정에서 원격 업데이트를 껐습니다(remoteUpdate: false)";
export const BUSY_MESSAGE = "런이 끝난 뒤 다시 시도하세요";
export const UNSUPPORTED_MESSAGE = "이 설치 방식은 원격 업데이트를 지원하지 않습니다";
export const INVALID_VERSION_MESSAGE = "정확한 판(예: 0.9.0)만 받습니다";

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
  spawn?: Spawner;
  realpath?: (p: string) => string;
  npmPath?: string;
  /** 설치가 끝나고 다시 띄우기 직전 — 서버에 ok 를 답하고 연결을 닫는다 */
  beforeRestart?: () => Promise<void>;
  exit?: (code: number) => void;
};

/**
 * 원격 업데이트 한 번. 실패면 사유와 함께 돌려주고 아무것도 다시 띄우지 않는다. 성공이면 beforeRestart → 같은 argv 로 분리된 자식 →
 * exit(0) 를 차례로 부르고 ok 를 돌려준다
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

  // 이 러너가 npm 전역 자리(<npm root -g>/@dodok/runner) 안에서 도는가 — 아니면 소스·tgz 압축 풀기 등 다른 설치 방식이다
  let root: string;
  try {
    root = (await run(npm, ["root", "-g"], { env, timeoutMs: 30_000 })).stdout.trim();
  } catch {
    return { ok: false, reason: "unsupported", message: `${UNSUPPORTED_MESSAGE} — npm 을 찾지 못했습니다` };
  }
  const entry = opts.argv[1];
  let global = false;
  try {
    const packageDir = join(realpath(root), ...RUNNER_PACKAGE.split("/"));
    global = entry !== undefined && realpath(entry).startsWith(packageDir + sep);
  } catch {
    global = false;
  }
  if (!global) return { ok: false, reason: "unsupported", message: UNSUPPORTED_MESSAGE };

  try {
    await run(npm, ["install", "--global", `${RUNNER_PACKAGE}@${opts.version}`], {
      env,
      timeoutMs: RUNNER_NPM_INSTALL_TIMEOUT_MS,
    });
  } catch (error) {
    const code = error instanceof RunFailure ? npmErrorCode(error.output) : null;
    return {
      ok: false,
      reason: "failed",
      message: `npm 설치에 실패했습니다${code ? `(${code})` : ""} — 그 머신에서 npm i -g ${RUNNER_PACKAGE}@${opts.version} 을 돌려 보세요`,
    };
  }

  await opts.beforeRestart?.();
  (opts.spawn ?? nodeSpawner)(opts.execPath, [...(opts.execArgv ?? []), ...opts.argv.slice(1)], {
    env: opts.env,
  });
  (opts.exit ?? ((code: number) => process.exit(code)))(0);
  return { ok: true };
}
