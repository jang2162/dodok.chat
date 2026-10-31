/**
 * `GET /llms.txt` — 노드(Gateway 호스트·러너 머신)에서 도는 AI 가 설치를 대신하는 안내서(설정 통합 스펙 「`llms.txt`」 절).
 * 본문 틀은 이 파일의 템플릿 한곳이고(계획 판정 PS6) 서버가 채우는 값은 인자로만 받는다 — 토큰·Gateway 목록·사람 이름은
 * 인자에 없으므로 실릴 길이 없다. 명령은 `docs/guides/docker-deploy.md` 「[웹 → B] 플러그인 설치·브리지 토큰」·「러너 설치」 절과
 * 같은 순서이고, 계정 설정 키·러너 설정은 `test/setup.llms.test.ts` 가 플러그인 설정 스키마·`RunnerConfig` 로 파싱해 대조한다.
 *
 * ⚠ 토큰은 어떤 외부 명령의 인자에도 나오지 않게 쓴다 — `curl` 은 `-K -`(표준 입력의 설정)로 머리를 받고, 패치 파일은 셸 내장
 * `printf` 가 쓴다(`ps` 에 보이지 않는다). 스펙 예시의 `curl -H "Authorization: Bearer $(cat …)"` 는 curl 의 argv 에 토큰이 남아
 * 같은 문서의 첫 규칙을 어긴다. 토큰이 든 파일은 이미 있어도(토큰 교체·재설치) `chmod 600` 으로 좁히고, 패치 파일은 `mktemp -d`
 * 자리에 두어(템플릿을 줘야 macOS 도 `TMPDIR` 을 따른다) 적용이 실패해도 `trap` 이 지운다 — 고정 `/tmp` 경로는 다른 사용자가 미리 만들어 둘 수 있다
 */
import { RUNNER_TOKEN_FILE } from "../runners/routes";

/** 서버가 품은 tgz 의 두 해시 — 파일(받은 것 대조)과 안의 번들(설치한 것 대조) */
export type LlmsFileInfo = { sha256: string; bundleSha256: string };

export type LlmsInput = {
  /** 공개 오리진(`https://…`) — 설치 파일·러너 serverUrl 이 이 위에 선다 */
  origin: string;
  /** 웹 오리진(APP_ORIGIN) — 사람이 확인할 연결 페이지 주소. 배포(한 오리진)는 origin 과 같고 dev 는 웹·서버가 갈린다 */
  webOrigin: string;
  /** 플러그인 계정 설정의 bridgeUrl — 발급 대화상자의 플러그인 설정 조각과 같은 값 */
  bridgeUrl: string;
  plugin: LlmsFileInfo | null;
  runner: LlmsFileInfo | null;
};

/** 노드에서 브리지 토큰을 잠깐 두는 자리 — 계정 설정에 넣은 뒤 지운다 */
const BRIDGE_TOKEN_FILE = "~/.dodok-bridge-token";
/** 러너 전용 Claude 로그인 디렉터리(러너 설정 `programs.claude.configDir`) — 사람의 `~/.claude` 와 섞지 않는다 */
const RUNNER_CLAUDE_DIR = "~/.dodok-runner/claude";
const RUNNER_CONFIG_PATH = "~/.dodok-runner/config.json";
/**
 * 설치된 러너 패키지 디렉터리 — bin 링크 `dodok-runner`(→ dist/main.js)를 풀어 두 단계 위. `$(npm root -g)` 는 일부 npm(11.19)이 경로 속
 * UUID 를 `***` 로 가려 찍어 깨진다. docker-deploy.md 「러너 설치」 3번이 같은 식을 쓴다(setup.llms.test 가 대조한다)
 */
export const RUNNER_PKG_DIR = `$(node -p 'path.resolve(fs.realpathSync(process.argv[1]), "../..")' "$(command -v dodok-runner)")`;
/** 패키지 이름이 `@dodok/claude-runner` → `@dodok/runner` 로 바뀌기 전 설치본을 걷는다 — 옛 판이 남은 머신이 사라지면 걷는다 */
export const RUNNER_LEGACY_UNINSTALL = "npm uninstall -g @dodok/claude-runner >/dev/null 2>&1";
const NO_FILE =
  "서버에 파일이 없습니다. 이 절의 설치를 멈추고 사람에게 알린다(서버 관리자가 파일을 만든 뒤 서버를 재시작해야 한다).";

/** 받은 설치 파일을 둘 자리 — 고정 `/tmp` 이름은 다른 사용자가 미리 만들거나 바꿔치기할 수 있다(템플릿을 줘야 macOS 도 TMPDIR 을 따른다) */
const MKTEMP_DIR = 'dir="$(mktemp -d "${TMPDIR:-/tmp}/dodok.XXXXXX")" && echo "$dir"';

