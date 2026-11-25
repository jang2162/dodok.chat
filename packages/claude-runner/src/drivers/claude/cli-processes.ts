import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type { SdkSpawnedProcess, SdkSpawnOptions } from "./sdk";

// 러너가 띄운 Claude Code CLI 의 기록과 정리(백그라운드 작업 검증 「발견 B」). 러너가 kill -9 로 죽으면 붙든 CLI 와 그 백그라운드
// 셸이 주인 없이 계속 돈다 — 다음에 뜬 러너가 기록을 보고 끈다. 기록은 러너 설정 디렉터리 아래 state/cli-processes.json.
//
// 끄는 길: 백그라운드 셸은 CLI 가 setsid 로 띄워 CLI 와 다른 세션·그룹에 있다(설치본 2.1.331 실측) — CLI 의 그룹으로는 셸에 닿지
// 않는다. 대신 CLI 는 SIGTERM 을 받으면 자기 백그라운드 셸을 스스로 정리한다(같은 실측). 그래서 CLI pid 에 SIGTERM 을 보내고, 보내기
// 직전에 뜬 CLI 의 자손 트리(ppid 기준) 가운데 유예 뒤에도 남은 것을 SIGKILL 한다 — 그룹 리더인 자손은 그 그룹째. 자손은 기록하지
// 않는다(그때그때 바뀐다).
// 남는 틈: CLI 가 먼저 죽고 셸만 남으면(셸의 ppid 가 1 로 바뀐다) 트리에서 찾지 못해 끄지 못한다. 감싸개 스크립트(exec 로 바뀌는
// 실행 파일)로 띄운 CLI 는 첫 COMMAND_REFRESH_MS(1초) 동안 기록의 command 가 감싸개의 것이다 — 그 사이 러너가 kill -9 되면 다음
// 시작이 command 가 다른 「다른 프로세스」로 보고 기록만 지우고 CLI 는 남는다(설치본 claude 가 감싸개가 아니면 해당 없음).
//
// Windows 는 쓰지 않는다 — 프로세스 그룹·시작 시각을 얻는 길이 달라 pid 재사용 확인을 할 수 없다. 거기서는 SDK 기본 spawn 그대로다
// (main.ts 가 이 모듈을 부르지 않는다).

export const CLI_PROCESSES_FILE = "cli-processes.json";
/** SIGTERM 뒤 SIGKILL 까지의 유예 */
export const LEFTOVER_KILL_GRACE_MS = 2000;
/** SDK 기본 spawn 과 같은 값 — exit 뒤 stderr 가 닫히기를 기다리는 시간, 꼬리 길이(sdk.mjs aFe·Gx) */
const STDERR_DRAIN_MS = 200;
const STDERR_TAIL = 2048;
/** spawn 직후의 command 는 감싸개 스크립트일 수 있다 — exec 를 마쳤을 만한 때 한 번 더 읽는다(그 전의 틈은 머리 주석) */
const COMMAND_REFRESH_MS = 1000;

const CliProcessEntry = z.object({
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  runnerPid: z.number().int().positive(),
  /** OS 가 아는 프로세스 시작 시각(ps lstart) — pid 재사용을 가른다 */
  startedAt: z.string().min(1),
  /** ps 의 command 그대로 — 로그에 찍지 않는다 */
  command: z.string(),
});
export type CliProcessEntry = z.infer<typeof CliProcessEntry>;

export type ProcessInfo = { startedAt: string; command: string };
export type ProcessRow = { pid: number; ppid: number; pgid: number };

/** OS 에 묻는 일 — 시험이 바꿔 끼울 수 있다 */
export type ProcessOps = {
  /** 그 pid 의 시작 시각·명령. 없으면 undefined */
  info(pid: number): ProcessInfo | undefined;
  /** 지금 도는 프로세스 전부의 pid·ppid·pgid */
  table(): ProcessRow[];
  alive(pid: number): boolean;
  /** 음수 pid 는 그 그룹. 실패(이미 없음 등)는 삼킨다 */
  kill(pid: number, signal: NodeJS.Signals): void;
};

