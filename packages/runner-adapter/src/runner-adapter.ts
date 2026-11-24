/**
 * `AgentAdapter` 의 러너 구현 — 러너 스펙 3·4.5·5·6·8장, 러너 일반화 스펙 3·4·5장.
 *
 * 러너가 사람 머신에서 `/runner` 네임스페이스로 붙는다(판정 P1). 러너는 천장(루트·프로그램·권한 상한)만 쥐고, 런 하나 = `run.start`
 * 하나에 서버가 에이전트 정의(프로젝트·프로그램·권한·도구 — agentDefinition)를 통째로 싣는다. 러너가 정규화한 `run.event` 를 받아
 * 오케스트레이터 신호로 옮기고, `run.final` 의 최종 답은 `onOutbound` 로 채널 메시지를 만든다 — OpenClaw 의 정본(`onCanonical`)과 같은 자리
 */
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterLogger,
  type AgentAdapter,
  type BridgeAuthGuard,
  buildChannelRulesAppend,
  type ControlResult,
  buildTurnFacts,
  type RunnerAdapterStatus,
  type RunnerSetupDetail,
  dodokSessionKey,
  parseDodokSessionKey,
  ErrorCode,
  type InboundDeliver,
  type OutboundMessage,
  permissionModeRank,
  resolvePermissionMode,
  type RunEventBody,
  type RunEventType,
  RUNNER_BOT_MCP_UPDATE_MESSAGE,
  RUNNER_BOTS_UPDATE_MESSAGE,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RUNNER_SHUTDOWN_STOP_REASON,
  RunnerApprovalRequested,
  type RunnerCeilingItem,
  RunnerApprovalWithdrawn,
  type RunnerClientToServerEvents,
  RunnerControlCall,
  RunnerFollowupRequest,
  type RunnerFollowupResult,
  RunnerTaskStopResult,
  RunnerTasksUpdate,
  RunnerCommandsList,
  RunnerCommandsListResult,
  RUNNER_COMMANDS_LIST_TIMEOUT_MS,
  RUNNER_UPDATE_ACK_TIMEOUT_MS,
  RunnerUpdate,
  RunnerUpdateResult,
  RunnerFsListResult,
  RunnerHello,
  type RunnerHelloResult,
  RunnerOutboundPost,
  type RunnerOutboundAck,
  RunnerProjectCheckResult,
  RunnerProjectRef,
  RunnerWorktreeCreate,
  RunnerWorktreeCreateResult,
  RunnerWorktreeRemove,
  RunnerWorktreeRemoveResult,
  type RunnerBotDefinition,
  type RunnerCapability,
  RunnerRunAck,
  type RunnerPermissionMode,
  type RunnerRunAgent,
  type RunnerRunBot,
  RunnerRunError,
  RunnerRunEvent,
  RunnerRunFinal,
  RunnerRunSession,
  RunnerRunStart,
  type RunnerServerToClientEvents,
  type RunSignal,
  type RunUsage,
} from "@dodok/shared";
import type { Namespace, Server, Socket } from "socket.io";
import type { z } from "zod";
import { RUNNER_APPROVAL_TTL_MS, RunnerApprovals } from "./approvals";
import {
  createRunner,
  type Runner,
  type RunnerLive,
  RunnerRegistry,
  type RunnerSocket,
  runnerLive,
} from "./connections";

export { RUNNER_APPROVAL_TTL_MS, type RunnerLive };

/** 핸드셰이크 `auth.token`(외부 입력 그대로)을 보고 통과면 그 토큰의 id·라벨, 아니면 null */
export type RunnerTokenVerifier = (presented: unknown) => { tokenId: string; label: string } | null;

/**
 * 러너 프레임 버킷 이름 — `run.event`(스트리밍 델타)와 나머지(hello·post·수명·승인)를 나눈다. 열린 런·기다리는 승인을 가리키는
 * 종결·승인 프레임 가운데 처리기가 받아들일 것은 버킷을 거치지 않는다(승인 요청은 런마다 누계 RUN_FREE_APPROVALS 개까지 —
 * namesOpenWork)
 */
export type RunnerFrameBucket = "events" | "control";

/**
 * 러너가 보내는 프레임의 속도 제한 — 러너 소켓마다 buckets() 를 한 번 부른다(숫자는 서버 LIMITS.runner). 넘친 프레임은 버리고
 * onLimited 는 주소별 1분에 한 번, 그사이 버린 수(dropped)와 함께 부른다
 */
export type RunnerFrameLimit = {
  buckets: () => Record<RunnerFrameBucket, { take(): boolean }>;
  onLimited: (address: string, frame: string, dropped: number) => void;
};

/**
 * run.start 에 실을 러너 에이전트 정의 — 서버가 에이전트 행·프로젝트 행에서 만든다(러너 일반화 스펙 3장). agent 는 shared
 * RunnerRunAgent 그대로다 — 러너는 runId 를 못 읽는 형식 오류면 카드 없이 버리므로 서버가 더 넓은 상한을 두면 런이 흔적 없이
 * 사라진다(태스크 2 리뷰 M3). instructions 는 에이전트 지시(agents.base_prompt) — 채널 규칙 틀 앞에 싣는다(계획 판정 PR1)
 */
export type RunnerAgentDefinition = {
  name: string;
  instructions: string | null;
  /**
   * 봇의 정의(러너 봇 스펙 B9) — 있으면 instructions 대신 봇 정의 틀을 싣는다. agent.bot(봇 폴더 id·SOUL.md 본문)과 함께 온다. 능력
   * bots 가 없는 러너에는 보내지 않는다(B7)
   */
  botDefinition?: RunnerBotDefinition;
  /** permissionMode null 은 권한 「기본」 — send 가 그 러너의 hello 상한으로 min(default, 상한)을 채운다(세션 설정 스펙 S5) */
  agent: Omit<RunnerRunAgent, "permissionMode"> & { permissionMode: RunnerPermissionMode | null };
};

// 권한 「기본」 계산은 웹(「기본 · <모드>」)과 같은 값이어야 해 shared 로 옮겼다 — 이 패키지의 내보내기는 그대로 둔다
export { resolvePermissionMode };

/** fs.list·project.check 의 ack 상한 — 러너가 디렉터리 하나를 읽는 시간 */
export const RUNNER_FS_ACK_TIMEOUT_MS = 10_000;

/** worktree.create·worktree.remove 의 ack 상한 — git 이 체크아웃·삭제에 오래 걸릴 수 있다(워크트리 스펙 5.2) */
export const RUNNER_GIT_ACK_TIMEOUT_MS = 30_000;

export type RunnerAdapterOptions = {
  /** 서버의 Socket.IO — 이 어댑터가 `io.of(RUNNER_NAMESPACE)` 를 맡는다 */
  io: Server;
  verifyToken: RunnerTokenVerifier;
  /** 거절 로그·실패 카운터의 원격 주소. 던지면 `handshake.address` */
  clientAddress: (socket: Socket) => string;
  /** 거절 로그의 주소 꼴(서버가 IP 를 가린다). 없으면 그대로 — 실패 카운터·스로틀은 원래 주소 */
  logAddress?: (address: string) => string;
  /** 브리지·첨부 HTTP 와 같은 인스턴스(러너 스펙 5장) — 막힌 주소는 토큰을 보지 않고 거절한다 */
  authGuard: BridgeAuthGuard;
  onBlocked: (address: string) => void;
  now: () => number;
  serverVersion: string;
  logger: AdapterLogger;
  /** run.start 에 실을 채널 이름·새 세션 제목 */
  channelName: (channelId: string) => string | undefined;
  /** outbound.post·최종 답을 서버가 받아 메시지를 만든다 — 오케스트레이터의 onCanonical 과 같은 자리. connectionId 는 보낸 러너의 토큰 id */
  onOutbound: (m: OutboundMessage, connectionId: string) => Promise<{ messageId: string }>;
  /** AdapterStatus.runners.tokens */
  tokenCount: () => number;
  /**
   * 제어 도구 호출(control.call)을 서버가 처리한다 — connectionId 는 보낸 러너의 토큰 id. 확인 카드를 기다리는 동안 늦게 끝나고
   * (최대 CONTROL_CONFIRM_TTL_MS), 던지지 않고 결과를 돌려준다. 없으면 호출마다 ADAPTER_UNAVAILABLE
   */
  onControlCall?: (connectionId: string, call: RunnerControlCall) => Promise<ControlResult>;
  /**
   * 백그라운드 작업이 끝나 러너의 CLI 가 스스로 연 턴(run.followup — 백그라운드 작업 스펙 5.5) — 서버가 추가 응답 런을 만들어 돌려준다.
   * 받아 준 런은 이 어댑터가 「도는 중」인 러너의 런으로 쫓는다. 없으면 늘 unknown 으로 거절한다
   */
  onFollowup?: (connectionId: string, req: RunnerFollowupRequest) => Promise<RunnerFollowupResult>;
  /** 러너가 알린 그 세션의 작업 전체(tasks.update), 또는 그 러너가 빠졌다({ disconnected: true }) — 서버가 작업 목록을 쥔다 */
  onTasks?: (connectionId: string, update: RunnerTasksUpdate | { disconnected: true }) => void;
  approvalTtlMs?: number;
  /**
   * 그 토큰의 러너가 맡는 러너 에이전트(providerAgentId)의 정의. 없으면(그 토큰의 러너 에이전트가 아니다·프로젝트가 없다) null.
   * 던지지 않는다
   */
  agentDefinition: (
    providerAgentId: string,
    tokenId: string,
    conversationId?: string,
  ) => RunnerAgentDefinition | null;
  frameLimit: RunnerFrameLimit;
};

