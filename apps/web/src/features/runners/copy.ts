import type {
  RunnerPermissionMode,
  RunnerProject,
  RunnerProjectCheck,
  RunnerProjectRef,
  RunnerSummary,
} from "@dodok/shared";
import { ApiRequestError, NetworkError } from "@/api/http";

/**
 * 「러너」 탭·러너 에이전트 칸의 문구(러너 일반화 스펙 7·8장). 서버 문구는 보이지 않는다 — 코드·사유마다 고정 문구.
 * 사용자 매뉴얼(`docs/manual/user-guide.md`)이 같은 글을 옮겨 적는다
 */

/** 러너가 둘러보기를 껐다(fs.list FORBIDDEN) — 스펙 8장 표의 문구 그대로 */
export const BROWSE_OFF = "이 러너는 둘러보기를 끄고 있습니다 — 경로를 직접 입력하세요";

/** project.check 실패 사유 넷(shared `RunnerProjectCheckResult`) */
export const CHECK_REASON: Record<Extract<RunnerProjectCheck, { ok: false }>["reason"], string> = {
  root_missing: "러너가 이 루트를 알리지 않습니다 — 러너 머신의 설정에서 루트를 확인하세요",
  not_found: "디렉터리가 없습니다 — 경로를 확인하세요",
  not_directory: "디렉터리가 아니라 파일입니다 — 디렉터리를 고르세요",
  outside_root: "루트 밖을 가리킵니다(심볼릭 링크 등) — 루트 안의 디렉터리를 고르세요",
};

/** 「확인」 결과 한 줄 */
export function checkText(result: RunnerProjectCheck): string {
  if (!result.ok) return CHECK_REASON[result.reason];
  return result.isGitRepo ? "확인됨 · git 저장소" : "확인됨";
}

/** 러너가 끊김(503 ADAPTER_UNAVAILABLE, 또는 열린 대화상자의 러너가 끊김) */
export const RUNNER_OFFLINE = "러너가 연결되어 있지 않습니다 — 러너를 띄운 뒤 다시 시도하세요";
/** 러너가 제때 답하지 않음(504 TIMEOUT) */
export const RUNNER_TIMEOUT = "러너가 제때 답하지 않았습니다 — 다시 시도하세요";

/** 러너에 묻는 요청(둘러보기·확인·더하기·옮기기)의 실패 — 끊김·제한시간·네트워크. 그 밖은 undefined(부르는 쪽이 가른다) */
export function runnerRequestError(e: unknown): string | undefined {
  if (e instanceof NetworkError) return "서버에 연결할 수 없습니다";
  if (!(e instanceof ApiRequestError)) return undefined;
  if (e.code === "ADAPTER_UNAVAILABLE") return RUNNER_OFFLINE;
  if (e.code === "TIMEOUT") return RUNNER_TIMEOUT;
  return undefined;
}

/** 프로젝트 자리 — `루트 라벨/relPath`. 루트 라벨이 없으면(끊김·러너가 그 루트를 안 알림) 루트 id */
export function projectPlace(project: Pick<RunnerProject, "rootId" | "rootLabel" | "relPath">): string {
  const root = project.rootLabel ?? project.rootId;
  return project.relPath === "" ? root : `${root}/${project.relPath}`;
}

/** 프로젝트 이름 규칙 — 서버가 trim 뒤 1~64자로 거른다 */
export const PROJECT_LABEL_MAX = 64;
export const PROJECT_LABEL_RULE = "이름은 1~64자로 적어 주세요";

/** 루트 라벨이 없는 프로젝트(Review Focus 2 — 머신 주인이 루트 id 를 바꾸거나 지움). 러너가 끊겼을 때는 「끊김」이 카드에 있다 */
export const ROOT_MISSING = "루트 없음";

/** 권한 모드 이름 — 값(SDK 의 permissionMode)과 뜻을 함께 */
export const PERMISSION_MODE_LABEL: Record<RunnerPermissionMode, string> = {
  plan: "plan — 계획만(도구를 쓰지 않음)",
  dontAsk: "dontAsk — 미리 허용한 도구만, 나머지는 거절",
  default: "default — 쓰기 도구는 승인 카드",
  acceptEdits: "acceptEdits — 파일 편집은 묻지 않음",
};

/** 프로그램 로그인 상태(hello `programs[].auth`) */
export const AUTH_LABEL = { ok: "로그인됨", missing: "로그인 안 됨", unknown: "로그인 모름" } as const;

/** 러너가 쓰는 Claude 로그인(hello `programs[].login`) — 로그인 상태 뒤 괄호. 옛 러너는 싣지 않아 붙지 않는다 */
export const LOGIN_LABEL = { default: "평소 로그인", dedicated: "전용 로그인" } as const;

/** 프로젝트가 없는(0031 이 보관한) 러너 에이전트 — 계획 Task 5 Step 3 의 문구 그대로 */
export const NO_PROJECT_RESTORE = "프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요";

// ── git 워크트리(워크트리 스펙 5.5) — 서버 문구를 그대로 쓰지 않고 사유 코드마다 고정 문구

