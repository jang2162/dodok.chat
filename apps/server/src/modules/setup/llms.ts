/**
 * `GET /llms.txt` — 노드(Gateway 호스트·러너 머신)에서 도는 AI 가 설치를 대신하는 안내서(설정 통합 스펙 「`llms.txt`」 절).
 * 본문 틀은 이 파일의 템플릿 한곳이고(계획 판정 PS6) 서버가 채우는 값은 인자로만 받는다 — 토큰·Gateway 목록·사람 이름은
 * 인자에 없으므로 실릴 길이 없다. 명령은 `docs/guides/docker-deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」·「러너 설치」 절과
 * 같은 순서이고(Gateway 절은 둘 다 설치 스크립트를 돌린다), 러너 설정은 `test/setup.llms.test.ts` 가 `RunnerConfig` 로, 플러그인 계정
 * 설정 키는 `test/setup.plugin-install-script.test.ts` 가 플러그인 설정 스키마로 파싱해 대조한다.
 *
 * ⚠ 토큰은 어떤 외부 명령의 인자에도 나오지 않게 쓴다. Gateway 절은 토큰을 설치 스크립트(`plugin-install-script.ts`)에 환경 변수로만
 * 넘기고, 스크립트가 `curl -K -`·`openclaw config patch --stdin` 의 표준 입력으로 쓴다(`ps` 에 보이지 않는다). 토큰이 든 파일은 이미
 * 있어도(토큰 교체·재설치) `chmod 600` 으로 좁히고, 받은 스크립트는 `mktemp -d` 자리에 두어(템플릿을 줘야 macOS 도 `TMPDIR` 을 따른다)
 * 실패해도 `trap` 이 지운다 — 고정 `/tmp` 경로는 다른 사용자가 미리 만들어 둘 수 있다
 */
import { PLUGIN_INSTALL_SCRIPT_PATH } from "@dodok/shared";
import { RUNNER_TOKEN_FILE } from "../runners/routes";

/** 서버가 품은 플러그인 tgz 의 두 해시 — 파일(받은 것 대조)과 안의 번들(설치한 것 대조) */
export type LlmsFileInfo = { sha256: string; bundleSha256: string };

export type LlmsInput = {
  /** 공개 오리진(`https://…`) — 설치 파일·러너 serverUrl 이 이 위에 선다 */
  origin: string;
  /** 웹 오리진(APP_ORIGIN) — 사람이 확인할 연결 페이지 주소. 배포(한 오리진)는 origin 과 같고 dev 는 웹·서버가 갈린다 */
  webOrigin: string;
  /** 플러그인 계정 설정의 bridgeUrl — 발급 대화상자의 플러그인 설정 조각과 같은 값 */
  bridgeUrl: string;
  /** 서버가 품은 플러그인 tgz — 없으면 Gateway 절 대신 NO_FILE. 러너 절은 npm(`@dodok/runner`)에서 설치하므로 러너 tgz 와 상관없이 나온다 */
  plugin: LlmsFileInfo | null;
};

/** 노드에서 브리지 토큰을 잠깐 두는 자리 — 계정 설정에 넣은 뒤 지운다 */
const BRIDGE_TOKEN_FILE = "~/.dodok-bridge-token";
/** 러너 전용 Claude 로그인을 원할 때의 디렉터리(러너 설정 `programs.claude.configDir`) — 기본은 평소 로그인(`~/.claude`) */
const RUNNER_CLAUDE_DIR = "~/.dodok-runner/claude";
const RUNNER_CONFIG_PATH = "~/.dodok-runner/config.json";
/**
 * 설치된 러너 패키지 디렉터리 — bin 링크 `dodok-runner`(→ dist/main.js)를 풀어 두 단계 위. `$(npm root -g)` 는 일부 npm(11.19)이 경로 속
 * UUID 를 `***` 로 가려 찍어 깨진다. docker-deploy.md 「러너 설치」 3번이 같은 식을 쓴다(setup.llms.test 가 대조한다)
 */