/** 토큰 파일의 값을 Authorization 머리로 실어 받는 명령 — 토큰은 표준 입력으로만 curl 에 간다 */
const download = (tokenFile: string, url: string, out: string) =>
  [
    `printf 'header = "Authorization: Bearer %s"\\n' "$(cat ${tokenFile})" \\`,
    `  | curl -fsS -K - ${url} -o ${out}`,
  ].join("\n");

function gatewaySection(input: LlmsInput, file: LlmsFileInfo): string {
  const { origin, webOrigin, bridgeUrl } = input;
  const out = '"${dir:?}/dodok-openclaw-plugin.tgz"';
  return `설치할 것: dodok OpenClaw 채널 플러그인. 이 호스트의 OpenClaw Gateway 안에서 돌며 dodok 서버로 나가는 연결 하나를 연다(호스트 쪽 포트는 열지 않는다).

- 파일 sha256: ${file.sha256}
- 번들 sha256(설치한 뒤 dist/index.js): ${file.bundleSha256}
- 계정 설정의 bridgeUrl: ${bridgeUrl}

1. 사람에게 받은 브리지 토큰을 0600 파일 ${BRIDGE_TOKEN_FILE} 에 둔다. 파일 쓰기 도구를 쓰거나, 아래 명령의 표준 입력으로 토큰 한 줄을 넣는다.

   \`\`\`bash
   ( umask 077; cat > ${BRIDGE_TOKEN_FILE} )
   chmod 600 ${BRIDGE_TOKEN_FILE}
   \`\`\`

2. 플러그인 파일을 \`mktemp -d\` 로 만든 임시 디렉터리에 받아 파일 sha256 을 대조한다. 다르면 멈추고 \`rm -rf "\${dir:?}"\` 로 지운다. 3번까지 같은 셸에서 이어 간다(셸이 바뀌면 첫 줄이 찍은 경로를 dir 에 다시 둔다).

   \`\`\`bash
   ${MKTEMP_DIR}
   ${download(BRIDGE_TOKEN_FILE, `${origin}/api/v1/setup/plugin.tgz`, out).replaceAll("\n", "\n   ")}
   shasum -a 256 ${out}   # Linux 는 sha256sum
   \`\`\`

3. Gateway 를 내린다(호스트가 Gateway 를 돌리는 방식대로 — 모르면 사람에게 묻는다). 떠 있는 Gateway 에 설치하면 파일이 바뀌지 않을 수 있다. 설치하고(받은 파일은 설치한 뒤 지운다), 로드됐는지와 번들 sha256 을 확인한다. 다르면 멈춘다.

   \`\`\`bash
   openclaw plugins install ${out} --force --accept-capabilities; rm -rf "\${dir:?}"
   openclaw plugins inspect dodok --json | jq '.plugin.status, .plugin.channelIds'   # "loaded", ["dodok"]
   shasum -a 256 ~/.openclaw/extensions/dodok/dist/index.js   # 기본 상태 디렉터리일 때
   \`\`\`

4. 계정 설정 패치 파일을 임시 디렉터리에 0600 으로 만들어 적용한다. 패치 파일과 토큰 파일은 성공·실패와 상관없이 지워진다. 종료 코드가 0 이 아니면 멈추고 사람에게 알린다(다시 하려면 1번부터 토큰을 다시 받는다).

   \`\`\`bash
   (
     token="$(cat ${BRIDGE_TOKEN_FILE})" && [ -n "$token" ] || exit 1
     dir="$(mktemp -d "\${TMPDIR:-/tmp}/dodok.XXXXXX")" || exit 1
     trap 'rm -rf "\${dir:?}" ${BRIDGE_TOKEN_FILE}' EXIT
     patch="\${dir:?}/dodok.patch.json5"
     ( umask 077; printf '{"channels":{"dodok":{"accounts":{"default":{"bridgeUrl":"%s","token":"%s"}}}}}\\n' \\
         '${bridgeUrl}' "$token" > "$patch" ) && chmod 600 "$patch" && openclaw config patch --file "$patch"
   )
   \`\`\`

   패치 파일의 모양(토큰 자리는 위 명령이 토큰 파일에서 채운다):

   \`\`\`json
   {"channels":{"dodok":{"accounts":{"default":{"bridgeUrl":"${bridgeUrl}","token":"<브리지 토큰>"}}}}}
   \`\`\`

5. Gateway 를 올린다. 사람에게 dodok 연결 페이지(${webOrigin}/settings/connection)의 그 Gateway 카드 「플러그인」이 「접속됨」이고 「서버와 같은 빌드입니다」인지 확인받는다. 카드에 기기 페어링 대기가 보이면 그 요청 id 를 사람에게 받아 승인한다.

   \`\`\`bash
   openclaw devices approve <요청 id>
   \`\`\`
`;
}

