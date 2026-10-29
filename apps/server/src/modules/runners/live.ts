/**
 * 붙은 러너에 묻는 REST 쪽 도우미 — 러너 어댑터의 hello 내용(메모리)·fs.list·project.check, 그리고 러너 천장과의 대조. 천장은
 * 러너가 런마다 다시 본다(RUNNER_CEILING) — 여기 대조는 만들고 고칠 때 화면에 바로 알리는 몫이다(러너 일반화 계획 Task 4)
 */
import {
  permissionModeRank,
  type RunnerCeilingItem,
  type RunnerPermissionMode,
  type RunnerProgram,
} from "@dodok/shared";
import type { RunnerAdapter, RunnerLive } from "@dodok/runner-adapter";
import { AdapterError } from "../../adapters/types";
import { apiError } from "../../http/errors";

/** 서버가 쓰는 러너 어댑터의 몫 — 러너 어댑터가 없으면(OpenClaw 만 붙인 테스트 앱) null */
export type RunnerLiveApi = Pick<RunnerAdapter, "runnerInfo" | "fsList" | "projectCheck">;

/**
 * 러너에 묻는다. 러너 어댑터가 없거나 러너가 붙어 있지 않으면 503 ADAPTER_UNAVAILABLE, 어댑터의 AdapterError 코드는 그대로 API 오류
 * 코드로(TIMEOUT 504·VALIDATION 400·INTERNAL 500 — 태스크 3 보고)
 */
export async function askRunner<T>(
  runners: RunnerLiveApi | null,
  ask: (api: RunnerLiveApi) => Promise<T>,
): Promise<T> {
  if (!runners) throw apiError("ADAPTER_UNAVAILABLE", "runner adapter not configured");
  try {
    return await ask(runners);
  } catch (err) {
    if (err instanceof AdapterError) throw apiError(err.code, err.message);
    throw err;
  }
}

/** 붙은 러너의 hello — 없으면 503(만들기·옮기기는 붙은 러너에만) */
export function liveRunner(runners: RunnerLiveApi | null, tokenId: string): RunnerLive {
  const live = runners?.runnerInfo(tokenId) ?? null;
  if (!live) throw apiError("ADAPTER_UNAVAILABLE", "runner is not connected");
  return live;
}

const beyond = (item: RunnerCeilingItem) =>
  apiError("VALIDATION", `러너 설정이 이 에이전트를 허용하지 않습니다(${item})`, { field: item });

/**
 * 러너 에이전트 정의가 붙은 러너의 천장 안인가(러너 일반화 스펙 2장 — 러너 ceiling.ts checkCeiling 과 같은 규칙). 준 필드만 본다 —
 * 만들기는 기본값을 채워 모두, 고치기(PATCH)는 바꾸는 항목만. 프로그램은 만들기(requireAvailable)면 그 러너가 알리고 쓸 수 있어야
 * 한다 — 고치기는 그 러너가 프로그램을 알리지 않으면 상한을 모르니 건너뛴다(런에서 러너가 거절한다). allowedTools 는 글자 그대로의
 * 부분집합(null 은 미리 허용한 도구가 없다 — 어느 상한에도 든다). 어긋나면 400 VALIDATION, details.field 는 항목 이름
 */
export function assertWithinCeiling(
  live: RunnerLive,
  program: RunnerProgram,
  fields: { permissionMode?: RunnerPermissionMode; allowedTools?: string[] | null },
  opts: { requireAvailable: boolean },
): void {
  const status = live.programs.find((p) => p.program === program);
  if (opts.requireAvailable && !status?.available) throw beyond("program");
  if (!status) return;
  const { maxPermissionMode, allowedToolsCeiling } = status.ceiling;
  if (
    fields.permissionMode !== undefined &&
    permissionModeRank(fields.permissionMode) > permissionModeRank(maxPermissionMode)
  )
    throw beyond("permissionMode");
  if (allowedToolsCeiling !== null && fields.allowedTools?.some((t) => !allowedToolsCeiling.includes(t)))
    throw beyond("allowedTools");
}
