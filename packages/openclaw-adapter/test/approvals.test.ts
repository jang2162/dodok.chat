import { Approval, ApprovalKind } from "@dodok/shared";
import type { EventFrame } from "@openclaw/gateway-protocol";
import { describe, expect, it } from "vitest";
import {
  GatewayApprovalKind,
  isApprovalEvent,
  mergeApproval,
  parseApprovalFrame,
  parseApprovalReplay,
  parseResolveResult,
  parseSessionKey,
  resolveParams,
  sameApproval,
  type ProviderApproval,
} from "../src/gateway/approvals";
import * as f from "./fixtures/gateway-events";

// 승인 스파이크 3장(원본 프레임)·4.1(resolve 왕복)·5.2(만료 비대칭)·5.3(재접속 되감기)·10.1(exec 미관측).
// 픽스처는 태스크 2 가 옮겨 둔 실측값 그대로다 — 여기서 다시 만들지 않는다.

const CREATED_AT = new Date(1_789_897_787_988).toISOString();
const EXPIRES_AT = new Date(1_789_897_907_988).toISOString(); // +120s
const RESOLVED_AT = new Date(1_789_897_790_009).toISOString();
const OTHER_SESSION = "agent:dev:discord:channel:01a09fc9-d204-7551-89d6-38544d07a202";
const THREAD_ROOT = "01a09fc9-d204-7551-89d6-38544d07a2ab";

const payloadOf = (frame: EventFrame): unknown => frame.payload;

/** 구독 응답에서 되감기 항목만 꺼낸다(다른 세션 것과 섞어 보려고). */
const replayEntries = (result: Record<string, unknown>): unknown[] =>
  (result.approvalReplay as { approvals: unknown[] }).approvals;

/** 프레임 하나를 정규화한다. undefined 면 테스트가 바로 깨지게 단언까지 한다. */
function parsed(event: string, payload: unknown): ProviderApproval {
  const approval = parseApprovalFrame(event, payload);
  expect(approval, `${event} 가 정규화되지 않았다`).toBeDefined();
  return approval as ProviderApproval;
}

/**
 * 정규화 결과가 shared `Approval` 계약에 그대로 들어갈 수 있는지 — 서버(태스크 4)가 붙이는 열만 채워서 판다.
 * 상한을 넘기거나 값이 계약 밖이면 여기서 걸린다.
 */
function fitsContract(a: ProviderApproval) {
  return Approval.safeParse({
    ...a,
    id: "01a09fc9-d204-7551-89d6-38544d07a2b1",
    channelId: a.conversationId,
    agentId: "01a09fc9-d204-7551-89d6-38544d07a2b2",
    expiresAt: a.expiresAt ?? EXPIRES_AT,
    createdAt: a.createdAt ?? CREATED_AT,
  });
}

describe("parseApprovalFrame — plugin 경로(정본)", () => {
  it("plugin.approval.requested 를 정규화한다", () => {
    const a = parsed("plugin.approval.requested", payloadOf(f.pluginApprovalRequested()));

    expect(a).toEqual({
      providerApprovalId: f.APPROVAL_ID,
      kind: "plugin",
      sessionKey: f.SESSION_KEY,
      providerAgentId: "dev",
      conversationId: f.CHANNEL_ID,
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      toolName: "Write",
      pluginId: "claude-cli",
      title: "claude-cli native tool: Write",
      description: '{"file_path":"/tmp/spike-approval.txt","content":"hello\\n"}',
      detail: '{"file_path":"/tmp/spike-approval.txt","content":"hello\\n"}',
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      status: "pending",
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(fitsContract(a).success).toBe(true);
  });

  it("plugin.approval.resolved 는 결정·이유·해결 시각을 싣고, createdAtMs·expiresAtMs 가 없다(3.4)", () => {
    const payload = payloadOf(f.pluginApprovalResolved()) as Record<string, unknown>;
    expect(payload.createdAtMs).toBeUndefined();
    expect(payload.expiresAtMs).toBeUndefined();

    const a = parsed("plugin.approval.resolved", payload);

    expect(a).toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      kind: "plugin",
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      resolvedAt: RESOLVED_AT,
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
    });
    // 없는 값을 지어내지 않는다 — 태스크 4 는 이미 저장한 행의 값을 지킨다
    expect(a.createdAt).toBeUndefined();
    expect(a.expiresAt).toBeUndefined();
  });

  it("만료는 plugin 경로에서 deny + resolvedBy:null 로 오지만 expired/timeout 으로 흡수한다(5.2)", () => {
    const a = parsed(
      "plugin.approval.resolved",
      payloadOf(f.pluginApprovalResolved({ decision: "deny", resolvedBy: null })),
    );

    expect(a).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
  });

  it("사용자 거절은 denied + user 다(같은 deny 인데 resolvedBy 가 있다)", () => {
    const a = parsed(
      "plugin.approval.resolved",
      payloadOf(f.pluginApprovalResolved({ decision: "deny", resolvedBy: "dodok-server" })),
    );

    expect(a).toMatchObject({ status: "denied", decision: "deny", reason: "user" });
  });

  it("프레임이 status 를 싣고 있으면 그것을 쓴다", () => {
    const base = payloadOf(f.pluginApprovalResolved({ decision: "deny", resolvedBy: null })) as object;
    const a = parsed("plugin.approval.resolved", { ...base, status: "cancelled", reason: "run-aborted" });

    expect(a).toMatchObject({ status: "cancelled", reason: "run-aborted", decision: "deny" });
  });
});

