import { describe, expect, it } from "vitest";
import { ComponentsV1 } from "../src/components";

/**
 * docs/guides/agent-guide.md 의 components 예시가 계약과 어긋나지 않게 잠근다. 펜스 정보 문자열로 고른다 —
 * `json dodok-components`(통과해야 함) · `json dodok-components-invalid <경로> <코드>`(그 위반 하나로만 실패해야 함) ·
 * `json dodok-message`(message 툴 인자, components 가 있으면 통과해야 함).
 * 예시를 지우거나 표시를 바꾸면 0개 실행이 통과로 보이므로 종류마다 최소 개수를 건다.
 */

// shared 는 Node 타입이 없다(`types: []`) — node:fs 대신 Vite 의 `?raw` 로 읽는다
const REPO_ROOT = decodeURIComponent(
  (import.meta as ImportMeta & { url: string }).url.replace(/^file:\/\//, ""),
).replace(/packages\/shared\/test\/[^/]+$/, "");
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

const INVALID = "json dodok-components-invalid";
const blocks = fencedBlocks(guide);
const ofKind = (info: string) => blocks.filter((b) => b.info === info);
const valid = ofKind("json dodok-components");
const invalid = blocks.filter((b) => b.info === INVALID || b.info.startsWith(`${INVALID} `));
const messages = ofKind("json dodok-message");

/** 예시 JSON 은 주석 없는 순수 JSON 이어야 한다 — 에이전트가 그대로 베낀다 */
function parseJson(b: Block): unknown {
  try {
    return JSON.parse(b.body);
  } catch (err) {
    throw new Error(`agent-guide.md ${b.line}행 ${b.info}: JSON 이 아니다 — ${String(err)}`);
  }
}

/**
 * 입력의 키 중 파싱 결과에 없는 것의 경로. z.object 는 모르는 키를 오류 없이 버리므로(`"reuseable": true` 가
 * 1회용 카드로 통과한다) 이것으로 오타를 잡는다. 기본값으로 결과에 더해지는 키는 괜찮다.
 */
function droppedKeys(input: unknown, output: unknown, path = ""): string[] {
  if (Array.isArray(input)) {
    if (!Array.isArray(output)) return [];
    return input.flatMap((v, i) => droppedKeys(v, output[i], `${path}${i}.`));
  }
  if (input === null || typeof input !== "object") return [];
  if (output === null || typeof output !== "object") return [];
  const out = output as Record<string, unknown>;
  return Object.entries(input).flatMap(([k, v]) =>
    k in out ? droppedKeys(v, out[k], `${path}${k}.`) : [`${path}${k}`],
  );
}

function expectValidComponents(input: unknown) {
  const result = ComponentsV1.safeParse(input);
  expect(result.error?.issues ?? []).toEqual([]);
  expect(droppedKeys(input, result.data)).toEqual([]);
}

describe("docs/guides/agent-guide.md components 예시", () => {
  it("종류마다 예시가 최소 개수만큼 있다", () => {
    expect(valid.length).toBeGreaterThanOrEqual(6);
    expect(invalid.length).toBeGreaterThanOrEqual(7);
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it.each(valid.map((b) => [b.line, b] as const))(
    "%i행 유효 예시는 ComponentsV1 을 통과하고 모르는 키가 없다",
    (_line, b) => {
      expectValidComponents(parseJson(b));
    },
  );

  // 위반이 둘이면 한 규칙이 풀려도 다른 위반으로 계속 실패해 아무것도 지키지 않는다 — 적어 둔 위반 하나만 허용한다
  it.each(invalid.map((b) => [b.line, b] as const))(
    "%i행 틀린 예시는 적어 둔 위반 하나로만 실패한다",
    (_line, b) => {
      const [path, code, ...rest] = b.info.slice(INVALID.length).trim().split(/\s+/);
      expect(path && code && rest.length === 0, `정보 문자열에 「<경로> <코드>」가 없다: ${b.info}`).toBe(
        true,
      );
      const issues = ComponentsV1.safeParse(parseJson(b)).error?.issues ?? [];
      expect(issues.map((i) => `${i.path.join(".")} ${i.code}`)).toEqual([`${path} ${code}`]);
    },
  );

  it.each(messages.map((b) => [b.line, b] as const))(
    "%i행 message 툴 예시는 send 이고 components 가 있으면 통과한다",
    (_line, b) => {
      const args = parseJson(b) as { action?: unknown; components?: unknown };
      expect(args.action).toBe("send");
      if (args.components !== undefined) expectValidComponents(args.components);
    },
  );
});