// ps 출력의 날짜 꼴이 로캘을 따르지 않게
const psEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" });
const LSTART = /^\s*(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+([\s\S]*?)\s*$/;

export const realProcessOps: ProcessOps = {
  info(pid) {
    try {
      const out = execFileSync("ps", ["-ww", "-o", "lstart=", "-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
        env: psEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      const m = LSTART.exec(out);
      return m ? { startedAt: m[1]!.replace(/\s+/g, " "), command: m[2]! } : undefined;
    } catch {
      return undefined;
    }
  },
  table() {
    try {
      const out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid="], {
        encoding: "utf8",
        env: psEnv(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.split("\n").flatMap((line) => {
        const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
        return pid && ppid !== undefined && pgid ? [{ pid, ppid, pgid }] : [];
      });
    } catch {
      return [];
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM 이면 있기는 하다(남의 프로세스)
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
  kill(pid, signal) {
    try {
      process.kill(pid, signal);
    } catch {
      // 이미 끝났다
    }
  },
};

const fileOf = (stateDir: string) => join(stateDir, CLI_PROCESSES_FILE);

/** 기록을 읽는다 — 없거나 깨졌으면 빈 목록, 모양이 틀린 항목은 그 항목만 뺀다 */
export function readCliProcesses(stateDir: string): CliProcessEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fileOf(stateDir), "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    const parsed = CliProcessEntry.safeParse(e);
    return parsed.success ? [parsed.data] : [];
  });
}

/** 임시 파일(0600)에 쓰고 rename — 읽는 쪽이 반쯤 쓴 파일을 보지 않는다 */
export function writeCliProcesses(stateDir: string, entries: readonly CliProcessEntry[]): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = join(
    stateDir,
    `.${CLI_PROCESSES_FILE}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(tmp, fileOf(stateDir));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

const sameEntry = (a: CliProcessEntry, b: Pick<CliProcessEntry, "pid" | "startedAt">) =>
  a.pid === b.pid && a.startedAt === b.startedAt;

/**
 * 읽고-고치고-쓰기를 한 자리에서. 원격 업데이트 때는 앞 판과 새 판이 같은 파일을 만질 수 있어, 쓰기 직전에 다시 읽어 남의 항목을
 * 지우지 않는다(동시에 쓰면 한쪽 변경이 빠질 수 있는 틈은 남는다 — 빠진 항목의 CLI 는 다음 정리에서 못 끈다)
 */
function updateCliProcesses(
  stateDir: string,
  fn: (entries: CliProcessEntry[]) => CliProcessEntry[],
  onError?: (error: unknown) => void,
): void {
  try {
    writeCliProcesses(stateDir, fn(readCliProcesses(stateDir)));
  } catch (error) {
    onError?.(error);
  }
}

export type TrackedCliProcess = SdkSpawnedProcess & {
  /** stderr 의 마지막 부분 — SDK 기본 spawn 이 exit 오류 문구에 붙이던 것. 커스텀 spawn 이면 SDK 가 붙이지 않는다 */
  stderrTail(): string;
};
export type CliSpawner = (options: SdkSpawnOptions) => TrackedCliProcess;
export type CliProcessRegistry = {
  spawn: CliSpawner;
  /**
   * 러너가 정상 종료할 때(런을 멈추고 붙든 프로세스를 놓은 뒤) 아직 도는 CLI 에 SIGTERM 을 보내고 모두 끝나기를(최대 timeoutMs)
   * 기다린다. 놓은 CLI 는 stdin EOF 뒤 ABORT_CLOSE_MS(5초)에야 닫히고 그 뒤 SDK 의 SIGTERM, CLI 는 SIGTERM 뒤 ~2초에 끝난다(설치본
   * 2.1.331 실측) — 기다리기만 하면 러너가 먼저 끝나 끝나는 중인 CLI 의 기록이 남는다. 예전에도 러너가 끝날 때 SDK 가 CLI 에 SIGTERM
   * 을 보냈다(sdk.mjs Zg) — 그것을 끝나기 전으로 당긴 것이다. CLI 는 SIGTERM 을 받으면 자기 백그라운드 셸을 정리한다
   */
  settle(timeoutMs: number): Promise<void>;
};

export type CliProcessRegistryOptions = {
  stateDir: string;
  ops?: ProcessOps;
  runnerPid?: number;
  /** 기록을 못 쓴 까닭 — 런은 그대로 돈다 */
  onError?: (error: unknown) => void;
};

/**
 * SDK Options.spawnClaudeCodeProcess 에 넣을 spawn — SDK 기본(sdk.mjs spawnLocalProcess)과 같게 stdio 셋을 pipe 로, SDK 가 넘긴
 * cwd·env·signal 그대로(env 는 러너의 허용 목록으로 만든 것 — 러너 process.env 를 섞지 않는다), windowsHide. 다른 것:
 * - detached — CLI 가 자기 세션·그룹에 선다. 터미널의 Ctrl-C 가 CLI 에 바로 가지 않고 러너의 정상 종료 길(런을 멈추고 CLI 를 닫는다)을
 *   지난다. unref 하지 않는다 — 러너가 CLI 를 기다린다
 * - 띄운 CLI 를 state/cli-processes.json 에 적고 끝나면 지운다
 * - stderr 꼬리를 쥔다(stderrTail) — SDK 는 커스텀 spawn 의 stderr 를 읽지 않는다. exit 는 기본처럼 stderr 가 닫힌 뒤(최대 200ms)에
 *   알린다
 * SDK 가 process exit 때 CLI 에 SIGTERM 을 보내는 추적(sdk.mjs Zg)은 커스텀 spawn 에도 그대로 걸린다.
 */
export function createCliProcessRegistry(opts: CliProcessRegistryOptions): CliProcessRegistry {
  const ops = opts.ops ?? realProcessOps;
  const runnerPid = opts.runnerPid ?? process.pid;
  const update = (fn: (entries: CliProcessEntry[]) => CliProcessEntry[]) =>
    updateCliProcesses(opts.stateDir, fn, opts.onError);
  // 아직 끝나지 않은 CLI 와 그 exit — settle 이 끄고 기다린다
  const running = new Map<Promise<void>, () => void>();

  const spawnCli: CliSpawner = (options) => {
    const child = spawn(options.command, options.args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // SDK 의 이 signal 은 stdin EOF 와 정상 종료 유예 뒤에 끊긴다 — 기본 spawn 도 그대로 넘긴다
      ...(options.signal ? { signal: options.signal } : {}),
      detached: true,
      windowsHide: true,
    });

    let entry: CliProcessEntry | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    child.once("spawn", () => {
      const pid = child.pid;
      if (pid === undefined) return;
      const info = ops.info(pid);
      if (!info) return;
      // detached 는 setsid — 그룹 id 가 pid 다
      const e: CliProcessEntry = { pid, pgid: pid, runnerPid, ...info };
      entry = e;
      update((list) => [...list.filter((x) => x.pid !== pid), e]);
      refresh = setTimeout(() => {
        const now = ops.info(pid);
        if (!entry || !now || now.startedAt !== e.startedAt || now.command === e.command) return;
        const next = { ...e, command: now.command };
        entry = next;
        update((list) => list.map((x) => (sameEntry(x, e) ? next : x)));
      }, COMMAND_REFRESH_MS);
      refresh.unref();
    });

    // stderr 꼬리와 exit 알림 — SDK 기본 spawn 과 같은 순서(stderr 가 닫힌 뒤 exit)
    let tail = "";
    const decoder = new StringDecoder("utf8");
    child.stderr.on("data", (chunk: Buffer) => {
      if (delivered) return;
      tail += decoder.write(chunk);
      if (tail.length > 2 * STDERR_TAIL) tail = tail.slice(-STDERR_TAIL);
    });
    child.stderr.on("error", () => {});
    let delivered = false;
    const exitBus = new EventEmitter();
    let stderrClosed = false;
    let exited = false;
    let drain: ReturnType<typeof setTimeout> | undefined;
    const deliver = () => {
      if (delivered) return;
      delivered = true;
      clearTimeout(drain);
      exitBus.emit("exit", child.exitCode, child.signalCode);
      // 기본 spawn 처럼 stderr 를 놓는다 — 손자가 CLI 의 stderr 를 쥐고 있으면 파이프가 닫히지 않아 러너를 붙든다
      const stderr = child.stderr as typeof child.stderr & { unref?: () => void };
      if (typeof stderr.unref === "function") stderr.unref();
      else stderr.destroy();
    };
    child.stderr.once("close", () => {
      tail += decoder.end();
      stderrClosed = true;
      if (exited) deliver();
    });
    const gone = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => {
        if (child.pid === undefined) resolve();
      });
    });
    running.set(gone, () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    });
    void gone.then(() => running.delete(gone));
    child.once("exit", () => {
      exited = true;
      clearTimeout(refresh);
      const done = entry;
      entry = undefined;
      if (done) update((list) => list.filter((x) => !sameEntry(x, done)));
      if (stderrClosed) deliver();
      else drain = setTimeout(deliver, STDERR_DRAIN_MS);
    });

    type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
    type AnyListener = ExitListener | ((error: Error) => void);
    const target = (event: "exit" | "error") => (event === "exit" ? exitBus : child);
    const proc = {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal: NodeJS.Signals) => child.kill(signal),
      on: (event: "exit" | "error", listener: AnyListener) => {
        target(event).on(event, listener);
      },
      once: (event: "exit" | "error", listener: AnyListener) => {
        target(event).once(event, listener);
      },
      off: (event: "exit" | "error", listener: AnyListener) => {
        target(event).off(event, listener);
      },
      stderrTail: () => tail.slice(-STDERR_TAIL),
    };
    return proc as TrackedCliProcess;
  };

  return {
    spawn: spawnCli,
    async settle(timeoutMs) {
      if (running.size === 0) return;
      for (const term of running.values()) term();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(running.keys()),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
      ]);
      clearTimeout(timer);
    },
  };
}

/** pid 와 그 자손(ppid 기준) — 표에 없는 pid 도 하나는 싣는다 */
function treeOf(pid: number, pgid: number, table: readonly ProcessRow[]): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of table) byParent.set(row.ppid, [...(byParent.get(row.ppid) ?? []), row]);
  const root = table.find((r) => r.pid === pid) ?? { pid, ppid: 0, pgid };
  const out: ProcessRow[] = [root];
  for (let i = 0; i < out.length; i++) {
    for (const child of byParent.get(out[i]!.pid) ?? [])
      if (!out.some((r) => r.pid === child.pid)) out.push(child);
  }
  return out;
}

export type CleanupResult = { killed: number; dropped: number };

/**
 * 러너 시작 때(서버에 붙기 전) 앞 러너가 남긴 CLI 를 끈다. runnerPid 가 살아 있는 항목은 그대로 둔다(다른 러너 — 원격 업데이트의 앞
 * 판 등). 죽은 러너의 항목은 그 pid 가 아직 같은 프로세스인지(시작 시각·command 가 기록과 같은지) 보고 — 같으면 끄고, 다르거나 없으면
 * 기록만 지운다(pid 재사용으로 남의 프로세스를 끄지 않게)
 */
export async function cleanupLeftoverClis(opts: {
  stateDir: string;
  ops?: ProcessOps;
  graceMs?: number;
  selfPid?: number;
  onError?: (error: unknown) => void;
}): Promise<CleanupResult> {
  const ops = opts.ops ?? realProcessOps;
  const selfPid = opts.selfPid ?? process.pid;
  const graceMs = opts.graceMs ?? LEFTOVER_KILL_GRACE_MS;
  const entries = readCliProcesses(opts.stateDir);
  // 내 pid 와 같은 runnerPid 는 죽은 러너의 pid 를 내가 받은 것이다
  const stale = entries.filter((e) => e.runnerPid === selfPid || !ops.alive(e.runnerPid));
  if (stale.length === 0) return { killed: 0, dropped: 0 };

  // 손으로 고친 기록이 init·나·내 그룹을 가리켜도 끄지 않는다(내 그룹 리더는 대개 러너를 띄운 셸)
  const table = ops.table();
  const selfPgid = table.find((r) => r.pid === selfPid)?.pgid;
  const protectedPid = (pid: number) => pid <= 1 || pid === selfPid || pid === selfPgid;

  const targets = stale.filter((e) => {
    if (protectedPid(e.pid)) return false;
    const info = ops.info(e.pid);
    return info !== undefined && info.startedAt === e.startedAt && info.command === e.command;
  });
  // 자손마다 시작 시각을 지금 잡아 둔다 — 유예 사이에 pid 가 재사용되면 SIGKILL 하지 않는다
  const rows = targets
    .flatMap((e) => treeOf(e.pid, e.pgid, table))
    .filter((r) => !protectedPid(r.pid) && r.pgid !== selfPgid)
    .flatMap((r) => {
      const startedAt = ops.info(r.pid)?.startedAt;
      return startedAt === undefined ? [] : [{ ...r, startedAt }];
    });
  for (const e of targets) ops.kill(e.pid, "SIGTERM");

  const deadline = Date.now() + graceMs;
  while (rows.some((r) => ops.alive(r.pid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  for (const r of rows) {
    if (!ops.alive(r.pid) || ops.info(r.pid)?.startedAt !== r.startedAt) continue;
    ops.kill(r.pgid === r.pid ? -r.pid : r.pid, "SIGKILL");
  }

  updateCliProcesses(
    opts.stateDir,
    (list) => list.filter((x) => !stale.some((s) => sameEntry(x, s))),
    opts.onError,
  );
  return { killed: targets.length, dropped: stale.length - targets.length };
}