describe("parseApprovalFrame — session.approval(보조, 재접속·중복 경로)", () => {
  it("pending 은 toolCallId 없이 정규화하고 urlPath 를 그대로 싣는다(3.3)", () => {
    const a = parsed("session.approval", payloadOf(f.sessionApproval()));

    expect(a).toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      kind: "plugin",
      status: "pending",
      title: "claude-cli native tool: Write",
      toolName: "Write",
      sessionKey: f.SESSION_KEY,
      conversationId: f.CHANNEL_ID,
      urlPath: `/approve/${encodeURIComponent(f.APPROVAL_ID)}`,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(a.toolCallId).toBeUndefined();
    expect(fitsContract(a).success).toBe(true);
  });

  it("terminal 은 status·decision·reason 을 그대로 쓴다", () => {
    const a = parsed("session.approval", payloadOf(f.sessionApproval({ phase: "terminal" })));

    expect(a).toMatchObject({ status: "allowed", decision: "allow-once", reason: "user" });
  });

  it("만료 terminal 은 expired + timeout(plugin 경로와 같은 값으로 모인다)", () => {
    const a = parsed(
      "session.approval",
      payloadOf(
        f.sessionApproval({ phase: "terminal", status: "expired", decision: "deny", reason: "timeout" }),
      ),
    );

    expect(a).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
  });

  it("⚠ 실측(5.2) — 만료 스냅샷에는 `decision` 이 아예 없다. status·reason 만 읽고 비운 채로 둔다", () => {
    const a = parsed(
      "session.approval",
      payloadOf(
        f.sessionApproval({ phase: "terminal", status: "expired", decision: null, reason: "timeout" }),
      ),
    );

    expect(a).toMatchObject({ status: "expired", reason: "timeout" });
    expect(a.decision).toBeUndefined(); // 지어내지 않는다 — 그 값은 정본 프레임이 들고 온다
  });
});

