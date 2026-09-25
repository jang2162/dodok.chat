import { describe, expect, it } from "vitest";
import { ComponentsV1 } from "../src/components";

/**
 * docs/guides/agent-guide.md 의 components 예시가 계약과 어긋나지 않게 잠근다. 펜스 정보 문자열로 고른다 —
 * `json dodok-components`(통과해야 함) · `json dodok-components-invalid`(실패해야 함) · `json dodok-message`(message 툴 인자, components 가 있으면 통과해야 함).
 * 예시를 지우거나 표시를 바꾸면 0개 실행이 통과로 보이므로 종류마다 최소 개수를 건다.
 */

// shared 는 Node 타입이 없다(`types: []`) — node:fs 대신 Vite 의 `?raw` 로 읽고, 경로에 필요한 import.meta.url 만 선언한다
declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

const REPO_ROOT = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "")).replace(
  /packages\/shared\/test\/[^/]+$/,
  "",
);
const GUIDE_PATH = `${REPO_ROOT}docs/guides/agent-guide.md`;
const { default: guide } = (await import(/* @vite-ignore */ `${GUIDE_PATH}?raw`)) as { default: string };

type Block = { info: string; body: string; line: number };

function fencedBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S.*)$/.exec(lines[i] ?? "");
    if (!open) continue;
    const start = i;
    const body: string[] = [];
    for (i++; i < lines.length && lines[i] !== "```"; i++) body.push(lines[i] ?? "");
    blocks.push({ info: (open[1] ?? "").trim(), body: body.join("\n"), line: start + 1 });
  }
  return blocks;
}

const blocks = fencedBlocks(guide);
const ofKind = (info: string) => blocks.filter((b) => b.info === info);
const valid = ofKind("json dodok-components");
const invalid = ofKind("json dodok-components-invalid");
const messages = ofKind("json dodok-message");

/** 예시 JSON 은 주석 없는 순수 JSON 이어야 한다 — 에이전트가 그대로 베낀다 */
function parseJson(b: Block): unknown {
  try {
    return JSON.parse(b.body);
  } catch (err) {
    throw new Error(`agent-guide.md ${b.line}행 ${b.info}: JSON 이 아니다 — ${String(err)}`);
  }
}

describe("docs/guides/agent-guide.md components 예시", () => {
  it("종류마다 예시가 최소 개수만큼 있다", () => {
    expect(valid.length).toBeGreaterThanOrEqual(6);
    expect(invalid.length).toBeGreaterThanOrEqual(5);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it.each(valid.map((b) => [b.line, b] as const))("%i행 유효 예시는 ComponentsV1 을 통과한다", (_line, b) => {
    const result = ComponentsV1.safeParse(parseJson(b));
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it.each(invalid.map((b) => [b.line, b] as const))(
    "%i행 틀린 예시는 ComponentsV1 에서 실패한다",
    (_line, b) => {
      expect(ComponentsV1.safeParse(parseJson(b)).success).toBe(false);
    },
  );

  it.each(messages.map((b) => [b.line, b] as const))(
    "%i행 message 툴 예시는 send 이고 components 가 있으면 통과한다",
    (_line, b) => {
      const args = parseJson(b) as { action?: unknown; components?: unknown };
      expect(args.action).toBe("send");
      if (args.components !== undefined) {
        expect(ComponentsV1.safeParse(args.components).error?.issues ?? []).toEqual([]);
      }
    },
  );
});
