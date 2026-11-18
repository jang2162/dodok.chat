import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  RunnerProjectRef,
  RunnerWorktreeCreate,
  RunnerWorktreeCreateResult,
  RunnerWorktreeRemove,
  RunnerWorktreeRemoveResult,
} from "@dodok/shared";
import { isInside, resolveProject } from "./ceiling";
import type { ResolvedRoot, ResolvedRunnerConfig } from "./config";
import { createPathMasker } from "./mask";

// git 워크트리(워크트리 스펙 5.3) — 서버가 worktree.create·worktree.remove 로 묻는다. git 은 execFile 로만 부르고(셸 없음)
// 사람이 적은 브랜치·경로는 옵션으로 읽히지 않게 앞에서 거르거나 `--` 뒤에 둔다. 만들기·지우기 모두 --force 가 없다 —
// 커밋하지 않은 변경이 있는 워크트리는 git 이 거절하고 그것을 dirty 로 돌려준다(W7)

export type GitResult = { code: number; stdout: string; stderr: string };
/** cwd 에서 git 을 부른다. git 이 없으면 code ENOENT 오류로 거절한다 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

type Deps = { git?: GitRunner; mask?: (s: string) => string };

/** 한 번의 git 호출 상한 — ack 상한(RUNNER_GIT_ACK_TIMEOUT_MS 30초) 안에서 끝나게 */
const GIT_CALL_TIMEOUT_MS = 25_000;
const MESSAGE_MAX = 200;
export const GIT_MISSING_MESSAGE = "러너 머신에 git 이 없습니다";

export const execGit: GitRunner = (args, cwd) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      args,
      // 자격 증명 물음 같은 대화형 입력으로 멈추지 않게, 사유 판정(dirty·branch_in_use)이 읽는 stderr 가 번역되지 않게
      {
        cwd,
        timeout: GIT_CALL_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === "ENOENT") return reject(err);
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

const isGitMissing = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const realpathOr = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};