describe("parseApprovalFrame — 우리 세션만 거른다(전역 이벤트)", () => {
  it("우리 세션 키 모양이면 정규화한다", () => {
    expect(
      parseApprovalFrame("plugin.approval.requested", payloadOf(f.pluginApprovalRequested())),
    ).toBeDefined();
  });

  it("다른 채널 플러그인·TUI 의 승인은 버린다", () => {
    const frames = [
      parseApprovalFrame(
        "plugin.approval.requested",
        payloadOf(f.pluginApprovalRequested({ sessionKey: OTHER_SESSION })),
      ),
      parseApprovalFrame("session.approval", payloadOf(f.sessionApproval({ sessionKey: OTHER_SESSION }))),
      parseApprovalFrame(
        "plugin.approval.requested",
        payloadOf(f.pluginApprovalRequested({ sessionKey: "agent:dev:dodok:channel:not-a-uuid" })),
      ),
      parseApprovalFrame(
        "plugin.approval.requested",
        payloadOf(f.pluginApprovalRequested({ sessionKey: "" })),
      ),
    ];

    expect(frames).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("parseSessionKey 는 스레드 접미사 말고 다른 접미사가 붙은 키를 받지 않는다", () => {
    expect(parseSessionKey(f.SESSION_KEY)).toEqual({ providerAgentId: "dev", conversationId: f.CHANNEL_ID });
    expect(parseSessionKey(`${f.SESSION_KEY}:sub`)).toBeUndefined();
    expect(parseSessionKey(`${f.SESSION_KEY}:thread:x`)).toBeUndefined();
    expect(parseSessionKey(OTHER_SESSION)).toBeUndefined();
  });

  it("parseSessionKey 는 스레드 키에서 threadRootId 까지 돌려준다", () => {
    expect(parseSessionKey(`${f.SESSION_KEY}:thread:${THREAD_ROOT.toUpperCase()}`)).toEqual({
      providerAgentId: "dev",
      conversationId: f.CHANNEL_ID,
      threadRootId: THREAD_ROOT,
    });
  });

  it("스레드 세션의 승인은 threadRootId 를 싣고, 채널 세션의 승인에는 그 키가 없다", () => {
    const threadKey = `${f.SESSION_KEY}:thread:${THREAD_ROOT}`;
    const a = parsed(
      "plugin.approval.requested",
      payloadOf(f.pluginApprovalRequested({ sessionKey: threadKey })),
    );
    expect(a).toMatchObject({
      sessionKey: threadKey,
      conversationId: f.CHANNEL_ID,
      threadRootId: THREAD_ROOT,
    });
    expect(parsed("plugin.approval.requested", payloadOf(f.pluginApprovalRequested()))).not.toHaveProperty(
      "threadRootId",
    );
  });
});

describe("parseApprovalFrame — kind 유도(resolved 에는 approvalKind 가 없다, 3.4)", () => {
  const base = () => payloadOf(f.pluginApprovalRequested()) as Record<string, unknown>;

  it("approvalKind 가 있으면 그것을 쓴다", () => {
    expect(parsed("plugin.approval.requested", { ...base(), approvalKind: "exec" }).kind).toBe("exec");
  });

  it.each([
    ["plugin.approval.resolved", "plugin"],
    ["exec.approval.requested", "exec"],
    ["exec.approval.resolved", "exec"],
    ["openclaw.approval.requested", "system-agent"],
    ["openclaw.approval.resolved", "system-agent"],
  ])("approvalKind 가 없으면 이벤트 이름 %s → %s", (event, kind) => {
    const { approvalKind: _drop, ...payload } = base();
    expect(parsed(event, { ...payload, decision: "allow-once", resolvedBy: "dodok" }).kind).toBe(kind);
  });

  it.each([
    ["plugin:533fe246", "plugin"],
    ["exec:533fe246", "exec"],
    ["system-agent:533fe246", "system-agent"],
  ])("이벤트 이름도 없으면 id 접두사 %s → %s", (id, kind) => {
    const payload = {
      sessionKey: f.SESSION_KEY,
      phase: "pending",
      approval: {
        id,
        status: "pending",
        presentation: { title: "t", severity: "warning", allowedDecisions: ["allow-once", "deny"] },
        createdAtMs: 1_789_897_787_988,
        expiresAtMs: 1_789_897_907_988,
      },
    };
    expect(parsed("session.approval", payload).kind).toBe(kind);
  });

  it("presentation.kind 가 id 접두사보다 앞선다", () => {
    const payload = {
      sessionKey: f.SESSION_KEY,
      approval: {
        id: "plugin:533fe246",
        status: "pending",
        presentation: {
          kind: "exec",
          title: "t",
          severity: "warning",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 1_789_897_787_988,
        expiresAtMs: 1_789_897_907_988,
      },
    };
    expect(parsed("session.approval", payload).kind).toBe("exec");
  });

  // `tool` 은 러너의 도구 승인 몫이다 — OpenClaw 쪽 단서로 들어와도 Gateway 세 kind 로만 읽고, 모르는 값처럼 다음 단서로 넘긴다
  it.each([
    ["approvalKind", "openclaw.approval.requested", "533fe246", "system-agent"],
    ["presentation.kind", "session.approval", "exec:533fe246", "exec"],
    ["id 접두사", "session.approval", "tool:533fe246", "plugin"],
  ])(
    "tool 단서(%s)는 Gateway kind 가 아니다 — 전과 같은 다음 단서 → %s·%s → %s",
    (_where, event, id, kind) => {
      const payload =
        event === "session.approval"
          ? {
              sessionKey: f.SESSION_KEY,
              approval: {
                id,
                status: "pending",
                presentation: {
                  kind: "tool",
                  title: "t",
                  severity: "warning",
                  allowedDecisions: ["allow-once", "deny"],
                },
                createdAtMs: 1_789_897_787_988,
                expiresAtMs: 1_789_897_907_988,
              },
            }
          : { ...base(), approvalKind: "tool" };
      expect(parsed(event, payload).kind).toBe(kind);
    },
  );

  it("아무 단서도 없으면 plugin 으로 둔다(승인을 버리지 않는다)", () => {
    const payload = {
      sessionKey: f.SESSION_KEY,
      approval: {
        id: "533fe246",
        status: "pending",
        presentation: { title: "t", severity: "warning", allowedDecisions: ["allow-once", "deny"] },
        createdAtMs: 1_789_897_787_988,
        expiresAtMs: 1_789_897_907_988,
      },
    };
    expect(parsed("session.approval", payload).kind).toBe("plugin");
  });
});

describe("parseApprovalFrame — 상한 초과는 fail-open: 보여 주는 값은 잘라서, 상관 키는 버려서 통과", () => {
  it("계약 상한을 넘는 값은 잘리고 끝에 … 가 붙는다 — 승인 자체는 살아남는다", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const a = parsed("plugin.approval.requested", {
      ...base,
      request: {
        ...base.request,
        title: "가".repeat(201),
        description: "나".repeat(513),
        detail: "다".repeat(16_385),
        toolName: "T".repeat(101),
      },
    });

    expect(a.title).toHaveLength(200);
    expect(a.title.endsWith("…")).toBe(true);
    expect(a.description).toHaveLength(512);
    expect(a.detail).toHaveLength(16_384);
    expect(a.toolName).toHaveLength(100);
    expect(a.toolName?.endsWith("…")).toBe(true);
    expect(fitsContract(a).success, JSON.stringify(fitsContract(a).error?.issues)).toBe(true);
  });

  it("상관 키인 toolCallId 는 자르지 않는다 — 상한을 넘으면 통째로 버리고 승인은 살린다", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const a = parsed("plugin.approval.requested", {
      ...base,
      request: { ...base.request, toolCallId: `toolu_${"a".repeat(200)}` },
    });

    expect(a.toolCallId).toBeUndefined(); // 잘린 id 는 어느 툴 호출과도 안 맞는다
    expect(a.title).toBe("claude-cli native tool: Write");
    expect(fitsContract(a).success).toBe(true);
  });

  it("500자를 넘는 urlPath 도 잘라서 통과한다", () => {
    const payload = {
      sessionKey: f.SESSION_KEY,
      approval: {
        id: f.APPROVAL_ID,
        status: "pending",
        presentation: { title: "t", severity: "warning", allowedDecisions: ["allow-once"] },
        urlPath: `/approve/${"x".repeat(600)}`,
        createdAtMs: 1_789_897_787_988,
        expiresAtMs: 1_789_897_907_988,
      },
    };

    const a = parsed("session.approval", payload);
    expect(a.urlPath).toHaveLength(500);
    expect(fitsContract(a).success).toBe(true);
  });

  it("서로게이트 쌍을 쪼개지 않는다", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const a = parsed("plugin.approval.requested", {
      ...base,
      request: { ...base.request, title: "🙂".repeat(120) }, // 240 UTF-16 코드 유닛
    });

    expect(a.title).toBe(`${"🙂".repeat(99)}…`); // 199번째 자리가 하위 서로게이트라 한 쌍을 더 버린다
    expect(fitsContract(a).success).toBe(true);
  });
});

