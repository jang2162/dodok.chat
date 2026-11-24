import { z } from "zod";
import { ErrorCode, Id } from "../common";
import { InboundDeliver, OutboundMessage } from "../bridge";
import type { ControlResult, RunnerControlCall } from "../control";
import {
  ApprovalDecision,
  BACKGROUND_TASKS_MAX,
  BackgroundTask,
  permissionModeRank,
  RUNNER_PERMISSION_MODES,
  RunnerContextBreakdown,
  RunnerEffort,
  RunnerModelOption,
  RunnerPermissionMode,
  RunnerProgram,
  RunnerToolNames,
} from "../domain";
import { AGENT_COMMANDS_MAX, AgentCommand } from "../commands";
import { RunEvent } from "../events";
import { RemoteUpdateAck, RemoteUpdateVersion } from "../setup";
import { type AppMcpCeiling, AppMcpMode, McpAutoAllowMap, McpServers, RunnerBotBuiltinTools } from "./mcp";

// `/runner` 계약(러너 스펙 3장, 계획 판정 P1) — Socket.IO 네임스페이스, 프레임은 이벤트 이름 + ack. 경계에서 이 Zod 로 파싱한다.
// 하트비트는 Socket.IO 가 한다 — ping/pong 프레임은 두지 않는다

export * from "./prompt";
export * from "./bot-templates";
export * from "./mcp";
export { permissionModeRank, RUNNER_PERMISSION_MODES, RunnerPermissionMode, RunnerProgram };

export const RUNNER_NAMESPACE = "/runner";
/** 첨부 바이트 HTTP(GET·POST, 러너 토큰) — 브리지의 /bridge/attachments 와 같은 모양 */
export const RUNNER_ATTACHMENTS_PATH = "/runner/attachments";
/** 2 — 러너는 천장만 쥐고 서버가 run.start 에 에이전트 정의를 싣는다(러너 일반화 스펙 3장). 옛 러너(1)는 PROTOCOL_MISMATCH */
export const RUNNER_PROTOCOL = 2;

// commands — run.start 의 deliver.command 를 그대로 프롬프트로 보내고 commands.list 에 답한다(에이전트 명령 C7·C8)
// remoteUpdate — runner.update 에 답한다. remoteUpdateOff — 그 머신의 설정이 원격 업데이트를 껐다(원격 업데이트 스펙 U1·U8). hello 가
// strict 라 최상위에 새 키를 두면 옛 서버가 새 러너를 거절한다 — 켜짐·꺼짐은 능력 문자열로 싣는다(옛 서버는 모르는 능력을 버린다)
export const RunnerCapability = z.enum([
  "threads",
  "interrupt",
  "approvals",
  "attachments",
  "worktrees",
  "commands",
  // 봇(러너 봇 스펙 B7) — run.start.agent.bot·commands.list 의 bot 갈래를 받는다. 없는 러너에는 봇 런을 보내지 않는다
  "bots",
  // 봇 MCP(러너 봇 2부 스펙 T5) — run.start.agent.bot.mcpServers·mcpAutoAllow 를 받는다. 없는 러너에 MCP 가 있는 봇 런은 보내지 않는다
  "botMcp",
  // 「이 러너 설정 제어」(T7) — run.start.agent.bot.builtinTools 에 runnerControl 이면 러너 제어 도구를 dodok MCP 에 싣는다
  "runnerControl",
  "remoteUpdate",
  "remoteUpdateOff",
  // 백그라운드 작업(백그라운드 작업 스펙 6장) — tasks.update·run.followup 을 내고 task.stop·session.release 를 받는다. 없는 러너에는
  // 서버가 새 프레임을 보내지 않는다(옛 러너는 첫 result 에서 CLI 를 닫는 지금 동작 그대로)
  "backgroundTasks",
]);
export type RunnerCapability = z.infer<typeof RunnerCapability>;

/** 능력 `bots` 가 없는 러너 — 봇 만들기 잠금 사유와 봇 런의 run_error 가 같은 글(러너 봇 스펙 B7) */
export const RUNNER_BOTS_UPDATE_MESSAGE = "러너를 업데이트하세요(봇은 0.9.0 부터)";

