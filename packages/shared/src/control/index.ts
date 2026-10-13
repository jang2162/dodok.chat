import { z } from "zod";
import { ErrorCode, Id } from "../common";

// 채널 안 에이전트가 제어 도구를 부르는 프레임(제어 MCP 스펙 「통로」 장) — 러너 `/runner`·플러그인 `/bridge` 의 `control.call`.
// 결과는 따로 프레임을 두지 않고 Socket.IO ack 로 돌려준다(계획 판정 PC2). 확인 카드를 기다리는 동안 ack 가 늦게 온다

export * from "./rest-bodies";
export * from "./tools";

/** tool 은 문자열로 받는다 — 모르는 이름은 서버가 findControlTool 로 가려 오류로 돌려준다(옛 서버·새 러너 조합에서 연결을 끊지 않게) */
export const ControlCall = z.object({
  callId: z.string().min(1).max(64),
  tool: z.string().max(64),
  args: z.record(z.string(), z.unknown()),
});
export type ControlCall = z.infer<typeof ControlCall>;

/** 러너 → 서버. runId 는 그 러너 토큰이 맡은 열린 런 — 끝난 런이면 서버가 NOT_FOUND */
export const RunnerControlCall = ControlCall.extend({ runId: Id });
export type RunnerControlCall = z.infer<typeof RunnerControlCall>;

/**
 * 플러그인 → 서버. runId 는 그 세션의 마지막 인바운드 런(플러그인 상관관계) — 세션 키만으로 찾으면 끝난 런의 늦은 호출이 같은 세션의
 * 다음 런을 시킨 사람의 권한을 빌린다. 서버는 그 런이 열려 있고 sessionKey·Gateway 가 맞을 때만 받는다
 */
export const BridgeControlCall = ControlCall.extend({ sessionKey: z.string(), runId: Id });
export type BridgeControlCall = z.infer<typeof BridgeControlCall>;

/** 확인 카드 기한 — 러너 도구 승인 기한과 같은 10분. 그 안에 결정이 없으면 도구 호출은 EXPIRED 로 끝난다 */
export const CONTROL_CONFIRM_TTL_MS = 600_000;

/**
 * 러너 CLI·플러그인이 control.call 의 ack 를 기다리는 상한. 서버는 확인 카드를 기다리는 동안 ack 를 미루고(최대
 * CONTROL_CONFIRM_TTL_MS, 그 전에 런이 끝나면 그때) 스스로 끊지 않는다 — 이보다 짧으면 허용한 쓰기가 실행됐는데 에이전트는 시간
 * 초과로 안다
 */
export const CONTROL_CALL_TIMEOUT_MS = CONTROL_CONFIRM_TTL_MS + 60_000;

export const ControlResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: ErrorCode, message: z.string() }) }),
]);
export type ControlResult = z.infer<typeof ControlResult>;
