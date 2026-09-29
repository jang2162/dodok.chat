import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import {
  RUN_EVENT_TYPES,
  RUNNER_ATTACHMENTS_PATH,
  RUNNER_NAMESPACE,
  RUNNER_PROTOCOL,
  RunEventBodySchema,
  RunnerApprovalRequested,
  RunnerApprovalResolve,
  RunnerApprovalWithdrawn,
  RunnerCapability,
  RunnerHello,
  RUNNER_POST_ID_PREFIX,
  RunnerHelloResult,
  RunnerOutboundAck,
  RunnerOutboundPost,
  RunnerRunAbort,
  RunnerRunAck,
  RunnerRunError,
  RunnerRunEvent,
  RunnerRunFinal,
  RunnerRunStart,
  type RunEventBody,
} from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const CH = "01a09fc9-d204-7551-89d6-38544d07a102";
const MSG = "01a09fc9-d204-7551-89d6-38544d07a103";
const SESSION = "5d3c1c2e-7f0a-4b8e-9c1d-2a3b4c5d6e7f";
const NOW = "2026-09-27T00:00:00.000Z";

const AGENT = { id: "coder", name: "코더", model: "sonnet", workdirLabel: "my-repo" };
const HELLO = {
  runnerProtocol: RUNNER_PROTOCOL,
  runnerVersion: "0.0.0",
  sdkVersion: "0.3.283",
  claudeCodeVersion: "3.1.0",
  bundleSha256: null,
  capabilities: ["threads", "interrupt", "approvals", "attachments"],
  agents: [AGENT],
};
const DELIVER = {
  deliveryId: ID,
  kind: "message",
  channelId: CH,
  agentId: "coder",
  sessionKey: `agent:coder:dodok:channel:${CH}`,
  runId: ID,
  message: {
    id: MSG,
    author: { type: "user", handle: "mia", displayName: "Mia" },
    text: "@coder 안녕",
    attachments: [],
    ts: NOW,
  },
  context: {
    recentMessages: [],
    participants: [],
    relayRules: "릴레이 없음",
  },
  options: {},
};
const START = {
  deliver: DELIVER,
  providerSessionId: SESSION,
  channelRulesAppend: "# dodok channel settings",
  turnFacts: "[dodok context]",
  sessionTitle: "general · 코더",
};
const APPROVAL = {
  providerApprovalId: "ap-1",
  runId: ID,
  sessionKey: `agent:coder:dodok:channel:${CH}`,
  toolCallId: "toolu_1",
  toolName: "Bash",
  summary: "git push",
  canAllowAlways: true,
};
const FINAL = {
  runId: ID,
  text: "끝",
  stopReason: "end_turn",
  usage: { inputTokens: 10, outputTokens: 3 },
  costUsd: 0.12,
  costKind: "subscription_estimate",
};

/** parse 결과가 입력과 같다 — 모르는 키도 기본값도 없는 유효 예 */
function roundTrip(schema: { parse(v: unknown): unknown }, value: unknown) {
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
}

describe("/runner 상수(P1)", () => {
  it("네임스페이스·첨부 경로·프로토콜", () => {
    expect(RUNNER_NAMESPACE).toBe("/runner");
    expect(RUNNER_ATTACHMENTS_PATH).toBe("/runner/attachments");
    expect(RUNNER_PROTOCOL).toBe(1);
    expect(RunnerCapability.options).toEqual(["threads", "interrupt", "approvals", "attachments"]);
  });
});

describe("/runner 프레임 — 유효 예 왕복", () => {
  it.each([
    ["RunnerHello", RunnerHello, HELLO],
    ["RunnerHelloResult ok", RunnerHelloResult, { ok: true, serverVersion: "0.0.0", conflicts: ["coder"] }],
    [
      "RunnerHelloResult 거절",
      RunnerHelloResult,
      { ok: false, code: "PROTOCOL_MISMATCH", message: "서버와 러너 판본을 맞추세요" },
    ],
    ["RunnerRunStart", RunnerRunStart, START],
    ["RunnerRunAck", RunnerRunAck, { runId: ID, admission: "dispatch", queuedPosition: 2 }],
    [
      "RunnerRunEvent",
      RunnerRunEvent,
      { runId: ID, event: { type: "TEXT_MESSAGE_CONTENT", runId: ID, messageId: "m1", delta: "안" } },
    ],
    ["RunnerRunFinal", RunnerRunFinal, FINAL],
    ["RunnerRunError", RunnerRunError, { runId: ID, code: "PROVIDER_AUTH", message: "로그인 필요" }],
    ["RunnerRunAbort", RunnerRunAbort, { runId: ID }],
    [
      "RunnerOutboundPost",
      RunnerOutboundPost,
      {
        outboundId: "runner-post:o-1",
        channelId: CH,
        agentId: "coder",
        sessionKey: `agent:coder:dodok:channel:${CH}`,
        runId: ID,
        text: "카드",
        attachmentIds: [ID],
        ts: NOW,
      },
    ],
    ["RunnerOutboundAck ok", RunnerOutboundAck, { ok: true, messageId: MSG }],
    ["RunnerOutboundAck 거절", RunnerOutboundAck, { ok: false, code: "VALIDATION", message: "빈 글" }],
    ["RunnerApprovalRequested", RunnerApprovalRequested, APPROVAL],
    ["RunnerApprovalWithdrawn", RunnerApprovalWithdrawn, { providerApprovalId: "ap-1" }],
    [
      "RunnerApprovalResolve",
      RunnerApprovalResolve,
      { providerApprovalId: "ap-1", decision: "allow-always" },
    ],
    [
      "RunnerApprovalResolve 기한",
      RunnerApprovalResolve,
      { providerApprovalId: "ap-1", decision: "deny", reason: "expired" },
    ],
  ])("%s", (_name, schema, value) => {
    roundTrip(schema, value);
  });
});