export interface RunnerAdapter extends AgentAdapter {
  readonly provider: "runner";
  status(): RunnerAdapterStatus;
  setupDetail(): RunnerSetupDetail;
  /**
   * 러너 첨부 GET 의 읽기 범위(조율자 판정 R5) — 그 토큰의 러너에 지금 열린 런의 deliver 로 보낸 첨부면 true. 런이 끝나거나
   * 러너가 끊기면 곧바로 false 다(열린 런 추적에서 빠진다)
   */
  mayReadAttachment(tokenId: string, attachmentId: string): boolean;
  /** 그 토큰으로 지금 붙은 러너가 hello 로 알린 것. 붙어 있지 않으면 null */
  runnerInfo(tokenId: string): RunnerLive | null;
  /**
   * 그 러너의 디렉터리 하나(러너 일반화 스펙 3장 fs.list). 러너가 붙어 있지 않으면 ADAPTER_UNAVAILABLE, ack 가
   * RUNNER_FS_ACK_TIMEOUT_MS 안에 없으면 TIMEOUT, 요청이 RunnerProjectRef 밖이면 VALIDATION — 모두 AdapterError
   */
  fsList(tokenId: string, ref: RunnerProjectRef): Promise<RunnerFsListResult>;
  /** 그 러너에서 프로젝트 자리가 쓸 만한가(project.check) — 오류는 fsList 와 같다 */
  projectCheck(tokenId: string, ref: RunnerProjectRef): Promise<RunnerProjectCheckResult>;
  /** 그 러너에 git 워크트리를 만든다(worktree.create) — ack 상한 RUNNER_GIT_ACK_TIMEOUT_MS, 오류는 fsList 와 같다 */
  worktreeCreate(tokenId: string, req: RunnerWorktreeCreate): Promise<RunnerWorktreeCreateResult>;
  /** 그 러너의 git 워크트리 폴더를 지운다(worktree.remove) — 오류는 worktreeCreate 와 같다 */
  worktreeRemove(tokenId: string, req: RunnerWorktreeRemove): Promise<RunnerWorktreeRemoveResult>;
  /**
   * 그 러너의 그 프로젝트에서 쓸 수 있는 명령(commands.list — 에이전트 명령 스펙 C8). ack 상한 RUNNER_COMMANDS_LIST_TIMEOUT_MS(30초),
   * 오류는 fsList 와 같다. 능력 commands 가 없는 러너에는 부르지 않는다(부르는 쪽이 hasCapability 로 본다)
   */
  commandsList(tokenId: string, req: RunnerCommandsList): Promise<RunnerCommandsListResult>;
  /**
   * 원격 업데이트(원격 업데이트 스펙 U3, runner.update) — 러너가 npm 설치를 끝내고 답한다(ack 상한 RUNNER_UPDATE_ACK_TIMEOUT_MS). 오류는
   * fsList 와 같다. 능력 remoteUpdate 가 없는 러너에는 부르지 않는다
   */
  runnerUpdate(tokenId: string, version: string): Promise<RunnerUpdateResult>;
  /** 그 토큰으로 지금 붙은 러너가 hello 로 그 능력을 알렸나. 붙어 있지 않으면 false */
  hasCapability(tokenId: string, capability: RunnerCapability): boolean;
  /**
   * 화면의 「종료」(task.stop) — 그 러너가 그 세션의 작업을 끄면 true. 러너가 붙어 있지 않거나 능력 backgroundTasks 가 없거나 답이
   * RUNNER_FS_ACK_TIMEOUT_MS 안에 없으면 false. 끈 결과(목록)는 tasks.update 로 따로 온다
   */
  stopTask(connectionId: string, sessionKey: string, taskId: string): Promise<boolean>;
  /** 세션 닫기·보관·내보내기(session.release) — 능력 backgroundTasks 가 있는 붙은 러너에만 보낸다 */
  releaseSession(connectionId: string, sessionKey: string): void;
  capabilitiesFor(providerAgentId: string, connectionId: string | null): AdapterCapabilities;
}

/** 연결 뒤 hello 를 기다리는 상한 — 넘으면 전송을 끊는다. 러너의 detect(판 읽기 + 모델 목록 받기)가 이 안에 끝나야 한다 */
export const HELLO_TIMEOUT_MS = 10_000;
const RUN_START_ACK_TIMEOUT_MS = 15_000;
const REJECT_LOG_INTERVAL_MS = 60_000;
const REJECT_LOG_MAX_ADDRESSES = 1_024;
const LIMIT_LOG_INTERVAL_MS = 60_000;
/** 한 런이 control 버킷을 거치지 않고 받을 수 있는 승인 요청의 누계 — 넘으면 그다음 요청부터 버킷을 센다 */
export const RUN_FREE_APPROVALS = 32;
const USAGE_EVENT = "dodok.usage";
/** interrupt 로 끝난 턴의 run.final stopReason */
const ABORTED_STOP_REASON = "aborted";
const UNKNOWN_FRAME_LOG_INTERVAL_MS = 60_000;
const SESSION_TITLE_MAX = 120;
/** 최종 답 글 상한 — 정본 OutboundMessage.text·Message.bodyMd 의 상한과 같다 */
const FINAL_TEXT_MAX = 100_000;
const FINAL_TRUNCATED_TAIL = "\n\n(길어서 잘렸습니다)";
// 러너가 보낼 수 있는 프레임 이름 — 나머지는 Socket.IO 가 조용히 버리므로 따로 warn 한다
const RUNNER_FRAMES: ReadonlySet<string> = new Set<keyof RunnerClientToServerEvents>([
  "hello",
  "run.session",
  "run.event",
  "run.final",
  "run.error",
  "outbound.post",
  "approval.requested",
  "approval.withdrawn",
  "control.call",
  "tasks.update",
  "run.followup",
]);
// 프레임이 쓰는 버킷 — run.event 는 모델 델타마다 오므로 따로 넉넉하게, 나머지는 런마다 몇 번뿐이다. 열린 런·기다리는 승인을
// 가리키는 종결·승인 프레임 가운데 처리기가 받아들일 것은 버킷을 거치지 않는다(승인 요청은 런마다 누계 RUN_FREE_APPROVALS 개까지
// — namesOpenWork)
export const FRAME_BUCKET: Record<keyof RunnerClientToServerEvents, RunnerFrameBucket> = {
  hello: "control",
  "run.session": "control",
  "run.event": "events",
  "run.final": "control",
  "run.error": "control",
  "outbound.post": "control",
  "approval.requested": "control",
  "approval.withdrawn": "control",
  "control.call": "control",
  "tasks.update": "events",
  "run.followup": "control",
};

/**
 * 러너가 `run.event` 로 보낼 수 있는 변형. 수명(RUN_*)·승인(APPROVAL_*)·대기(RUN_QUEUED)·상태(STATE_SNAPSHOT)는 서버와 이 어댑터가
 * 만드는 사실이라 러너가 지어내면 런 상태·승인 카드를 흉내 낼 수 있다
 */
const RUNNER_EVENT_TYPES: ReadonlySet<RunEventType> = new Set<RunEventType>([
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_REPLACE",
  "TEXT_MESSAGE_END",
  // 추론 — 옛 서버는 이 타입을 계약 밖으로 읽어 그 이벤트만 버린다(onRunEvent 의 safeParse — 런은 이어진다)
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_RESULT",
  "STEP_STARTED",
  "STEP_FINISHED",
  // 서브에이전트 줄(백그라운드 작업 스펙 5.4) — subagentRunId 는 러너가 지은 표시용 키다. 서버 런을 가리키지 않는다(웹은 줄 키로만 쓴다)
  "SUBAGENT_STARTED",
  "SUBAGENT_FINISHED",
  "SUBAGENT_ERROR",
  "CUSTOM",
]);
// 비용은 run.final 에서만 만든다 — 러너가 CUSTOM 으로 다른 값을 겹쳐 쓰지 못하게
const RESERVED_CUSTOM_NAMES: ReadonlySet<string> = new Set([USAGE_EVENT, "openclaw.usage"]);

type RunTrack = {
  runId: string;
  runner: Runner;
  deliver: InboundDeliver;
  /** 비용 이벤트의 모델 — 에이전트 정의의 모델(null 이면 프로그램 기본이라 싣지 않는다) */
  model: string | null;
  /** 서버가 세션 id 를 정한 런 — 그러면 run.session 을 받지 않는다 */
  serverSessionIds: boolean;
  started: boolean;
  openTools: Set<string>;
  aborted: boolean;
  /** control 버킷 밖으로 받은 승인 요청의 누계 — 철회·결정에도 줄지 않는다(까닭은 namesOpenWork) */
  freeApprovals: number;
  /** run.start 의 dispatch ack 전이면 — 러너가 끊기면 곧바로 send 를 끝낸다 */
  rejectAck?: (error: AdapterError) => void;
};

