/**
 * 노드(Gateway 호스트·러너 머신)의 AI 에게 건넬 한 줄 — 서버의 `GET /llms.txt` 안내서 주소와 발급한 토큰 원문(설정 통합 스펙 「발급
 * 대화상자」 절). 절 이름은 서버 템플릿(`apps/server/src/modules/setup/llms.ts`)의 절 제목과 같아야 AI 가 찾는다 — 서버
 * `test/setup.llms.test.ts` 가 이 함수를 불러 대조한다
 */
const SECTION = { bridge: "OpenClaw Gateway 호스트", runner: "Claude 러너 머신" } as const;

export function llmsHandoffLine(kind: "bridge" | "runner", origin: string, token: string): string {
  return kind === "bridge"
    ? `${origin}/llms.txt 를 읽고 「${SECTION.bridge}」 절대로 이 호스트에 dodok 플러그인을 설치해 줘. 브리지 토큰: ${token}`
    : `${origin}/llms.txt 를 읽고 「${SECTION.runner}」 절대로 이 머신에 dodok 러너를 설치해 줘. 러너 토큰: ${token}`;
}

/**
 * 서버의 공개 오리진 — 서버 `runnerServerUrl`(modules/runners/routes.ts)과 같은 규칙으로 브리지 공개 주소의 오리진을 http(s) 로.
 * 안내서·설치 파일·러너 serverUrl 이 모두 이 오리진 위에 선다
 */
export function publicOriginOf(bridgePublicUrl: string): string {
  try {
    const url = new URL(bridgePublicUrl);
    return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  } catch {
    return "https://chat.example.com";
  }
}