export const RUNNER_PKG_DIR = `$(node -p 'path.resolve(fs.realpathSync(process.argv[1]), "../..")' "$(command -v dodok-runner)")`;
/** 러너 설치 — npm 레지스트리의 `@dodok/runner`(연결 페이지의 설치 명령과 같은 패키지) */
export const RUNNER_NPM_INSTALL = "npm i -g @dodok/runner";
const NO_FILE =
  "서버에 파일이 없습니다. 이 절의 설치를 멈추고 사람에게 알린다(서버 관리자가 파일을 만든 뒤 서버를 재시작해야 한다).";

/** 받은 설치 파일을 둘 자리 — 고정 `/tmp` 이름은 다른 사용자가 미리 만들거나 바꿔치기할 수 있다(템플릿을 줘야 macOS 도 TMPDIR 을 따른다) */
const MKTEMP_DIR = 'dir="$(mktemp -d "${TMPDIR:-/tmp}/dodok.XXXXXX")" && echo "$dir"';

/**
 * Gateway 절 — 받기·대조·Gateway 내리기·설치·계정 설정·올리기는 설치 스크립트(`plugin-install-script.ts`)가 한다. AI 는 스크립트를 받아
 * 읽은 뒤 토큰 파일의 값을 환경 변수로 넘겨 돌린다(사람용 한 줄은 발급 대화상자의 `curl … | DODOK_BRIDGE_TOKEN='…' bash`)
 */
function gatewaySection(input: LlmsInput, file: LlmsFileInfo): string {
  const { origin, webOrigin, bridgeUrl } = input;
  const script = '"${dir:?}/install.sh"';
  return `설치할 것: dodok OpenClaw 채널 플러그인. 이 호스트의 OpenClaw Gateway 안에서 돌며 dodok 서버로 나가는 연결 하나를 연다(호스트 쪽 포트는 열지 않는다).

- 설치 스크립트: ${origin}${PLUGIN_INSTALL_SCRIPT_PATH}(로그인 없이 받는다 — 본문에 토큰이 없다)
- 파일 sha256: ${file.sha256}(스크립트가 받은 파일을 대조한다)
- 번들 sha256(설치한 뒤 dist/index.js): ${file.bundleSha256}(스크립트가 설치한 번들을 대조한다)
- 계정 설정의 bridgeUrl: ${bridgeUrl}(스크립트가 넣는다)

설치 스크립트가 하는 일: 이 토큰으로 플러그인 파일 받기 → 파일 sha256 대조 → Gateway 내리기(openclaw gateway stop) → 설치 → 로드·번들 sha256 대조 → 계정 설정(bridgeUrl·토큰, openclaw config patch --stdin) → Gateway 올리기(openclaw gateway start). 대조가 어긋나거나 중간에 실패하면 멈추고, 자기가 내린 Gateway 는 다시 올린다.

1. 사람에게 받은 브리지 토큰을 0600 파일 ${BRIDGE_TOKEN_FILE} 에 둔다. 파일 쓰기 도구를 쓰거나, 아래 명령의 표준 입력으로 토큰 한 줄을 넣는다.

   \`\`\`bash
   ( umask 077; cat > ${BRIDGE_TOKEN_FILE} )
   chmod 600 ${BRIDGE_TOKEN_FILE}
   \`\`\`

2. 설치 스크립트를 \`mktemp -d\` 로 만든 임시 디렉터리에 받아 끝까지 읽는다(위 순서와 다른 일을 하면 멈추고 사람에게 알린다). 3번까지 같은 셸에서 이어 간다(셸이 바뀌면 첫 줄이 찍은 경로를 dir 에 다시 둔다).

   \`\`\`bash
   ${MKTEMP_DIR}
   curl -fsS ${origin}${PLUGIN_INSTALL_SCRIPT_PATH} -o ${script}
   \`\`\`

3. 스크립트를 토큰 환경 변수와 함께 돌린다. 토큰 파일과 임시 디렉터리는 성공·실패와 상관없이 지워진다. 종료 코드가 0 이 아니면 멈추고 스크립트가 남긴 이유를 사람에게 알린다(다시 하려면 1번부터 토큰을 다시 받는다). 스크립트가 \`DODOK_GATEWAY_SERVICE=0\` 을 말하며 멈추면 이 호스트의 Gateway 가 서비스(systemd·launchd)가 아니다 — 사람에게 Gateway 를 어떻게 돌리는지 묻고, 사람이 Gateway 를 내린 뒤 bash 앞에 \`DODOK_GATEWAY_SERVICE=0\` 을 붙여 돌린다(끝나면 Gateway 는 사람이 올린다).

   \`\`\`bash
   (
     trap 'rm -f ${BRIDGE_TOKEN_FILE}; rm -rf "\${dir:?}"' EXIT
     DODOK_BRIDGE_TOKEN="$(cat ${BRIDGE_TOKEN_FILE})" bash ${script}
   )
   \`\`\`

4. 사람에게 dodok 연결 페이지(${webOrigin}/settings/connection)의 그 Gateway 카드 「플러그인」이 「접속됨」이고 「서버와 같은 빌드입니다」인지 확인받는다. 카드에 기기 페어링 대기가 보이면 그 요청 id 를 사람에게 받아 승인한다.

   \`\`\`bash
   openclaw devices approve <요청 id>
   \`\`\`
`;
}

