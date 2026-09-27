// 호스트 경로 원문은 run.event·오류 문구에 싣지 않는다(러너 계획 Global Constraints) — 작업 디렉터리 안은 상대 경로로,
// 밖은 표지로 바꾼다. 도구 인자·결과·오류 문구에만 쓴다. 모델이 쓴 답 글(델타·최종 답)은 가리지 않는다 —
// 델타 조각에 걸친 경로를 잡을 수 없고, OpenClaw 경로도 답 글은 그대로 싣는다

export const OUTSIDE_WORKDIR = "<작업 디렉터리 밖>";

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 앞 글자가 낱말·`:`(URL 의 `//`)·`/`·`.`(./ ../)·`~`·`-` 이면 경로의 시작이 아니다
const ABSOLUTE_PATH = /(?<![\w:/.~\\-])~?\/[^\s"'`,;)\]}<>|]+/g;

/** roots 는 작업 디렉터리의 절대 경로들(설정의 경로와 realpath 가 다를 수 있다 — macOS /private/tmp 등) */
export function createPathMasker(roots: readonly string[]): (text: string) => string {
  const sorted = [...new Set(roots.map((r) => r.replace(/\/+$/, "")).filter((r) => r.length > 1))].sort(
    (a, b) => b.length - a.length,
  );
  const inside =
    sorted.length > 0
      ? new RegExp(`(?<![\\w./~-])(?:${sorted.map(escapeRegExp).join("|")})(?:/+|(?![\\w.-]))`, "g")
      : undefined;
  return (text) => {
    const relative = inside ? text.replace(inside, (m) => (m.endsWith("/") ? "" : ".")) : text;
    return relative.replace(ABSOLUTE_PATH, OUTSIDE_WORKDIR);
  };
}