/** 능력 `botMcp` 가 없는 러너에 MCP 가 있는 봇 런 — run_error 글(러너 봇 2부 스펙 T5) */
export const RUNNER_BOT_MCP_UPDATE_MESSAGE = "러너를 업데이트하세요(봇 도구는 0.10.0 부터)";

/** queuedPosition 이 있으면 러너 동시 상한에 걸려 기다린다 — 어댑터가 RUN_QUEUED 를 낸다 */
export const RunnerRunAck = z.object({
  runId: Id,
  admission: z.enum(["dispatch", "drop"]),
  queuedPosition: z.int().min(1).optional(),
  /** 기다리는 까닭이 붙든 프로세스일 때 그 수(백그라운드 작업 스펙 D7) — 어댑터가 RUN_QUEUED.heldSlots 로 싣는다 */
  heldSlots: z.int().min(0).optional(),
  reason: z.string().optional(),
});
export type RunnerRunAck = z.infer<typeof RunnerRunAck>;

// RunEvent 변형마다 seq·ts 를 뺀다 — 서버가 붙인다. 러너가 실어 보내도 strip 으로 버린다
type OmitSeqTs<T> = T extends z.ZodObject<infer S, infer C> ? z.ZodObject<Omit<S, "seq" | "ts">, C> : never;
type OmitEach<T extends readonly unknown[]> = { -readonly [K in keyof T]: OmitSeqTs<T[K]> };
type RunEventBodyOptions = OmitEach<typeof RunEvent.options>;
// map 은 튜플 모양을 잃는다 — 변형마다 같은 omit 이라 모양은 위 매핑 타입과 같다
const runEventBodyOptions = RunEvent.options.map((o) =>
  (o as z.ZodObject).omit({ seq: true, ts: true }),
) as unknown as RunEventBodyOptions;
export const RunEventBodySchema = z.discriminatedUnion("type", runEventBodyOptions);

export const RunnerRunEvent = z.object({ runId: Id, event: RunEventBodySchema });
export type RunnerRunEvent = z.infer<typeof RunnerRunEvent>;

/**
 * 러너가 꺼지느라(SIGINT·SIGTERM) 멈춘 턴의 run.final stopReason — 어댑터가 사람 중지(`aborted`)와 가르고
 * `ADAPTER_UNAVAILABLE` 로 닫는다(「다시 실행」이 붙게)
 */
export const RUNNER_SHUTDOWN_STOP_REASON = "runner_shutdown";

/**
 * 드라이버가 없는 프로그램을 러너 설정에 적었을 때 hello `programs` 줄의 `reason` — 꺼진 것과 같지만 사유와 함께 알린다.
 * 웹은 이 사유를 「설치 안 됨」이 아니라 「지원 예정」으로 그린다(연결 재설계 스펙 「「지원 예정」 판정」). 러너와 웹이 같은 값을 쓴다
 */
export const RUNNER_NO_DRIVER_REASON = "이 러너 판본에는 이 프로그램의 드라이버가 없습니다";

/** 그 프롬프트 턴의 result. costUsd 는 세션 누적 비용의 런 전후 차이(ADR 0007 5.9) */
export const RunnerRunFinal = z.object({
  runId: Id,
  text: z.string(),
  stopReason: z.string(),
  usage: z
    .object({
      inputTokens: z.int().optional(),
      outputTokens: z.int().optional(),
      /** 그 턴의 마지막 API 호출 입력(+캐시) 토큰 — 컨텍스트 사용률의 분자. 옛 러너는 싣지 않는다 */
      contextTokens: z.int().min(0).optional(),
      /** 그 모델의 컨텍스트 창 크기 — 사용률의 분모. 옛 러너는 싣지 않는다 */
      contextWindow: z.int().min(1).optional(),
      /** 런 끝 컨텍스트 세부(작성기 칩 스펙 C7) — 받지 못했으면 없다. 옛 러너는 싣지 않는다 */
      contextBreakdown: RunnerContextBreakdown.optional(),
    })
    .optional(),
  costUsd: z.number().min(0).optional(),
  costKind: z.enum(["api", "subscription_estimate"]),
});
export type RunnerRunFinal = z.infer<typeof RunnerRunFinal>;

