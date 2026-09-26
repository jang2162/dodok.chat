import type {
  Approval,
  ApprovalDecision,
  ClientToServerEvents,
  ComponentInteract,
  RunEventsReplayResult,
  RunState,
  ServerToClientEvents,
} from "@dodok/shared";
import type { Server, Socket } from "socket.io";

/** 인증 미들웨어가 채운다. sessionId 는 Better Auth session 행의 id — 토큰 원문은 소켓에 두지 않는다 */
export type WireSocketData = { userId: string; sessionId: string };

/** 기본 네임스페이스 wire 서버(계약 스펙 7장). 서버 간 이벤트는 없다(단일 프로세스). */
export type WireServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  WireSocketData
>;
export type WireSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  WireSocketData
>;

/** wire 가 런에 대해 부르는 면. 태스크 9 가 오케스트레이터·상호작용 서비스로 구현한다. */
export type RunsFacade = {
  /** 채널의 종료되지 않은 런 */
  activeRuns(channelId: string): RunState[];
  /** 채널의 아직 살아 있는 승인(만료 시각이 지난 것은 뺀다) — 구독 ack */
  pendingApprovals(channelId: string): Approval[];
  /** 승인 카드의 버튼 — 설계 4.4 의 검사를 통과할 때만 Gateway 로 나간다 */
  resolveApproval(input: { approvalId: string; decision: ApprovalDecision; userId: string }): Promise<void>;
  abort(runId: string, userId: string): Promise<void>;
  replay(runId: string, afterSeq: number): Promise<RunEventsReplayResult>;
  interact(input: ComponentInteract & { userId: string }): Promise<{ interactionId: string }>;
};