/** 「워크트리 만들기」 단추가 잠긴 사유(worktreeLock) */
export const WORKTREE_LOCK = {
  offline: "러너가 연결되어 있어야 워크트리를 만들 수 있습니다",
  revoked: "토큰이 폐기된 러너입니다",
  outdated: "러너를 업데이트하세요(워크트리는 0.7.0 부터)",
  notGit: "git 저장소의 맨 위 프로젝트에서만 만들 수 있습니다 — 「확인」으로 다시 확인하세요",
  isWorktree: "워크트리 안에는 워크트리를 만들 수 없습니다",
  archived: "보관한 프로젝트입니다",
} as const;

/** 러너 worktree.create 실패 사유(서버 400 `details.reason`) */
export const WORKTREE_CREATE_REASON: Record<string, string> = {
  not_git: "git 저장소가 아닙니다 — 「확인」으로 다시 확인하세요",
  is_worktree: WORKTREE_LOCK.isWorktree,
  target_exists: "그 위치에 이미 파일이 있습니다 — 다른 위치를 고르세요",
  outside_root: "러너의 허용 루트 밖입니다 — 루트 안의 위치를 고르세요",
  root_missing: "러너가 그 루트를 알리지 않습니다 — 러너 머신의 설정에서 루트를 확인하세요",
  branch_in_use: "그 브랜치는 다른 워크트리가 쓰고 있습니다 — 다른 브랜치를 적으세요",
  invalid_branch: "브랜치 이름이 올바르지 않습니다 — 공백·~^:?*[ 없이, - 로 시작하지 않게 적으세요",
  git_failed: "git 이 실패했습니다",
  runner_outdated: WORKTREE_LOCK.outdated,
  runner_offline: WORKTREE_LOCK.offline,
};

/** 보관(폴더 정리) 실패 사유(서버 409 `details.reason`·프로젝트 `cleanupIssue`) — 그 줄에 「폴더를 남기고 보관」과 함께 */
export const WORKTREE_CLEANUP_REASON: Record<string, string> = {
  dirty: "정리하지 못했습니다 — 커밋하지 않은 변경이 있습니다",
  runner_offline: "러너가 연결되어 있어야 정리할 수 있습니다",
  runner_revoked: "러너가 폐기되어 폴더를 정리할 수 없습니다",
  not_worktree: "정리하지 못했습니다 — 그 폴더가 워크트리가 아닙니다",
  git_failed: "정리하지 못했습니다 — git 이 실패했습니다",
};
export const KEEP_FOLDER = "폴더를 남기고 보관";
/** 보관이 막힌 사유(서버 409 `details.reason`) — W9·W11 */
export const ARCHIVE_BLOCKED: Record<string, string> = {
  active_worktrees: "워크트리를 먼저 보관하세요",
  active_agents: "에이전트를 먼저 보관하세요",
};
/** 워크트리 보관 확인 — 무엇이 지워지고 무엇이 남는가(W1·W7) */
export const WORKTREE_ARCHIVE_NOTE =
  "보관하면 러너가 워크트리 폴더를 지웁니다(브랜치는 남습니다). 무시된 파일(node_modules 등)은 함께 지워집니다.";

const SLUG_MAX = 40;
export const randomHex = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * 이름 → 폴더·브랜치 슬러그 — 서버 `slugOf`(apps/server runners/projects.ts)와 같은 규칙: 소문자 ASCII·숫자·`-` 만, 40자, 비면
 * `wt-<6 hex>`. hex 는 부르는 쪽이 고정해 넘긴다(입력마다 바뀌지 않게)
 */
export function slugOf(label: string, hex: string = randomHex()): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? `wt-${hex}` : slug;
}

/** 기본 위치 `<부모 relPath>/.worktrees/<슬러그>`(W3), 기본 브랜치 `dodok/<슬러그>`(W6) */
export function worktreeDefaults(
  parent: Pick<RunnerProject, "rootId" | "relPath">,
  label: string,
  hex?: string,
): { branch: string; location: RunnerProjectRef } {
  const slug = slugOf(label, hex);
  return {
    branch: `dodok/${slug}`,
    location: {
      rootId: parent.rootId,
      relPath: parent.relPath === "" ? `.worktrees/${slug}` : `${parent.relPath}/.worktrees/${slug}`,
    },
  };
}

/** 그 프로젝트에서 워크트리를 만들 수 없는 사유 — 없으면 undefined */
export function worktreeLock(
  parent: Pick<RunnerProject, "isGit" | "parentProjectId" | "archivedAt">,
  runner: Pick<RunnerSummary, "connected" | "revoked" | "capabilities">,
): string | undefined {
  if (parent.parentProjectId !== null) return WORKTREE_LOCK.isWorktree;
  if (parent.archivedAt !== null) return WORKTREE_LOCK.archived;
  if (runner.revoked) return WORKTREE_LOCK.revoked;
  if (!runner.connected) return WORKTREE_LOCK.offline;
  if (!runner.capabilities.includes("worktrees")) return WORKTREE_LOCK.outdated;
  if (!parent.isGit) return WORKTREE_LOCK.notGit;
  return undefined;
}

/** 워크트리의 이름 표시 — `<부모 이름> · <브랜치>`(스펙 5.5). 부모를 모르면 자기 이름 */
export function worktreeName(
  project: Pick<RunnerProject, "label" | "parentProjectId" | "branch">,
  projects: readonly Pick<RunnerProject, "id" | "label">[],
): string {
  if (project.parentProjectId === null) return project.label;
  const parent = projects.find((p) => p.id === project.parentProjectId);
  return parent && project.branch ? `${parent.label} · ${project.branch}` : project.label;
}
