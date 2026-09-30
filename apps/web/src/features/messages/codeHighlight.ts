import type { CodeHighlighterPlugin } from "streamdown";

/** Streamdown 이 그리는 토큰 결과 — 타입을 내보내지 않아 플러그인 서명에서 꺼낸다 */
type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin["highlight"]>>;

/**
 * 칠하는 언어와 별칭 — 에이전트가 채널에 흔히 내는 것만 둔다(웹·서버 코드 ts·tsx·js·html·css, 데이터·설정 json·yaml,
 * 명령 bash, 스크립트·도구 python·go·rust, 질의 sql, 변경분 diff). 문법은 언어마다 따로 지연 로딩하므로 목록에 있어도
 * 쓰이기 전에는 받지 않는다 — 늘릴 때 드는 값은 서비스 워커 사전 저장(문법 조각 크기)뿐이다.
 * 별칭은 shiki 문법이 스스로 선언하는 것(`bundledLanguagesInfo` 의 aliases) 그대로다. 없는 이름은 지금 모양(칠하지 않음)
 */
const LANGUAGES = {
  typescript: ["ts", "cts", "mts"],
  tsx: [],
  javascript: ["js", "cjs", "mjs"],
  json: [],
  shellscript: ["bash", "sh", "shell", "zsh"],
  python: ["py"],
  go: [],
  rust: ["rs"],
  sql: [],
  yaml: ["yml"],
  diff: [],
  html: [],
  css: [],
} as const satisfies Record<string, readonly string[]>;

export type LanguageId = keyof typeof LANGUAGES;

const BY_NAME = new Map<string, LanguageId>(
  Object.entries(LANGUAGES).flatMap(([id, aliases]) =>
    [id, ...aliases].map((name) => [name, id as LanguageId] as const),
  ),
);

/** 펜스의 언어 이름(` ```TS `) → 문법 id. 대소문자·앞뒤 공백은 무시, 모르면 undefined */
export function resolveLanguage(name: string): LanguageId | undefined {
  return BY_NAME.get(name.trim().toLowerCase());
}

/** 지연 로딩되는 쪽(`./shikiEngine`) — 문법을 불러 두고, 불러 둔 문법으로 동기 토큰화한다 */
export interface HighlightEngine {
  loadLanguage(lang: LanguageId): Promise<void>;
  tokens(code: string, lang: LanguageId): HighlightResult;
}

/** 밝음·어두움 테마 — Streamdown 이 밝음을 `--sdm-c`, 어두움을 `--shiki-dark` 로 싣고 `dark:` 변형(시스템 설정)으로 고른다 */
export const THEMES: [string, string] = ["github-light", "github-dark"];

/**
 * Streamdown 코드 하이라이터 플러그인. 엔진은 처음으로 칠할 코드 블록이 그려질 때 한 번 불러온다(초기 번들에 shiki 가 없다).
 * - 준비 전이면 null 을 내고, 준비되면 `callback` 으로 결과를 넘긴다. 준비 뒤에는 바로 결과를 낸다
 * - 모르는 언어·엔진이나 문법 로딩 실패·토큰화 예외는 null — Streamdown 이 지금 모양(칠하지 않은 줄)을 그대로 둔다
 * - 실패는 페이지 수명 동안 기억한다: 블록마다 다시 받으러 가면 조각이 없는 동안(옛 탭·오프라인) 요청이 블록 수만큼 쌓인다.
 *   경고는 엔진·언어마다 한 번
 * 요청의 `themes` 는 보지 않는다 — 엔진은 THEMES 둘만 들고 있다(`getThemes` 가 Streamdown 에 같은 값을 알린다)
 */
export function createCodeHighlighter(loadEngine: () => Promise<HighlightEngine>): CodeHighlighterPlugin {
  let engine: Promise<HighlightEngine | undefined> | undefined;
  let ready: HighlightEngine | undefined;
  const languages = new Map<LanguageId, Promise<boolean>>();
  const loaded = new Set<LanguageId>();

  const getEngine = () =>
    (engine ??= loadEngine().then(
      (e) => (ready = e),
      (err: unknown) => {
        console.warn("[dodok] 코드 하이라이트 엔진을 불러오지 못했다 — 코드 블록은 칠하지 않는다", err);
        return undefined;
      },
    ));

  const ensure = (lang: LanguageId) => {
    let p = languages.get(lang);
    if (!p) {
      p = getEngine().then(async (e) => {
        if (!e) return false;
        try {
          await e.loadLanguage(lang);
          loaded.add(lang);
          return true;
        } catch (err) {
          console.warn(`[dodok] ${lang} 문법을 불러오지 못했다 — 그 언어는 칠하지 않는다`, err);
          return false;
        }
      });
      languages.set(lang, p);
    }
    return p;
  };

  const tokens = (code: string, lang: LanguageId) => {
    try {
      return ready?.tokens(code, lang) ?? null;
    } catch {
      return null;
    }
  };

  return {
    name: "shiki",
    type: "code-highlighter",
    getSupportedLanguages: () => [...BY_NAME.keys()],
    getThemes: () => THEMES,
    supportsLanguage: (name) => resolveLanguage(name) !== undefined,
    highlight({ code, language }, callback) {
      const lang = resolveLanguage(language);
      if (!lang) return null;
      if (loaded.has(lang)) return tokens(code, lang);
      void ensure(lang).then((ok) => {
        const result = ok ? tokens(code, lang) : null;
        if (result) callback?.(result);
      });
      return null;
    },
  };
}

/** 앱이 쓰는 하나 — 엔진 모듈은 동적 import 라 별도 조각으로 나간다 */
export const codeHighlighter = createCodeHighlighter(() =>
  import("./shikiEngine").then((m) => m.createShikiEngine()),
);