type SocketAuth = { tokenId?: string; label?: string };

/**
 * DISCONNECT 패킷 없이 전송만 닫는다 — 러너는 `transport close` 로 받아 백오프 재접속한다(Ruling R4). 서버 종료·hello 타임아웃처럼
 * 러너 잘못이 아닌 끊김에 쓴다. `disconnect(true)` 는 러너에 `io server disconnect` 로 가고 러너는 종료한다(토큰 폐기·같은 토큰 교체·
 * hello 거절 — 다시 붙어도 소용없는 끊김)
 */
function dropTransport(socket: { conn: { close(): void } }): void {
  socket.conn.close();
}

/** 코드 포인트 경계에서 UTF-16 길이 max 안으로 자른다 — 서로게이트 쌍을 반으로 가르지 않는다(스키마 길이는 UTF-16) */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * 최종 답을 정본 상한 안으로 — 넘치면 꼬리를 붙여 자른다. 러너 계약(RunnerRunFinal.text)에는 상한이 없고 저장이 스키마에 걸리면
 * 스냅숏도 같은 글로 실패해 답이 조용히 사라진다(최종 리뷰 M1). 어느 판본의 러너가 붙어도 막히게 러너가 아니라 여기서 자른다
 */
function fitFinalText(text: string): string {
  if (text.length <= FINAL_TEXT_MAX) return text;
  return clip(text, FINAL_TEXT_MAX - FINAL_TRUNCATED_TAIL.length) + FINAL_TRUNCATED_TAIL;
}

/**
 * 그 러너의 능력에 맞춘 봇 런 자리(러너 봇 2부 스펙 T5·T7) — MCP 가 있는 봇인데 botMcp 가 없는 러너면 run_error(VALIDATION, 「러너를
 * 업데이트하세요」), MCP 가 없으면 옛 러너에도 그대로 간다. runnerControl 이 없는 러너에는 내장 도구를 빼고 보낸다(대화는 되게)
 */
function botForRunner(bot: RunnerRunBot, runner: { capabilities: readonly string[] }): RunnerRunBot {
  const { mcpServers, mcpAutoAllow, builtinTools, ...rest } = bot;
  const hasMcp = mcpServers !== undefined && Object.keys(mcpServers).length > 0;
  if (hasMcp && !runner.capabilities.includes("botMcp"))
    throw new AdapterError("VALIDATION", RUNNER_BOT_MCP_UPDATE_MESSAGE);
  return {
    ...rest,
    ...(hasMcp ? { mcpServers } : {}),
    ...(hasMcp && mcpAutoAllow !== undefined ? { mcpAutoAllow } : {}),
    ...(builtinTools !== undefined && builtinTools.length > 0 && runner.capabilities.includes("runnerControl")
      ? { builtinTools }
      : {}),
  };
}

function issues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

