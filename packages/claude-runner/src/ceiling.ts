import { realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import {
  permissionModeRank,
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
    path = realpathSync(ref.relPath === "" ? root.path : join(root.path, ref.relPath));
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

/**
 * 순서는 root → path → program → permissionMode → allowedTools(먼저 걸린 하나만). allowedTools 는 글자 그대로의 부분집합이다 —
 * `Bash(git status)` 는 상한 `Bash` 에 들지 않는다(규칙 문법을 풀어 넓게 보지 않는다). null 은 미리 허용한 도구가 없다는 뜻이라
 * 어느 상한에도 든다. isAvailable 은 그 프로그램의 드라이버가 있고 detect 가 available 이라고 했는가
 */
export function checkCeiling(
  cfg: Pick<ResolvedRunnerConfig, "roots" | "programs">,
  agent: RunnerRunAgent,
  isAvailable: (program: RunnerProgram) => boolean,
): CeilingResult {
  const project = resolveProject(cfg.roots, agent.project);
  if (!project.ok) return { ok: false, item: project.reason === "root_missing" ? "root" : "path" };
  const ceiling = cfg.programs[agent.program];
  if (!ceiling || !isAvailable(agent.program)) return { ok: false, item: "program" };
  if (permissionModeRank(agent.permissionMode) > permissionModeRank(ceiling.maxPermissionMode)) {
    return { ok: false, item: "permissionMode" };
  }
  const allowed = ceiling.allowedToolsCeiling;
  if (allowed !== null && agent.allowedTools?.some((t) => !allowed.includes(t))) {
    return { ok: false, item: "allowedTools" };
  }
  return { ok: true, workdir: project.path };
}
