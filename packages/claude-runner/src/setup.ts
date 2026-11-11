import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { RunnerPermissionMode } from "@dodok/shared";
import { loadRunnerConfig, MAX_ROOTS, RunnerConfig } from "./config";
import { resolveClaudeConfigDir } from "./drivers/claude/config-dir";
import {
  isExecutableFile,
  readClaudeVersion,
  resolveClaudeExecutable,
  type IsExecutable,
  type ReadVersion,
} from "./drivers/claude/executable";

// 첫 실행 마법사 — 설정 파일이 없을 때(또는 `dodok-runner setup`) 터미널에서 서버 주소·토큰·루트·권한 상한을 묻고 설정을 쓴다.
// 묻지 않는 키는 스키마 기본값을 그대로 적는다 — 나중에 손으로 고칠 자리가 파일에 보이게. 토큰은 설정 본문이 아니라 tokenFile 에만 둔다

/** Ctrl-C·EOF — 마법사는 아무것도 쓰지 않고 끝낸다 */
export class SetupAborted extends Error {}

export type Prompter = {
  /** 한 줄을 받는다 — hidden 이면 친 글자를 화면에 찍지 않는다. Ctrl-C·EOF 면 SetupAborted 로 던진다 */
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  print(line: string): void;
  close(): void;
};

/**
 * readline 으로 만든 터미널 질문기. 줄을 큐로 받는다 — readline 의 question() 은 질문이 없을 때 온 줄을 버려서, 빠르게 붙여 넣은
 * 여러 줄이 사라진다. 숨김 입력은 readline 이 쓰는 출력만 막는다(질문은 막기 전에 찍는다)
 */
export function createTerminalPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream & { isTTY?: boolean },
): Prompter {
  let muted = false;
  const sink = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) output.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input, output: sink, terminal: output.isTTY === true, historySize: 0 });
  const lines: string[] = [];
  let closed = false;
  let waiter: { resolve(line: string): void; reject(e: Error): void } | undefined;
  rl.on("line", (line) => {
    if (waiter) {
      const w = waiter;
      waiter = undefined;
      w.resolve(line);
    } else lines.push(line);
  });
  const end = () => {
    closed = true;
    const w = waiter;
    waiter = undefined;
    w?.reject(new SetupAborted());
  };
  rl.on("close", end);
  // SIGINT 리스너가 없으면 readline 은 입력을 멈추기만 한다 — 질문이 영영 끝나지 않는다
  rl.on("SIGINT", () => rl.close());
  return {
    ask(question, opts) {
      const queued = lines.shift();
      if (queued !== undefined) {
        output.write(`${question}\n`);
        return Promise.resolve(queued);
      }
      if (closed) return Promise.reject(new SetupAborted());
      rl.setPrompt(question);
      rl.prompt();
      if (opts?.hidden) muted = true;
      return new Promise<string>((res, rej) => {
        waiter = { resolve: res, reject: rej };
      }).finally(() => {
        if (opts?.hidden) {
          muted = false;
          output.write("\n");
        }
      });
    },
    print: (line) => output.write(`${line}\n`),
    close: () => {
      rl.close();
    },
  };
}

export type ClaudeStatus = { cli: string; loggedIn: boolean };

/** 마법사가 보여 줄 Claude Code — 러너가 연결 때 고르는 규칙(executable.ts·config-dir.ts)을 그대로 쓴다. 로그인은 디렉터리 유무만 본다 */
export async function detectClaudeForSetup(opts: {
  env: NodeJS.ProcessEnv;
  bundledVersion: string;
  isExecutable?: IsExecutable;
  readVersion?: ReadVersion;
  exists?: (path: string) => boolean;
}): Promise<ClaudeStatus> {
  const chosen = resolveClaudeExecutable({}, opts.env, opts.isExecutable ?? isExecutableFile);
  let cli: string;
  if (chosen.cli === "installed") {
    const version = await (opts.readVersion ?? readClaudeVersion)(chosen.path, opts.env);
    cli = `설치본 ${version ?? "(판 모름)"} (${chosen.path})`;
  } else {
    cli = `내장 ${opts.bundledVersion}`;
  }
  const { dir } = resolveClaudeConfigDir({}, opts.env);
  const home = opts.env.HOME || homedir();
  const loggedIn = (opts.exists ?? existsSync)(dir ?? join(home, ".claude"));
  return { cli, loggedIn };
}

export type SetupOptions = {
  prompter: Prompter;
  configPath: string;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  claude: () => Promise<ClaudeStatus>;
  /** setup 하위 명령 — 설정이 이미 있으면 덮기 전에 묻는다 */
  confirmOverwrite?: boolean;
};

export type SetupResult =
  | { status: "saved"; loaded: ReturnType<typeof loadRunnerConfig> }
  | { status: "kept" | "declined" | "aborted" };

const PERMISSION_CHOICES: { mode: RunnerPermissionMode; label: string }[] = [
  { mode: "default", label: "default — 편집·명령마다 승인" },
  { mode: "acceptEdits", label: "acceptEdits — 편집은 바로, 명령은 승인" },
  { mode: "plan", label: "plan — 읽기·계획만" },
];

/** 라벨에서 루트 id — RunnerRootId([a-z0-9-]{1,32}) 꼴로 줄이고 겹치면 -2, -3… 을 붙인다 */
export function rootIdFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32)
      .replace(/-+$/, "") || "root";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const id = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

