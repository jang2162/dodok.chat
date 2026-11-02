import type {
  RunnerPermissionMode,
  RunnerProgram,
  RunnerProgramCapability,
  RunnerProgramStatus,
  RunnerRunStart,
} from "@dodok/shared";
import type { ProgramCeiling } from "./config";
import type { RunSink } from "./sink";

// 프로그램 드라이버 계약(러너 일반화 스펙 4장). 연결은 천장 검사를 마친 런을 RunSpec 으로 풀어 드라이버에 넘기고, 드라이버는
// 결과를 sink 로만 낸다 — final·error 중 하나를 한 번 내고 던지지 않는다. 이번 드라이버는 drivers/claude 하나다

/** 천장 검사를 통과한 런 하나 — 경로는 러너 안에서만 쓰는 풀린 절대 경로다 */
export type RunSpec = {
  start: RunnerRunStart;
  /** 프로젝트 디렉터리의 realpath — 루트 안임을 천장 검사가 확인했다 */
  workdir: string;
  /** 그 프로그램의 전용 로그인 디렉터리(설정 programs.<program>.configDir). 없으면 평소 로그인(러너 프로세스의 CLAUDE_CONFIG_DIR 또는 ~/.claude) */
  configDir?: string;
  model: string | null;
  permissionMode: RunnerPermissionMode;
  /** null 이면 미리 허용한 도구가 없다 */
  allowedTools: string[] | null;
  /** 설정의 disallowedTools 와 에이전트의 것을 합친 것 — 드라이버가 늘 막는 도구는 드라이버가 더한다 */
  disallowedTools: string[];
};

export type ProgramDetection = Pick<RunnerProgramStatus, "available" | "version" | "auth" | "reason">;

export interface ProgramDriver {
  program: RunnerProgram;
  /** 사람에게 보이는 프로그램 이름 — 오류 문구(「러너의 <이름> 로그인을 확인하세요」)에 쓴다 */
  label: string;
  capabilities: Record<RunnerProgramCapability, boolean>;
  /** 설치·판본·로그인 상태. 던지지 않는다 — 못 쓰면 available false 와 사유 */
  detect(ceiling: ProgramCeiling): Promise<ProgramDetection>;
  startRun(spec: RunSpec, sink: RunSink, signal: AbortSignal): Promise<void>;
}

/** hello 의 programs[].capabilities — 드라이버가 할 수 있는 것만 */
export const capabilityList = (driver: ProgramDriver): RunnerProgramCapability[] =>
  (Object.keys(driver.capabilities) as RunnerProgramCapability[]).filter((c) => driver.capabilities[c]);