/** result 전에 SDK 예외·CLI 종료가 났을 때만. 로그인 문제는 PROVIDER_AUTH */
export const RunnerRunError = z.object({ runId: Id, code: ErrorCode, message: z.string().max(2000) });
export type RunnerRunError = z.infer<typeof RunnerRunError>;

export const RunnerRunAbort = z.object({ runId: Id });
export type RunnerRunAbort = z.infer<typeof RunnerRunAbort>;

/**
 * 러너 `post` 의 outboundId 접두사. 어댑터가 최종 답을 `runner-final:<runId>` 로 저장하므로 러너가 고른 id 는 이 접두사로 묶는다 —
 * 그 키(와 다른 메시지의 external_id)를 먼저 써서 최종 답을 막거나 남의 메시지 id 를 돌려받지 못하게(최종 리뷰 M4)
 */
export const RUNNER_POST_ID_PREFIX = "runner-post:";

/** dodok 도구 `mcp__dodok__post` — 첨부는 먼저 /runner/attachments 로 올린 artifact id */
export const RunnerOutboundPost = OutboundMessage.extend({
  outboundId: z
    .string()
    .min(RUNNER_POST_ID_PREFIX.length + 1)
    .max(128)
    .startsWith(RUNNER_POST_ID_PREFIX),
});
export type RunnerOutboundPost = z.infer<typeof RunnerOutboundPost>;
export const RunnerOutboundAck = z.union([
  z.object({ ok: z.literal(true), messageId: Id }),
  z.object({ ok: z.literal(false), code: ErrorCode, message: z.string() }),
]);
export type RunnerOutboundAck = z.infer<typeof RunnerOutboundAck>;

/** canUseTool 이 불렸다(러너 스펙 6장). summary 는 작업 디렉터리 상대 경로만 — 밖이면 `<작업 디렉터리 밖>` */
export const RunnerApprovalRequested = z.object({
  providerApprovalId: z.string().min(1).max(128),
  runId: Id,
  sessionKey: z.string(),
  toolCallId: z.string(),
  toolName: z.string().max(128),
  summary: z.string().max(400),
  /**
   * 도구 입력 JSON 전체(가림·숨김 글자 드러내기는 summary 와 같은 규칙, 넘으면 끝을 자르고 표시) — 카드의 「전체 보기」.
   * 선택: 옛 러너는 보내지 않는다(그때 카드는 요약만)
   */
  args: z.string().max(16_000).optional(),
  canAllowAlways: z.boolean(),
});
export type RunnerApprovalRequested = z.infer<typeof RunnerApprovalRequested>;

/** 콜백 signal 이 끊겼다(런 중지 등) — 카드는 철회로 닫힌다 */
export const RunnerApprovalWithdrawn = z.object({ providerApprovalId: z.string() });
export type RunnerApprovalWithdrawn = z.infer<typeof RunnerApprovalWithdrawn>;

/** 기한(판정 P5)이 지나 서버가 보내는 거절은 reason: "expired" */
export const RunnerApprovalResolve = z.object({
  providerApprovalId: z.string(),
  decision: ApprovalDecision,
  reason: z.enum(["expired"]).optional(),
});
export type RunnerApprovalResolve = z.infer<typeof RunnerApprovalResolve>;

// ── 백그라운드 작업(백그라운드 작업 스펙 5.3·5.4·5.5) — 능력 backgroundTasks 인 러너만

/** 러너 → 서버. 그 세션 프로세스의 작업 전체(바꿔 끼우는 값) — 프로세스가 닫히면 빈 목록 */
export const RunnerTasksUpdate = z.object({
  sessionKey: z.string(),
  tasks: z.array(BackgroundTask).max(BACKGROUND_TASKS_MAX),
});
export type RunnerTasksUpdate = z.infer<typeof RunnerTasksUpdate>;

/** 러너 → 서버(ack). CLI 가 작업 알림 뒤 스스로 연 턴에 서버의 추가 응답 런을 청한다 */
export const RunnerFollowupRequest = z.object({
  sessionKey: z.string(),
  originRunId: Id,
  taskIds: z.array(z.string().min(1).max(128)).min(1).max(BACKGROUND_TASKS_MAX),
});
export type RunnerFollowupRequest = z.infer<typeof RunnerFollowupRequest>;

