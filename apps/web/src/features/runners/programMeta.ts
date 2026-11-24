import { RUNNER_PROGRAM_NAME, RunnerProgram, type RunnerProgramStatus } from "@dodok/shared";

/**
 * 러너 프로그램의 웹 표 한 곳(연결 재설계 스펙 목표 4) — 이름·배지 글자·색. 새 프로그램은 여기에 한 줄 더하면
 * 트리 배지·러너 프로그램 카드·에이전트 칩·활동 카드가 함께 따라온다. 상표 로고는 쓰지 않는다.
 * tone 은 에이전트 색 토큰으로 칠한다(ProgramBadge) — 새 하드코딩 색을 두지 않는다
 */
export const PROGRAM_META: Record<
  RunnerProgram,
  { name: string; short: string; tone: "clay" | "blue" | "violet" }
> = {
  claude: { name: RUNNER_PROGRAM_NAME.claude, short: "CC", tone: "clay" },
  codex: { name: RUNNER_PROGRAM_NAME.codex, short: "CX", tone: "blue" },
  opencode: { name: RUNNER_PROGRAM_NAME.opencode, short: "OC", tone: "violet" },
};

/**
 * 프로그램 카드 한 줄의 상태 — 쓸 수 있음 · 로그인 필요(auth missing) · 설치 안 됨(available false) ·
 * 로그인 확인 안 됨(auth unknown, 칩 없음) · 지원 예정(enum 에 있는데 이 러너 판이 알리지 않음)
 */
export type ProgramRowState = "available" | "login" | "not-installed" | "unknown-auth" | "unsupported";

export type ProgramRows =
  | { kind: "disconnected" }
  | {
      kind: "rows";
      rows: Array<{ program: RunnerProgram; state: ProgramRowState; status?: RunnerProgramStatus }>;
    };

function stateOf(status: RunnerProgramStatus): ProgramRowState {
  if (!status.available) return "not-installed";
  if (status.auth === "missing") return "login";
  if (status.auth === "unknown") return "unknown-auth";
  return "available";
}

/**
 * 러너 hello 의 programs 를 enum 순서의 줄로. 끊긴 러너는 programs 가 빈 목록으로 오므로 「지원 예정」 줄을 만들지 않고
 * disconnected 하나로 답한다(스펙 목표 4)
 */
export function programRows(programs: RunnerProgramStatus[], connected: boolean): ProgramRows {
  if (!connected) return { kind: "disconnected" };
  return {
    kind: "rows",
    rows: RunnerProgram.options.map((program) => {
      // 같은 프로그램이 두 번 오면 앞의 것
      const status = programs.find((p) => p.program === program);
      return status ? { program, state: stateOf(status), status } : { program, state: "unsupported" };
    }),
  };
}
