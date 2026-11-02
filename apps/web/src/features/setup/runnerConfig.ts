import type { RunnerConfigSnippet } from "@dodok/shared";

/** 러너 설정 파일의 기본 자리(러너 스펙 4.1 `dodok-runner --config` 기본값) */
export const RUNNER_CONFIG_PATH = "~/.dodok-runner/config.json";
/** 러너 전용 Claude 로그인을 원할 때의 디렉터리 — 설정 `programs.claude.configDir` 에 적는다. 기본은 평소 로그인(`~/.claude`) */
export const RUNNER_CLAUDE_DIR = "~/.dodok-runner/claude";

/**
 * 러너 설정 파일 예시 — 러너의 `RunnerConfig`(packages/claude-runner config.ts)와 같은 꼴, 서버 llms.txt 안내서의 예시와 같은 값. 서버가 준
 * 조각(serverUrl·tokenFile)에 루트 하나와 Claude Code 프로그램 하나(평소 로그인 — configDir 없음)를 더한다. 에이전트는 이 파일이 아니라 앱에서 만든다(러너 일반화 스펙
 * 2장). 루트 `label` 을 적는 예를 둔다 — 안 적으면 디렉터리 이름(홈이면 계정 이름)이 서버로 간다. 토큰 원문은 싣지 않는다(tokenFile).
 * 서버 `test/setup.llms.test.ts` 가 이 결과를 `RunnerConfig` 로 파싱해 대조한다 — 그래서 이 파일은 React·`@/` 를 들이지 않는다
 */
export function runnerConfigExample(snippet: RunnerConfigSnippet): string {
  return JSON.stringify(
    {
      serverUrl: snippet.serverUrl,
      tokenFile: snippet.tokenFile,
      maxConcurrentRuns: 3,
      roots: [{ id: "src", path: "~/src", label: "내 저장소들" }],
      browse: true,
      programs: {
        // configDir 을 적지 않는다 — 평소 claude 로그인을 쓴다(적으면 그 디렉터리의 전용 로그인)
        claude: {
          maxPermissionMode: "default",
          disallowedTools: [],
          allowedToolsCeiling: null,
        },
      },
    },
    null,
    2,
  );
}