/** 거절이면 러너는 그 턴을 interrupt 하고 모은 메시지를 버린다 — 거절 알림은 서버가 스레드에 남긴다 */
export const RunnerFollowupResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), runId: Id, deliver: InboundDeliver }),
  z.object({ ok: z.literal(false), reason: z.enum(["limit", "archived", "inactive", "closed", "unknown"]) }),
]);
export type RunnerFollowupResult = z.infer<typeof RunnerFollowupResult>;

/** 서버 → 러너(ack). 화면의 「종료」 — 끈 결과는 tasks.update 로 돌아온다 */
export const RunnerTaskStop = z.object({ sessionKey: z.string(), taskId: z.string().min(1).max(128) });
export type RunnerTaskStop = z.infer<typeof RunnerTaskStop>;
export const RunnerTaskStopResult = z.object({ ok: z.boolean() });
export type RunnerTaskStopResult = z.infer<typeof RunnerTaskStopResult>;

/** 서버 → 러너. 세션 닫기·보관·내보내기 — 그 세션의 작업을 모두 끄고 붙든 프로세스를 닫는다 */
export const RunnerSessionRelease = z.object({ sessionKey: z.string() });
export type RunnerSessionRelease = z.infer<typeof RunnerSessionRelease>;

export interface RunnerClientToServerEvents {
  hello: (p: RunnerHello, ack: (r: RunnerHelloResult) => void) => void;
  "run.session": (p: RunnerRunSession) => void;
  "run.event": (p: RunnerRunEvent) => void;
  "run.final": (p: RunnerRunFinal) => void;
  "run.error": (p: RunnerRunError) => void;
  "outbound.post": (p: RunnerOutboundPost, ack: (r: RunnerOutboundAck) => void) => void;
  "approval.requested": (p: RunnerApprovalRequested) => void;
  "approval.withdrawn": (p: RunnerApprovalWithdrawn) => void;
  "control.call": (p: RunnerControlCall, ack: (r: ControlResult) => void) => void;
  "tasks.update": (p: RunnerTasksUpdate) => void;
  "run.followup": (p: RunnerFollowupRequest, ack: (r: RunnerFollowupResult) => void) => void;
}

export interface RunnerServerToClientEvents {
  "run.start": (p: RunnerRunStart, ack: (r: RunnerRunAck) => void) => void;
  "run.abort": (p: RunnerRunAbort) => void;
  "approval.resolve": (p: RunnerApprovalResolve) => void;
  "fs.list": (p: RunnerProjectRef, ack: (r: RunnerFsListResult) => void) => void;
  "project.check": (p: RunnerProjectRef, ack: (r: RunnerProjectCheckResult) => void) => void;
  "worktree.create": (p: RunnerWorktreeCreate, ack: (r: RunnerWorktreeCreateResult) => void) => void;
  "worktree.remove": (p: RunnerWorktreeRemove, ack: (r: RunnerWorktreeRemoveResult) => void) => void;
  "commands.list": (p: RunnerCommandsList, ack: (r: RunnerCommandsListResult) => void) => void;
  "runner.update": (p: RunnerUpdate, ack: (r: RunnerUpdateResult) => void) => void;
  "task.stop": (p: RunnerTaskStop, ack: (r: RunnerTaskStopResult) => void) => void;
  "session.release": (p: RunnerSessionRelease) => void;
}

// ── 원격 업데이트(원격 업데이트 스펙 U3) — 서버 → 러너 ack 요청. 러너는 npm 의 그 판(지금보다 높은 정확한 semver)을 자기 전역 자리에
// 설치하고 ok 로 답한 뒤 같은 인자로 스스로 다시 띄운다

export const RunnerUpdate = z.object({ version: RemoteUpdateVersion });
export type RunnerUpdate = z.infer<typeof RunnerUpdate>;
export const RunnerUpdateResult = RemoteUpdateAck;
export type RunnerUpdateResult = RemoteUpdateAck;
/** runner.update ack 상한 — 러너는 npm 설치(상한 RUNNER_NPM_INSTALL_TIMEOUT_MS)를 끝내고 답한다 */
export const RUNNER_UPDATE_ACK_TIMEOUT_MS = 170_000;
/** 러너가 npm 설치를 끊는 시간 — ack 상한보다 앞선다 */
export const RUNNER_NPM_INSTALL_TIMEOUT_MS = 150_000;