describe("parseApprovalFrame — 모르는 모양(10.1 exec·system-agent 방어)", () => {
  it("승인 이벤트가 아니거나 모양이 다르면 undefined", () => {
    expect(parseApprovalFrame("chat", {})).toBeUndefined();
    expect(parseApprovalFrame("session.message", payloadOf(f.sessionMessage()))).toBeUndefined();
    expect(parseApprovalFrame("plugin.approval.requested", { id: 1 })).toBeUndefined();
    expect(parseApprovalFrame("plugin.approval.requested", null)).toBeUndefined();
    expect(parseApprovalFrame("session.approval", { sessionKey: f.SESSION_KEY })).toBeUndefined();
  });

  it("isApprovalEvent 가 승인 이벤트 여섯을 가려낸다", () => {
    const events = [
      "plugin.approval.requested",
      "plugin.approval.resolved",
      "exec.approval.requested",
      "exec.approval.resolved",
      "openclaw.approval.requested",
      "openclaw.approval.resolved",
      "session.approval",
    ];
    expect(events.filter(isApprovalEvent)).toEqual(events);
    expect(["chat", "agent", "session.message", "sessions.changed"].filter(isApprovalEvent)).toEqual([]);
  });

  it("allowedDecisions 가 없거나 전부 모르는 값이면 버린다(버튼을 지어내면 Gateway 가 조용히 거절한다, 4.4)", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const without = { ...base, request: { ...base.request, allowedDecisions: undefined } };
    const unknown = { ...base, request: { ...base.request, allowedDecisions: ["approve", "reject"] } };

    expect(parseApprovalFrame("plugin.approval.requested", without)).toBeUndefined();
    expect(parseApprovalFrame("plugin.approval.requested", unknown)).toBeUndefined();
  });

  it("모르는 결정 값은 걸러 내고 중복은 합친다", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const a = parsed("plugin.approval.requested", {
      ...base,
      request: { ...base.request, allowedDecisions: ["allow-once", "approve", "allow-once", "deny"] },
    });

    expect(a.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("exec 승인은 title 이 없어도 버리지 않는다 — 기본 제목 + commandText 를 설명으로(10.1, 실물 미관측)", () => {
    const a = parsed("exec.approval.requested", {
      id: "exec:8f0b9d2e-0000-4000-8000-000000000001",
      request: {
        commandText: "rm -rf /tmp/x",
        host: "mac-studio",
        severity: "critical",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        agentId: "dev",
        sessionKey: f.SESSION_KEY,
      },
      createdAtMs: 1_789_897_787_988,
      expiresAtMs: 1_789_899_587_988, // exec 기본 TTL 30분
    });

    expect(a).toMatchObject({
      kind: "exec",
      title: "승인 요청 (exec)",
      description: "rm -rf /tmp/x",
      severity: "critical",
      status: "pending",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    });
    expect(fitsContract(a).success).toBe(true);
  });

  it("title 이 없고 toolName 만 있으면 툴 이름으로 제목을 만든다", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const a = parsed("plugin.approval.requested", {
      ...base,
      request: { ...base.request, title: "   " },
    });

    expect(a.title).toBe("툴 승인: Write");
  });

  it("모르는 severity 는 warning 으로 내린다", () => {
    const base = payloadOf(f.pluginApprovalRequested()) as { request: Record<string, unknown> };
    const a = parsed("plugin.approval.requested", {
      ...base,
      request: { ...base.request, severity: "catastrophic" },
    });

    expect(a.severity).toBe("warning");
  });
});

