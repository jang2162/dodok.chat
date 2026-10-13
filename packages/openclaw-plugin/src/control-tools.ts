/**
 * 제어 도구(제어 MCP 스펙 「OpenClaw 플러그인」 절) — shared CONTROL_TOOLS 를 dodok 세션의 에이전트에게 도구로 낸다. 실행은 브리지의
 * control.call 로 서버에 묻고 그 ack 를 도구 결과로 돌려준다. 역할·확인 카드·입력 검사는 서버가 한다(여기서 막지 않는다).
 *
 * 브리지·상관관계는 globalThis 레지스트리에서 찾는다 — 모델 런의 도구는 번들의 둘째 평가 세대에서 돈다(ADR 0004).
 * `openclaw` 를 import 하지 않는다(단위 테스트 대상). 도구 꼴은 SDK AnyAgentTool 에 맞춘다 — 등록은 index.ts.
 */
import { randomUUID } from "node:crypto";
import {
  CONTROL_TOOLS,
  type BridgeControlCall,
  type ControlResult,
  type ControlUnknownResult,
  controlResultText,
  controlToolJsonSchema,
  parseDodokSessionKey,
} from "@dodok/shared";
import { getBridge, getCorrelation } from "./bridge-registry";
import { DEFAULT_ACCOUNT_ID } from "./config";

/**
 * Gateway 의 도구 이름은 플러그인·코어를 통틀어 하나의 이름 공간이다 — 겹치면 코어가 나중 것을 오류 로그만 남기고 뺀다
 * (loader 「plugin tool name conflict」). list_channels 같은 이름은 다른 채널 플러그인과 겹치기 쉽고 모델에게도 어느 메신저의 것인지
 * 모호해서 접두를 붙인다. 서버에 보내는 tool 은 접두 없는 CONTROL_TOOLS 이름이다
 */
export const CONTROL_TOOL_PREFIX = "dodok_";
/** openclaw.plugin.json contracts.tools 와 같아야 한다 — 선언하지 않은 이름은 Gateway 가 등록을 거절한다(manifest 테스트) */
export const CONTROL_PLUGIN_TOOL_NAMES: readonly string[] = CONTROL_TOOLS.map(
  (t) => CONTROL_TOOL_PREFIX + t.name,
);

export type ControlToolContext = { sessionKey?: string; agentAccountId?: string };

type ControlToolDetails = { ok: boolean; code?: string };
export type ControlAgentTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: ControlToolDetails }>;
};

/** 브리지가 하는 일 중 도구가 쓰는 것 — 테스트가 갈아 끼운다 */
export type ControlBridge = {
  sendControl: (call: BridgeControlCall) => Promise<ControlResult | ControlUnknownResult>;
};

export type ControlToolDeps = {
  getBridge?: (accountId: string) => ControlBridge | undefined;
  /** 그 세션의 마지막 인바운드 런 id(플러그인 상관관계) */
  getRunId?: (sessionKey: string) => string | undefined;
  newId?: () => string;
};

// details.ok 가 false 면 Gateway 가 도구 결과를 오류로 본다(isError — tool-result-error 의 isToolResultError). 던지지 않는다 — 던지면
// 오류 문구가 Gateway 의 일반 꼴로 바뀌어 code·「결과를 모른다」가 흐려진다
function toolResult(outcome: ControlResult | ControlUnknownResult) {
  const { text, isError } = controlResultText(outcome);
  const code = "unknown" in outcome || outcome.ok ? undefined : outcome.error.code;
  return { content: [{ type: "text" as const, text }], details: { ok: !isError, ...(code ? { code } : {}) } };
}

const refused = (code: "NOT_FOUND" | "ADAPTER_UNAVAILABLE" | "EXPIRED", message: string) =>
  toolResult({ ok: false, error: { code, message } });

/**
 * registerTool 팩토리. dodok 세션이 아니면 도구를 내지 않는다(다른 채널의 세션에서 보이지 않게). runId 는 실행할 때의 상관관계 —
 * 도구가 Gateway 캐시(MCP loopback 30초)로 다음 런까지 쓰일 수 있어 팩토리를 부를 때 잡지 않는다. 끝난 런의 이름은 서버가
 * NOT_FOUND 로 거른다(그 runId 가 열려 있고 세션 키·Gateway 가 맞을 때만 받는다)
 */
export function createControlToolFactory(deps: ControlToolDeps = {}) {
  const bridgeOf = deps.getBridge ?? getBridge;
  const runIdOf = deps.getRunId ?? ((sessionKey: string) => getCorrelation(sessionKey)?.runId);
  const newId = deps.newId ?? randomUUID;
  return (ctx: ControlToolContext): ControlAgentTool[] | null => {
    const sessionKey = ctx.sessionKey;
    if (!sessionKey || parseDodokSessionKey(sessionKey) === undefined) return null;
    const accountId = ctx.agentAccountId ?? DEFAULT_ACCOUNT_ID;
    return CONTROL_TOOLS.map((tool) => ({
      name: CONTROL_TOOL_PREFIX + tool.name,
      label: `dodok ${tool.name}`,
      description: tool.description,
      parameters: controlToolJsonSchema(tool),
      execute: async (_toolCallId, params, signal) => {
        // 멈춘 런의 늦은 호출이 그 사이 같은 세션에 온 다음 인바운드의 runId 를 집지 않게
        if (signal?.aborted) return refused("EXPIRED", "런이 멈춰 보내지 않았습니다");
        const runId = runIdOf(sessionKey);
        if (!runId) {
          return refused(
            "NOT_FOUND",
            "이 세션에 dodok 런이 없습니다 — dodok 채널 메시지로 시작한 런에서만 쓸 수 있습니다",
          );
        }
        const bridge = bridgeOf(accountId);
        if (!bridge)
          return refused("ADAPTER_UNAVAILABLE", `dodok: account "${accountId}" bridge is not running`);
        const args =
          params !== null && typeof params === "object" && !Array.isArray(params)
            ? (params as Record<string, unknown>)
            : {};
        return toolResult(
          await bridge.sendControl({ callId: newId(), sessionKey, runId, tool: tool.name, args }),
        );
      },
    }));
  };
}