function expandPath(p: string, home: string, cwd: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return resolve(home, p.slice(2));
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

const isYes = (answer: string, fallback: boolean): boolean => {
  const a = answer.trim().toLowerCase();
  if (a === "") return fallback;
  return a === "y" || a === "yes" || a === "예" || a === "ㅇ";
};

/**
 * 시작할 길 — 마법사는 설정 파일이 없을 때(또는 setup)와 터미널일 때만. 설정이 있는데 깨졌으면 덮지 않고 로더가 오류로 끝낸다
 */
export function chooseStart(opts: {
  setup: boolean;
  configExists: boolean;
  interactive: boolean;
}): { kind: "wizard" } | { kind: "load" } | { kind: "error"; message: string } {
  if (!opts.setup && opts.configExists) return { kind: "load" };
  if (opts.interactive) return { kind: "wizard" };
  return {
    kind: "error",
    message: opts.setup
      ? "setup 은 터미널에서 실행하세요"
      : "설정 파일이 없습니다 — --config 경로를 확인하세요\n터미널에서 dodok-runner 를 실행하면 설정을 만듭니다",
  };
}

/** 토큰 파일 자리 — 설정 파일 위치(--config)와 무관하게 늘 여기다 */
export const TOKEN_FILE = "~/.dodok-runner/token";

export async function runSetupWizard(opts: SetupOptions): Promise<SetupResult> {
  const { prompter: p, configPath, home, cwd } = opts;
  try {
    if (opts.confirmOverwrite && existsSync(configPath)) {
      const answer = await p.ask("설정 파일이 이미 있습니다. 덮어쓸까요? (y/N) ");
      if (!isYes(answer, false)) {
        p.print("설정을 그대로 둡니다.");
        return { status: "kept" };
      }
    }
    p.print("dodok-runner 설정을 만듭니다. (Ctrl-C 로 그만두기)");

    // 1. 서버 주소 — 설정 스키마와 같은 규칙으로 본다
    let serverUrl: string;
    for (;;) {
      const answer = (await p.ask("서버 주소: ")).trim();
      if (RunnerConfig.shape.serverUrl.safeParse(answer).success) {
        serverUrl = answer;
        break;
      }
      p.print("http:// 또는 https:// 로 시작하는 주소를 넣으세요.");
    }

    // 2. 러너 토큰 — 화면에 찍지 않는다
    let token: string;
    for (;;) {
      token = (await p.ask("러너 토큰: ", { hidden: true })).trim();
      if (token) break;
      p.print("토큰을 넣으세요.");
    }

    // 3. 루트
    const roots: { id: string; path: string; label: string }[] = [];
    const taken = new Set<string>();
    for (;;) {
      let path: string;
      for (;;) {
        const answer = (await p.ask(`루트 경로 [${cwd}]: `)).trim();
        path = expandPath(answer || cwd, home, cwd);
        if (isDirectory(path)) break;
        p.print("있는 디렉터리를 넣으세요.");
      }
      const fallbackLabel = (basename(path) || "root").slice(0, 64);
      const label = ((await p.ask(`라벨 [${fallbackLabel}]: `)).trim() || fallbackLabel).slice(0, 64);
      const id = rootIdFromLabel(label, taken);
      taken.add(id);
      roots.push({ id, path, label });
      if (roots.length >= MAX_ROOTS) break;
      if (!isYes(await p.ask("루트를 더 추가할까요? (y/N) "), false)) break;
    }

    // 4. Claude Code — 보여 주기만 한다
    const claude = await opts.claude();
    p.print(`Claude Code: ${claude.cli}`);
    p.print(
      claude.loggedIn ? "로그인: 평소 claude 로그인을 씁니다" : "로그인: 없음 — claude 를 열어 /login 하세요",
    );

    // 5. 권한 상한
    let maxPermissionMode: RunnerPermissionMode;
    p.print("권한 상한:");
    PERMISSION_CHOICES.forEach((c, i) => p.print(`  ${i + 1}) ${c.label}`));
    for (;;) {
      const answer = (await p.ask("선택 [1]: ")).trim();
      const byNumber = PERMISSION_CHOICES[Number(answer || "1") - 1];
      const byName = PERMISSION_CHOICES.find((c) => c.mode === answer);
      const chosen = byName ?? (/^\d+$/.test(answer || "1") ? byNumber : undefined);
      if (chosen) {
        maxPermissionMode = chosen.mode;
        break;
      }
      p.print(`1~${PERMISSION_CHOICES.length} 중에서 고르세요.`);
    }

    const config = {
      serverUrl,
      tokenFile: TOKEN_FILE,
      maxConcurrentRuns: 3,
      roots,
      browse: true,
      programs: {
        claude: { maxPermissionMode, disallowedTools: [], allowedToolsCeiling: null },
      },
    } satisfies RunnerConfig;
    // 로더와 같은 스키마 — 여기서 어긋나면 마법사의 버그다
    RunnerConfig.parse(config);
    const text = `${JSON.stringify(config, null, 2)}\n`;

    p.print("");
    p.print(`${configPath}:`);
    p.print(text.trimEnd());
    if (!isYes(await p.ask("저장하고 시작할까요? (Y/n) "), true)) {
      p.print("저장하지 않았습니다.");
      return { status: "declined" };
    }

    const tokenPath = expandPath(TOKEN_FILE, home, cwd);
    mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(tokenPath), 0o700);
    writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
    if (existsSync(configPath)) renameSync(configPath, `${configPath}.bak`);
    writeFileSync(configPath, text, { mode: 0o600 });
    chmodSync(configPath, 0o600);
    p.print(`저장했습니다: ${configPath}`);

    // 러너가 실제로 읽는 길로 다시 읽는다 — 마법사와 로더가 어긋나면 여기서 드러난다
    return { status: "saved", loaded: loadRunnerConfig(configPath, opts.env) };
  } catch (error) {
    if (error instanceof SetupAborted) {
      p.print("");
      p.print("설정을 만들지 않고 끝냅니다.");
      return { status: "aborted" };
    }
    throw error;
  } finally {
    p.close();
  }
}
