import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithClient } from "../../../test/messages";
import { createCodeHighlighter, type HighlightEngine, resolveLanguage } from "./codeHighlight";
import { MessageBody } from "./MessageBody";

/**
 * 코드 블록의 토큰 글자 조각 — Streamdown 은 토큰마다 <span> 을 그리고 색을 `--sdm-c`(밝음)·`--shiki-dark`(어두움)
 * 변수로 싣는다. 하이라이트가 없으면 `--sdm-c: inherit` 한 조각이 줄 전체다
 */
function tokenSpans(block: Element) {
  return Array.from(block.querySelectorAll<HTMLElement>("pre code > span > span"));
}
/** 테마 색이 입혀진 토큰(`#` 으로 시작하는 색) — 하이라이트되지 않은 블록은 0 */
function coloredTokens(block: Element) {
  return tokenSpans(block).filter((s) => s.style.getPropertyValue("--sdm-c").startsWith("#"));
}
const blocks = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('[data-streamdown="code-block"]'));

describe("코드 하이라이트 — 확정 메시지", () => {
  it("ts 코드 블록은 지연 로딩 뒤 밝음·어두움 두 테마 색으로 칠해진다", async () => {
    const { container } = renderWithClient(<MessageBody bodyMd={"```ts\nconst a: number = 1;\n```"} />);
    const [block] = blocks(container);
    await waitFor(() => expect(coloredTokens(block!).length).toBeGreaterThan(1));
    for (const s of coloredTokens(block!)) {
      expect(s.style.getPropertyValue("--shiki-dark")).toMatch(/^#/);
    }
    // 바탕은 앱의 코드 블록 틀 그대로 — 테마 바탕을 싣지 않는다
    const pre = block!.querySelector("pre")!;
    expect(pre.style.getPropertyValue("--sdm-bg")).toBe("transparent");
    expect(pre.style.getPropertyValue("--shiki-dark-bg")).toBe("");
    // 글자는 그대로다
    expect(block!.querySelector("pre")).toHaveTextContent("const a: number = 1;");
  });

  it("별칭(bash·py·yml·rs·js)도 칠해진다", async () => {
    const md = ["bash", "py", "yml", "rs", "js"].map((l) => `\`\`\`${l}\nx = "y" # 1\n\`\`\``).join("\n\n");
    const { container } = renderWithClient(<MessageBody bodyMd={md} />);
    await waitFor(() => {
      for (const b of blocks(container)) expect(coloredTokens(b).length).toBeGreaterThan(0);
    });
  });

  it("모르는 언어·언어 없음은 지금 모양 그대로 — 같은 메시지의 ts 블록이 칠해진 뒤에도", async () => {
    const { container } = renderWithClient(
      <MessageBody bodyMd={"```ts\nconst a = 1;\n```\n\n```brainfuck\n+++.\n```\n\n```\nplain\n```"} />,
    );
    const [ts, unknown, none] = blocks(container);
    await waitFor(() => expect(coloredTokens(ts!).length).toBeGreaterThan(0));
    for (const b of [unknown!, none!]) {
      expect(coloredTokens(b)).toHaveLength(0);
      expect(tokenSpans(b).map((s) => s.style.getPropertyValue("--sdm-c"))).toEqual(["inherit"]);
    }
  });
});

describe("코드 하이라이트 — 스트리밍 버블", () => {
  // 스트리밍 코드 블록은 끝으로 스크롤한다(Streamdown) — jsdom 요소에는 scrollTo 가 없다
  beforeEach(() => {
    HTMLElement.prototype.scrollTo = () => {};
  });
  afterEach(() => {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo;
  });

  it("스트리밍 중인 본문은 칠하지 않는다 — 옆의 확정 메시지가 칠해진 뒤에도", async () => {
    const md = "```ts\nconst a = 1;\n```";
    const { container } = renderWithClient(
      <>
        <div data-testid="static">
          <MessageBody bodyMd={md} />
        </div>
        <div data-testid="streaming">
          <MessageBody bodyMd={md} streaming caret />
        </div>
      </>,
    );
    const staticBlock = container.querySelector('[data-testid="static"] [data-streamdown="code-block"]');
    const streamBlock = container.querySelector('[data-testid="streaming"] [data-streamdown="code-block"]');
    await waitFor(() => expect(coloredTokens(staticBlock!).length).toBeGreaterThan(0));
    expect(coloredTokens(streamBlock!)).toHaveLength(0);
  });
});

describe("resolveLanguage", () => {
  it("언어 id·별칭을 대소문자·앞뒤 공백 무시로 푼다, 모르면 undefined", () => {
    expect(resolveLanguage("TS")).toBe("typescript");
    expect(resolveLanguage(" bash ")).toBe("shellscript");
    expect(resolveLanguage("zsh")).toBe("shellscript");
    expect(resolveLanguage("yml")).toBe("yaml");
    expect(resolveLanguage("tsx")).toBe("tsx");
    expect(resolveLanguage("brainfuck")).toBeUndefined();
    expect(resolveLanguage("")).toBeUndefined();
    // 객체 원형의 이름이 언어로 풀리면 안 된다
    expect(resolveLanguage("constructor")).toBeUndefined();
    expect(resolveLanguage("__proto__")).toBeUndefined();
  });
});

describe("createCodeHighlighter", () => {
  const RESULT = { tokens: [[{ content: "x", color: "#111111" }]] };
  const OPTS = { code: "x", language: "ts", themes: ["github-light", "github-dark"] as [string, string] };

  function fakeEngine(): HighlightEngine & { loadLanguage: ReturnType<typeof vi.fn> } {
    return { loadLanguage: vi.fn(async () => {}), tokens: vi.fn(() => RESULT) };
  }

  it("처음에는 null 을 내고 로딩이 끝나면 콜백으로, 그다음부터는 바로 결과를 낸다", async () => {
    const engine = fakeEngine();
    const load = vi.fn(async () => engine);
    const plugin = createCodeHighlighter(load);
    const cb = vi.fn();
    expect(plugin.highlight(OPTS, cb)).toBeNull();
    await waitFor(() => expect(cb).toHaveBeenCalledWith(RESULT));
    expect(plugin.highlight(OPTS)).toBe(RESULT);
    expect(load).toHaveBeenCalledTimes(1);
    expect(engine.loadLanguage).toHaveBeenCalledTimes(1);
    expect(engine.loadLanguage).toHaveBeenCalledWith("typescript");
  });

  it("모르는 언어는 엔진을 불러오지도 않는다", () => {
    const load = vi.fn(async () => fakeEngine());
    const plugin = createCodeHighlighter(load);
    expect(plugin.highlight({ ...OPTS, language: "brainfuck" }, vi.fn())).toBeNull();
    expect(plugin.supportsLanguage("brainfuck")).toBe(false);
    expect(plugin.supportsLanguage("ts")).toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("엔진 로딩이 실패하면 콜백을 부르지 않고, 다시 불러오지도 않는다(페이지 수명 동안)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const load = vi.fn(async () => {
      throw new Error("chunk 404");
    });
    const plugin = createCodeHighlighter(load);
    const cb = vi.fn();
    expect(plugin.highlight(OPTS, cb)).toBeNull();
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(plugin.highlight(OPTS, cb)).toBeNull();
    // 다른 언어도 엔진을 다시 받으러 가지 않는다
    expect(plugin.highlight({ ...OPTS, language: "py" }, cb)).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("한 언어의 문법 로딩이 실패하면 그 언어만 그대로 — 다른 언어는 칠한다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const engine = fakeEngine();
    engine.loadLanguage.mockImplementation(async (lang: string) => {
      if (lang === "python") throw new Error("grammar 404");
    });
    const plugin = createCodeHighlighter(async () => engine);
    const py = vi.fn();
    const ts = vi.fn();
    plugin.highlight({ ...OPTS, language: "py" }, py);
    plugin.highlight(OPTS, ts);
    await waitFor(() => expect(ts).toHaveBeenCalledWith(RESULT));
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(plugin.highlight({ ...OPTS, language: "py" }, py)).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect(py).not.toHaveBeenCalled();
    expect(engine.loadLanguage.mock.calls.filter(([l]) => l === "python")).toHaveLength(1);
    warn.mockRestore();
  });

  it("토큰화가 던지면 null — 블록은 그대로", async () => {
    const engine = fakeEngine();
    engine.tokens = vi.fn(() => {
      throw new Error("regex");
    });
    const plugin = createCodeHighlighter(async () => engine);
    const cb = vi.fn();
    plugin.highlight(OPTS, cb);
    await waitFor(() => expect(engine.loadLanguage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(cb).not.toHaveBeenCalled();
    expect(plugin.highlight(OPTS)).toBeNull();
  });
});