function runnerSection(input: LlmsInput): string {
  const { origin, webOrigin } = input;
  // 러너는 천장만 쥔다(러너 일반화 스펙 2장) — 에이전트는 앱에서 만든다. 상한은 낮게: 서버 쪽 admin 이 루트 안 어디서든 이 상한까지 돌릴 수 있다
  const config = {
    serverUrl: origin,
    tokenFile: RUNNER_TOKEN_FILE,
    maxConcurrentRuns: 3,
    roots: [{ id: "src", path: "~/src", label: "내 저장소들" }],
    browse: true,
    programs: {
      // configDir 없음 — 평소 claude 로그인. 전용 로그인은 사람이 원할 때만 3번에서 더한다
      claude: {
        maxPermissionMode: "default",
        disallowedTools: [],
        allowedToolsCeiling: null,
      },
    },
  };
  return `설치할 것: dodok 러너(명령 dodok-runner). 이 머신의 허용 루트 안에서 dodok 앱이 만든 에이전트(Claude Code)를 돌려 dodok 서버로 나가는 연결 하나를 연다(머신 쪽 포트는 열지 않는다). 필요한 것: macOS 또는 Linux, Node 24, npm 레지스트리에 닿는 네트워크.

- npm 패키지: @dodok/runner
- 러너 설정의 serverUrl: ${origin}

1. 사람에게 받은 러너 토큰을 0600 파일 ${RUNNER_TOKEN_FILE} 에 둔다. 파일 쓰기 도구를 쓰거나, 아래 명령의 표준 입력으로 토큰 한 줄을 넣는다. 러너가 이 파일을 계속 읽으므로 지우지 않는다.

   \`\`\`bash
   ( umask 077; mkdir -p ~/.dodok-runner; cat > ${RUNNER_TOKEN_FILE} )
   chmod 600 ${RUNNER_TOKEN_FILE}
   \`\`\`

2. 러너를 npm 레지스트리에서 설치하고 판본이 찍히는지 본다. 설치할 때 Claude Agent SDK(과 플랫폼별 번들 CLI)도 함께 받는다. 설치가 실패하면(권한 오류 EACCES 포함 — sudo 를 쓰지 않는다) 멈추고 사람에게 알린다.

   \`\`\`bash
   ${RUNNER_NPM_INSTALL}
   dodok-runner --version
   \`\`\`

3. 러너는 이 머신의 평소 Claude Code 로그인을 쓴다. 아래 첫 줄(claude auth status)로 로그인돼 있는지 본다(출력 JSON 의 loggedIn). 이 머신에 claude 명령이 없으면(command -v claude 가 비면) 둘째 줄 — 러너가 설치할 때 받은 번들 CLI — 로 본다. 그 경로가 없으면 ls "${RUNNER_PKG_DIR}/node_modules/@anthropic-ai" 로 플랫폼별 디렉터리 이름을 보고(Linux musl 이면 -musl 이 붙는다) 그 이름으로 바꾼다. 로그인돼 있으면 4번으로 간다. 안 돼 있으면 로그인은 사람이 한다 — 사람에게 claude(없으면 둘째 줄에서 auth status 를 뺀 번들 CLI)를 열어 /login 을 마치게 하고, 마쳤다고 할 때까지 멈춘다. 전용 로그인을 쓸지 먼저 묻지 않는다. 사람이 전용 로그인을 원한다고 하면 그때만 그 명령 앞에 CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} 를 붙여 로그인하게 하고, 4번 설정의 programs.claude 에 "configDir": "${RUNNER_CLAUDE_DIR}" 를 더한다(전용 로그인이면 대화 기록도 그 디렉터리에 따로 남는다).

   \`\`\`bash
   claude auth status
   "${RUNNER_PKG_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')/claude" auth status
   \`\`\`

4. 설정 파일 ${RUNNER_CONFIG_PATH} 을 만든다. roots 의 경로(에이전트가 돌 수 있는 디렉터리 — 좁게)·라벨과 id(영문 소문자·숫자·-)는 사람에게 묻는다. 에이전트는 이 파일이 아니라 dodok 앱에서 만든다. 토큰은 이 파일에 적지 않는다(적으면 러너가 거절한다).

   \`\`\`json
   ${JSON.stringify(config, null, 2).replaceAll("\n", "\n   ")}
   \`\`\`

5. dodok-runner 를 실행한다. 이 명령은 끝나지 않고 전경에 머문다 — 출력에 \`연결됨\` 이 보이면 사람에게 넘기고(끄려면 Ctrl+C) 이 명령이 끝나기를 기다리지 않는다. 사람에게 dodok 설정의 「러너」 탭(${webOrigin}/settings/runners)에 이 머신이 「연결됨」으로 보이는지 확인받는다.

   \`\`\`bash
   dodok-runner
   \`\`\`
`;
}

