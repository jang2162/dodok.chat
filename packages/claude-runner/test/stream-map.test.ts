import { RunEventBodySchema } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { createPathMasker, type PathMasker } from "../src/mask";
import { createStreamMapper } from "../src/stream-map";
import { script, sdkMsg } from "./helpers/fake-query";

const RUN = "0192f000-0000-7000-8000-000000000001";

function mapper(clock = { t: 1000 }, mask?: PathMasker) {
  return createStreamMapper(() => clock.t, { runId: RUN, mask });
}

const events = (items: ReturnType<ReturnType<typeof mapper>["map"]>) => items.map((i) => i.event);

describe("createStreamMapper — ADR 0007 6.4 대응표", () => {
  it("텍스트: 그 API 메시지의 첫 텍스트 블록에서 START, 델타마다 CONTENT, message_stop 에서 END", () => {
    const m = mapper();
    const out = [
      script.messageStart("msg_1"),
      script.blockStart(0, { type: "text", text: "" }),
      script.textDelta(0, "안녕"),
      script.textDelta(0, ""),
      script.textDelta(0, "하세요"),
      script.blockStop(0),
      script.blockStart(1, { type: "text", text: "" }),
      script.textDelta(1, "!"),
      script.blockStop(1),
      script.messageStop(),
    ].flatMap((x) => events(m.map(x)));
    expect(out).toEqual([
      { type: "TEXT_MESSAGE_START", runId: RUN, messageId: "msg_1", role: "assistant" },
      { type: "TEXT_MESSAGE_CONTENT", runId: RUN, messageId: "msg_1", delta: "안녕" },
      { type: "TEXT_MESSAGE_CONTENT", runId: RUN, messageId: "msg_1", delta: "하세요" },
      { type: "TEXT_MESSAGE_CONTENT", runId: RUN, messageId: "msg_1", delta: "!" },
      { type: "TEXT_MESSAGE_END", runId: RUN, messageId: "msg_1" },
    ]);
    for (const e of out) expect(RunEventBodySchema.safeParse(e).success).toBe(true);
  });

  it("텍스트가 없던 API 메시지는 message_stop 에 END 를 내지 않는다", () => {
    const m = mapper();
    const out = [script.messageStart("msg_1"), script.messageStop()].flatMap((x) => events(m.map(x)));
    expect(out).toEqual([]);
  });

  it("도구: 시작·인자·끝·결과, 결과의 ok 와 START 부터 잰 durationMs", () => {
    const clock = { t: 1000 };
    const m = mapper(clock);
    const out: unknown[] = [];
    const push = (x: Parameters<typeof m.map>[0]) => out.push(...events(m.map(x)));
    push(script.messageStart("msg_2"));
    push(script.blockStart(0, { type: "tool_use", id: "toolu_1", name: "Bash", input: {} }));
    push(script.jsonDelta(0, '{"comm'));
    push(script.jsonDelta(0, 'and":"ls"}'));
    push(script.blockStop(0));
    push(script.messageStop());
    clock.t = 1250;
    push(script.toolResult("toolu_1", "a.txt\nb.txt"));
    expect(out).toEqual([
      {
        type: "TOOL_CALL_START",
        runId: RUN,
        toolCallId: "toolu_1",
        toolCallName: "Bash",
        parentMessageId: "msg_2",
      },
      { type: "TOOL_CALL_ARGS", runId: RUN, toolCallId: "toolu_1", delta: '{"command":"ls"}' },
      { type: "TOOL_CALL_END", runId: RUN, toolCallId: "toolu_1" },
      {
        type: "TOOL_CALL_RESULT",
        runId: RUN,
        toolCallId: "toolu_1",
        content: "a.txt\nb.txt",
        ok: true,
        durationMs: 250,
      },
    ]);
  });

  it("도구 결과 is_error → ok false, 블록 배열 내용은 글만 이어 붙이고 이미지는 표시만", () => {
    const m = mapper();
    m.map(script.blockStart(0, { type: "tool_use", id: "toolu_2", name: "Read", input: {} }));
    const [item] = m.map(
      script.toolResult(
        "toolu_2",
        [
          { type: "text", text: "첫째" },
          { type: "image", source: { type: "base64", data: "AAAA" } },
          { type: "text", text: "둘째" },
        ],
        true,
      ),
    );
    expect(item?.event).toMatchObject({
      type: "TOOL_CALL_RESULT",
      ok: false,
      content: "첫째\n[image]\n둘째",
    });
  });

  it("도구 결과는 2000자로 자른다", () => {
    const m = mapper();
    const [item] = m.map(script.toolResult("toolu_x", "가".repeat(5000)));
    const event = item?.event;
    expect(event?.type === "TOOL_CALL_RESULT" && event.content.length).toBe(2000);
  });

  it("도구 인자·결과의 호스트 경로를 가린다 — 인자는 블록이 끝날 때 한 번에(쪼개진 경로도 가린다)", () => {
    const m = mapper({ t: 0 }, createPathMasker(["/home/u/src/repo"]));
    m.map(script.blockStart(0, { type: "tool_use", id: "toolu_3", name: "Read", input: {} }));
    const out = [
      ...m.map(script.jsonDelta(0, '{"file_path":"/home/u/sr')),
      ...m.map(script.jsonDelta(0, 'c/repo/src/a.ts"}')),
      ...m.map(script.blockStop(0)),
      ...m.map(script.toolResult("toolu_3", "cat /etc/passwd 와 /home/u/src/repo 를 봄")),
    ].map((i) => i.event);
    expect(out).toEqual([
      { type: "TOOL_CALL_ARGS", runId: RUN, toolCallId: "toolu_3", delta: '{"file_path":"src/a.ts"}' },
      { type: "TOOL_CALL_END", runId: RUN, toolCallId: "toolu_3" },
      expect.objectContaining({ content: "cat <작업 디렉터리 밖> 와 . 를 봄" }),
    ]);
  });

  it("result success → final(글·멈춘 사유·토큰·세션 누적 비용)", () => {
    const m = mapper();
    const [item] = m.map(
      script.success("답입니다", {
        stop_reason: "end_turn",
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 3,
          output_tokens: 7,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 20,
        },
      }),
    );
    expect(item).toEqual({
      final: {
        text: "답입니다",
        stopReason: "end_turn",
        usage: { inputTokens: 123, outputTokens: 7 },
        totalCostUsd: 0.42,
      },
    });
  });

  it("interrupt 로 끝난 턴의 error_during_execution → final { text 빈 글, stopReason aborted } — 사용량·누적 비용도 싣는다(판정 R1)", () => {
    const m = mapper();
    m.markInterrupted();
    const items = m.map(
      script.errorResult("error_during_execution", ["[ede_diagnostic] result_type=user"], {
        total_cost_usd: 0.07,
        usage: {
          input_tokens: 4,
          output_tokens: 2,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 0,
        },
      }),
    );
    expect(items).toEqual([
      {
        final: {
          text: "",
          stopReason: "aborted",
          usage: { inputTokens: 14, outputTokens: 2 },
          totalCostUsd: 0.07,
        },
      },
    ]);
    expect(items.some((i) => i.event)).toBe(false);
  });

  it("interrupt 없이 error_* → error(INTERNAL, errors 를 이어 붙임)", () => {
    const m = mapper();
    const items = m.map(script.errorResult("error_max_turns", ["너무 많은 턴", "둘째"]));
    expect(items).toEqual([{ error: { code: "INTERNAL", message: "너무 많은 턴; 둘째" } }]);
  });

  it("success 인데 is_error(API 오류로 끝난 턴) → error, 인증 표지가 있으면 PROVIDER_AUTH", () => {
    const m = mapper();
    m.map(
      sdkMsg({ type: "assistant", message: { id: "msg_e", content: [] }, error: "authentication_failed" }),
    );
    const items = m.map(script.success("Invalid API key · Please run /login", { is_error: true }));
    expect(items).toEqual([{ error: { code: "PROVIDER_AUTH", message: expect.any(String) } }]);
    const other = mapper().map(script.success("Overloaded", { is_error: true }));
    expect(other).toEqual([{ error: { code: "INTERNAL", message: "Overloaded" } }]);
  });

  it("오류 문구의 호스트 경로를 가린다", () => {
    const m = mapper({ t: 0 }, createPathMasker(["/home/u/src/repo"]));
    const items = m.map(script.errorResult("error_during_execution", ["ENOENT /home/u/.claude/x.json"]));
    expect(items[0]?.error?.message).toBe("ENOENT <작업 디렉터리 밖>");
  });

  it("버리는 것: thinking 블록·system/thinking_tokens·tool_progress·그 밖의 system·완성본 assistant", () => {
    const m = mapper();
    const out = [
      script.messageStart("msg_t"),
      script.blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      sdkMsg({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
      }),
      sdkMsg({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "x" } },
      }),
      script.blockStop(0),
      sdkMsg({ type: "system", subtype: "thinking_tokens", estimated_tokens: 50 }),
      sdkMsg({ type: "tool_progress", tool_use_id: "t", tool_name: "Bash", elapsed_time_seconds: 1 }),
      sdkMsg({ type: "system", subtype: "status", status: "requesting" }),
      script.init(),
      sdkMsg({ type: "rate_limit_event" }),
      sdkMsg({ type: "assistant", message: { id: "msg_t", content: [{ type: "text", text: "완성본" }] } }),
      script.messageStop(),
    ].flatMap((x) => m.map(x));
    expect(out).toEqual([]);
  });

  it("서브에이전트(parent_tool_use_id 가 있는) 스트림은 본 버블에 섞지 않는다", () => {
    const m = mapper();
    const sub = (x: ReturnType<typeof script.messageStart>) =>
      ({ ...x, parent_tool_use_id: "toolu_task" }) as typeof x;
    const out = [
      sub(script.messageStart("msg_sub")),
      sub(script.blockStart(0, { type: "text", text: "" })),
      sub(script.textDelta(0, "속")),
    ].flatMap((x) => m.map(x));
    expect(out).toEqual([]);
  });
});

