import { randomUUID } from "node:crypto";
import {
  CONTROL_TOOLS,
  type ControlResult,
  type ControlUnknownResult,
  controlResultText,
  type RunnerControlCall,
} from "@dodok/shared";
import { defineSdkTool, type SdkMcpTool } from "./drivers/claude/sdk";

// 제어 도구(제어 MCP 스펙 「Claude 러너」 절) — shared CONTROL_TOOLS 를 dodok MCP 서버에 그대로 싣는다. 처리기는 `/runner` 의
// control.call 로 서버에 묻고 그 ack 를 도구 결과로 돌려준다. 역할·확인 카드·입력 검사는 서버가 한다(여기서 막지 않는다)

/** 모델이 보는 이름 — allowedTools 에 늘 싣는다. 쓰기는 서버가 확인 카드를 띄우므로 러너 승인 카드까지 뜨면 두 번 묻는다 */
export const CONTROL_TOOL_FULL_NAMES: readonly string[] = CONTROL_TOOLS.map((t) => `mcp__dodok__${t.name}`);

/** 서버에 닿지 못했거나(ControlResult 의 ADAPTER_UNAVAILABLE) 답을 못 받은(unknown) 것까지 담는다 */
export type ControlCallOutcome = ControlResult | ControlUnknownResult;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export function createControlTools(deps: {
  /** 그 런의 run.start 런 id — 서버는 이 러너 토큰이 맡은 열린 런일 때만 받는다(끝난 런의 이름으로 부를 수 없다) */
  runId: string;
  call: (call: RunnerControlCall) => Promise<ControlCallOutcome>;
  newId?: () => string;
}): SdkMcpTool[] {
  return CONTROL_TOOLS.map((tool) =>
    // SDK MCP 층은 모양(shape)만 본다 — refine·strict 는 서버의 입력 검사(VALIDATION)가 본다
    defineSdkTool(tool.name, tool.description, tool.input.shape, async (args): Promise<ToolResult> => {
      const outcome = await deps.call({
        callId: (deps.newId ?? randomUUID)(),
        runId: deps.runId,
        tool: tool.name,
        args: args as Record<string, unknown>,
      });
      const { text, isError } = controlResultText(outcome);
      return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
    }),
  );
}