describe("/runner 프레임 — 거절", () => {
  it("RunnerHello — 에이전트 id 대문자(키에서 푼 id 와 어긋난다)", () => {
    expect(RunnerHello.safeParse({ ...HELLO, agents: [{ ...AGENT, id: "Coder" }] }).success).toBe(false);
  });

  it("RunnerHello — 에이전트 33개", () => {
    const agents = Array.from({ length: 33 }, (_, i) => ({ ...AGENT, id: `a${i}` }));
    expect(RunnerHello.safeParse({ ...HELLO, agents }).success).toBe(false);
    expect(RunnerHello.safeParse({ ...HELLO, agents: agents.slice(0, 32) }).success).toBe(true);
  });

  it("RunnerHello — 모르는 capability 는 문자열이면 받는다(서버가 버린다)", () => {
    expect(RunnerHello.parse({ ...HELLO, capabilities: ["threads", "teleport"] }).capabilities).toEqual([
      "threads",
      "teleport",
    ]);
  });

  it("RunnerRunStart — providerSessionId 가 UUID 가 아님", () => {
    expect(RunnerRunStart.safeParse({ ...START, providerSessionId: "not-a-uuid" }).success).toBe(false);
  });

  it("RunnerRunStart — 제목 121자", () => {
    expect(RunnerRunStart.safeParse({ ...START, sessionTitle: "가".repeat(121) }).success).toBe(false);
  });

  it("RunnerApprovalRequested — summary 401자", () => {
    expect(RunnerApprovalRequested.safeParse({ ...APPROVAL, summary: "a".repeat(400) }).success).toBe(true);
    expect(RunnerApprovalRequested.safeParse({ ...APPROVAL, summary: "a".repeat(401) }).success).toBe(false);
  });

  it("RunnerRunFinal — costUsd 음수", () => {
    expect(RunnerRunFinal.safeParse({ ...FINAL, costUsd: -0.01 }).success).toBe(false);
  });

  it("RunnerRunFinal — costKind 밖의 값", () => {
    expect(RunnerRunFinal.safeParse({ ...FINAL, costKind: "free" }).success).toBe(false);
  });

  it("RunnerRunError — ErrorCode 밖의 코드", () => {
    expect(RunnerRunError.safeParse({ runId: ID, code: "OOPS", message: "x" }).success).toBe(false);
  });

  it("RunnerHelloResult — hello 거절 코드는 서버가 실제로 내는 PROTOCOL_MISMATCH 하나뿐 — 토큰·가드 거절은 핸드셰이크(connect_error)로 간다 [최종 리뷰 M3]", () => {
    for (const code of ["INTERNAL", "UNAUTHORIZED", "RATE_LIMITED"])
      expect(RunnerHelloResult.safeParse({ ok: false, code, message: "x" }).success).toBe(false);
  });

  it("RunnerOutboundPost — outboundId 는 runner-post: 접두사 뒤에 한 글자 이상 [최종 리뷰 M4]", () => {
    const post = {
      channelId: CH,
      agentId: "coder",
      sessionKey: `agent:coder:dodok:channel:${CH}`,
      runId: ID,
      text: "카드",
      ts: NOW,
    };
    for (const outboundId of [
      `runner-final:${ID}`,
      "o-1",
      RUNNER_POST_ID_PREFIX,
      ` ${RUNNER_POST_ID_PREFIX}x`,
    ])
      expect(RunnerOutboundPost.safeParse({ ...post, outboundId }).success).toBe(false);
    expect(RunnerOutboundPost.safeParse({ ...post, outboundId: `${RUNNER_POST_ID_PREFIX}x` }).success).toBe(
      true,
    );
  });
});

describe("RunEventBodySchema — seq·ts 는 서버가 붙인다", () => {
  it("seq·ts 가 있어도 통과하되 결과에서 빠진다", () => {
    const parsed = RunEventBodySchema.parse({
      type: "TOOL_CALL_START",
      runId: ID,
      seq: 7,
      ts: NOW,
      toolCallId: "toolu_1",
      toolCallName: "Read",
    });
    expect(parsed).toEqual({
      type: "TOOL_CALL_START",
      runId: ID,
      toolCallId: "toolu_1",
      toolCallName: "Read",
    });
    expect(parsed).not.toHaveProperty("seq");
    expect(parsed).not.toHaveProperty("ts");
  });

  it("모르는 이벤트 종류·변형의 필수 필드 누락은 거절", () => {
    expect(RunEventBodySchema.safeParse({ type: "NOPE", runId: ID }).success).toBe(false);
    expect(
      RunEventBodySchema.safeParse({ type: "TEXT_MESSAGE_CONTENT", runId: ID, messageId: "m1" }).success,
    ).toBe(false);
  });

  it("파싱 결과 타입이 어댑터 계약의 RunEventBody 와 같다", () => {
    expectTypeOf<z.infer<typeof RunEventBodySchema>>().toEqualTypeOf<RunEventBody>();
  });

  it("RunEvent 의 모든 변형을 싣는다", () => {
    expect(RunEventBodySchema.options.map((o) => o.shape.type.value)).toEqual(RUN_EVENT_TYPES);
  });
});