/**
 * ⚠ 실측(p2-t6) — 같은 승인이 필드가 어긋나는 두 프레임으로 온다. 뒤엣것을 버리면 순서에 따라 값을 잃는다.
 * 병합 규칙 둘: 표시 값은 **빈 자리만** 채우고, 결말은 **먼저 확정된 쪽**이 이긴다(서버 저장과 같은 규칙).
 */
describe("mergeApproval — 같은 승인의 두 모양 합치기", () => {
  const URL_PATH = `/approve/${encodeURIComponent(f.APPROVAL_ID)}`;
  const fromPlugin = () => parsed("plugin.approval.requested", payloadOf(f.pluginApprovalRequested()));
  const fromSession = (o: Parameters<typeof f.sessionApproval>[0] = {}) =>
    parsed("session.approval", payloadOf(f.sessionApproval(o)));

  it("plugin → session: toolCallId 와 urlPath 가 둘 다 남는다", () => {
    const merged = mergeApproval(fromPlugin(), fromSession());

    expect(merged).toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      status: "pending",
      toolCallId: f.APPROVAL_TOOL_CALL_ID,
      urlPath: URL_PATH,
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
    });
    expect(fitsContract(merged).success).toBe(true);
  });

  it("session → plugin: 순서를 뒤집어도 같은 값이 나온다", () => {
    const a = mergeApproval(fromSession(), fromPlugin());
    const b = mergeApproval(fromPlugin(), fromSession());

    expect(a.toolCallId).toBe(f.APPROVAL_TOOL_CALL_ID);
    expect(a.urlPath).toBe(URL_PATH);
    // 표시 값은 두 프레임이 같은 것을 싣고 있어 순서가 바뀌어도 결과가 같다
    expect(a).toEqual(b);
  });

  it("먼저 온 값은 덮지 않는다 — 나중 프레임의 다른 제목·툴 이름은 무시한다", () => {
    const first = fromPlugin();
    const merged = mergeApproval(first, fromSession({ title: "다른 제목", toolName: "Bash" }));

    expect(merged.title).toBe(first.title);
    expect(merged.toolName).toBe(first.toolName);
  });

  it("결말은 먼저 확정된 쪽이 이긴다 — 뒤늦은 pending 이 닫힌 승인을 되살리지 않는다", () => {
    const resolved = parsed("plugin.approval.resolved", payloadOf(f.pluginApprovalResolved()));

    const late = mergeApproval(resolved, fromSession()); // 되감기 pending 이 뒤늦게
    expect(late).toMatchObject({ status: "allowed", decision: "allow-once", reason: "user" });
    expect(late.urlPath).toBe(URL_PATH); // 표시 값은 그래도 채운다

    const first = mergeApproval(fromPlugin(), fromSession({ phase: "terminal" })); // pending 이 먼저
    expect(first).toMatchObject({ status: "allowed", decision: "allow-once", resolvedAt: RESOLVED_AT });
  });

  it("결말이 둘이면 먼저 온 것만 쓴다 — status·decision·reason 이 섞이지 않는다", () => {
    const expired = parsed(
      "plugin.approval.resolved",
      payloadOf(f.pluginApprovalResolved({ decision: "deny", resolvedBy: null })),
    );

    const merged = mergeApproval(expired, fromSession({ phase: "terminal" })); // 세션은 allowed/user 다

    expect(merged).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
  });

  /**
   * ⚠ 실측(3.4·5.2) — 확정도 짝으로 온다: `session.approval(terminal, expired)` 에는 `decision` 이 없고
   * `plugin.approval.resolved` 에는 `deny`+`resolvedBy:null` 만 있다. 어느 쪽이 먼저 오든 같은 행이 남아야 한다(리뷰 F2).
   */
  describe("확정 짝 — 도착 순서가 행을 바꾸지 않는다", () => {
    const expiredSession = () =>
      parsed(
        "session.approval",
        payloadOf(
          f.sessionApproval({ phase: "terminal", status: "expired", decision: null, reason: "timeout" }),
        ),
      );
    const expiredPlugin = () =>
      parsed(
        "plugin.approval.resolved",
        payloadOf(f.pluginApprovalResolved({ decision: "deny", resolvedBy: null })),
      );
    const outcome = { status: "expired", decision: "deny", reason: "timeout" };

    it("session → plugin: 비어 있던 decision 을 같은 결말의 짝이 채운다", () => {
      expect(mergeApproval(expiredSession(), expiredPlugin())).toMatchObject(outcome);
    });

    it("plugin → session: 뒤집어도 같다", () => {
      expect(mergeApproval(expiredPlugin(), expiredSession())).toMatchObject(outcome);
    });

    it("두 순서의 결말 셋이 글자 그대로 같다", () => {
      const pick = (a: ProviderApproval) => ({ status: a.status, decision: a.decision, reason: a.reason });
      expect(pick(mergeApproval(expiredSession(), expiredPlugin()))).toEqual(
        pick(mergeApproval(expiredPlugin(), expiredSession())),
      );
    });

    it("다른 결말을 말하는 프레임은 빈 자리를 채우지 않는다 — 만료가 allow-once 를 얻지 않는다", () => {
      const allowed = parsed("plugin.approval.resolved", payloadOf(f.pluginApprovalResolved()));

      const merged = mergeApproval(expiredSession(), allowed);

      expect(merged.status).toBe("expired");
      expect(merged.decision).toBeUndefined();
    });
  });

  it("sameApproval — 새로 채운 필드도 상태 변화도 없으면 같다고 본다", () => {
    const plugin = fromPlugin();
    expect(sameApproval(plugin, mergeApproval(plugin, fromPlugin()))).toBe(true);

    const merged = mergeApproval(plugin, fromSession());
    expect(sameApproval(plugin, merged)).toBe(false); // urlPath 가 새로 찼다
    expect(sameApproval(merged, mergeApproval(merged, fromSession()))).toBe(true); // 더 채울 자리가 없다
  });
});

