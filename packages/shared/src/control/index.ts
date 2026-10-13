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

/**
 * 러너·플러그인이 control.call 의 ack 를 받지 못한 호출(보낸 뒤 끊김·CONTROL_CALL_TIMEOUT_MS 초과). 서버는 그 호출을 받았을 수 있고,
 * 확인 카드는 끊김·시간 초과로 닫히지 않아 사람이 나중에 허용하면 실행된다 — 그래서 「실패」라고 하지 않는다. 실패라고 하면 모델이
 * 같은 요청을 되풀이해 카드가 둘 뜬다. 보내기 전에 끊겨 있었으면 서버에 닿지 않은 것이라 이것이 아니라 ADAPTER_UNAVAILABLE 이다
 */
export type ControlUnknownResult = { unknown: true };
export const CONTROL_RESULT_UNKNOWN_MESSAGE =
  "결과를 모릅니다 — 서버의 답을 받지 못했습니다(연결이 끊겼거나 시간이 지났습니다). 요청은 확인 카드에서 아직 기다리고 있거나 이미 " +
  "실행됐을 수 있습니다. 채널의 확인 카드나 시스템 메시지를 확인하고, 같은 요청을 바로 되풀이하지 마세요.";

/**
 * 모델에게 보이는 도구 결과 글 — `/mcp`·러너·플러그인이 같은 꼴을 쓴다. 성공은 data 의 JSON, 서버가 거절한 것은 { code, message } 의
 * JSON(ErrorCode 그대로 — 제어 MCP 스펙 「실행 흐름」 장), 결과를 모르는 것은 CONTROL_RESULT_UNKNOWN_MESSAGE
 */
export function controlResultText(result: ControlResult | ControlUnknownResult): {
  text: string;
  isError: boolean;
} {
  if ("unknown" in result) return { text: CONTROL_RESULT_UNKNOWN_MESSAGE, isError: true };
  if (result.ok) return { text: JSON.stringify(result.data ?? null), isError: false };
  return { text: JSON.stringify({ code: result.error.code, message: result.error.message }), isError: true };
}
