import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { RunnerPermissionMode } from "@dodok/shared";
import { expandHome, loadRunnerConfig, MAX_ROOTS, RunnerConfig } from "./config";
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
 * 여러 줄이 사라진다. 터미널 모드의 readline 은 친 글자를 스스로 되찍으므로 출력을 막는 것으로 숨긴다 — 질문을 기다리지 않는 동안도
 * 막는다: 서버 주소 칸에 「주소 + 줄바꿈 + 토큰」을 한꺼번에 붙여 넣으면 둘째 줄은 토큰 질문이 뜨기 전에 처리되어, 막지 않으면
 * 원문이 화면에 남는다. 보이는 질문은 prompt() 가 질문과 지금까지 친 줄을 다시 그린다
 */
export function createTerminalPrompter(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream & { isTTY?: boolean },
): Prompter {
  let muted = true;
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
    // 같은 덩어리의 남은 글자를 readline 이 이어서 되찍기 전에 막는다 — 다음 질문이 숨김일 수 있다
    muted = true;
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
        // 미리 들어온 줄 — 막혀 있던 동안 되찍지 않았으니 여기서 보인다(숨김이면 질문만)
        output.write(`${question}${opts?.hidden ? "" : queued}\n`);
        return Promise.resolve(queued);
      }
      if (closed) return Promise.reject(new SetupAborted());
      if (opts?.hidden) {
        // 질문은 직접 찍고 readline 의 그리기(질문 + 미리 친 글자)는 막힌 채로 둔다
        output.write(question);
        rl.setPrompt("");
      } else {
        muted = false;
        rl.setPrompt(question);
      }
      rl.prompt();
      return new Promise<string>((res, rej) => {
        waiter = { resolve: res, reject: rej };
      }).finally(() => {
        if (opts?.hidden) output.write("\n");
      });
    },
    print: (line) => output.write(`${line}\n`),
    close: () => {
      rl.close();
    },
  };
}

export type ClaudeStatus = { cli: string; loggedIn: boolean };

/**
 * 마법사가 보여 줄 Claude Code — 러너가 연결 때 고르는 규칙(executable.ts·config-dir.ts)을 그대로 쓴다. 로그인은 디렉터리 유무만 본다.
 * ceiling 은 지금 설정의 executable·configDir(setup 으로 다시 열 때) — 없으면 평소 길
 */