// ── 천장·프로젝트(러너 일반화 스펙 2·3장) — 러너는 천장(루트·프로그램·권한 상한)만 쥐고, 서버가 run.start 에 에이전트 정의를
// 통째로 싣는다

/** 러너 로컬 설정의 루트 id — 바꾸면 그 루트의 프로젝트가 「루트 없음」이 된다 */
export const RunnerRootId = z.string().regex(/^[a-z0-9-]{1,32}$/, "root id must match [a-z0-9-]{1,32}");
export type RunnerRootId = z.infer<typeof RunnerRootId>;

/**
 * 루트 안의 상대 경로 — 서버·러너가 같은 스키마로 거른다. 빈 문자열은 루트 자신. `/` 로만 나누고 `..`·`.`·빈 성분·NUL·`\`·앞 `/`
 * 는 거절한다. 러너는 이 검사를 믿지 않고 realpath 로 루트 안인지 다시 본다(심볼릭 링크는 글자로 못 거른다)
 */
export const RunnerRelPath = z
  .string()
  .max(512)
  .refine(
    (p) =>
      p === "" ||
      (!p.includes("\0") &&
        !p.includes("\\") &&
        p.split("/").every((part) => part !== "" && part !== "." && part !== "..")),
    "relPath must be a relative path inside the root",
  );
export type RunnerRelPath = z.infer<typeof RunnerRelPath>;

/** 루트 하나 안의 디렉터리 — 프로젝트의 자리이자 fs.list·project.check 요청 */
export const RunnerProjectRef = z.object({ rootId: RunnerRootId, relPath: RunnerRelPath });
export type RunnerProjectRef = z.infer<typeof RunnerProjectRef>;

/** 프로그램 드라이버가 할 수 있는 것(계획 판정 PR3) — 서버가 그 러너·그 프로그램의 값으로 런 전에 가른다 */
export const RunnerProgramCapability = z.enum([
  "serverSessionIds",
  "approvals",
  "images",
  "interrupt",
  "mcpTools",
  "costs",
]);
export type RunnerProgramCapability = z.infer<typeof RunnerProgramCapability>;

/** 러너가 쓰는 Claude 로그인 — 평소(`~/.claude`)·전용(설정 configDir). 옛 러너는 싣지 않는다 */
export const RunnerProgramLogin = z.enum(["default", "dedicated"]);
export type RunnerProgramLogin = z.infer<typeof RunnerProgramLogin>;

/** 러너가 띄우는 CLI — 머신에 설치된 것(설정 executable 또는 PATH)·SDK 에 든 것. 옛 러너는 싣지 않는다 */
export const RunnerProgramCli = z.enum(["installed", "bundled"]);
export type RunnerProgramCli = z.infer<typeof RunnerProgramCli>;

export const RunnerProgramStatus = z.object({
  program: RunnerProgram,
  /** 이 러너가 그 프로그램을 돌릴 수 있나 — 드라이버가 있고 설치돼 있다 */
  available: z.boolean(),
  version: z.string().max(64).optional(),
  auth: z.enum(["ok", "missing", "unknown"]),
  login: RunnerProgramLogin.optional(),
  cli: RunnerProgramCli.optional(),
  /** 못 쓰는 까닭·로그인 안내 — 경로 원문은 싣지 않는다 */
  reason: z.string().max(200).optional(),
  // 문자열이면 받는다 — 모르는 값은 서버가 버린다(hello capabilities 와 같은 까닭)
  capabilities: z.array(z.string()),
  ceiling: z.object({
    maxPermissionMode: RunnerPermissionMode,
    /** 배열이면 에이전트의 allowedTools 는 그 부분집합이어야 한다. null 이면 상한 없음 */
    allowedToolsCeiling: RunnerToolNames.nullable(),
    /**
     * 앱에서 온 MCP 의 천장(러너 봇 2부 스펙 T2·T3) — 러너 로컬 appMcp·appMcpCommands. 이 객체는 strict 가 아니라 옛 서버는 지운다
     * (hello 최상위에 키를 두면 옛 서버가 새 러너를 거절한다). 옛 러너는 싣지 않는다 — 서버는 없으면 "off" 로 읽는다
     */
    appMcp: AppMcpMode.optional(),
    appMcpCommands: z.array(z.string().min(1).max(128)).max(64).nullable().optional(),
  }),
  /**
   * 그 프로그램이 받는 모델(SDK supportedModels — 작성기 칩 스펙 C3). 받지 못했으면 없다. 옛 러너는 싣지 않는다 — 이 객체는
   * strict 가 아니라 옛 서버는 이 키를 지운다(hello 최상위에는 새 키를 두지 않는다)
   */
  models: z.array(RunnerModelOption).max(32).optional(),
});
export type RunnerProgramStatus = z.infer<typeof RunnerProgramStatus>;