describe("parseApprovalReplay — 재접속 되감기(5.3)", () => {
  it("구독 응답의 approvalReplay.approvals 를 정규화한다", () => {
    const other = "plugin:0cc938c2-1111-4000-8000-000000000002";
    const list = parseApprovalReplay(f.approvalSubscribeResult({ ids: [f.APPROVAL_ID, other] }));

    expect(list.map((a) => a.providerApprovalId)).toEqual([f.APPROVAL_ID, other]);
    expect(list[0]).toMatchObject({
      kind: "plugin",
      status: "pending",
      sessionKey: f.SESSION_KEY,
      conversationId: f.CHANNEL_ID,
      expiresAt: EXPIRES_AT,
    });
  });

  it("approvalReplay 가 없거나 모양이 다르면 빈 배열", () => {
    expect(parseApprovalReplay({ subscribed: true, key: f.SESSION_KEY })).toEqual([]);
    expect(parseApprovalReplay({ approvalReplay: { approvals: "nope" } })).toEqual([]);
    expect(parseApprovalReplay(undefined)).toEqual([]);
  });

  it("우리 세션 키가 아닌 항목은 거르고 나머지는 살린다", () => {
    const mine = "plugin:0cc938c2-1111-4000-8000-000000000003";
    const theirs = replayEntries(f.approvalSubscribeResult({ sessionKey: OTHER_SESSION }));
    const ours = replayEntries(f.approvalSubscribeResult({ id: mine }));

    const list = parseApprovalReplay({ approvalReplay: { approvals: [...theirs, ...ours] } });

    expect(list.map((a) => a.providerApprovalId)).toEqual([mine]);
  });
});