describe("createPathMasker", () => {
  const mask = createPathMasker(["/home/u/src/repo", "/private/home/u/src/repo"]);
  it("작업 디렉터리 안은 상대 경로로, 밖은 표지로", () => {
    expect(mask("/home/u/src/repo/a/b.ts")).toBe("a/b.ts");
    expect(mask("/private/home/u/src/repo/a")).toBe("a");
    expect(mask("cd /home/u/src/repo && ls")).toBe("cd . && ls");
    expect(mask("/home/u/src/repo2/x")).toBe("<작업 디렉터리 밖>");
    expect(mask("~/secret and /etc/passwd")).toBe("<작업 디렉터리 밖> and <작업 디렉터리 밖>");
  });
  it("URL·상대 경로·나눗셈은 건드리지 않는다", () => {
    expect(mask("https://example.com/a/b")).toBe("https://example.com/a/b");
    expect(mask("./src/a.ts and src/b.ts, 1/2, a / b")).toBe("./src/a.ts and src/b.ts, 1/2, a / b");
  });
});

describe("createStreamMapper — resume 직후 빈 result", () => {
  it("num_turns 0 인 success 는 런의 끝이 아니다 — 아무것도 내지 않는다", () => {
    expect(mapper().map(script.success("", { num_turns: 0 }))).toEqual([]);
  });
});