/** hello 의 그 프로그램 천장에서 MCP 판정 천장(appMcpVerdict 의 첫 인자)을 꺼낸다 — 옛 러너(appMcp 없음)는 "off" */
export function appMcpCeilingOf(status: Pick<RunnerProgramStatus, "ceiling"> | undefined): AppMcpCeiling {
  return {
    appMcp: status?.ceiling.appMcp ?? "off",
    appMcpCommands: status?.ceiling.appMcpCommands ?? null,
    allowedToolsCeiling: status?.ceiling.allowedToolsCeiling ?? null,
  };
}

/**
 * 러너 → 서버 hello. 루트는 id·라벨뿐이다 — 호스트 경로는 서버로 가지 않는다(스펙 결정 3). strict 라 옛 hello 의 agents·
 * claudeCodeVersion(과 루트의 path)이 실리면 거절한다
 */
export const RunnerHello = z.strictObject({
  runnerProtocol: z.int(),
  runnerVersion: z.string(),
  sdkVersion: z.string(),
  bundleSha256: z.string().nullable(),
  capabilities: z.array(z.string()),
  roots: z.array(z.strictObject({ id: RunnerRootId, label: z.string().min(1).max(64) })).max(16),
  browse: z.boolean(),
  programs: z.array(RunnerProgramStatus).max(8),
});
export type RunnerHello = z.infer<typeof RunnerHello>;

/**
 * 거절이면 러너는 사유를 출력하고 종료한다. hello 거절은 판본 불일치뿐이다 — 토큰 틀림(UNAUTHORIZED)·가드 차단(RATE_LIMITED)은
 * 핸드셰이크 미들웨어가 connect_error 로 거절하고, 러너는 거기서 가른다(RATE_LIMITED 는 끝내지 않는다 — 최종 리뷰 M3)
 */
export const RunnerHelloResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), serverVersion: z.string() }),
  z.object({ ok: z.literal(false), code: z.literal("PROTOCOL_MISMATCH"), message: z.string() }),
]);
export type RunnerHelloResult = z.infer<typeof RunnerHelloResult>;

/**
 * 봇 id — 그 봇 에이전트의 providerAgentId(서버가 짓는 `r-` + 소문자 hex 10, 러너 봇 스펙 B1). 러너가 `botsDir/<id>` 를 런 자리로
 * 쓰므로 이 꼴만 받는다(`..`·`/` 가 들어갈 자리가 없다). 러너는 이 검사를 믿지 않고 realpath 로 다시 본다
 */
export const RUNNER_BOT_ID_PATTERN = /^r-[0-9a-f]{10}$/;
export const RunnerBotId = z.string().regex(RUNNER_BOT_ID_PATTERN, "bot id must match r-[0-9a-f]{10}");
export type RunnerBotId = z.infer<typeof RunnerBotId>;

/** 봇 런의 자리 — soul 은 러너가 봇 폴더의 `SOUL.md` 로 쓰는 본문(서버 `renderBotSoul`). 지시는 서버가 channelRulesAppend 에 넣는다(B9) */
export const RunnerRunBot = z.object({
  id: RunnerBotId,
  soul: z.string().max(16_000),
  /**
   * 봇의 MCP 서버 원문(러너 봇 2부 스펙 T5·T6) — 서버는 능력 botMcp 가 있는 러너에만 싣는다. 러너는 받은 것을 appMcpVerdict 로 다시
   * 판정해 통과한 것만 SDK mcpServers 에 넣는다. strict 가 아니라 옛 러너는 이 키들을 버린다
   */
  mcpServers: McpServers.optional(),
  mcpAutoAllow: McpAutoAllowMap.optional(),
  /** 내장 도구(T7) — 서버는 능력 runnerControl 이 없는 러너에는 빼고 싣는다 */
  builtinTools: RunnerBotBuiltinTools.optional(),
});
export type RunnerRunBot = z.infer<typeof RunnerRunBot>;

