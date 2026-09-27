// 호스트 경로 원문은 run.event·run.final·오류 문구에 싣지 않는다(러너 계획 Global Constraints) — 작업 디렉터리 안은
// 상대 경로로, 밖은 표지로 바꾼다. 도구 인자·결과·오류 문구·모델 답 글(델타·최종 답)에 쓴다.
// 보지 않는 것: Windows 경로(`C:\…`), 작업 디렉터리 밖 경로 안의 공백 뒤 꼬리(`/a/My Docs/x` → `<밖> Docs/x` —
// 경로 키 값은 통째로 본다), 상대 경로(`../../etc/passwd`), 낱말 바로 뒤 경로(`-I/a/include`), 호스트가 붙은
// URL(`file://localhost/…`·`vscode://file/…`)

export const OUTSIDE_WORKDIR = "<작업 디렉터리 밖>";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 경로가 시작될 수 있는 자리. 앞 글자가 낱말·`/`·`.`(./ ../)·`~`·`-`·`\` 이면 시작이 아니다. 예외 셋 —
// JSON 원문의 `\n`·`\t`·`\r` 바로 뒤(도구 인자는 JSON 원문이라 줄바꿈이 백슬래시+글자다), `file://` 바로 뒤,
// `:` 바로 뒤(`ENOENT:/…`)는 시작이다. 단 `://` 는 URL 이라 시작이 아니다
const PATH_START = String.raw`(?:(?<=\\[ntr])|(?<=\bfile://)|(?<=:)(?!//)|(?<![\w:/.~\\-]))`;
// 백슬래시에서 끊는다 — JSON 원문의 `\n` 을 경로의 일부로 삼키지 않게
const ABSOLUTE_PATH = new RegExp(String.raw`${PATH_START}~?/[^\s"'\x60,;)\]}<>|\\]+`, "g");
// 도구 인자에서 값 전체가 경로인 키 — 공백이 든 경로도 통째로 가린다(Read·Write·Edit·NotebookEdit·Glob·Grep)
const PATH_KEY = /(?:^|_)path$|^(?:cwd|dir|directory)$/;

export type PathMasker = {
  (text: string): string;
  /** 도구 인자(JSON 원문) — 파싱되면 값 안 문자열을 재귀로 가리고 다시 stringify, 안 되면(잘린 JSON) 원문 가림 */
  json(text: string): string;
  /** JSON.stringify 하기 전의 값 — stringify 뒤에는 줄바꿈이 `\n` 이 되어 가림이 어긋날 수 있다 */
  value(v: unknown): unknown;
  /**
   * 스트리밍 글에서 지금 가려 내보내도 되는 길이. 가림 규칙의 경로는 공백을 품지 않으므로 마지막 공백까지는 안전하고,
   * 그 뒤 꼬리는 다음 조각과 이어질 경로의 앞부분일 수 있어 쥔다. 공백이 든 작업 디렉터리의 앞부분으로 끝나면 그 앞까지
   */
  safeCut(text: string): number;
};

export const NO_MASK: PathMasker = Object.assign((text: string) => text, {
  json: (text: string) => text,
  value: (v: unknown) => v,
  safeCut: (text: string) => text.length,
});

/** roots 는 작업 디렉터리의 절대 경로들(설정의 경로와 realpath 가 다를 수 있다 — macOS /private/tmp 등) */
export function createPathMasker(roots: readonly string[]): PathMasker {
  const sorted = [...new Set(roots.map((r) => r.replace(/\/+$/, "")).filter((r) => r.length > 1))].sort(
    (a, b) => b.length - a.length,
  );
  const inside =
    sorted.length > 0
      ? new RegExp(`${PATH_START}(?:${sorted.map(escapeRegExp).join("|")})(?:/+|(?![\\w.-]))`, "g")
      : undefined;
  // 공백이 든 작업 디렉터리의 「공백까지 앞부분」들 — safeCut 이 그 앞에서 자른다
  const spacedPrefixes = sorted.flatMap((r) =>
    [...r.matchAll(/\s/g)].map((m) => r.slice(0, (m.index ?? 0) + 1)),
  );

  const mask = (text: string): string => {
    const relative = inside ? text.replace(inside, (m) => (m.endsWith("/") ? "" : ".")) : text;
    return relative.replace(ABSOLUTE_PATH, OUTSIDE_WORKDIR);
  };

  const maskWholePath = (s: string): string => {
    for (const root of sorted) {
      if (s === root) return ".";
      // 나머지도 본다 — 인자에는 모델이 무엇이든 쓸 수 있다(`<작업 디렉터리>/a\n/밖/경로`)
      if (s.startsWith(`${root}/`)) return mask(s.slice(root.length).replace(/^\/+/, "")) || ".";
    }
    return /^~?\//.test(s) ? OUTSIDE_WORKDIR : mask(s);
  };

  const value = (v: unknown, key?: string): unknown => {
    if (typeof v === "string") return key !== undefined && PATH_KEY.test(key) ? maskWholePath(v) : mask(v);
    if (Array.isArray(v)) return v.map((x) => value(x));
    if (v && typeof v === "object") {
      // 키에도 경로가 올 수 있다(MCP 도구의 맵 인자·구조화 결과). 경로 키 판정은 원래 키로. 가린 키가 겹치면 뒤 것만 남는다
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [mask(k), value(x, k)]));
    }
    return v;
  };

  return Object.assign(mask, {
    json(text: string): string {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return mask(text);
      }
      return JSON.stringify(value(parsed));
    },
    value: (v: unknown) => value(v),
    safeCut(text: string): number {
      const lastSpace = text.search(/\s\S*$/);
      let cut = lastSpace < 0 ? 0 : lastSpace + 1;
      for (let moved = true; moved;) {
        moved = false;
        for (const prefix of spacedPrefixes) {
          if (cut >= prefix.length && text.slice(0, cut).endsWith(prefix)) {
            cut -= prefix.length;
            moved = true;
          }
        }
      }
      return cut;
    },
  });
}