export function createRunnerAdapter(opts: RunnerAdapterOptions): RunnerAdapter {
  const { logger, now } = opts;
  const namespace = opts.io.of(RUNNER_NAMESPACE) as unknown as Namespace<
    RunnerClientToServerEvents,
    RunnerServerToClientEvents
  >;
  const handlers = new Set<(e: AdapterEvent) => void>();
  const registry = new RunnerRegistry();
  const runs = new Map<string, RunTrack>();
  // hello 전 연결까지 — 폐기는 hello 여부와 무관하게 그 토큰의 연결을 전부 끊는다
  const sockets = new Map<string, { socket: RunnerSocket; tokenId: string }>();
  const helloTimers = new Set<ReturnType<typeof setTimeout>>();
  const rejectLog = new Map<string, { at: number; suppressed: number }>();
  const limitLog = new Map<string, { at: number; suppressed: number }>();
  const inflightPosts = new Map<string, Promise<{ messageId: string }>>();
  let closed = false;
  // 러너는 매 런 채널 규칙을 싣고(판정 P3) 세션 id 는 프로그램마다 다르다 — 어댑터 전체 값은 Claude 처럼 서버가 정하는 쪽이고
  // 런은 capabilitiesFor 가 그 러너·그 프로그램의 값으로 가른다(러너 일반화 계획 판정 PR3). agentsList 는 false — 러너는 에이전트를
  // 알리지 않는다(앱에서 러너 프로젝트로 만든다)
  const capabilities: AdapterCapabilities = {
    agentsList: false,
    configSet: true,
    promptEveryRun: true,
    serverSessionIds: true,
  };

  function emit(event: AdapterEvent) {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error({ err: error, kind: event.kind }, "adapter event handler threw");
      }
    }
  }
  // 연결 id 는 그 런을 맡은 러너의 토큰 id(멀티 Gateway 스펙 「어댑터 계약」 절) — 서버가 런의 연결과 대조한다
  const emitEvent = (connectionId: string, runId: string, event: RunEventBody) =>
    emit({ kind: "run_event", runId, connectionId, event });
  const emitSignal = (connectionId: string, runId: string, signal: RunSignal) =>
    emit({ kind: "run_signal", runId, connectionId, signal });

  const status = (): RunnerAdapterStatus => ({
    provider: "runner",
    runners: { connected: registry.size, tokens: opts.tokenCount() },
  });
  const setupDetail = (): RunnerSetupDetail => ({ provider: "runner", runners: registry.connections() });
  function announceRunners() {
    emit({ kind: "status", status: status(), capabilities: { ...capabilities } });
    emit({ kind: "setup" });
  }

  /** 정의를 읽다 던지면 없는 것으로 — 런은 send 가 닫고, 능력은 어댑터 전체 값으로 */
  function definitionOf(
    providerAgentId: string,
    tokenId: string,
    conversationId?: string,
  ): RunnerAgentDefinition | null {
    try {
      return opts.agentDefinition(providerAgentId, tokenId, conversationId);
    } catch (error) {
      logger.error(
        { err: error, agentId: providerAgentId, tokenId },
        "runner agent definition lookup failed",
      );
      return null;
    }
  }

  /**
   * 그 에이전트 몫의 능력(계획 판정 PR3) — 그 러너가 그 프로그램에 대해 hello 로 알린 capabilities. 러너가 끊겼거나 프로그램을
   * 알리지 않았으면 어댑터 전체 값이다 — 그 런은 어차피 send 가 ADAPTER_UNAVAILABLE 로, 또는 러너가 RUNNER_CEILING(program)으로 닫는다
   */
  function capabilitiesFor(providerAgentId: string, connectionId: string | null): AdapterCapabilities {
    const runner = connectionId === null ? undefined : registry.byToken(connectionId);
    const definition = runner ? definitionOf(providerAgentId, runner.tokenId) : null;
    const program = definition && runner?.programs.find((p) => p.program === definition.agent.program);
    if (!program) return { ...capabilities };
    return { ...capabilities, serverSessionIds: program.capabilities.includes("serverSessionIds") };
  }

  const isLive = (runner: Runner) => registry.get(runner.socket.id) === runner;
  const approvals = new RunnerApprovals({
    ttlMs: opts.approvalTtlMs ?? RUNNER_APPROVAL_TTL_MS,
    now,
    isLive,
    emit: (approval, runner) => emit({ kind: "approval", connectionId: runner.tokenId, approval }),
  });

  function remoteAddress(socket: Socket): string {
    try {
      return opts.clientAddress(socket);
    } catch {
      return socket.handshake.address;
    }
  }

  /** 폐기된 토큰으로 재접속을 되풀이하는 러너가 로그를 채우지 않게 주소별 1분에 한 줄 */
  function logRejected(address: string, reason: string, at: number) {
    const entry = rejectLog.get(address);
    if (entry && at - entry.at < REJECT_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    rejectLog.delete(address);
    rejectLog.set(address, { at, suppressed: 0 });
    while (rejectLog.size > REJECT_LOG_MAX_ADDRESSES)
      rejectLog.delete(rejectLog.keys().next().value as string);
    const shown = opts.logAddress ? opts.logAddress(address) : address;
    logger.warn({ address: shown, reason, suppressed: entry?.suppressed ?? 0 }, "runner connection rejected");
  }

  /**
   * 넘친 프레임 — 주소별 1분에 한 줄 warn 과 onLimited(운영 사건). 버릴 때마다 쓰면 러너 한 소켓이 초당 수천 번 버릴 때
   * 막으려던 로그·DB 쓰기를 이것이 대신 만든다. dropped 는 이 줄까지 버린 수(앞 줄 뒤로 말없이 버린 것 포함)
   */
  function onFrameLimited(address: string, frame: string, tokenId: string) {
    const at = now();
    const entry = limitLog.get(address);
    if (entry && at - entry.at < LIMIT_LOG_INTERVAL_MS) {
      entry.suppressed += 1;
      return;
    }
    limitLog.delete(address);
    limitLog.set(address, { at, suppressed: 0 });
    while (limitLog.size > REJECT_LOG_MAX_ADDRESSES) limitLog.delete(limitLog.keys().next().value as string);
    const dropped = (entry?.suppressed ?? 0) + 1;
    logger.warn({ address, tokenId, frame, dropped }, "runner frames rate limited — dropped");
    try {
      opts.frameLimit.onLimited(address, frame, dropped);
    } catch (error) {
      logger.error({ err: error }, "runner frame limit handler threw");
    }
  }

  // 브리지 핸드셰이크(openclaw-adapter bridge/server.ts)와 같은 순서 — 막혔으면 토큰을 보지 않는다, 검증 실패만 센다
  namespace.use((socket, next) => {
    const address = remoteAddress(socket as unknown as Socket);
    const at = now();
    if (opts.authGuard.isBlocked(address, at)) {
      logRejected(address, "blocked after repeated failures", at);
      return next(new Error("RATE_LIMITED"));
    }
    const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    let verified: { tokenId: string; label: string } | null;
    try {
      verified = opts.verifyToken(token);
    } catch {
      // 검증 함수 오류(저장소 등)는 러너 잘못이 아니라 실패로 세지 않는다
      logRejected(address, "token verification failed", at);
      return next(new Error("UNAUTHORIZED"));
    }
    if (verified) {
      Object.assign(socket.data as SocketAuth, verified);
      return next();
    }
    if (opts.authGuard.fail(address, at)) opts.onBlocked(address);
    logRejected(address, "token mismatch", at);
    next(new Error("UNAUTHORIZED"));
  });

  /** 러너를 빼고 그 러너에 걸린 런·승인을 닫는다. 교체와 disconnect 가 겹쳐 두 번 불려도 한 번만 한다 */
  function dropRunner(runner: Runner, reason: string) {
    if (!registry.remove(runner.socket.id)) return;
    logger.info({ tokenId: runner.tokenId, label: runner.label, reason }, "runner disconnected");
    if (closed) return;
    releaseRunner(runner);
    announceRunners();
  }

  /** 레지스트리에서 빠진 러너의 런은 오류로, 떠 있던 승인은 철회로 닫는다 */
  function releaseRunner(runner: Runner) {
    for (const run of runs.values()) {
      if (run.runner !== runner) continue;
      runs.delete(run.runId);
      const error = new AdapterError("ADAPTER_UNAVAILABLE", "runner disconnected");
      // dispatch ack 전이면 send 가 던지고 오케스트레이터가 닫는다 — 여기서 RUN_ERROR 를 겹쳐 내지 않는다
      if (run.rejectAck) {
        run.rejectAck(error);
        continue;
      }
      emitEvent(run.runner.tokenId, run.runId, {
        type: "RUN_ERROR",
        runId: run.runId,
        code: error.code,
        message: error.message,
      });
      emitSignal(run.runner.tokenId, run.runId, {
        kind: "gateway_error",
        code: error.code,
        message: error.message,
      });
    }
    approvals.cancelForRunner(runner);
    // 작업 목록은 「러너 연결 끊김」으로 — 다시 붙으면 러너가 목록을 다시 보낸다(스펙 5.5)
    if (runner.capabilities.includes("backgroundTasks")) {
      try {
        opts.onTasks?.(runner.tokenId, { disconnected: true });
      } catch (error) {
        logger.error({ err: error }, "runner tasks handler threw");
      }
    }
  }

  function onHello(socket: RunnerSocket, auth: Required<SocketAuth>, payload: unknown, ack: unknown) {
    const reply = (r: RunnerHelloResult) => {
      if (typeof ack === "function") ack(r);
    };
    if (registry.get(socket.id)) {
      logger.warn({ tokenId: auth.tokenId }, "runner hello repeated — ignored");
      return reply({ ok: true, serverVersion: opts.serverVersion });
    }
    const reject = (message: string, detail: object) => {
      logger.warn({ tokenId: auth.tokenId, ...detail }, "runner hello rejected");
      reply({ ok: false, code: "PROTOCOL_MISMATCH", message });
      socket.disconnect(true);
    };
    // 판본부터 본다 — 옛 러너(1)의 hello 는 모양도 다르다(agents·claudeCodeVersion). 모양 오류보다 판본 불일치를 알려야 머신
    // 주인이 할 일(러너 다시 설치)을 안다
    const protocol = (payload as { runnerProtocol?: unknown } | null)?.runnerProtocol;
    if (typeof protocol === "number" && protocol !== RUNNER_PROTOCOL) {
      return reject(`server speaks runner protocol ${RUNNER_PROTOCOL}`, { runnerProtocol: protocol });
    }
    const parsed = RunnerHello.safeParse(payload);
    if (!parsed.success)
      return reject("hello does not match the runner protocol", { issues: issues(parsed.error) });
    const runner = createRunner({
      socket,
      tokenId: auth.tokenId,
      label: auth.label,
      hello: parsed.data,
      connectedAt: new Date(now()).toISOString(),
    });
    // 토큰 하나 = 러너 하나. 뒤 연결이 이기고 앞 연결의 자리를 그대로 잇는다 — 뒤 연결의 에이전트가 자기와 충돌하지 않고,
    // 앞 연결이 빠진 틈에 다른 러너가 에이전트를 가져가지도 않는다. 앞 연결의 런은 그 소켓과 함께 끝난다
    const previous = registry.byToken(auth.tokenId);
    if (previous) {
      registry.replace(previous, runner);
      logger.info(
        { tokenId: previous.tokenId, label: previous.label, reason: "replaced" },
        "runner disconnected",
      );
      releaseRunner(previous);
      previous.socket.disconnect(true);
    } else {
      registry.add(runner);
    }
    // 루트는 id 만 — 라벨은 머신 주인이 적은 글이라 로그에 싣지 않는다(라벨을 안 적으면 디렉터리 이름이 온다)
    logger.info(
      {
        tokenId: runner.tokenId,
        label: runner.label,
        runnerVersion: runner.hello.runnerVersion,
        sdkVersion: runner.hello.sdkVersion,
        roots: runner.hello.roots.map((r) => r.id),
        browse: runner.hello.browse,
        programs: runner.programs.map((p) => ({
          program: p.program,
          available: p.available,
          version: p.version,
          auth: p.auth,
        })),
      },
      "runner hello",
    );
    reply({ ok: true, serverVersion: opts.serverVersion });
    announceRunners();
  }

  /** 이 러너가 띄운 런이면 그 추적 — 남의 런·모르는 런은 버린다 */
  function ownRun(runner: Runner, runId: string, frame: string): RunTrack | undefined {
    const run = runs.get(runId);
    if (run?.runner === runner) return run;
    logger.warn(
      { tokenId: runner.tokenId, runId, frame },
      "runner frame for a run it does not own — dropped",
    );
    return undefined;
  }

  function onRunEvent(runner: Runner, payload: unknown) {
    const parsed = RunnerRunEvent.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.event violates contract",
      );
      return;
    }
    const { runId, event } = parsed.data as { runId: string; event: RunEventBody };
    const run = ownRun(runner, runId, "run.event");
    if (!run) return;
    if (
      !RUNNER_EVENT_TYPES.has(event.type) ||
      (event.type === "CUSTOM" && RESERVED_CUSTOM_NAMES.has(event.name)) ||
      event.runId !== runId
    ) {
      logger.warn(
        { tokenId: runner.tokenId, runId, type: event.type },
        "runner run.event not allowed — dropped",
      );
      return;
    }
    if (!run.started) {
      run.started = true;
      emitSignal(runner.tokenId, runId, { kind: "gateway_started" });
    }
    emitEvent(runner.tokenId, runId, event);
    switch (event.type) {
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_REPLACE":
        emitSignal(runner.tokenId, runId, { kind: "text_delta" });
        return;
      case "TOOL_CALL_START":
        run.openTools.add(event.toolCallId);
        emitSignal(runner.tokenId, runId, { kind: "tool_start" });
        return;
      // 도구가 끝나는 것은 결과가 왔을 때다 — TOOL_CALL_END 는 입력 블록이 닫힌 것뿐이고 도구는 그 뒤에 돈다(ADR 0007 6의 4 대응표)
      case "TOOL_CALL_RESULT":
        run.openTools.delete(event.toolCallId);
        emitSignal(runner.tokenId, runId, { kind: "tool_end", openTools: run.openTools.size });
        return;
    }
  }

  async function onRunFinal(runner: Runner, payload: unknown) {
    const parsed = RunnerRunFinal.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.final violates contract",
      );
      return;
    }
    const final = parsed.data;
    const run = ownRun(runner, final.runId, "run.final");
    if (!run) return;
    runs.delete(run.runId);
    approvals.cancelForRun(run.runId);
    const usage: RunUsage = { costKind: final.costKind, ...(run.model === null ? {} : { model: run.model }) };
    if (final.usage?.inputTokens !== undefined) usage.inputTokens = final.usage.inputTokens;
    if (final.usage?.outputTokens !== undefined) usage.outputTokens = final.usage.outputTokens;
    if (final.costUsd !== undefined) usage.costUsd = final.costUsd;
    // 상태 줄의 컨텍스트 %(세션 설정 스펙 5.1) — 둘 다 있을 때만. 옛 러너는 싣지 않는다
    if (final.usage?.contextTokens !== undefined && final.usage.contextWindow !== undefined) {
      usage.contextTokens = final.usage.contextTokens;
      usage.contextWindow = final.usage.contextWindow;
    }
    // 런 끝 컨텍스트 세부(작성기 칩 스펙 5.2) — 필드를 손으로 옮기므로 여기서 빠지면 말없이 사라진다. 옛 러너는 싣지 않는다
    if (final.usage?.contextBreakdown !== undefined) usage.contextBreakdown = final.usage.contextBreakdown;
    // 잴 것이 하나도 없으면(대기열에서 중지된 런 — init 을 못 봐 costKind 는 기본값) 내지 않는다 — 비용 없는 런이
    // API 키 러너 행에 「환산 포함」을 켜지 않게(최종 리뷰 M2)
    const measured =
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.costUsd !== undefined ||
      usage.contextBreakdown !== undefined;
    if (measured)
      emitEvent(run.runner.tokenId, run.runId, {
        type: "CUSTOM",
        runId: run.runId,
        name: USAGE_EVENT,
        value: usage,
      });
    // 중지된 턴(서버가 abort 했거나 러너 쪽에서 interrupt — 러너는 수명 이벤트를 run.event 로 보내지 않는다)은 메시지 없이
    // 중지로 닫는다. 중간 답을 올리면 안 된다 — 정본 저장은 끝난 런에도 메시지를 만든다. 서버가 이미 aborted 로 닫은 런이면
    // 오케스트레이터가 이 둘을 버린다
    if (run.aborted || final.stopReason === ABORTED_STOP_REASON) {
      emitEvent(run.runner.tokenId, run.runId, { type: "RUN_ABORTED", runId: run.runId, by: "user" });
      emitSignal(run.runner.tokenId, run.runId, { kind: "gateway_aborted" });
      return;
    }
    // 러너를 끄느라 멈춘 턴 — 사람 중지가 아니다. 러너가 끊긴 런과 같이 닫아 채널에 「다시 실행」 카드가 뜨게 한다
    if (final.stopReason === RUNNER_SHUTDOWN_STOP_REASON) {
      const error = new AdapterError("ADAPTER_UNAVAILABLE", "runner stopped");
      emitEvent(run.runner.tokenId, run.runId, {
        type: "RUN_ERROR",
        runId: run.runId,
        code: error.code,
        message: error.message,
      });
      emitSignal(run.runner.tokenId, run.runId, {
        kind: "gateway_error",
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (final.text.trim() === "") {
      emitSignal(run.runner.tokenId, run.runId, { kind: "gateway_final" });
      return;
    }
    const d = run.deliver;
    const text = fitFinalText(final.text);
    const message: OutboundMessage = {
      // 같은 런의 최종 답은 하나 — 메시지 external_id 유일 인덱스가 재전송을 흡수한다
      outboundId: `runner-final:${run.runId}`,
      conversationId: d.conversationId,
      agentId: d.agentId,
      sessionKey: d.sessionKey,
      ...(d.threadId === undefined ? {} : { threadId: d.threadId }),
      runId: run.runId,
      replyToInboundId: d.message.id,
      text,
      attachmentIds: [],
      ts: new Date(now()).toISOString(),
    };
    try {
      // 정본이 먼저 저장되면 종료 신호에서 곧바로 done 이다 — finalizing 상한을 기다리지 않는다
      await opts.onOutbound(message, run.runner.tokenId);
      emitSignal(run.runner.tokenId, run.runId, { kind: "gateway_final" });
    } catch (error) {
      // 저장이 실패하면 스냅숏을 싣는다 — 오케스트레이터가 finalizing 상한에서 그 글로 메시지를 만든다
      logger.warn(
        { err: error, runId: run.runId },
        "runner final message store failed — falling back to snapshot",
      );
      emit({
        kind: "run_signal",
        runId: run.runId,
        connectionId: run.runner.tokenId,
        signal: { kind: "gateway_final" },
        snapshotText: text,
      });
    }
  }

  function onRunError(runner: Runner, payload: unknown) {
    const parsed = RunnerRunError.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.error violates contract",
      );
      return;
    }
    const { runId, code, message } = parsed.data;
    if (!ownRun(runner, runId, "run.error")) return;
    runs.delete(runId);
    approvals.cancelForRun(runId);
    emitEvent(runner.tokenId, runId, { type: "RUN_ERROR", runId, code, message });
    emitSignal(runner.tokenId, runId, { kind: "gateway_error", code, message });
  }

  /**
   * 프로그램이 스스로 지은 세션 id(계획 판정 PR3) — 서버가 그 런의 세션 행에 저장해 다음 런에 싣는다. 서버가 세션 id 를 정한 런이
   * 보내면 버린다 — 서버가 정한 id 를 러너가 바꿔 다른 세션 전사로 잇지 못하게
   */
  function onRunSession(runner: Runner, payload: unknown) {
    const parsed = RunnerRunSession.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner run.session violates contract",
      );
      return;
    }
    const run = ownRun(runner, parsed.data.runId, "run.session");
    if (!run) return;
    if (run.serverSessionIds) {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId },
        "runner run.session for a server-chosen session — dropped",
      );
      return;
    }
    emit({
      kind: "run_session",
      runId: run.runId,
      connectionId: runner.tokenId,
      providerSessionId: parsed.data.providerSessionId,
    });
  }

  async function onOutboundPost(runner: Runner, payload: unknown, ack: unknown) {
    const reply = (r: RunnerOutboundAck) => {
      if (typeof ack === "function") ack(r);
    };
    const parsed = RunnerOutboundPost.safeParse(payload);
    if (!parsed.success) return reply({ ok: false, code: "VALIDATION", message: issues(parsed.error) });
    const post = parsed.data;
    const deny = (message: string) => {
      logger.warn({ tokenId: runner.tokenId, agentId: post.agentId, runId: post.runId }, message);
      reply({ ok: false, code: "FORBIDDEN", message });
    };
    // 러너는 자기에게 배정된 열린 런에만, 그 런의 대화·에이전트·세션·스레드 그대로 쓴다. 끝난 런 id 를 실으면 서버가 그 런의
    // 에이전트 글로 저장하고, 런 없는 글은 다른 채널에도 저장된다 — 어느 쪽도 이 러너가 흉내 낼 자리가 아니다
    const run = post.runId === undefined ? undefined : runs.get(post.runId);
    if (!run || run.runner !== runner || run.aborted)
      return deny("post must belong to an open run of this runner");
    const d = run.deliver;
    if (
      post.conversationId !== d.conversationId ||
      post.agentId !== d.agentId ||
      post.sessionKey !== d.sessionKey ||
      post.threadId !== d.threadId
    ) {
      return deny("post does not match its run");
    }
    let pending = inflightPosts.get(post.outboundId);
    if (!pending) {
      pending = opts.onOutbound(post, runner.tokenId).finally(() => inflightPosts.delete(post.outboundId));
      inflightPosts.set(post.outboundId, pending);
    }
    try {
      const { messageId } = await pending;
      emit({ kind: "canonical", connectionId: runner.tokenId, message: post });
      reply({ ok: true, messageId });
    } catch (error) {
      const code = ErrorCode.safeParse((error as { code?: unknown } | null)?.code).data ?? "INTERNAL";
      logger.warn(
        { err: error, tokenId: runner.tokenId, outboundId: post.outboundId },
        "runner outbound.post failed",
      );
      reply({ ok: false, code, message: "outbound message failed" });
    }
  }

  /**
   * 제어 도구 호출(제어 MCP 스펙 「Claude 러너」 절) — 이 러너가 맡은 열린 런의 이름으로만 받는다. 끝난 런·남의 런이면 서버에 묻지
   * 않고 NOT_FOUND(서버도 principalForRunner 로 한 번 더 본다). ack 는 서버의 결과가 올 때까지 미룬다 — 확인 카드를 기다리면 길다
   */
  async function onControlCall(runner: Runner, payload: unknown, ack: unknown) {
    const reply = (r: ControlResult) => {
      if (typeof ack === "function") ack(r);
    };
    const fail = (code: ErrorCode, message: string) => reply({ ok: false, error: { code, message } });
    const parsed = RunnerControlCall.safeParse(payload);
    if (!parsed.success) return fail("VALIDATION", issues(parsed.error));
    const call = parsed.data;
    const run = runs.get(call.runId);
    if (!run || run.runner !== runner || run.aborted) return fail("NOT_FOUND", "no open run of this runner");
    if (!opts.onControlCall) return fail("ADAPTER_UNAVAILABLE", "control tools are not served");
    try {
      reply(await opts.onControlCall(runner.tokenId, call));
    } catch (error) {
      logger.warn({ err: error, tokenId: runner.tokenId, runId: call.runId }, "runner control.call failed");
      fail("INTERNAL", "control call failed");
    }
  }

  function onTasksUpdate(runner: Runner, payload: unknown) {
    if (!runner.capabilities.includes("backgroundTasks")) {
      logger.warn({ tokenId: runner.tokenId }, "runner tasks.update without backgroundTasks — dropped");
      return;
    }
    const parsed = RunnerTasksUpdate.safeParse(payload);
    if (!parsed.success || parseDodokSessionKey(parsed.data.sessionKey) === undefined) {
      logger.warn(
        { tokenId: runner.tokenId, ...(parsed.success ? {} : { issues: issues(parsed.error) }) },
        "runner tasks.update violates contract",
      );
      return;
    }
    try {
      opts.onTasks?.(runner.tokenId, parsed.data);
    } catch (error) {
      logger.error({ err: error }, "runner tasks handler threw");
    }
  }

  /**
   * 러너의 CLI 가 스스로 연 턴(스펙 5.3) — 서버가 받아 준 런은 곧바로 「도는 중」인 이 러너의 런이다(started). ack 는 추적을 등록한
   * 뒤에 보낸다 — 러너는 ack 를 받자마자 쥐어 둔 이벤트를 그 런 id 로 흘린다
   */
  async function onRunFollowup(runner: Runner, payload: unknown, ack: unknown) {
    const reply = (r: RunnerFollowupResult) => {
      if (typeof ack === "function") ack(r);
    };
    const parsed = RunnerFollowupRequest.safeParse(payload);
    if (!parsed.success || parseDodokSessionKey(parsed.data.sessionKey) === undefined) {
      logger.warn({ tokenId: runner.tokenId }, "runner run.followup violates contract");
      return reply({ ok: false, reason: "unknown" });
    }
    if (!runner.capabilities.includes("backgroundTasks") || !opts.onFollowup)
      return reply({ ok: false, reason: "unknown" });
    let result: RunnerFollowupResult;
    try {
      result = await opts.onFollowup(runner.tokenId, parsed.data);
    } catch (error) {
      logger.warn({ err: error, tokenId: runner.tokenId }, "runner run.followup failed");
      return reply({ ok: false, reason: "unknown" });
    }
    if (result.ok) {
      if (closed || !isLive(runner)) return reply({ ok: false, reason: "unknown" });
      const definition = opts.agentDefinition(
        result.deliver.agentId,
        runner.tokenId,
        result.deliver.conversationId,
      );
      runs.set(result.runId, {
        runId: result.runId,
        runner,
        deliver: result.deliver,
        model: definition?.agent.model ?? null,
        serverSessionIds: true,
        started: true,
        openTools: new Set(),
        aborted: false,
        freeApprovals: 0,
      });
      logger.info({ runId: result.runId, tokenId: runner.tokenId }, "runner follow-up run started");
    }
    reply(result);
  }

  function onApprovalRequested(runner: Runner, payload: unknown) {
    const parsed = RunnerApprovalRequested.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner approval.requested violates contract",
      );
      return;
    }
    const run = ownRun(runner, parsed.data.runId, "approval.requested");
    if (!run) return;
    // 서버는 이미 그 런을 닫았다 — 카드가 런 없이 남거나 같은 세션의 다음 런에 붙는다. 러너에는 run.abort 가 가 있다
    if (run.aborted) {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId, providerApprovalId: parsed.data.providerApprovalId },
        "runner approval for an aborted run — dropped",
      );
      return;
    }
    // 세션 키로 채널·에이전트를 푼다 — 런의 키와 다르면 다른 채널의 카드를 띄우려는 것이다
    if (parsed.data.sessionKey !== run.deliver.sessionKey) {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId },
        "runner approval sessionKey mismatch — dropped",
      );
      return;
    }
    const result = approvals.request(runner, parsed.data);
    if (result === "duplicate") {
      // 러너는 결정을 영영 못 받는다 — 런이 runMs 까지 매달리는 원인을 찾을 수 있게 남긴다
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId, providerApprovalId: parsed.data.providerApprovalId },
        "runner approval id already used — dropped",
      );
    } else if (result === "invalid-session") {
      logger.warn(
        { tokenId: runner.tokenId, runId: run.runId },
        "runner approval sessionKey invalid — dropped",
      );
    }
  }

  function onApprovalWithdrawn(runner: Runner, payload: unknown) {
    const parsed = RunnerApprovalWithdrawn.safeParse(payload);
    if (!parsed.success) {
      logger.warn(
        { tokenId: runner.tokenId, issues: issues(parsed.error) },
        "runner approval.withdrawn violates contract",
      );
      return;
    }
    approvals.withdraw(runner, parsed.data.providerApprovalId);
  }

  /**
   * 버킷을 거치지 않는 프레임 — 이 러너의 열린 런을 닫는 run.final·run.error, 그 런의 새 승인 요청, 기다리는 승인의 철회.
   * 이것을 버리면 런은 runMs(기본 10분)에서야 닫히고 러너의 canUseTool 도 그때까지 기다린다. post 를 쏟는 다른 런이 control 을
   * 비웠다고 이 런까지 매달리면 안 된다.
   *
   * 처리기가 받아들일 프레임만 예외다 — 처리기와 같은 조건(계약 스키마, 이 러너가 연 런, 승인은 중지 안 된 런·그 런의 세션 키·
   * 안 쓴 id, 철회는 기다리는 승인)을 먼저 본다. 그래서 한 런의 예외 프레임은 종결 1(처리가 런을 곧바로 지운다) + 요청 누계
   * RUN_FREE_APPROVALS + 그 철회(기다리는 승인마다 한 번 — 받아들인 요청 수 이하)로 묶인다. 요청은 지금 기다리는 수가 아니라
   * 누계(RunTrack.freeApprovals)로 센다 — 철회하면 기다리는 수가 도로 주므로, 요청·철회를 되풀이해 승인 카드·푸시를 버킷을 한
   * 번도 안 세고 끝없이 만든다. 처리기가 버리고 warn 을 쓸 프레임(계약 위반·남의 런·끝난 런·세션 키 불일치·이미 쓴 id)과 누계를
   * 넘은 요청은 control 버킷을 센다 — 열린 runId 하나로 warn 줄을 버킷 밖에서 되풀이하지 못하게. 파싱은 처리기가 한 번 더 한다
   * (예외로 통과하는 수가 묶여 있어 두 번이 싸다). 싼 소유 대조를 먼저 해서, 남의 것·모르는 것을 가리키는 프레임은 파싱하지 않고
   * 버킷으로 간다
   */
  function namesOpenWork(
    runner: Runner | undefined,
    event: keyof RunnerClientToServerEvents,
    payload: unknown,
  ): boolean {
    if (!runner || typeof payload !== "object" || payload === null) return false;
    const { runId, providerApprovalId } = payload as { runId?: unknown; providerApprovalId?: unknown };
    const run = typeof runId === "string" ? runs.get(runId) : undefined;
    const own = run !== undefined && run.runner === runner;
    switch (event) {
      case "run.final":
        return own && RunnerRunFinal.safeParse(payload).success;
      case "run.error":
        return own && RunnerRunError.safeParse(payload).success;
      case "approval.requested": {
        if (
          !own ||
          run.aborted ||
          typeof providerApprovalId !== "string" ||
          approvals.used(runner, providerApprovalId) ||
          run.freeApprovals >= RUN_FREE_APPROVALS
        )
          return false;
        const parsed = RunnerApprovalRequested.safeParse(payload);
        if (
          !parsed.success ||
          parsed.data.sessionKey !== run.deliver.sessionKey ||
          parseDodokSessionKey(parsed.data.sessionKey) === undefined
        )
          return false;
        run.freeApprovals += 1;
        return true;
      }
      case "approval.withdrawn":
        return (
          typeof providerApprovalId === "string" &&
          approvals.isPending(runner, providerApprovalId) &&
          RunnerApprovalWithdrawn.safeParse(payload).success
        );
      default:
        return false;
    }
  }

  /** 서버 → 러너 ack 요청(fs.list·project.check·worktree.*) — 요청·답 모두 계약 스키마로 거른다 */
  async function askRunner<Q, R>(
    tokenId: string,
    event:
      | "fs.list"
      | "project.check"
      | "worktree.create"
      | "worktree.remove"
      | "commands.list"
      | "runner.update",
    payload: Q,
    requestSchema: z.ZodType<Q>,
    schema: z.ZodType<R>,
    timeoutMs: number = RUNNER_FS_ACK_TIMEOUT_MS,
  ): Promise<R> {
    const request = requestSchema.safeParse(payload);
    if (!request.success) throw new AdapterError("VALIDATION", issues(request.error));
    const runner = registry.byToken(tokenId);
    if (closed || !runner) throw new AdapterError("ADAPTER_UNAVAILABLE", "runner is not connected");
    let raw: unknown;
    try {
      // 이벤트마다 페이로드 타입이 달라 emitWithAck 의 오버로드를 고를 수 없다 — 요청은 위에서 계약으로 걸렀다
      raw = await (
        runner.socket.timeout(timeoutMs) as unknown as {
          emitWithAck(e: string, p: unknown): Promise<unknown>;
        }
      ).emitWithAck(event, request.data);
    } catch {
      // 기다리는 사이 끊긴 것과 늦은 것을 가른다 — 끊김은 다시 붙으면 되고, 늦음은 러너 쪽 디스크가 느린 것이다
      throw isLive(runner)
        ? new AdapterError("TIMEOUT", `runner did not ack ${event} in time`)
        : new AdapterError("ADAPTER_UNAVAILABLE", "runner disconnected");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ tokenId, event, issues: issues(parsed.error) }, "runner ack violates contract");
      throw new AdapterError("INTERNAL", `ADAPTER_PROTOCOL: ${event} ack invalid`);
    }
    return parsed.data;
  }

  namespace.on("connection", (socket) => {
    const { tokenId, label } = socket.data as SocketAuth;
    if (tokenId === undefined || label === undefined) {
      socket.disconnect(true);
      return;
    }
    const auth = { tokenId, label };
    sockets.set(socket.id, { socket, tokenId });
    const helloTimer = setTimeout(() => {
      helloTimers.delete(helloTimer);
      if (registry.get(socket.id)) return;
      logger.warn({ tokenId }, "runner sent no hello in time — disconnecting");
      dropTransport(socket);
    }, HELLO_TIMEOUT_MS);
    helloTimers.add(helloTimer);
    const buckets = opts.frameLimit.buckets();
    const address = remoteAddress(socket as unknown as Socket);
    // hello 전 프레임은 버린다 — 등록되지 않은 러너는 런도 에이전트도 없다
    const ready = (): Runner | undefined => registry.get(socket.id);
    /** 버킷에서 하나 꺼낸다 — 비었으면 false. ack 를 기다리는 프레임이면 RATE_LIMITED 로 답한다 */
    const admit = (event: keyof RunnerClientToServerEvents, args: unknown[]): boolean => {
      if (namesOpenWork(ready(), event, args[0])) return true;
      if (buckets[FRAME_BUCKET[event]].take()) return true;
      onFrameLimited(address, event, tokenId);
      const ack = args.at(-1);
      if (event === "outbound.post" && typeof ack === "function")
        (ack as (r: RunnerOutboundAck) => void)({
          ok: false,
          code: "RATE_LIMITED",
          message: "too many frames",
        });
      if (event === "control.call" && typeof ack === "function")
        (ack as (r: ControlResult) => void)({
          ok: false,
          error: { code: "RATE_LIMITED", message: "too many frames" },
        });
      if (event === "run.followup" && typeof ack === "function")
        (ack as (r: RunnerFollowupResult) => void)({ ok: false, reason: "unknown" });
      return false;
    };
    const on = <A extends unknown[]>(
      event: keyof RunnerClientToServerEvents,
      handler: (runner: Runner, ...args: A) => unknown,
    ) => {
      (socket as unknown as Socket).on(event, (...args: unknown[]) => {
        if (!admit(event, args)) return;
        const runner = ready();
        if (runner) void handler(runner, ...(args as A));
      });
    };

    // 스펙 3장 「모르는 프레임 종류는 버리고 warn」 — 되풀이하는 러너가 로그를 채우지 않게 소켓마다 1분에 한 줄
    let unknownFrames: { at: number; suppressed: number } | undefined;
    socket.onAny((event: string) => {
      if (RUNNER_FRAMES.has(event)) return;
      const at = now();
      if (unknownFrames && at - unknownFrames.at < UNKNOWN_FRAME_LOG_INTERVAL_MS) {
        unknownFrames.suppressed += 1;
        return;
      }
      logger.warn(
        { tokenId, event: event.slice(0, 64), suppressed: unknownFrames?.suppressed ?? 0 },
        "runner sent an unknown frame — dropped",
      );
      unknownFrames = { at, suppressed: 0 };
    });
    (socket as unknown as Socket).on("hello", (payload: unknown, ack: unknown) => {
      if (!admit("hello", [payload, ack])) return;
      if (registry.get(socket.id) === undefined) {
        clearTimeout(helloTimer);
        helloTimers.delete(helloTimer);
      }
      onHello(socket, auth, payload, ack);
    });
    on("run.session", onRunSession);
    on("run.event", onRunEvent);
    on("run.final", onRunFinal);
    on("run.error", onRunError);
    on("outbound.post", onOutboundPost);
    on("approval.requested", onApprovalRequested);
    on("approval.withdrawn", onApprovalWithdrawn);
    on("control.call", onControlCall);
    on("tasks.update", onTasksUpdate);
    on("run.followup", onRunFollowup);
    socket.on("disconnect", () => {
      clearTimeout(helloTimer);
      helloTimers.delete(helloTimer);
      sockets.delete(socket.id);
      const runner = registry.get(socket.id);
      if (runner) dropRunner(runner, "disconnect");
    });
  });

  return {
    provider: "runner",

    async connect() {
      // 네임스페이스는 만들 때 붙였다 — 러너가 먼저 붙어 오므로 기다릴 연결이 없다
    },

    async close() {
      closed = true;
      for (const timer of helloTimers) clearTimeout(timer);
      helloTimers.clear();
      approvals.close();
      for (const run of runs.values())
        run.rejectAck?.(new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed"));
      runs.clear();
      for (const socket of namespace.sockets.values()) dropTransport(socket);
    },

    status,
    capabilities: () => ({ ...capabilities }),
    setupDetail,

    mayReadAttachment(tokenId, attachmentId) {
      for (const run of runs.values()) {
        // 사람이 중지한 런은 러너가 run.final 을 보낼 때까지 runs 에 남는다 — 그동안 그 런의 첨부 읽기 허락을 남기지 않는다
        if (run.runner.tokenId !== tokenId || run.aborted) continue;
        if (run.deliver.message.attachments.some((a) => a.id === attachmentId)) return true;
      }
      return false;
    },

    runnerInfo(tokenId) {
      const runner = registry.byToken(tokenId);
      return runner ? runnerLive(runner) : null;
    },

    fsList: (tokenId, ref) => askRunner(tokenId, "fs.list", ref, RunnerProjectRef, RunnerFsListResult),
    projectCheck: (tokenId, ref) =>
      askRunner(tokenId, "project.check", ref, RunnerProjectRef, RunnerProjectCheckResult),
    worktreeCreate: (tokenId, req) =>
      askRunner(
        tokenId,
        "worktree.create",
        req,
        RunnerWorktreeCreate,
        RunnerWorktreeCreateResult,
        RUNNER_GIT_ACK_TIMEOUT_MS,
      ),
    worktreeRemove: (tokenId, req) =>
      askRunner(
        tokenId,
        "worktree.remove",
        req,
        RunnerWorktreeRemove,
        RunnerWorktreeRemoveResult,
        RUNNER_GIT_ACK_TIMEOUT_MS,
      ),
    commandsList: (tokenId, req) =>
      askRunner(
        tokenId,
        "commands.list",
        req,
        RunnerCommandsList,
        RunnerCommandsListResult,
        RUNNER_COMMANDS_LIST_TIMEOUT_MS,
      ),
    runnerUpdate: (tokenId, version) =>
      askRunner(
        tokenId,
        "runner.update",
        { version },
        RunnerUpdate,
        RunnerUpdateResult,
        RUNNER_UPDATE_ACK_TIMEOUT_MS,
      ),
    hasCapability: (tokenId, capability) =>
      !closed && (registry.byToken(tokenId)?.capabilities.includes(capability) ?? false),
    capabilitiesFor,

    revokeTokenSessions(tokenId) {
      let count = 0;
      // disconnect 가 동기로 지금 항목을 sockets 에서 지운다 — Map 순회는 남은 항목을 이어 돈다
      for (const { socket, tokenId: id } of sockets.values()) {
        if (id !== tokenId) continue;
        count += 1;
        socket.disconnect(true);
      }
      logger.info({ tokenId, sessions: count }, "runner sessions revoked");
      return count;
    },

    // 러너는 에이전트를 알리지 않는다 — 러너 에이전트는 앱에서 러너 프로젝트로 만든다(러너 일반화 계획 판정 PR9)
    async listAgents() {
      return [];
    },

    sessionKeyFor: dodokSessionKey,

    // 러너 능력(threads 등)은 그 에이전트가 묶인 러너 토큰의 연결이 hello 로 알린 것. 러너가 없으면 오케스트레이터가 옛 러너로
    // 닫지 않고 send 가 ADAPTER_UNAVAILABLE 로 닫게 true
    supports: (_providerAgentId, connectionId, capability) =>
      (connectionId === null ? undefined : registry.byToken(connectionId))?.capabilities.includes(
        capability,
      ) ?? true,

    async send(input, sendOpts) {
      if (closed) throw new AdapterError("ADAPTER_UNAVAILABLE", "adapter closed");
      // 러너 에이전트는 만들 때부터 러너 토큰에 묶인다 — 그 토큰의 러너만 맡는다
      const runner = sendOpts.connectionId === null ? undefined : registry.byToken(sendOpts.connectionId);
      if (!runner) throw new AdapterError("ADAPTER_UNAVAILABLE", "the agent's runner is not connected");
      const definition = definitionOf(input.agentId, runner.tokenId, input.conversationId);
      if (!definition) throw new AdapterError("NOT_FOUND", "no runner agent with a project for this runner");
      // 옛 러너는 project 를 요구한다 — 봇 런을 보내면 형식 오류로 버린다(러너 봇 스펙 B7)
      if (definition.agent.bot !== undefined && !runner.capabilities.includes("bots"))
        throw new AdapterError("VALIDATION", RUNNER_BOTS_UPDATE_MESSAGE);
      const bot = definition.agent.bot === undefined ? undefined : botForRunner(definition.agent.bot, runner);
      const ceiling = runner.programs.find((p) => p.program === definition.agent.program)?.ceiling;
      const agent = {
        ...definition.agent,
        ...(bot === undefined ? {} : { bot }),
        permissionMode: resolvePermissionMode(definition.agent.permissionMode, ceiling?.maxPermissionMode),
      };
      // acceptEdits 위의 모드(auto·bypassPermissions)는 그 모드를 아는 러너만 상한으로 알릴 수 있다. 알린 상한 위면 보내지 않고 러너의
      // 천장 거절과 같은 RUNNER_CEILING 으로 닫는다 — 옛 러너는 그 값을 몰라 run.start 를 VALIDATION 으로 버리고, 카드에는 코드만 남는다.
      // acceptEdits 이하는 지금처럼 보내 러너가 거절한다(Review Focus 3)
      if (
        ceiling !== undefined &&
        permissionModeRank(agent.permissionMode) > permissionModeRank("acceptEdits") &&
        permissionModeRank(agent.permissionMode) > permissionModeRank(ceiling.maxPermissionMode)
      ) {
        const code = "RUNNER_CEILING";
        const message: RunnerCeilingItem = "permissionMode";
        logger.info(
          { runId: input.runId, tokenId: runner.tokenId, permissionMode: agent.permissionMode },
          "runner run refused above the announced permission ceiling",
        );
        emitEvent(runner.tokenId, input.runId, { type: "RUN_ERROR", runId: input.runId, code, message });
        emitSignal(runner.tokenId, input.runId, { kind: "gateway_error", code, message });
        return { admission: "dispatch", providerRunId: input.runId, connectionId: runner.tokenId };
      }
      const serverSessionIds = capabilitiesFor(input.agentId, runner.tokenId).serverSessionIds;
      if (serverSessionIds && sendOpts.providerSessionId === undefined) {
        throw new AdapterError("INTERNAL", "this runner program needs a server-chosen providerSessionId");
      }
      const channelName = opts.channelName(input.channelId) ?? input.channelId;
      const start = RunnerRunStart.safeParse({
        deliver: input,
        ...(sendOpts.providerSessionId === undefined
          ? {}
          : { providerSessionId: sendOpts.providerSessionId }),
        channelRulesAppend: buildChannelRulesAppend({
          agentInstructions: definition.instructions,
          ...(definition.botDefinition === undefined ? {} : { bot: definition.botDefinition }),
          channelName,
          ...(input.dm ? { dm: input.dm } : {}),
          ...(input.groupDm ? { groupDm: true as const } : {}),
          channelPrompt: input.context.channelPrompt,
          promptOverride: input.context.promptOverride,
          relayRules: input.context.relayRules,
        }),
        turnFacts: buildTurnFacts({
          conversationTitle: input.conversationTitle,
          participants: input.context.participants,
          ...(input.dm ? { dm: input.dm } : {}),
          ...(input.groupDm ? { groupDm: true as const } : {}),
          thread: input.threadId !== undefined,
          reactions: input.context.reactions,
          reactionsOmitted: input.context.reactionsOmitted,
        }),
        // DM·그룹 DM 채널 행의 이름은 `dm`·`direct` 라 그대로 쓰면 「dm · …」 — 둘 다 「DM」으로
        sessionTitle: clip(
          `${input.dm || input.groupDm ? "DM" : channelName} · ${definition.name}`,
          SESSION_TITLE_MAX,
        ),
        agent,
      });
      if (!start.success) throw new AdapterError("INTERNAL", `run.start invalid: ${issues(start.error)}`);

      // 러너는 ack 전에도 이벤트를 보낼 수 있다 — 보내기 전에 등록한다
      const run: RunTrack = {
        runId: input.runId,
        runner,
        deliver: input,
        model: definition.agent.model,
        serverSessionIds,
        started: false,
        openTools: new Set(),
        aborted: false,
        freeApprovals: 0,
      };
      runs.set(run.runId, run);
      let ack: RunnerRunAck;
      try {
        ack = await new Promise<RunnerRunAck>((resolve, reject) => {
          run.rejectAck = reject;
          runner.socket.timeout(RUN_START_ACK_TIMEOUT_MS).emit("run.start", start.data, (err, raw) => {
            if (err) {
              reject(new AdapterError("ADAPTER_UNAVAILABLE", "runner did not ack run.start in time"));
              return;
            }
            const parsed = RunnerRunAck.safeParse(raw);
            if (!parsed.success || parsed.data.runId !== run.runId) {
              const why = parsed.success ? "runId mismatch" : issues(parsed.error);
              reject(new AdapterError("INTERNAL", `ADAPTER_PROTOCOL: run.ack ${why}`));
              return;
            }
            // 받아들인 런은 이 콜백에서 곧바로 「러너의 런」이 된다 — ack 와 끊김이 같은 틱에 와서 send 가 이어지기 전에
            // dropRunner 가 돌아도 RUN_ERROR 를 낸다(send 는 dispatch 를 돌려주고 오케스트레이터는 이미 닫힌 런으로 본다)
            if (parsed.data.admission === "dispatch") run.rejectAck = undefined;
            resolve(parsed.data);
          });
        });
      } catch (error) {
        if (runs.get(run.runId) === run) runs.delete(run.runId);
        throw error;
      } finally {
        run.rejectAck = undefined;
      }
      if (ack.admission === "drop") {
        runs.delete(run.runId);
        return ack.reason === undefined
          ? { admission: "drop", connectionId: runner.tokenId }
          : { admission: "drop", reason: ack.reason, connectionId: runner.tokenId };
      }
      if (ack.queuedPosition !== undefined && runs.get(run.runId) === run) {
        emitEvent(run.runner.tokenId, run.runId, {
          type: "RUN_QUEUED",
          runId: run.runId,
          position: ack.queuedPosition,
          // 붙든 프로세스가 자리를 쥔 수 — 웹이 대기 표시에 그 까닭을 붙인다(D7)
          ...(ack.heldSlots === undefined || ack.heldSlots === 0 ? {} : { heldSlots: ack.heldSlots }),
        });
      }
      logger.info(
        {
          runId: run.runId,
          deliveryId: input.deliveryId,
          tokenId: runner.tokenId,
          queuedPosition: ack.queuedPosition,
        },
        "runner run started",
      );
      // 러너 대기열에 선 런 — 오케스트레이터가 queuedMs 로 닫지 않게 알린다(최종 리뷰 I1). 끊김·폐기는 dropRunner 가 닫는다
      return {
        admission: "dispatch",
        providerRunId: run.runId,
        connectionId: runner.tokenId,
        ...(ack.queuedPosition === undefined ? {} : { queued: true }),
      };
    },

    async stopTask(connectionId, sessionKey, taskId) {
      const runner = registry.byToken(connectionId);
      if (closed || !runner || !runner.capabilities.includes("backgroundTasks")) return false;
      try {
        const raw: unknown = await runner.socket
          .timeout(RUNNER_FS_ACK_TIMEOUT_MS)
          .emitWithAck("task.stop", { sessionKey, taskId });
        return RunnerTaskStopResult.safeParse(raw).data?.ok === true;
      } catch {
        return false;
      }
    },

    releaseSession(connectionId, sessionKey) {
      const runner = registry.byToken(connectionId);
      if (closed || !runner || !runner.capabilities.includes("backgroundTasks") || !isLive(runner)) return;
      runner.socket.emit("session.release", { sessionKey });
    },

    async abort(runId, _sessionKey, _connectionId) {
      const run = runs.get(runId);
      if (!run) return;
      run.aborted = true;
      if (isLive(run.runner)) run.runner.socket.emit("run.abort", { runId });
    },

    // 러너는 채널 규칙을 매 런 run.start 에 싣는다 — 따로 밀어 넣을 설정이 없다
    async syncChannelConfig(_channelId, _config, _connectionId) {
      return { applied: "live" };
    },

    // 러너 승인 id 는 이미 토큰 id 를 품는다(approvals.ts #id) — 연결 id 를 따로 보지 않는다
    async resolveApproval(providerApprovalId, kind, decision, _connectionId) {
      if (kind !== "tool")
        throw new AdapterError("INTERNAL", `approval kind ${kind} is not a runner approval`);
      return approvals.resolve(providerApprovalId, decision);
    },

    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },

    forgetRun(runId) {
      runs.delete(runId);
      approvals.cancelForRun(runId);
    },
  };
}
