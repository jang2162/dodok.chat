/**
 * 웹훅 원문 → 문구 아래 붙일 블록(자동화 스펙 「웹훅」 절 「엔드포인트」 표의 본문 줄). JSON 타입이면 다시 들여 쓴 json 블록, 아니면
 * 원문 그대로의 블록. 펜스는 원문 속 가장 긴 백틱 줄보다 길게(Review Focus 2), 블록 안 글은 8,000자에서 자른다.
 * 멘션 무력화는 여기서 하지 않는다 — 게시(createAutomationMessage)가 한다(두 번 바뀌지 않게)
 */
import { describe, expect, it } from "vitest";
import { REINDENT_LIMITS, WEBHOOK_BLOCK_MAX, webhookBlock } from "../src/modules/automations/body";

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

  describe("[I2] 다시 쓰기 상한 — 넘으면 원문 그대로의 블록(8,000자 자르기만)", () => {
    const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
    const rawBlock = (raw: string) =>
      `\`\`\`\n${raw.length > WEBHOOK_BLOCK_MAX ? `${raw.slice(0, WEBHOOK_BLOCK_MAX)}${TRUNCATED}` : raw}\n\`\`\``;

    it("상한 값", () => {
      expect(REINDENT_LIMITS).toEqual({ depth: 64, nodes: 10_000, length: 256 * 1024 });
    });

    // 6000 은 리뷰가 잰 입력(고치기 전 수치는 body.ts REINDENT_LIMITS 주석). 테스트 워커는 스택이 작아 6000 에서는 stringify 가
    // 던져(RangeError) 고치기 전에도 원문 블록이 되므로, 워커 안에서도 끝까지 다시 쓰는 4000(8 KB → 32M 자)을 함께 둔다 — 고치기
    // 전 코드로 이 사례를 돌리면 json 블록·103~172 ms·힙 +272 MB, 고친 뒤 약 1 ms·+0.3 MB(워커는 5000 까지 다시 썼다).
    // 시간 상한 100 ms 는 부하 평균 40~80(15코어)에서 1 ms 짜리가 밀려도 넘지 않게 둔 여유다 — 고치기 전과의 구분은 결과 꼴(원문
    // 블록)과 힙도 함께 맡는다
    it.each([6000, 4000])("깊이 %i 의 [ … ] 본문 — 원문 그대로의 블록, 100 ms·힙 64 MB 안", (depth) => {
      const deep = nested(depth);
      const heapBefore = process.memoryUsage().heapUsed;
      const started = performance.now();
      const block = webhookBlock(deep, "application/json");
      const elapsedMs = performance.now() - started;
      const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
      expect(block).toBe(rawBlock(deep));
      expect(elapsedMs).toBeLessThan(100);
      expect(heapGrowth).toBeLessThan(64 * 1024 * 1024);
    });

    it("깊이 — 상한(64단)까지는 json 블록, 한 단 더 깊으면 원문 블록. stringify 가 스택을 넘는 30,000단도 원문 블록", () => {
      expect(webhookBlock(nested(REINDENT_LIMITS.depth), "application/json")).toMatch(/^```json\n\[\n {2}\[/);
      const over = nested(REINDENT_LIMITS.depth + 1);
      expect(webhookBlock(over, "application/json")).toBe(rawBlock(over));
      const deepest = nested(30_000);
      expect(webhookBlock(deepest, "application/json")).toBe(rawBlock(deepest));
    });

    it('깊이는 객체 중첩에도 — {"a": 를 상한(64단)까지는 json 블록, 한 단 더 깊으면 원문 블록', () => {
      const objects = (depth: number) => `${'{"a":'.repeat(depth)}0${"}".repeat(depth)}`;
      expect(webhookBlock(objects(REINDENT_LIMITS.depth), "application/json")).toMatch(
        /^```json\n\{\n {2}"a": \{/,
      );
      const over = objects(REINDENT_LIMITS.depth + 1);
      expect(webhookBlock(over, "application/json")).toBe(rawBlock(over));
    });

    it("값 수 — 상한(루트 포함 10,000)까지는 json 블록, 하나 더 많으면 원문 블록", () => {
      const zeros = (n: number) => JSON.stringify(Array.from({ length: n }, () => 0));
      expect(webhookBlock(zeros(REINDENT_LIMITS.nodes - 1), "application/json")).toMatch(
        /^```json\n\[\n {2}0,\n/,
      );
      const over = zeros(REINDENT_LIMITS.nodes);
      expect(webhookBlock(over, "application/json")).toBe(rawBlock(over));
    });

    it("다시 쓴 길이 — 상한까지는 json 블록, 한 글자 더 길면 원문 블록", () => {
      // 문자열 하나는 다시 써도 길이가 그대로다(따옴표 포함) — 어림이 정확한 자리
      const atLimit = JSON.stringify("a".repeat(REINDENT_LIMITS.length - 2));
      expect(webhookBlock(atLimit, "application/json")).toMatch(/^```json\n"a/);
      const over = JSON.stringify("a".repeat(REINDENT_LIMITS.length - 1));
      expect(webhookBlock(over, "application/json")).toBe(rawBlock(over));
    });

    it("다시 쓴 길이 어림은 들여쓰기를 센다 — 깊이 60 의 빗(맨 안 배열에 잎 n개)이 어림 상한 바로 아래면 json, 바로 위면 원문", () => {
      // 빗: 배열 60겹(깊이 0~59), 맨 안 배열에 0 이 n개. 어림(body.ts withinReindentLimits) = 컨테이너 Σ(3+2d) 3,720 + 바깥 자식
      // 줄 Σ(2+2(d+1)) 3,658 + 잎 줄 n×(2+2×60) + 잎 n×1 = 7,378 + 123n. 들여쓰기 몫이 빠지면 바로 위 n 도 json 이 된다
      const comb = (n: number) =>
        `${"[".repeat(60)}${Array.from({ length: n }, () => 0).join(",")}${"]".repeat(60)}`;
      const atLimit = Math.floor((REINDENT_LIMITS.length - 7378) / 123);
      expect(7378 + 123 * atLimit).toBeLessThanOrEqual(REINDENT_LIMITS.length);
      expect(webhookBlock(comb(atLimit), "application/json")).toMatch(/^```json\n\[\n {2}\[/);
      const over = comb(atLimit + 1);
      expect(webhookBlock(over, "application/json")).toBe(rawBlock(over));
    });
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
