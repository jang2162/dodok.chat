import { createHighlighterCore, type LanguageInput } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubDark from "shiki/themes/github-dark.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import type { HighlightEngine, LanguageId } from "./codeHighlight";

/**
 * 코드 하이라이트 엔진 — `codeHighlight.ts` 가 처음 칠할 블록에서 동적 import 로 부른다(이 조각은 초기 번들 밖).
 * 정규식은 JS 엔진(RegExp) — oniguruma WASM 을 쓰지 않아 CSP 에 `wasm-unsafe-eval` 이 필요 없다.
 * `forgiving` 은 JS 로 못 옮기는 패턴 하나 때문에 문법 전체가 던지지 않고 그 패턴만 건너뛰게 한다
 */

/** 문법마다 따로 동적 import — 쓰인 언어의 문법만 받는다. 키는 codeHighlight.ts 의 LANGUAGES 와 같아야 한다(타입이 건다) */
const GRAMMARS: Record<LanguageId, () => Promise<{ default: LanguageInput }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
};

export async function createShikiEngine(): Promise<HighlightEngine> {
  const highlighter = await createHighlighterCore({
    themes: [githubLight, githubDark],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return {
    async loadLanguage(lang) {
      await highlighter.loadLanguage((await GRAMMARS[lang]()).default);
    },
    tokens(code, lang) {
      const { tokens, fg } = highlighter.codeToTokens(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
      });
      // 바탕은 앱 토큰(코드 블록 틀) 그대로 — 테마 바탕(`bg`·`rootStyle` 의 --shiki-dark-bg)은 넘기지 않는다
      return { tokens, fg, bg: "transparent" };
    },
  };
}