export function renderLlmsTxt(input: LlmsInput): string {
  const { origin } = input;
  return `# dodok — 노드 설치 안내서

이 문서는 dodok 서버(${origin})가 내주는 설치 안내서다. dodok 은 사람과 AI 에이전트가 같은 채널에서 대화하는 메신저이고, 에이전트는 OpenClaw Gateway 호스트의 dodok 플러그인이나 사람 머신의 러너를 거쳐 이 서버에 붙는다. 이 문서를 읽는 AI 는 사람에게 받은 토큰 하나로 그 노드를 설치한다. 사람이 고른 절 하나만 따른다.

## AI 가 지킬 규칙

1. 토큰을 화면·로그·명령 줄 인자에 찍지 않는다 — 파일(0600)이나 표준 입력으로 넘긴다.
2. 토큰은 이 안내서가 지정한 자리에만 둔다.
3. 사람이 할 단계(Claude 로그인, 기기 페어링 승인 확인)에서는 멈추고 사람에게 묻는다.
4. 이 서버에서 받은 파일은 이 안내서의 sha256 과 대조하고, 다르면 멈춘다.

## OpenClaw Gateway 호스트

${input.plugin ? gatewaySection(input, input.plugin) : `${NO_FILE}\n`}
## 러너 머신

${runnerSection(input)}`;
}