describe("createStreamMapper — 답 글의 호스트 경로 가림(리뷰 I4)", () => {
  const ROOT = "/home/u/src/repo";
  const textOf = (items: ReturnType<ReturnType<typeof mapper>["map"]>) =>
    items.map((i) => (i.event?.type === "TEXT_MESSAGE_CONTENT" ? i.event.delta : "")).join("");

  function stream(chunks: string[]) {
    const m = mapper({ t: 0 }, createPathMasker([ROOT]));
    const items = [
      script.messageStart("msg_1"),
      script.blockStart(0, { type: "text", text: "" }),
      ...chunks.map((c) => script.textDelta(0, c)),
      script.blockStop(0),
      script.messageStop(),
    ].flatMap((x) => m.map(x));
    return items;
  }

  it("델타 둘에 걸친 경로도 가린다 — 마지막 공백 뒤 꼬리를 쥐었다가 이어 붙여 가린다", () => {
    const items = stream(["파일은 /home/u/sr", "c/repo/a.ts 와 /Users/x/.aw", "s/credentials 입니다"]);
    const text = textOf(items);
    expect(text).toBe("파일은 a.ts 와 <작업 디렉터리 밖> 입니다");
    for (const i of items) {
      if (i.event?.type === "TEXT_MESSAGE_CONTENT") {
        expect(i.event.delta).not.toMatch(/\/home|\/Users|\.aw|credentials/);
        expect(RunEventBodySchema.safeParse(i.event).success).toBe(true);
      }
    }
    expect(items.at(-1)?.event?.type).toBe("TEXT_MESSAGE_END");
  });

  it("경로로 끝나는 메시지 — 쥔 꼬리를 블록 끝에서 가려 내보낸 뒤 END", () => {
    const items = stream(["다 고쳤습니다: /home/u/src/repo/src/", "main.ts"]);
    expect(textOf(items)).toBe("다 고쳤습니다: src/main.ts");
    const types = items.map((i) => i.event?.type);
    expect(types.at(-1)).toBe("TEXT_MESSAGE_END");
    expect(types.at(-2)).toBe("TEXT_MESSAGE_CONTENT");
  });

  it("공백 없는 글이 이어지면 쥐었다가 블록 끝에 한 번에 낸다", () => {
    const items = stream(["abc", "def"]);
    expect(items.filter((i) => i.event?.type === "TEXT_MESSAGE_CONTENT")).toHaveLength(1);
    expect(textOf(items)).toBe("abcdef");
  });

  it("final.text 는 전체를 가린다", () => {
    const m = mapper({ t: 0 }, createPathMasker([ROOT]));
    const [item] = m.map(script.success("/home/u/src/repo/a.ts 와\n/etc/passwd 를 봤습니다"));
    expect(item?.final?.text).toBe("a.ts 와\n<작업 디렉터리 밖> 를 봤습니다");
  });

  it("객체 모양 도구 결과도 stringify 전에 가린다 — 줄바꿈 이스케이프 뒤 경로가 새지 않는다", () => {
    const m = mapper({ t: 0 }, createPathMasker([ROOT]));
    const [item] = m.map(
      script.toolResult("toolu_o", {
        stdout: "ok\n/home/u/.aws/credentials",
        file_path: "/home/u/My Docs/plan.md",
      }),
    );
    const event = item?.event;
    expect(event?.type === "TOOL_CALL_RESULT" && event.content).toBe(
      JSON.stringify({ stdout: "ok\n<작업 디렉터리 밖>", file_path: "<작업 디렉터리 밖>" }),
    );
  });

  it("여러 줄 인자(JSON 원문의 \\n 뒤 경로)도 가린다", () => {
    const m = mapper({ t: 0 }, createPathMasker([ROOT]));
    m.map(script.blockStart(0, { type: "tool_use", id: "toolu_w", name: "Write", input: {} }));
    m.map(
      script.jsonDelta(
        0,
        JSON.stringify({ file_path: `${ROOT}/a.md`, content: "see\n/home/u/.aws/credentials\n" }),
      ),
    );
    const [args] = m.map(script.blockStop(0));
    const event = args?.event;
    expect(event?.type === "TOOL_CALL_ARGS" && JSON.parse(event.delta)).toEqual({
      file_path: "a.md",
      content: "see\n<작업 디렉터리 밖>\n",
    });
  });
});
