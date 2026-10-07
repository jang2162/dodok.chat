/**
 * 웹훅 원문 → 문구 아래 붙일 블록(자동화 스펙 「웹훅」 절 「엔드포인트」 표의 본문 줄). JSON 타입이면 다시 들여 쓴 json 블록, 아니면
 * 원문 그대로의 블록. 펜스는 원문 속 가장 긴 백틱 줄보다 길게(Review Focus 2), 블록 안 글은 8,000자에서 자른다.
 * 멘션 무력화는 여기서 하지 않는다 — 게시(createAutomationMessage)가 한다(두 번 바뀌지 않게)
 */
import { describe, expect, it } from "vitest";
import { WEBHOOK_BLOCK_MAX, webhookBlock } from "../src/modules/automations/body";

const TRUNCATED = "…(잘림)";

describe("webhookBlock", () => {
  it("JSON 타입(charset 포함)이면 2칸 들여쓰기로 다시 써서 json 블록", () => {
    expect(webhookBlock('{"a":1,"b":[true,null]}', "application/json; charset=utf-8")).toBe(
      '```json\n{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}\n```',
    );
  });

  it("타입 이름은 대소문자를 가리지 않고, +json 접미(application/vnd.github+json)도 JSON 이다", () => {
    expect(webhookBlock('{"ok":false}', "Application/JSON")).toBe('```json\n{\n  "ok": false\n}\n```');
    expect(webhookBlock('{"ok":false}', "application/vnd.github+json")).toBe(
      '```json\n{\n  "ok": false\n}\n```',
    );
  });

  it("JSON 타입인데 깨진 JSON 이면 원문 그대로의 텍스트 블록", () => {
    expect(webhookBlock('{"a":', "application/json")).toBe('```\n{"a":\n```');
  });

  it("텍스트는 원문 그대로 언어 없는 블록", () => {
    expect(webhookBlock("deploy done\n  status: ok", "text/plain")).toBe(
      "```\ndeploy done\n  status: ok\n```",
    );
  });

  it("[Review Focus 2] JSON 인데 text/plain 으로 왔거나 Content-Type 이 없으면 다시 쓰지 않은 텍스트 블록", () => {
    const raw = '{"a":1}';
    expect(webhookBlock(raw, "text/plain")).toBe('```\n{"a":1}\n```');
    expect(webhookBlock(raw, undefined)).toBe('```\n{"a":1}\n```');
    // 폼도 파싱하지 않는다 — 원문 문자열 그대로
    expect(webhookBlock("payload=%7B%7D&x=1", "application/x-www-form-urlencoded")).toBe(
      "```\npayload=%7B%7D&x=1\n```",
    );
  });

  it("[Review Focus 2] 원문에 ``` 가 있으면 펜스를 늘려 블록이 깨지지 않는다 — 가장 긴 백틱 줄보다 하나 길게", () => {
    const log = "step 1\n```\ncode\n```\nstep 2";
    expect(webhookBlock(log, "text/plain")).toBe(`\`\`\`\`\n${log}\n\`\`\`\``);
    const longer = "inline `x` and ````` five";
    expect(webhookBlock(longer, "text/plain")).toBe(`\`\`\`\`\`\`\n${longer}\n\`\`\`\`\`\``);
  });

  it("[Review Focus 2] 다시 쓴 JSON 문자열 값에 ``` 가 있어도 펜스를 늘린다", () => {
    const block = webhookBlock(JSON.stringify({ body: "fix ``` fence" }), "application/json");
    expect(block).toBe('````json\n{\n  "body": "fix ``` fence"\n}\n````');
  });

  it("블록 안 글은 8,000자에서 자르고 「…(잘림)」 — 8,000자는 그대로", () => {
    expect(WEBHOOK_BLOCK_MAX).toBe(8000);
    const exact = "a".repeat(8000);
    expect(webhookBlock(exact, "text/plain")).toBe(`\`\`\`\n${exact}\n\`\`\``);
    const over = "a".repeat(8001);
    expect(webhookBlock(over, "text/plain")).toBe(`\`\`\`\n${"a".repeat(8000)}${TRUNCATED}\n\`\`\``);
  });

  it("자르기는 글자(코드 포인트) 단위 — 경계의 이모지를 반쪽으로 남기지 않는다", () => {
    const raw = `${"a".repeat(7999)}😀b`;
    expect(webhookBlock(raw, "text/plain")).toBe(`\`\`\`\n${"a".repeat(7999)}😀${TRUNCATED}\n\`\`\``);
  });

  it("JSON 은 다시 쓴 글을 잰다 — 다시 쓴 뒤 8,000자를 넘으면 자른다", () => {
    const raw = JSON.stringify(Array.from({ length: 2000 }, (_, i) => i));
    const block = webhookBlock(raw, "application/json") as string;
    const inner = block.slice("```json\n".length, -"\n```".length);
    expect(inner.endsWith(TRUNCATED)).toBe(true);
    expect(Array.from(inner.slice(0, -TRUNCATED.length))).toHaveLength(8000);
  });

  it("펜스는 블록에 실제로 들어가는 글(자른 뒤)로 고른다", () => {
    const raw = `${"a".repeat(7996)}\`\`\`\`\`\`tail`;
    const block = webhookBlock(raw, "text/plain") as string;
    expect(block).toBe(`\`\`\`\`\`\n${"a".repeat(7996)}\`\`\`\`${TRUNCATED}\n\`\`\`\`\``);
  });

  it("다시 쓸 수 없을 만큼 깊은 JSON 도 던지지 않는다 — 원문 그대로의 블록이거나 json 블록", () => {
    const deep = `${"[".repeat(30_000)}${"]".repeat(30_000)}`;
    const block = webhookBlock(deep, "application/json") as string;
    expect(block.startsWith("```")).toBe(true);
    expect(block.endsWith("…(잘림)\n```")).toBe(true);
  });

  it("멘션 토큰 꼴은 바꾸지 않는다 — 무력화는 게시가 한다", () => {
    const raw = "<@a:01999999-0000-7000-8000-000000000001> @dev";
    expect(webhookBlock(raw, "text/plain")).toBe(`\`\`\`\n${raw}\n\`\`\``);
  });

  it("본문이 비었거나 공백뿐이면 블록 없음(undefined)", () => {
    expect(webhookBlock("", undefined)).toBeUndefined();
    expect(webhookBlock("", "application/json")).toBeUndefined();
    expect(webhookBlock(" \n\t", "text/plain")).toBeUndefined();
  });
});
