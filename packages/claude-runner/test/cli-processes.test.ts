import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLI_PROCESSES_FILE,
  cleanupLeftoverClis,
  createCliProcessRegistry,
  readCliProcesses,
  realProcessOps,
  writeCliProcesses,
  type CliProcessEntry,
} from "../src/drivers/claude/cli-processes";

// 실제 프로세스·ps 로 잰다(가짜 OS 로는 pid 재사용·자손 트리를 잴 수 없다). Windows 는 이 정리를 하지 않는다
const POSIX = process.platform !== "win32";

const until = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("기다린 조건이 오지 않았다");
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** 이미 끝난 프로세스의 pid — 죽은 러너 흉내 */
async function deadPid(): Promise<number> {
  const p = spawn("true");
  await new Promise((r) => p.once("exit", r));
  return p.pid!;
}

describe.skipIf(!POSIX)("cli-processes", () => {
  let dir: string;
  const started: ChildProcess[] = [];
  const extraPids: number[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dodok-cli-proc-"));
  });
  afterEach(() => {
    for (const p of started) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    for (const pid of extraPids) realProcessOps.kill(pid, "SIGKILL");
    started.length = 0;
    extraPids.length = 0;
    rmSync(dir, { recursive: true, force: true });
  });

  /** 떨어져 도는 프로세스 하나 — 기록이 가리킬 「남은 CLI」 */
  function detached(command: string, args: string[]): ChildProcess {
    const p = spawn(command, args, { detached: true, stdio: "ignore" });
    started.push(p);
    return p;
  }

  async function entryFor(pid: number, runnerPid: number): Promise<CliProcessEntry> {
    await until(() => realProcessOps.info(pid) !== undefined);
    const info = realProcessOps.info(pid)!;
    return { pid, pgid: pid, runnerPid, ...info };
  }

  it("records a spawned cli and removes it on exit", async () => {
    const registry = createCliProcessRegistry({ stateDir: dir });
    const p = registry.spawn({
      command: "/bin/sh",
      args: ["-c", "echo 'Error: Session ID abc is already in use.' >&2; read line"],
      env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal,
    });
    await until(() => readCliProcesses(dir).length === 1);
    const [entry] = readCliProcesses(dir);
    expect(entry).toMatchObject({ runnerPid: process.pid });
    expect(entry!.pgid).toBe(entry!.pid);
    expect(entry!.startedAt).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(entry!.command).toContain("/bin/sh");

    const exited = new Promise<[number | null, string | null]>((r) =>
      p.once("exit", (c: number | null, s: string | null) => r([c, s])),
    );
    p.stdin.end("\n");
    expect(await exited).toEqual([0, null]);
    // exit 알림은 stderr 가 닫힌 뒤 — 꼬리가 다 차 있다(SDK 기본 spawn 이 오류 문구에 붙이던 것)
    expect(p.stderrTail()).toContain("already in use");
    expect(readCliProcesses(dir)).toEqual([]);
  });

  it("settle terminates running clis and waits for them to exit", async () => {
    const registry = createCliProcessRegistry({ stateDir: dir });
    const p = registry.spawn({
      command: "/bin/sh",
      args: ["-c", "trap 'exit 0' TERM; while :; do sleep 0.05; done"],
      env: { PATH: "/usr/bin:/bin" },
      signal: new AbortController().signal,
    });
    await until(() => readCliProcesses(dir).length === 1);
    const pid = readCliProcesses(dir)[0]!.pid;
    await registry.settle(5000);
    expect(realProcessOps.alive(pid)).toBe(false);
    expect(p.exitCode).toBe(0);
    expect(readCliProcesses(dir)).toEqual([]);
  });

  it("kills a leftover cli group from a dead runner on start", async () => {
    // 남은 CLI 흉내 — SIGTERM 을 무시하고, 자식(백그라운드 셸 흉내)은 setsid 로 자기 세션에 띄운다(실측한 CLI 의 꼴)
    const script = [
      "const { spawn } = require('node:child_process');",
      "const c = spawn('sleep', ['100000'], { detached: true, stdio: 'ignore' });",
      "console.log(c.pid);",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1e6);",
    ].join("\n");
    const cli = spawn(process.execPath, ["-e", script], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    started.push(cli);
    const shellPid = await new Promise<number>((r) =>
      cli.stdout!.once("data", (d) => r(Number(String(d).trim()))),
    );
    extraPids.push(shellPid);
    expect(realProcessOps.alive(shellPid)).toBe(true);

    writeCliProcesses(dir, [await entryFor(cli.pid!, await deadPid())]);
    const result = await cleanupLeftoverClis({ stateDir: dir, graceMs: 300 });

    expect(result).toEqual({ killed: 1, dropped: 0 });
    await until(() => !realProcessOps.alive(shellPid) && cli.signalCode !== null);
    expect(cli.signalCode).toBe("SIGKILL");
    expect(readCliProcesses(dir)).toEqual([]);
  });

  it("does not kill a reused pid whose start time differs", async () => {
    const other = detached("sleep", ["100000"]);
    const entry = await entryFor(other.pid!, await deadPid());
    writeCliProcesses(dir, [{ ...entry, startedAt: "Thu Jan 1 00:00:00 1970" }]);

    const result = await cleanupLeftoverClis({ stateDir: dir, graceMs: 300 });

    expect(result).toEqual({ killed: 0, dropped: 1 });
    expect(realProcessOps.alive(other.pid!)).toBe(true);
    expect(readCliProcesses(dir)).toEqual([]);
  });

  it("leaves entries of a live runner alone", async () => {
    const runner = detached("sleep", ["100000"]);
    const cli = detached("sleep", ["100000"]);
    const entry = await entryFor(cli.pid!, runner.pid!);
    writeCliProcesses(dir, [entry]);

    const result = await cleanupLeftoverClis({ stateDir: dir, graceMs: 300 });

    expect(result).toEqual({ killed: 0, dropped: 0 });
    expect(realProcessOps.alive(cli.pid!)).toBe(true);
    expect(readCliProcesses(dir)).toEqual([entry]);
  });

  it("writes the state file atomically with mode 0600", () => {
    const file = join(dir, "state", CLI_PROCESSES_FILE);
    const entry: CliProcessEntry = {
      pid: 4242,
      pgid: 4242,
      runnerPid: 4141,
      startedAt: "Tue Nov 24 10:00:00 2026",
      command: "claude",
    };
    writeCliProcesses(join(dir, "state"), [entry]);
    const before = statSync(file);
    writeCliProcesses(join(dir, "state"), []);
    const after = statSync(file);

    expect(after.mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
    // 새 파일을 rename 으로 바꿔 끼웠다 — 그 자리에 덮어쓰지 않았다. 임시 파일이 남지 않는다
    expect(after.ino).not.toBe(before.ino);
    expect(readdirSync(join(dir, "state"))).toEqual([CLI_PROCESSES_FILE]);
    expect(readCliProcesses(join(dir, "state"))).toEqual([]);
  });

  it("drops malformed entries and survives a broken file", () => {
    writeFileSync(join(dir, CLI_PROCESSES_FILE), "{not json");
    expect(readCliProcesses(dir)).toEqual([]);
    writeFileSync(join(dir, CLI_PROCESSES_FILE), JSON.stringify([{ pid: "x" }, null]));
    expect(readCliProcesses(dir)).toEqual([]);
  });
});
