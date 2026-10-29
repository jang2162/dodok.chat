import { RunnerApprovalRequested } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { summarizeToolInput } from "../src/drivers/claude/approvals";
import { OUTSIDE_WORKDIR } from "../src/mask";
import { createRunSink, type RunEmitter } from "../src/sink";
import { createFakeBridge } from "./helpers/fake-bridge";
import { RUN_ID, runStart } from "./helpers/fixtures";

// sink 는 드라이버가 가리지 않고 넘긴 글 칸도 내보내기 직전에 가린다(러너 일반화 스펙 4장 「경로 가림은 sink 가」)

const WORKDIR = "/home/u/src/my-repo";

function harness() {
  const out: Array<[string, unknown]> = [];
  const emit: RunEmitter = {
    event: (e) => void out.push(["event", e]),
    final: (f) => void out.push(["final", f]),
    error: (code, message) => void out.push(["error", { code, message }]),
    session: (id) => void out.push(["session", id]),
  };
  const bridge = createFakeBridge();
  return { out, bridge, sink: createRunSink({ workdir: WORKDIR, emit, bridge }) };
}

describe("createRunSink", () => {
  it("run.event 의 글 칸(답 글·도구 인자·도구 결과)을 가린다 — 나머지는 그대로", () => {
    const { out, sink } = harness();
    sink.event({
      type: "TEXT_MESSAGE_CONTENT",
      runId: RUN_ID,
      messageId: "m",
      delta: `보세요 ${WORKDIR}/a.ts`,
    });
    sink.event({
      type: "TOOL_CALL_ARGS",
      runId: RUN_ID,
      toolCallId: "t",
      delta: `{"file_path":"${WORKDIR}/b.ts"}`,
    });
    sink.event({
      type: "TOOL_CALL_RESULT",
      runId: RUN_ID,
      toolCallId: "t",
      content: "/etc/passwd",
    });
    sink.event({ type: "TOOL_CALL_START", runId: RUN_ID, toolCallId: "t", toolCallName: "Read" });
    expect(out).toEqual([
      ["event", { type: "TEXT_MESSAGE_CONTENT", runId: RUN_ID, messageId: "m", delta: "보세요 a.ts" }],
      ["event", { type: "TOOL_CALL_ARGS", runId: RUN_ID, toolCallId: "t", delta: '{"file_path":"b.ts"}' }],
      [
        "event",
        {
          type: "TOOL_CALL_RESULT",
          runId: RUN_ID,
          toolCallId: "t",
          content: OUTSIDE_WORKDIR,
        },
      ],
      ["event", { type: "TOOL_CALL_START", runId: RUN_ID, toolCallId: "t", toolCallName: "Read" }],
    ]);
  });

  it("가리고 나서 빈 답 글 조각은 내지 않는다(TEXT_MESSAGE_CONTENT 는 1자 이상)", () => {
    const { out, sink } = harness();
    sink.event({ type: "TEXT_MESSAGE_CONTENT", runId: RUN_ID, messageId: "m", delta: `${WORKDIR}/` });
    expect(out).toEqual([]);
  });

  it("final·error 를 가리고 error 는 2000자로 자른다", () => {
    const { out, sink } = harness();
    sink.final({ text: `끝 ${WORKDIR}/x`, stopReason: "end_turn", costKind: "api" });
    sink.error("INTERNAL", `실패: ${WORKDIR}/y ${"z".repeat(3000)}`);
    expect(out[0]).toEqual(["final", { text: "끝 x", stopReason: "end_turn", costKind: "api" }]);
    const [, error] = out[1] as [string, { code: string; message: string }];
    expect(error.code).toBe("INTERNAL");
    expect(error.message.startsWith("실패: y ")).toBe(true);
    expect(error.message).toHaveLength(2000);
  });

  it("post 글·카드를 가린다, 승인 요약·세션 id 는 그대로 넘긴다", async () => {
    const { out, bridge, sink } = harness();
    const deliver = runStart().deliver;
    await sink.post({
      outboundId: "runner-post:1",
      conversationId: deliver.conversationId,
      agentId: deliver.agentId,
      sessionKey: deliver.sessionKey,
      text: `파일 ${WORKDIR}/r.md`,
      components: { v: 1, blocks: [{ type: "text", text: "/Users/me/secret" }] } as never,
      attachmentIds: [],
      ts: "2026-10-29T00:00:00.000Z",
    });
    sink.requestApproval({
      providerApprovalId: "a",
      runId: RUN_ID,
      sessionKey: deliver.sessionKey,
      toolCallId: "a",
      toolName: "Bash",
      summary: "cat k",
      canAllowAlways: false,
    });
    sink.session("thread_1");
    expect(bridge.posts[0]).toMatchObject({
      text: "파일 r.md",
      components: { blocks: [{ text: OUTSIDE_WORKDIR }] },
    });
    expect(bridge.requested[0]!.summary).toBe("cat k");
    expect(out).toEqual([["session", "thread_1"]]);
  });

  // 드라이버가 가린 뒤 가운데를 줄인 요약 — 생략 표시(끝이 공백) 뒤 꼬리의 `/…` 는 다시 가리면 절대 경로로 보인다(태스크 2 리뷰 H1)
  it.each([
    [
      "꼬리 숨김",
      "cat " + "a".repeat(350) + " src/b" + "/c".repeat(10) + "/dd".repeat(7) + "/e f" + " z".repeat(40),
    ],
    ["400자 넘김", "cat " + "a".repeat(351) + " q/e f" + " z".repeat(61) + "z"],
  ])("승인 요약은 드라이버가 줄인 그대로 — %s", (_, command) => {
    const { bridge, sink } = harness();
    const summary = summarizeToolInput("Bash", { command }, WORKDIR);
    expect(summary).toContain("자 생략)… /");
    // 이 입력이 실제로 다시 가림에 바뀌는 꼴인가 — 아니면 아래 단언은 아무것도 재지 않는다
    expect(sink.mask(summary)).not.toBe(summary);
    sink.requestApproval({
      providerApprovalId: "a",
      runId: RUN_ID,
      sessionKey: runStart().deliver.sessionKey,
      toolCallId: "a",
      toolName: "Bash",
      summary,
      canAllowAlways: false,
    });
    expect(bridge.requested[0]!.summary).toBe(summary);
    expect(RunnerApprovalRequested.safeParse(bridge.requested[0]).success).toBe(true);
  });

  // 줄이지 않은 글에서만 선다 — 가운데를 줄인 승인 요약은 아니라서 sink 가 보지 않는다(위 「드라이버가 줄인 그대로」)
  it("가림은 두 번 해도 같은 글이다 — 드라이버가 먼저 가린 글을 sink 가 다시 가려도 바뀌지 않는다", () => {
    const { sink } = harness();
    for (const text of [`a ${WORKDIR}/x /etc/y`, `${WORKDIR}`, `see ../up and ./here`, `"${WORKDIR}/q"`]) {
      const once = sink.mask(text);
      expect(sink.mask(once)).toBe(once);
      expect(sink.mask.json(sink.mask.json(`{"p":"${text.replaceAll('"', "")}"}`))).toBe(
        sink.mask.json(`{"p":"${text.replaceAll('"', "")}"}`),
      );
    }
  });
});