function runnerSection(input: LlmsInput, file: LlmsFileInfo): string {
  const { origin, webOrigin } = input;
  const out = '"${dir:?}/dodok-claude-runner.tgz"';
  // 러너는 천장만 쥔다(러너 일반화 스펙 2장) — 에이전트는 앱에서 만든다. 상한은 낮게: 서버 쪽 admin 이 루트 안 어디서든 이 상한까지 돌릴 수 있다
  const config = {
    serverUrl: origin,
    tokenFile: RUNNER_TOKEN_FILE,
    maxConcurrentRuns: 3,
    roots: [{ id: "src", path: "~/src", label: "내 저장소들" }],
    browse: true,
    programs: {
      claude: {
        configDir: RUNNER_CLAUDE_DIR,
        maxPermissionMode: "default",
        disallowedTools: [],
        allowedToolsCeiling: null,
      },
    },
  };
  return `설치할 것: dodok 러너(명령 dodok-runner). 이 머신의 허용 루트 안에서 dodok 앱이 만든 에이전트(Claude Code)를 돌려 dodok 서버로 나가는 연결 하나를 연다(머신 쪽 포트는 열지 않는다). 필요한 것: macOS 또는 Linux, Node 24, npm 레지스트리에 닿는 네트워크.

- 파일 sha256: ${file.sha256}
- 번들 sha256(설치한 뒤 dist/main.js): ${file.bundleSha256}
- 러너 설정의 serverUrl: ${origin}

1. 사람에게 받은 러너 토큰을 0600 파일 ${RUNNER_TOKEN_FILE} 에 둔다. 파일 쓰기 도구를 쓰거나, 아래 명령의 표준 입력으로 토큰 한 줄을 넣는다. 러너가 이 파일을 계속 읽으므로 지우지 않는다.

   \`\`\`bash
   ( umask 077; mkdir -p ~/.dodok-runner; cat > ${RUNNER_TOKEN_FILE} )
   chmod 600 ${RUNNER_TOKEN_FILE}
   \`\`\`

2. 러너 파일을 \`mktemp -d\` 로 만든 임시 디렉터리에 받아 파일 sha256 을 대조하고(다르면 멈춘다) 설치한 뒤 번들 sha256 을 대조한다(다르면 멈춘다). 받은 파일은 설치한 뒤 지운다.

   \`\`\`bash
   ${MKTEMP_DIR}
   ${download(RUNNER_TOKEN_FILE, `${origin}/api/v1/setup/runner.tgz`, out).replaceAll("\n", "\n   ")}
   shasum -a 256 ${out}   # Linux 는 sha256sum
   ${RUNNER_LEGACY_UNINSTALL}   # 옛 이름이 dodok-runner 를 쥐고 있으면 설치가 EEXIST 로 실패한다. 없으면 아무 일도 안 한다
   npm install -g ${out}; rm -rf "\${dir:?}"
   shasum -a 256 "${RUNNER_PKG_DIR}/dist/main.js"
   \`\`\`

3. 러너 전용 Claude 로그인은 사람이 한다. 아래 명령을 사람에게 보여 주고, 로그인을 마쳤다고 할 때까지 멈춘다. 이 머신에 claude 명령이 없으면(command -v claude 가 비면) 둘째 줄 — 러너가 설치할 때 받은 번들 CLI — 을 보여 준다. 그 경로가 없으면 ls "${RUNNER_PKG_DIR}/node_modules/@anthropic-ai" 로 플랫폼별 디렉터리 이름을 보고(Linux musl 이면 -musl 이 붙는다) 그 이름으로 바꾼다.

   \`\`\`bash
   CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} claude
   CLAUDE_CONFIG_DIR=${RUNNER_CLAUDE_DIR} "${RUNNER_PKG_DIR}/node_modules/@anthropic-ai/claude-agent-sdk-$(node -p 'process.platform+"-"+process.arch')/claude"
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
4. 받은 파일은 이 안내서의 sha256 과 대조하고, 다르면 멈춘다.

## OpenClaw Gateway 호스트

${input.plugin ? gatewaySection(input, input.plugin) : `${NO_FILE}\n`}
## 러너 머신

${input.runner ? runnerSection(input, input.runner) : `${NO_FILE}\n`}`;
}
