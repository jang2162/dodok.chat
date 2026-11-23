import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  permissionModeRank,
  RUNNER_BOT_ID_PATTERN,
  type RunnerCeilingItem,
  type RunnerProgram,
  type RunnerProjectRef,
  type RunnerRunAgent,
} from "@dodok/shared";
import type { ResolvedRoot, ResolvedRunnerConfig } from "./config";

// 천장 검사(러너 일반화 스펙 3장) — 서버가 run.start 에 실은 에이전트 정의가 이 머신의 설정 안인가. 러너는 무상태라 런마다 다시
// 본다: 설정을 바꾸면 다음 런부터 맞다. 걸린 항목 이름만 서버로 간다(경로 원문 없음)

export type CeilingResult = { ok: true; workdir: string } | { ok: false; item: RunnerCeilingItem };

/** child 가 root 자신이거나 그 아래인가 — 둘 다 realpath 여야 한다 */
export const isInside = (root: string, child: string): boolean =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

export type ResolvedProject =
  | { ok: true; root: ResolvedRoot; path: string }
  | { ok: false; reason: "root_missing" | "not_found" | "outside_root" | "not_directory" };

/**
 * 루트 + relPath 를 realpath 로 푼다. 글자 검사(RunnerRelPath)는 서버가 했지만 링크는 글자로 못 거르므로 여기서 다시 본다 —
 * 루트 안의 링크가 밖을 가리키면 outside_root. 디렉터리가 아니면 not_directory
 */
export function resolveProject(roots: readonly ResolvedRoot[], ref: RunnerProjectRef): ResolvedProject {
  const root = roots.find((r) => r.id === ref.rootId);
  if (!root) return { ok: false, reason: "root_missing" };
  let path: string;
  try {
    // native — 설정 루트(config.ts)와 같은 풀이여야 대소문자만 다른 relPath 가 같은 작업 디렉터리가 된다
    path = realpathSync.native(ref.relPath === "" ? root.path : join(root.path, ref.relPath));
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!isInside(root.path, path)) return { ok: false, reason: "outside_root" };
  try {
    if (!statSync(path).isDirectory()) return { ok: false, reason: "not_directory" };
  } catch {
    return { ok: false, reason: "not_found" };
  }
  return { ok: true, root, path };
}

export type ResolvedBot = { ok: true; path: string } | { ok: false };

/**
 * 봇 폴더(러너 봇 스펙 B1) — `<botsDir>/<id>`. id 는 `r-` + 소문자 hex 10 만(글자로 `..`·`/` 를 막는다), botsDir 를 realpath 로 푼
 * 자리 바로 아래 한 단계여야 한다. botsDir·봇 폴더가 없으면 0700 으로 만든다. 봇 폴더가 심볼릭 링크거나 디렉터리가 아니면 거절 —
 * 링크는 봇 자리 밖을 가리킬 수 있다. 던지지 않는다
 */
export function resolveBot(botsDir: string, id: string): ResolvedBot {
  if (!RUNNER_BOT_ID_PATTERN.test(id)) return { ok: false };
  let base: string;
  try {
    mkdirSync(botsDir, { recursive: true, mode: 0o700 });
    base = realpathSync.native(botsDir);
  } catch {
    return { ok: false };
  }
  const path = join(base, id);
  try {
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined) mkdirSync(path, { mode: 0o700 });
    else if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false };
    // 사이에 링크로 바뀌었어도 realpath 가 정확히 그 자리여야 한다
    if (realpathSync.native(path) !== path) return { ok: false };
  } catch {
    return { ok: false };
  }
  return { ok: true, path };
}

/**
 * 순서는 root → path → program → permissionMode → allowedTools(먼저 걸린 하나만). allowedTools 는 글자 그대로의 부분집합이다 —
 * `Bash(git status)` 는 상한 `Bash` 에 들지 않는다(규칙 문법을 풀어 넓게 보지 않는다). null 은 미리 허용한 도구가 없다는 뜻이라
 * 어느 상한에도 든다. isAvailable 은 그 프로그램의 드라이버가 있고 detect 가 available 이라고 했는가. 봇 런은 root·path 대신 bot
 * (봇 폴더 — resolveBot) — 허용 루트와 상관없이 봇 자리만 본다(러너 봇 스펙 B1)
 */
export function checkCeiling(
  cfg: Pick<ResolvedRunnerConfig, "roots" | "programs" | "botsDir">,
  agent: RunnerRunAgent,
  isAvailable: (program: RunnerProgram) => boolean,
): CeilingResult {
  let workdir: string;
  if (agent.bot !== undefined) {
    const bot = resolveBot(cfg.botsDir, agent.bot.id);
    if (!bot.ok) return { ok: false, item: "bot" };
    workdir = bot.path;
  } else if (agent.project !== undefined) {
    const project = resolveProject(cfg.roots, agent.project);
    if (!project.ok) return { ok: false, item: project.reason === "root_missing" ? "root" : "path" };
    workdir = project.path;
  } else {
    // 계약(RunnerRunAgent)이 정확히 하나를 강제한다 — 여기 오지 않는다
    return { ok: false, item: "path" };
  }
  const ceiling = cfg.programs[agent.program];
  if (!ceiling || !isAvailable(agent.program)) return { ok: false, item: "program" };
  if (permissionModeRank(agent.permissionMode) > permissionModeRank(ceiling.maxPermissionMode)) {
    return { ok: false, item: "permissionMode" };
  }
  const allowed = ceiling.allowedToolsCeiling;
  if (allowed !== null && agent.allowedTools?.some((t) => !allowed.includes(t))) {
    return { ok: false, item: "allowedTools" };
  }
  return { ok: true, workdir };
}
