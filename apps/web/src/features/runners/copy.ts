import type { RunnerPermissionMode, RunnerProject, RunnerProjectCheck } from "@dodok/shared";
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