describe("resolveParams / parseResolveResult — approval.resolve 왕복(4.1)", () => {
  // `kind` 는 wire 에 없어 저장된 행에서만 온다 — 한 값으로 굳으면 exec·system-agent 승인이 어긋난 kind 로 나간다.
  it("Gateway kind 는 셋뿐 — 러너의 tool·제어 확인 카드는 Gateway 로 나가지 않는다", () => {
    expect(GatewayApprovalKind.options).toEqual(["exec", "plugin", "system-agent"]);
    expect(ApprovalKind.options).toContain("tool");
    expect(ApprovalKind.options).toContain("dodok_control");
  });

  it.each(GatewayApprovalKind.options)("resolveParams 는 저장된 행의 kind(%s)를 그대로 싣는다", (kind) => {
    expect(resolveParams({ providerApprovalId: f.APPROVAL_ID, kind }, "allow-once")).toEqual({
      id: f.APPROVAL_ID,
      kind,
      decision: "allow-once",
    });
  });

  it("응답의 terminal 스냅샷을 같은 정규화로 돌려준다", () => {
    const a = parseResolveResult(f.approvalResolveResult(), "plugin");

    expect(a).toMatchObject({
      providerApprovalId: f.APPROVAL_ID,
      kind: "plugin",
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      resolvedAt: RESOLVED_AT,
      sessionKey: f.SESSION_KEY,
      conversationId: f.CHANNEL_ID,
    });
  });

  it("applied:false(이미 확정된 승인)도 스냅샷을 돌려준다 — 오류가 아니다(4.4)", () => {
    const a = parseResolveResult(
      f.approvalResolveResult({ applied: false, status: "denied", decision: "deny" }),
      "plugin",
    );

    expect(a).toMatchObject({ status: "denied", decision: "deny" });
  });

  it("스냅샷의 kind 를 못 읽으면 인자로 받은 kind 를 쓴다", () => {
    const res = f.approvalResolveResult({ id: "8f0b9d2e-0000-4000-8000-000000000001" }) as {
      approval: { presentation: Record<string, unknown> };
    };
    res.approval.presentation.kind = undefined;

    expect(parseResolveResult(res, "system-agent")?.kind).toBe("system-agent");
  });

  it("모양이 다르면 undefined", () => {
    expect(parseResolveResult({ applied: true }, "plugin")).toBeUndefined();
    expect(parseResolveResult(null, "plugin")).toBeUndefined();
  });
});
