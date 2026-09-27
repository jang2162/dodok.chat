// Claude Agent SDK 를 import 하는 유일한 파일. 나머지는 SdkPort 로만 SDK 를 쓰고, 테스트는 이 포트를 가짜로 바꾼다
// (모든 테스트가 CLI 를 띄우지 않는다 — test/helpers/fake-query.ts).
import {
  createSdkMcpServer,
  getSessionInfo,
  query,
  tool,
  type CanUseTool,
  type Options,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export type SdkMessage = SDKMessage;
export type SdkUserMessage = SDKUserMessage;
export type SdkOptions = Options;
export type { CanUseTool };
// tool() 은 입력 스키마마다 다른 제네릭을 돌려준다 — createSdkMcpServer 가 받는 원소 타입을 그대로 쓴다
export type SdkMcpTool = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>[number];
export type SdkMcpServer = ReturnType<typeof createSdkMcpServer>;
/** 도구 정의를 만드는 순수 함수(CLI·MCP 서버를 띄우지 않는다) — 가짜 SdkPort 도 이 정의의 handler 를 부른다 */
export const defineSdkTool = tool;

export type SdkQuery = AsyncIterable<SdkMessage> & {
  interrupt(): Promise<unknown>;
  close(): void;
};

export type SdkPort = {
  query: (args: { prompt: AsyncIterable<SdkUserMessage>; options: SdkOptions }) => SdkQuery;
  /** 그 세션의 전사가 이 작업 디렉터리에 있으면 참 — 러너가 resume 과 sessionId 를 가른다(계획 판정 P2) */
  sessionExists: (sessionId: string, cwd: string) => Promise<boolean>;
  createMcpServer: (tools: SdkMcpTool[]) => SdkMcpServer;
};

export const realSdk: SdkPort = {
  query: (args) => query(args),
  // SDK 세션 도우미는 러너 프로세스의 process.env.CLAUDE_CONFIG_DIR 을 읽는다(ADR 0007 5.2) — main 이 먼저 맞춰 둔다
  sessionExists: async (sessionId, cwd) => (await getSessionInfo(sessionId, { dir: cwd })) !== undefined,
  // alwaysLoad — 없으면 dodok 도구가 ToolSearch 뒤로 밀려 모델이 스키마 없이 첫 호출을 한다(ADR 0007 5.7)
  createMcpServer: (tools) => createSdkMcpServer({ name: "dodok", alwaysLoad: true, tools }),
};