/** 저장소의 주 작업 트리 맨 위인가(W14) — 하위 디렉터리·다른 워크트리·git 아님은 거짓 */
export async function isGitTop(dir: string, git: GitRunner = execGit): Promise<boolean> {
  let r: GitResult;
  try {
    r = await git(["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], dir);
  } catch {
    return false;
  }
  if (r.code !== 0) return false;
  const [top, gitDir, commonDir] = r.stdout.split("\n").map((l) => l.trim());
  if (!top || !gitDir || !commonDir) return false;
  const here = realpathOr(dir);
  return realpathOr(top) === here && realpathOr(resolve(dir, gitDir)) === realpathOr(resolve(dir, commonDir));
}

type Target =
  | { ok: true; path: string; root: ResolvedRoot }
  | { ok: false; reason: "root_missing" | "outside_root" };

/**
 * 아직 없을 수 있는 폴더를 루트 안으로 푼다 — 가장 가까운 있는 조상을 realpath 로 풀고 나머지 이름을 붙인다(링크는 있는
 * 조상에만 있을 수 있다). 그 결과가 루트 밖이면 outside_root
 */
function resolveTarget(roots: readonly ResolvedRoot[], ref: RunnerProjectRef): Target {
  const root = roots.find((r) => r.id === ref.rootId);
  if (!root) return { ok: false, reason: "root_missing" };
  let rootPath: string;
  try {
    rootPath = realpathSync.native(root.path);
  } catch {
    return { ok: false, reason: "root_missing" };
  }
  const parts = ref.relPath === "" ? [] : ref.relPath.split("/");
  const rest: string[] = [];
  let existing = parts.length === 0 ? root.path : join(root.path, ...parts);
  for (;;) {
    try {
      existing = realpathSync.native(existing);
      break;
    } catch {
      if (existing === root.path) return { ok: false, reason: "root_missing" };
      rest.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const path = rest.length === 0 ? existing : join(existing, ...rest);
  if (!isInside(rootPath, path) || path === rootPath) return { ok: false, reason: "outside_root" };
  return { ok: true, path, root: { ...root, path: rootPath } };
}

/** 제어 문자(줄바꿈 등) — info/exclude 에 다른 줄을 끼워 넣을 수 있어 경로·브랜치에서 거절한다 */
// oxlint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/** porcelain 목록의 워크트리 경로 → 브랜치(분리된 HEAD 면 null). 첫 항목은 주 작업 트리다(git 이 그렇게 낸다) */
async function listWorktrees(git: GitRunner, repo: string): Promise<Map<string, string | null>> {
  const r = await git(["worktree", "list", "--porcelain"], repo);
  const out = new Map<string, string | null>();
  if (r.code !== 0) return out;
  let current: string | undefined;
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = realpathOr(line.slice("worktree ".length));
      out.set(current, null);
    } else if (line.startsWith("branch refs/heads/") && current !== undefined) {
      out.set(current, line.slice("branch refs/heads/".length));
    }
  }
  return out;
}

/** gitignore 패턴의 특수 글자를 글자 그대로 읽히게 — 끝 공백도 */
const escapeIgnore = (rel: string): string =>
  rel.replace(/[\\*?[\]!#]/g, "\\$&").replace(/ +$/, (m) => m.replace(/ /g, "\\ "));

/**
 * 워크트리 폴더가 저장소 안이면 그 자리를 저장소의 무시 규칙에 넣는다(W5) — 추적 파일(.gitignore)은 건드리지 않고
 * `git rev-parse --git-path info/exclude` 의 파일에만, 이미 무시되면 쓰지 않는다. 기본 위치(.worktrees/<이름>)는 `/.worktrees/`
 */
async function excludeTarget(git: GitRunner, repo: string, target: string): Promise<void> {
  if (!isInside(repo, target) || target === repo) return;
  const rel = relative(repo, target).split(sep).join("/");
  const first = rel.split("/")[0];
  const dirRel = first === ".worktrees" ? ".worktrees" : rel;
  const ignored = await git(["check-ignore", "-q", "--", `${dirRel}/`], repo);
  if (ignored.code === 0) return;
  const pathOut = await git(["rev-parse", "--git-path", "info/exclude"], repo);
  if (pathOut.code !== 0) return;
  const raw = pathOut.stdout.trim();
  const file = isAbsolute(raw) ? raw : resolve(repo, raw);
  const line = `/${escapeIgnore(dirRel)}/`;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // 없으면 새로 — info/ 디렉터리가 없으면 아래 append 가 실패하고 그대로 둔다(무시 규칙은 보기 편의일 뿐)
  }
  if (text.split("\n").includes(line)) return;
  try {
    appendFileSync(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
  } catch {
    // 무시 규칙을 못 써도 워크트리는 만들어졌다 — 저장소 status 에 폴더가 보일 뿐
  }
}

const isEmptyDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory() && readdirSync(p).length === 0;
  } catch {
    return false;
  }
};

export async function createWorktree(
  cfg: Pick<ResolvedRunnerConfig, "roots">,
  req: RunnerWorktreeCreate,
  deps: Deps = {},
): Promise<RunnerWorktreeCreateResult> {
  const git = deps.git ?? execGit;
  const repo = resolveProject(cfg.roots, req.repo);
  if (!repo.ok) {
    return {
      ok: false,
      reason:
        repo.reason === "root_missing"
          ? "root_missing"
          : repo.reason === "outside_root"
            ? "outside_root"
            : "not_git",
    };
  }
  const mask = deps.mask ?? createPathMasker([repo.root.path, realpathOr(repo.root.path)]);
  const fail = (
    reason: Extract<RunnerWorktreeCreateResult, { ok: false }>["reason"],
    stderr?: string,
  ): RunnerWorktreeCreateResult => {
    const message = stderr?.trim() ? mask(stderr.trim()).slice(0, MESSAGE_MAX) : undefined;
    return message ? { ok: false, reason, message } : { ok: false, reason };
  };
  try {
    if (!(await isGitTop(repo.path, git))) {
      // 다른 git 호출보다 먼저 git 이 있는지 — 없으면 isGitTop 이 거짓이라 not_git 으로 잘못 답한다
      await git(["--version"], repo.path);
      return fail(
        existsSync(join(repo.path, ".git")) && !lstatSync(join(repo.path, ".git")).isDirectory()
          ? "is_worktree"
          : "not_git",
      );
    }
    // `-` 로 시작하는 이름은 check-ref-format 이 옵션으로 읽을 수 있다(그 명령은 `--` 를 받지 않는다) — 먼저 거른다.
    // `@{` 는 check-ref-format --branch 가 `@{-1}` 처럼 다른 브랜치로 펼쳐 엉뚱한 사유가 나온다. 제어 문자도 여기서
    if (req.branch.startsWith("-") || req.branch.includes("@{") || CONTROL_CHARS.test(req.branch))
      return fail("invalid_branch");
    if (CONTROL_CHARS.test(req.target.relPath)) return fail("outside_root");
    const refCheck = await git(["check-ref-format", "--branch", req.branch], repo.path);
    if (refCheck.code !== 0) return fail("invalid_branch");

    const target = resolveTarget(cfg.roots, req.target);
    if (!target.ok) return fail(target.reason);
    if (existsSync(target.path) && !isEmptyDir(target.path)) {
      // 받아들이기(W13)는 요청한 글자 그대로의 자리가 다른 워크트리일 때만 — 주 작업 트리(첫 항목·.git 이 디렉터리)는 빼고,
      // 대소문자만 다르거나 링크를 거쳐 같은 폴더로 풀리는 자리는 다른 행이 이미 가리킬 수 있어 받아들이지 않는다
      const registered = await listWorktrees(git, repo.path);
      const main = registered.keys().next().value;
      const literal =
        req.target.relPath === ""
          ? target.root.path
          : join(target.root.path, ...req.target.relPath.split("/"));
      const dotGit = join(target.path, ".git");
      if (
        target.path === literal &&
        target.path !== main &&
        !(existsSync(dotGit) && lstatSync(dotGit).isDirectory()) &&
        registered.has(target.path) &&
        registered.get(target.path) === req.branch
      ) {
        const head = await git(["rev-parse", "--short", "HEAD"], target.path);
        await excludeTarget(git, repo.path, target.path);
        return { ok: true, created: false, adopted: true, base: head.stdout.trim().slice(0, 64) };
      }
      return fail("target_exists");
    }

    const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${req.branch}`], repo.path);
    const created = exists.code !== 0;
    const add = created
      ? await git(["worktree", "add", "-b", req.branch, "--", target.path, "HEAD"], repo.path)
      : await git(["worktree", "add", "--", target.path, req.branch], repo.path);
    if (add.code !== 0) {
      if (/already checked out|is already used by worktree/.test(add.stderr))
        return fail("branch_in_use", add.stderr);
      return fail("git_failed", add.stderr);
    }
    await excludeTarget(git, repo.path, target.path);
    const head = await git(["rev-parse", "--short", "HEAD"], target.path);
    return { ok: true, created, adopted: false, base: head.stdout.trim().slice(0, 64) };
  } catch (e) {
    return fail("git_failed", isGitMissing(e) ? GIT_MISSING_MESSAGE : undefined);
  }
}

export async function removeWorktree(
  cfg: Pick<ResolvedRunnerConfig, "roots">,
  req: RunnerWorktreeRemove,
  deps: Deps = {},
): Promise<RunnerWorktreeRemoveResult> {
  const git = deps.git ?? execGit;
  const repo = resolveProject(cfg.roots, req.repo);
  if (!repo.ok) return { ok: false, reason: "git_failed", message: "저장소를 찾지 못했습니다" };
  const mask = deps.mask ?? createPathMasker([repo.root.path, realpathOr(repo.root.path)]);
  const fail = (
    reason: Extract<RunnerWorktreeRemoveResult, { ok: false }>["reason"],
    stderr?: string,
  ): RunnerWorktreeRemoveResult => {
    const message = stderr?.trim() ? mask(stderr.trim()).slice(0, MESSAGE_MAX) : undefined;
    return message ? { ok: false, reason, message } : { ok: false, reason };
  };
  try {
    const target = resolveTarget(cfg.roots, req.target);
    if (!target.ok) return fail("not_worktree");
    if (!existsSync(target.path)) {
      // 폴더가 이미 없다 — git 의 등록만 치운다(W7)
      const prune = await git(["worktree", "prune"], repo.path);
      return prune.code === 0 ? { ok: true } : fail("git_failed", prune.stderr);
    }
    const dotGit = join(target.path, ".git");
    if (!existsSync(dotGit) || lstatSync(dotGit).isDirectory()) return fail("not_worktree");
    const registered = await listWorktrees(git, repo.path);
    if (!registered.has(target.path) || target.path === realpathOr(repo.path)) return fail("not_worktree");
    // 분리된 HEAD 의 커밋은 git worktree remove 가 지켜 주지 않는다(reflog 도 함께 지워진다) — 어떤 브랜치에도 닿지 않으면 지우지 않는다
    const onBranch = await git(["symbolic-ref", "-q", "HEAD"], target.path);
    if (onBranch.code !== 0) {
      const head = await git(["rev-parse", "--verify", "--quiet", "HEAD"], target.path);
      const sha = head.stdout.trim();
      if (head.code === 0 && sha !== "") {
        if (!/^[0-9a-f]{7,64}$/.test(sha)) return fail("git_failed");
        const contains = await git(
          ["for-each-ref", "--count=1", "--format=%(refname)", "--contains", sha, "refs/heads"],
          repo.path,
        );
        if (contains.code !== 0) return fail("git_failed", contains.stderr);
        if (contains.stdout.trim() === "") return fail("unmerged_detached");
      }
    }
    const rm = await git(["worktree", "remove", "--", target.path], repo.path);
    if (rm.code === 0) return { ok: true };
    if (/contains modified or untracked files/.test(rm.stderr)) return fail("dirty", rm.stderr);
    return fail("git_failed", rm.stderr);
  } catch (e) {
    return fail("git_failed", isGitMissing(e) ? GIT_MISSING_MESSAGE : undefined);
  }
}
