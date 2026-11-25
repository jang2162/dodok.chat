import type {
  AgentCommand,
  AppMcpCeiling,
  BackgroundTask,
  InboundDeliver,
  RunnerFollowupRequest,
  RunnerFollowupResult,
  RunnerEffort,
  RunnerPermissionMode,
  RunnerProgram,
  RunnerProgramCapability,
  RunnerProgramStatus,
  RunnerRunStart,
} from "@dodok/shared";
import type { ProgramCeiling } from "./config";
import type { RunSink } from "./sink";

/** 추가 응답 런 하나 — 연결이 그 런 id 로 sink 와 중지 signal(run.abort)을 만든다. 턴이 끝나면 close */
export type FollowupRun = { sink: RunSink; signal: AbortSignal; close(): void };

/**
 * 백그라운드 작업(백그라운드 작업 스펙 5.3·5.4) — 드라이버가 런보다 오래 사는 작업을 서버에 알리는 길. 연결이 채운다
 * (createBackgroundHooksSlot). 드라이버는 연결보다 먼저 만들어지므로 자리를 먼저 받고 연결이 나중에 잇는다
 */
export type BackgroundHooks = {
  /** CLI 가 작업 알림 뒤 스스로 연 턴 — 서버에 추가 응답 런을 청한다. 끊겨 있거나 답이 없으면 { ok: false, reason: "unknown" } */
  requestFollowup(req: RunnerFollowupRequest): Promise<RunnerFollowupResult>;
  /** 서버가 받아 준 추가 응답 런의 sink·signal */
  openFollowup(run: { runId: string; deliver: InboundDeliver; workdir: string }): FollowupRun;
  /** 그 세션의 작업 전체가 바뀌었다(바꿔 끼우는 값) — 연결이 세션마다 묶어 tasks.update 로 낸다 */
  tasksChanged(sessionKey: string, tasks: BackgroundTask[]): void;
  /** 그 세션의 프로세스를 붙들기 시작했다·놓았다 — 스케줄러 자리 하나 */
  held(sessionKey: string, holding: boolean): void;
  /**
   * 지금 프로세스를 붙들어도 되나 — 서버가 마지막 hello 결과에 backgroundTasks 를 알렸을 때만 참(리뷰 C1). 옛 서버는 추가 응답·작업
   * 끄기·세션 놓기를 보내지 않아 붙든 프로세스를 끌 길이 없다. 거짓이면 첫 result 에서 닫는다(지금 동작)
   */
  canHold(): boolean;
};

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
  /** null·없음이면 프로그램 기본 — 천장이 없다(세션 설정 스펙 5.6) */
  effort?: RunnerEffort | null;
  permissionMode: RunnerPermissionMode;
  /** null 이면 미리 허용한 도구가 없다 */
  allowedTools: string[] | null;
  /** 설정의 disallowedTools 와 에이전트의 것을 합친 것 — 드라이버가 늘 막는 도구는 드라이버가 더한다 */
  disallowedTools: string[];
  /** 앱 MCP 천장(러너 로컬 appMcp·appMcpCommands·allowedToolsCeiling — 러너 봇 2부 스펙 T2). 없으면 앱 MCP 를 모두 막는다 */
  appMcp?: AppMcpCeiling;
};

export type ProgramDetection = Pick<
  RunnerProgramStatus,
  "available" | "version" | "auth" | "reason" | "login" | "cli" | "models"
>;

export interface ProgramDriver {
  program: RunnerProgram;
  /** 사람에게 보이는 프로그램 이름 — 오류 문구(「러너의 <이름> 로그인을 확인하세요」)에 쓴다 */
  label: string;
  capabilities: Record<RunnerProgramCapability, boolean>;
  /** 설치·판본·로그인 상태. 던지지 않는다 — 못 쓰면 available false 와 사유 */
  detect(ceiling: ProgramCeiling): Promise<ProgramDetection>;
  startRun(spec: RunSpec, sink: RunSink, signal: AbortSignal): Promise<void>;
  /**
   * 그 프로젝트(workdir)에서 쓸 수 있는 명령(commands.list — 에이전트 명령 C8). 없으면 그 프로그램은 명령 목록이 없다. 던질 수 있다 —
   * 연결이 failed 로 답한다
   */
  listCommands?(args: { workdir: string; configDir?: string; signal: AbortSignal }): Promise<AgentCommand[]>;
  /**
   * 백그라운드 작업(백그라운드 작업 스펙 5.2·5.5) — 런보다 오래 사는 작업을 쥐는 드라이버만. 있으면 연결이 hello 에 능력
   * backgroundTasks 를 싣는다
   */
  background?: {
    /** 화면의 「종료」 — 없는 세션·작업이면 false */
    stopTask(sessionKey: string, taskId: string): Promise<boolean>;
    /** 세션 닫기·보관 — 도는 턴을 멈추고 작업을 모두 끈 채 프로세스를 닫는다 */
    release(sessionKey: string): void;
    /** 작업이 남은 세션마다 지금 목록 — 다시 붙은 뒤 한 번씩 보낸다 */
    held(): Array<{ sessionKey: string; tasks: BackgroundTask[] }>;
  };
}

/** hello 의 programs[].capabilities — 드라이버가 할 수 있는 것만 */
export const capabilityList = (driver: ProgramDriver): RunnerProgramCapability[] =>
  (Object.keys(driver.capabilities) as RunnerProgramCapability[]).filter((c) => driver.capabilities[c]);
