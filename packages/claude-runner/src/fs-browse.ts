import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  RUNNER_FS_LIST_MAX,
  type RunnerFsEntry,
  type RunnerFsListResult,
  type RunnerProjectCheckResult,
  type RunnerProjectRef,
} from "@dodok/shared";
import { isInside, resolveProject } from "./ceiling";
import type { ResolvedRunnerConfig } from "./config";

// 디렉터리 둘러보기·프로젝트 확인(러너 일반화 스펙 3장) — 앱에서 프로젝트를 더할 때 서버가 묻는다. 나가는 것은 루트 아래
// 항목 이름과 git 여부뿐이다. 숨김(`.` 시작)과 루트 밖을 가리키는 링크는 보이지 않는다

/** `.git` 이 디렉터리든 파일(워크트리·서브모듈)이든 git 저장소로 본다 */
const isGitRepo = (dir: string): boolean => existsSync(join(dir, ".git"));

/** 디렉터리이거나 루트 안 디렉터리를 가리키는 링크면 그 풀린 경로, 아니면 undefined */
function directoryInside(rootPath: string, parent: string, entry: Dirent): string | undefined {
  const full = join(parent, entry.name);
  if (entry.isDirectory()) return full;
  if (!entry.isSymbolicLink()) return undefined;
  try {
    const target = realpathSync(full);
    return isInside(rootPath, target) && statSync(target).isDirectory() ? target : undefined;
  } catch {
    return undefined;
  }
}

export function listDirectory(
  cfg: Pick<ResolvedRunnerConfig, "roots" | "browse">,
  ref: RunnerProjectRef,
): RunnerFsListResult {
  if (!cfg.browse) return { ok: false, code: "FORBIDDEN" };
  // 루트 밖·없음·파일은 모두 NOT_FOUND — 루트 밖에 무엇이 있는지 가르쳐 주지 않는다
  const project = resolveProject(cfg.roots, ref);
  if (!project.ok) return { ok: false, code: "NOT_FOUND" };
  let dirents: Dirent[];
  try {
    dirents = readdirSync(project.path, { withFileTypes: true });
  } catch {
    return { ok: false, code: "NOT_FOUND" };
  }
  const dirs = dirents
    .filter((d) => !d.name.startsWith("."))
    .flatMap((d) => {
      const dir = directoryInside(project.root.path, project.path, d);
      return dir === undefined ? [] : [{ name: d.name, dir }];
    })
    // 코드 포인트 순 — 로캘에 따라 바뀌지 않게
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries: RunnerFsEntry[] = dirs
    .slice(0, RUNNER_FS_LIST_MAX)
    .map(({ name, dir }) => ({ name, isGitRepo: isGitRepo(dir) }));
  return { ok: true, entries, truncated: dirs.length > RUNNER_FS_LIST_MAX };
}

export function checkProject(
  cfg: Pick<ResolvedRunnerConfig, "roots">,
  ref: RunnerProjectRef,
): RunnerProjectCheckResult {
  const project = resolveProject(cfg.roots, ref);
  if (!project.ok) return project;
  return { ok: true, isGitRepo: isGitRepo(project.path) };
}