export async function detectClaudeForSetup(opts: {
  env: NodeJS.ProcessEnv;
  bundledVersion: string;
  ceiling?: { executable?: string; configDir?: string };
  isExecutable?: IsExecutable;
  readVersion?: ReadVersion;
  exists?: (path: string) => boolean;
}): Promise<ClaudeStatus> {
  const ceiling = opts.ceiling ?? {};
  const chosen = resolveClaudeExecutable(ceiling, opts.env, opts.isExecutable ?? isExecutableFile);
  let cli: string;
  if (chosen.cli === "installed") {
    const version = await (opts.readVersion ?? readClaudeVersion)(chosen.path, opts.env);
    cli = `설치본 ${version ?? "(판 모름)"} (${chosen.path})`;
  } else if (chosen.cli === "bundled") {
    cli = `내장 ${opts.bundledVersion}`;
  } else {
    cli = `쓸 수 없음 — ${chosen.reason}`;
  }
  const { dir } = resolveClaudeConfigDir(ceiling, opts.env);
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
  claude: (ceiling: { executable?: string; configDir?: string }) => Promise<ClaudeStatus>;
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

/** 홈 아래면 `~/…` 로 — 설정 파일에 사람의 홈 경로 원문을 박지 않는다(옮겨도 그대로 읽히게) */
function tildify(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(home + sep) ? `~/${p.slice(home.length + 1)}` : p;
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

export type CliPlan =
  | { kind: "usage" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "wizard"; confirmOverwrite: boolean }
  | { kind: "token" }
  | { kind: "load" }
  | { kind: "error"; message: string };

const COMMANDS = new Set(["setup", "token"]);

/**
 * 시작할 길(main.ts) — 마법사는 설정 파일이 없을 때(또는 setup)와 터미널일 때만. 설정이 있는데 깨졌으면 덮지 않고 로더가 오류로 끝낸다.
 * token 은 토큰만 바꾼다(숨김 입력이라 터미널에서만)
 */
export function planCli(opts: {
  positionals: readonly string[];
  help?: boolean;
  version?: boolean;
  configExists: boolean;
  interactive: boolean;
}): CliPlan {
  const [command, ...rest] = opts.positionals;
  if (rest.length > 0 || (command !== undefined && !COMMANDS.has(command))) return { kind: "usage" };
  if (opts.help) return { kind: "help" };
  if (opts.version) return { kind: "version" };
  if (command === "token") {
    return opts.interactive
      ? { kind: "token" }
      : { kind: "error", message: "token 은 터미널에서 실행하세요" };
  }
  const setup = command === "setup";
  if (!setup && opts.configExists) return { kind: "load" };
  if (opts.interactive) return { kind: "wizard", confirmOverwrite: setup };
  return {
    kind: "error",
    message: setup
      ? "setup 은 터미널에서 실행하세요"
      : "설정 파일이 없습니다 — --config 경로를 확인하세요\n터미널에서 dodok-runner 를 실행하면 설정을 만듭니다",
  };
}

/** 토큰 파일 자리 — 설정 파일과 같은 디렉터리의 token(러너 둘이 --config 로 갈리면 토큰도 갈린다). 기본 설정이면 ~/.dodok-runner/token */
export function tokenFileFor(configPath: string, home: string): string {
  return tildify(join(dirname(configPath), "token"), home);
}

/** 지금 설정 — 스키마를 통과할 때만. 못 읽거나 깨졌으면 undefined(마법사는 처음부터 묻는다) */
function readExistingConfig(configPath: string): RunnerConfig | undefined {
  try {
    const parsed = RunnerConfig.safeParse(JSON.parse(readFileSync(configPath, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readTokenFile(path: string): string {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return "";
  }
}

/** 토큰 파일을 0600 으로 쓴다 — 디렉터리가 없으면 0700 으로 만든다 */
function writeTokenFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** 숨김 입력으로 토큰 — 비면 다시 묻는다. keep 이면 빈 입력은 그대로 둔다는 뜻이라 "" 를 돌려준다 */
async function askToken(p: Prompter, question: string, keep: boolean): Promise<string> {
  for (;;) {
    const token = (await p.ask(question, { hidden: true })).trim();
    if (token || keep) return token;
    p.print("토큰을 넣으세요.");
  }
}

export async function runSetupWizard(opts: SetupOptions): Promise<SetupResult> {
  const { prompter: p, configPath, home, cwd } = opts;
  try {
    let prev: RunnerConfig | undefined;
    if (existsSync(configPath)) {
      if (opts.confirmOverwrite) {
        const answer = await p.ask("설정 파일이 이미 있습니다. 덮어쓸까요? (y/N) ");
        if (!isYes(answer, false)) {
          p.print("설정을 그대로 둡니다.");
          return { status: "kept" };
        }
      }
      prev = readExistingConfig(configPath);
      if (!prev) p.print("지금 설정을 읽지 못해 처음부터 묻습니다.");
    }
    p.print(
      prev
        ? "dodok-runner 설정을 다시 만듭니다. [ ] 안은 지금 값 — Enter 면 그대로. (Ctrl-C 로 그만두기)"
        : "dodok-runner 설정을 만듭니다. (Ctrl-C 로 그만두기)",
    );

    // 1. 서버 주소 — 설정 스키마와 같은 규칙으로 본다
    let serverUrl: string;
    for (;;) {
      const answer =
        (await p.ask(prev ? `서버 주소 [${prev.serverUrl}]: ` : "서버 주소: ")).trim() ||
        (prev?.serverUrl ?? "");
      if (RunnerConfig.shape.serverUrl.safeParse(answer).success) {
        serverUrl = answer;
        break;
      }
      p.print("http:// 또는 https:// 로 시작하는 주소를 넣으세요.");
    }

    // 2. 러너 토큰 — 화면에 찍지 않는다. 지금 설정의 tokenFile 은 자리를 그대로 쓰고, 읽히는 토큰이 있으면 Enter 로 둔다
    const tokenFile = prev?.tokenFile ?? tokenFileFor(configPath, home);
    const tokenPath = expandHome(tokenFile, home);
    const keepToken = prev?.tokenFile !== undefined && readTokenFile(tokenPath) !== "";
    const token = await askToken(p, keepToken ? "러너 토큰 [그대로]: " : "러너 토큰: ", keepToken);

    // 3. 루트 — 지금 루트는 그대로 둘지만 묻고 id 를 바꾸지 않는다(서버의 프로젝트가 그 id 로 루트를 가리킨다). 지운 루트의 id 도
    // 새 루트에 다시 주지 않는다 — 옛 프로젝트가 엉뚱한 디렉터리를 가리키게 된다
    const roots: RunnerConfig["roots"] = [];
    const taken = new Set<string>(prev?.roots.map((r) => r.id));
    for (const r of prev?.roots ?? []) {
      const label = r.label ?? (basename(expandHome(r.path, home)) || r.id);
      if (!isDirectory(expandHome(r.path, home))) {
        p.print(`루트 ${label} (${r.path}): 디렉터리가 없어 뺍니다.`);
        continue;
      }
      if (isYes(await p.ask(`루트 ${label} (${r.path}) 를 그대로 둘까요? (Y/n) `), true)) roots.push(r);
    }
    let adding =
      roots.length === 0 ||
      (roots.length < MAX_ROOTS && isYes(await p.ask("루트를 더 추가할까요? (y/N) "), false));
    while (adding) {
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
      adding = roots.length < MAX_ROOTS && isYes(await p.ask("루트를 더 추가할까요? (y/N) "), false);
    }

    // 4. Claude Code — 보여 주기만 한다
    const prevClaude = prev?.programs.claude;
    const claude = await opts.claude({
      ...(prevClaude?.executable === undefined
        ? {}
        : { executable: expandHome(prevClaude.executable, home) }),
      ...(prevClaude?.configDir === undefined ? {} : { configDir: expandHome(prevClaude.configDir, home) }),
    });
    p.print(`Claude Code: ${claude.cli}`);
    p.print(
      claude.loggedIn
        ? `로그인: ${prevClaude?.configDir === undefined ? "평소 claude 로그인을 씁니다" : `전용 로그인(${prevClaude.configDir})`}`
        : "로그인: 없음 — claude 를 열어 /login 하세요",
    );

    // 5. 권한 상한
    const fallbackChoice =
      Math.max(
        0,
        PERMISSION_CHOICES.findIndex((c) => c.mode === prevClaude?.maxPermissionMode),
      ) + 1;
    let maxPermissionMode: RunnerPermissionMode;
    p.print("권한 상한:");
    PERMISSION_CHOICES.forEach((c, i) => p.print(`  ${i + 1}) ${c.label}`));
    for (;;) {
      const answer = (await p.ask(`선택 [${fallbackChoice}]: `)).trim() || String(fallbackChoice);
      const byNumber = /^\d+$/.test(answer) ? PERMISSION_CHOICES[Number(answer) - 1] : undefined;
      const chosen = PERMISSION_CHOICES.find((c) => c.mode === answer) ?? byNumber;
      if (chosen) {
        maxPermissionMode = chosen.mode;
        break;
      }
      p.print(`1~${PERMISSION_CHOICES.length} 중에서 고르세요.`);
    }

    // 묻지 않는 키 — 지금 설정에 있으면 그대로(maxConcurrentRuns·browse·도구 상한·configDir·executable), 없으면 스키마 기본값을 적는다
    const config = {
      serverUrl,
      tokenFile,
      maxConcurrentRuns: prev?.maxConcurrentRuns ?? 3,
      roots,
      browse: prev?.browse ?? true,
      programs: {
        ...prev?.programs,
        claude: {
          disallowedTools: [],
          allowedToolsCeiling: null,
          ...prevClaude,
          maxPermissionMode,
        },
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

    if (token) {
      writeTokenFile(tokenPath, token);
      // 기본 자리(설정과 같은 디렉터리)면 디렉터리도 좁힌다 — 사람이 고른 다른 자리의 디렉터리 권한은 건드리지 않는다
      if (tokenFile === tokenFileFor(configPath, home)) chmodSync(dirname(tokenPath), 0o700);
    }
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

export type TokenResult = { status: "saved" | "aborted" } | { status: "error"; message: string };

/**
 * `dodok-runner token` — 다시 발급한 토큰만 바꾼다. 설정 파일은 건드리지 않고 그 설정의 tokenFile 자리에 쓴다(루트 id·권한 상한이 그대로).
 * 설정이 없거나 tokenFile 이 없으면(env 토큰) 무엇을 할지 한 줄로 알리고 끝낸다
 */
export async function runTokenCommand(opts: {
  prompter: Prompter;
  configPath: string;
  home: string;
}): Promise<TokenResult> {
  const { prompter: p, configPath, home } = opts;
  try {
    if (!existsSync(configPath)) {
      return {
        status: "error",
        message: "설정 파일이 없습니다 — 터미널에서 dodok-runner 를 실행해 설정을 만드세요",
      };
    }
    const config = readExistingConfig(configPath);
    if (!config) {
      return { status: "error", message: "설정 파일을 읽지 못했습니다 — dodok-runner 로 오류를 확인하세요" };
    }
    if (config.tokenFile === undefined) {
      return {
        status: "error",
        message: "이 설정은 tokenFile 을 쓰지 않습니다 — 토큰을 둔 env DODOK_RUNNER_TOKEN 을 바꾸세요",
      };
    }
    const token = await askToken(p, "새 러너 토큰: ", false);
    writeTokenFile(expandHome(config.tokenFile, home), token);
    p.print(`토큰을 바꿨습니다: ${config.tokenFile} — 러너를 다시 시작하세요(dodok-runner)`);
    return { status: "saved" };
  } catch (error) {
    if (error instanceof SetupAborted) {
      p.print("");
      p.print("토큰을 바꾸지 않고 끝냅니다.");
      return { status: "aborted" };
    }
    throw error;
  } finally {
    p.close();
  }
}