/**
 * 서버가 정한 에이전트 정의 — 러너는 런마다 천장(로컬 설정)과 견주고 넘으면 RUNNER_CEILING 으로 거절한다. 자리는 project·bot 중
 * 정확히 하나(러너 봇 스펙 B2). 옛 러너는 project 를 요구한다 — 서버는 능력 `bots` 가 없는 러너에 봇 런을 보내지 않는다(B7).
 * refine 이 붙어 `.pick` 을 못 쓴다 — 필드 스키마는 `.shape` 로 꺼낸다
 */
export const RunnerRunAgent = z
  .object({
    program: RunnerProgram,
    project: RunnerProjectRef.optional(),
    bot: RunnerRunBot.optional(),
    /** null 이면 프로그램 기본 모델 */
    model: z.string().min(1).max(128).nullable(),
    permissionMode: RunnerPermissionMode,
    /** null·없음이면 프로그램 기본. 옛 서버는 싣지 않는다 — strict 가 아니라 옛 러너는 이 키를 버린다 */
    effort: RunnerEffort.nullable().optional(),
    /** 묻지 않고 허용하는 도구. null 이면 미리 허용한 도구가 없다(상한 안에서 프로그램 기본). 서버는 늘 null 을 보낸다 — 옛 러너가 이 키를 요구한다 */
    allowedTools: RunnerToolNames.nullable(),
    disallowedTools: RunnerToolNames,
  })
  .refine((a) => (a.project === undefined) !== (a.bot === undefined), {
    message: "agent needs exactly one of project or bot",
  });
export type RunnerRunAgent = z.infer<typeof RunnerRunAgent>;

/**
 * 런 하나. resume 은 싣지 않는다 — 러너가 그 providerSessionId 의 전사가 있으면 이어 가고 없으면 새로 연다(판정 P2).
 * channelRulesAppend·turnFacts 는 서버가 `buildChannelRulesAppend`·`buildTurnFacts` 로 만든다(판정 P3 — 에이전트 지시도 그 틀 안,
 * 러너 일반화 계획 판정 PR1). providerSessionId 는 서버가 세션 id 를 정할 수 있는 프로그램(serverSessionIds)이면 늘, 아니면 그
 * 프로그램이 run.session 으로 알린 값이 있을 때만 싣는다
 */
export const RunnerRunStart = z.object({
  deliver: InboundDeliver,
  providerSessionId: z.string().min(1).max(128).optional(),
  channelRulesAppend: z.string(),
  turnFacts: z.string(),
  sessionTitle: z.string().max(120),
  agent: RunnerRunAgent,
});
export type RunnerRunStart = z.infer<typeof RunnerRunStart>;

/** 프로그램이 스스로 지은 세션 id — 서버가 세션 행에 저장해 다음 런에 싣는다 */
export const RunnerRunSession = z.object({ runId: Id, providerSessionId: z.string().min(1).max(128) });
export type RunnerRunSession = z.infer<typeof RunnerRunSession>;

/** fs.list — 디렉터리만, 숨김(`.` 시작) 빼고, 루트 밖을 가리키는 링크 빼고, 이름순 500개 */
export const RUNNER_FS_LIST_MAX = 500;
export const RunnerFsEntry = z.object({ name: z.string().min(1).max(255), isGitRepo: z.boolean() });
export type RunnerFsEntry = z.infer<typeof RunnerFsEntry>;
export const RunnerFsListResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    entries: z.array(RunnerFsEntry).max(RUNNER_FS_LIST_MAX),
    truncated: z.boolean(),
  }),
  // FORBIDDEN — 러너가 둘러보기를 껐다(browse: false). NOT_FOUND — 루트·디렉터리가 없거나 루트 밖
  z.object({ ok: z.literal(false), code: z.enum(["FORBIDDEN", "NOT_FOUND"]) }),
]);
export type RunnerFsListResult = z.infer<typeof RunnerFsListResult>;

