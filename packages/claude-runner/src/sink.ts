import {
  RUNNER_SHUTDOWN_STOP_REASON,
  type ErrorCode,
  type RunEventBody,
  type RunnerApprovalRequested,
  type RunnerApprovalResolve,
  type RunnerControlCall,
  type RunnerOutboundAck,
  type RunnerOutboundPost,
  type RunnerRunFinal,
} from "@dodok/shared";
import type { AttachmentsHttp } from "./attachments-http";
import type { ControlCallOutcome } from "./control-tools";
import { createPathMasker, type PathMasker, workdirRoots } from "./mask";

// 런이 서버로 내보내는 한 자리(러너 일반화 스펙 4장 RunSink). 호스트 경로 가림은 여기서 정한다 — 가리는 뿌리(작업 디렉터리의
// 설정 경로와 realpath)는 workdirMasker 하나가 짓고, 드라이버는 스트리밍 꼬리 쥐기·카드 길이 검사처럼 구조를 아는 자리에서
// sink.mask 를 쓴다. 그와 별도로 sink 는 run.event·run.final·run.error·outbound.post·approval.requested 의 글 칸을 내보내기
// 직전에 한 번 더 가린다 — 가림은 두 번 해도 같은 글이라(가린 글에는 작업 디렉터리·절대 경로가 남지 않는다) 드라이버가 빠뜨린
// 칸의 그물이다. 보지 않는 것: control.call 인자(채널 프롬프트 등 사람이 시킨 글이다), 이미지·파일 바이트

const ERROR_MESSAGE_MAX = 2000;

/** interrupt 로 끝난 런의 final — 어댑터가 메시지 없는 중지로 닫는다(판정 R1) */
export const ABORTED_STOP_REASON = "aborted";

/**
 * 중지로 끝난 런 — 메시지 없는 final(조율자 판정 R1). 러너는 수명 이벤트를 run.event 로 내지 않는다.
 * reason 은 중지 signal 의 reason — 러너를 끄느라 멈췄으면 stopReason 이 runner_shutdown 이다
 */
export function abortedFinal(
  costKind: RunnerRunFinal["costKind"] = "subscription_estimate",
  reason?: unknown,
): Omit<RunnerRunFinal, "runId"> {
  return { text: "", stopReason: abortStopReason(reason), costKind };
}

export function abortStopReason(reason: unknown): string {
  return reason === RUNNER_SHUTDOWN_STOP_REASON ? RUNNER_SHUTDOWN_STOP_REASON : ABORTED_STOP_REASON;
}

export type ApprovalOutcome = Pick<RunnerApprovalResolve, "decision" | "reason">;

/** 작업 디렉터리 경로를 가리는 함수 — 이 런의 sink 와 드라이버의 요약(승인 카드)이 같은 뿌리를 쓴다 */
export const workdirMasker = (workdir: string): PathMasker => createPathMasker(workdirRoots(workdir));

/** run.* 프레임을 내보내는 길 — 연결이 연결 세대에 묶어 만든다 */
export type RunEmitter = {
  event(event: RunEventBody): void;
  final(final: Omit<RunnerRunFinal, "runId">): void;
  error(code: ErrorCode, message: string): void;
  /** 프로그램이 스스로 지은 세션 id(run.session) — serverSessionIds 가 없는 드라이버만 */
  session(providerSessionId: string): void;
};

/** 런이 서버와 주고받는 길 — 연결이 연결 세대에 묶어 만든다(끊긴 연결의 런은 새 연결로 보내지 않는다) */
export type RunBridge = {
  http: AttachmentsHttp;
  post(message: RunnerOutboundPost): Promise<RunnerOutboundAck>;
  /** 제어 도구 호출 — 던지지 않는다. 보낸 뒤 답을 못 받으면 unknown(서버가 실행했을 수 있다) */
  control(call: RunnerControlCall): Promise<ControlCallOutcome>;
  requestApproval(request: RunnerApprovalRequested): void;
  withdrawApproval(providerApprovalId: string): void;
  /** approval.resolve 가 오면 풀리고 signal 이 끊기면 거절된다 */
  waitDecision(providerApprovalId: string, signal: AbortSignal): Promise<ApprovalOutcome>;
};

export type RunSink = RunEmitter &
  RunBridge & {
    /** 이 런의 작업 디렉터리 가림 */
    mask: PathMasker;
  };

function maskEvent(event: RunEventBody, mask: PathMasker): RunEventBody | undefined {
  switch (event.type) {
    case "TEXT_MESSAGE_CONTENT": {
      const delta = mask(event.delta);
      return delta ? { ...event, delta } : undefined;
    }
    case "TOOL_CALL_ARGS":
      return { ...event, delta: mask.json(event.delta) };
    case "TOOL_CALL_RESULT":
      return { ...event, content: mask(event.content) };
    default:
      return event;
  }
}

export function createRunSink(o: { workdir: string; emit: RunEmitter; bridge: RunBridge }): RunSink {
  const mask = workdirMasker(o.workdir);
  const { emit, bridge } = o;
  return {
    mask,
    http: bridge.http,
    event(event) {
      const masked = maskEvent(event, mask);
      if (masked) emit.event(masked);
    },
    final(final) {
      emit.final({ ...final, text: mask(final.text) });
    },
    error(code, message) {
      emit.error(code, mask(message).slice(0, ERROR_MESSAGE_MAX));
    },
    session: (id) => emit.session(id),
    post(message) {
      return bridge.post({
        ...message,
        text: mask(message.text),
        ...(message.components === undefined
          ? {}
          : { components: mask.value(message.components) as RunnerOutboundPost["components"] }),
      });
    },
    control: (call) => bridge.control(call),
    requestApproval(request) {
      bridge.requestApproval({ ...request, summary: mask(request.summary) });
    },
    withdrawApproval: (id) => bridge.withdrawApproval(id),
    waitDecision: (id, signal) => bridge.waitDecision(id, signal),
  };
}