export const RunnerProjectCheckResult = z.discriminatedUnion("ok", [
  // isGitTop — 저장소의 주 작업 트리 맨 위일 때만 참(워크트리 스펙 W14). 옛 러너는 싣지 않는다(서버는 false 로 읽는다)
  z.object({ ok: z.literal(true), isGitRepo: z.boolean(), isGitTop: z.boolean().optional() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["root_missing", "not_found", "not_directory", "outside_root"]),
  }),
]);
export type RunnerProjectCheckResult = z.infer<typeof RunnerProjectCheckResult>;

// ── git 워크트리(워크트리 스펙 5.2) — 서버 → 러너 ack 요청. message 는 러너가 경로를 가리고 200자로 자른 git stderr

/** worktree.create — repo 는 저장소(주 작업 트리 맨 위), target 은 만들 워크트리 폴더(아직 없거나 빈 디렉터리) */
export const RunnerWorktreeCreate = z.object({
  repo: RunnerProjectRef,
  target: RunnerProjectRef,
  branch: z.string().min(1).max(200),
});
export type RunnerWorktreeCreate = z.infer<typeof RunnerWorktreeCreate>;

export const RunnerWorktreeCreateResult = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    /** 새 브랜치였나 */
    created: z.boolean(),
    /** 이미 그 자리에 같은 브랜치로 등록된 워크트리를 받아들였나(W13) */
    adopted: z.boolean(),
    /** 기준 커밋 짧은 해시 */
    base: z.string().max(64),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum([
      "not_git",
      "is_worktree",
      "target_exists",
      "outside_root",
      "root_missing",
      "branch_in_use",
      "invalid_branch",
      "git_failed",
    ]),
    message: z.string().max(200).optional(),
  }),
]);
export type RunnerWorktreeCreateResult = z.infer<typeof RunnerWorktreeCreateResult>;

/**
 * worktree.remove — `--force` 없이 지운다. 커밋하지 않은 변경·추적 안 된 파일이 있으면 dirty(W7), 분리된 HEAD 의 커밋이 어떤
 * 브랜치에도 닿지 않으면 unmerged_detached(지우면 그 커밋을 찾을 길이 없다)
 */
export const RunnerWorktreeRemove = z.object({ repo: RunnerProjectRef, target: RunnerProjectRef });
export type RunnerWorktreeRemove = z.infer<typeof RunnerWorktreeRemove>;

export const RunnerWorktreeRemoveResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(["dirty", "unmerged_detached", "not_worktree", "git_failed"]),
    message: z.string().max(200).optional(),
  }),
]);
export type RunnerWorktreeRemoveResult = z.infer<typeof RunnerWorktreeRemoveResult>;

/** 천장 검사가 걸린 항목 — run.error RUNNER_CEILING 의 message 가 이 이름 하나다 */
export const RunnerCeilingItem = z.enum(["root", "path", "program", "permissionMode", "allowedTools", "bot"]);
export type RunnerCeilingItem = z.infer<typeof RunnerCeilingItem>;

// ── 명령 목록(에이전트 명령 스펙 C8) — 서버 → 러너 ack 요청. 프로젝트마다 묻는다(프로젝트 명령이 cwd 마다 다르다). 봇은 그 봇
// 폴더로 묻는다(러너 봇 스펙 B13 — 능력 `bots` 인 러너에만)

/** 러너 명령 목록 ack 상한 — 프롬프트 없는 query 를 열고 supportedCommands() 를 받는 시간 */
export const RUNNER_COMMANDS_LIST_TIMEOUT_MS = 30_000;

export const RunnerCommandsList = z.union([
  z.object({ project: RunnerProjectRef }),
  z.object({ bot: z.object({ id: RunnerBotId }) }),
]);
export type RunnerCommandsList = z.infer<typeof RunnerCommandsList>;

export const RunnerCommandsListResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), commands: z.array(AgentCommand).max(AGENT_COMMANDS_MAX) }),
  z.object({ ok: z.literal(false), reason: z.enum(["root_missing", "not_found", "failed"]) }),
]);
export type RunnerCommandsListResult = z.infer<typeof RunnerCommandsListResult>;
