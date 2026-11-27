# @dodok/runner

[dodok](https://github.com/jang2162/dodok.chat) 의 러너 CLI `dodok-runner`. 사람의 머신에서 dodok 앱이 만든 에이전트를 그 머신의 프로젝트 디렉터리에서 돌려(지금 프로그램은 Claude Code — [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) dodok 채널에 붙인다. 러너는 서버로 **나가는** 연결 하나(Socket.IO `/runner`)만 쓰고, 머신 쪽 포트는 열지 않는다.

## 설치

Node 22 이상(저장소가 재는 판은 24), macOS 또는 Linux.

```bash
npm i -g @dodok/runner
dodok-runner --version
```

설치할 때 npm 이 Claude Agent SDK(과 플랫폼별 번들 CLI, 약 225 MB)를 받는다 — 러너 번들은 SDK 를 품지 않는다.

러너는 이 머신에 **설치된 `claude`** 로 돈다 — 러너를 띄운 셸의 `PATH` 에서 찾고, 없으면 SDK 에 든 번들 CLI 로 돈다. 다른 실행 파일을 쓰려면 설정의 `programs.claude` 에 `"executable": "<경로>"` 를 적는다(그 경로가 없거나 실행할 수 없으면 번들로 돌아가지 않고 그 프로그램을 쓸 수 없다고 알린다). 설정 → 연결의 러너 상세가 판본 뒤에 「(설치본)」·「(내장)」으로 보인다.

npm 판은 서버와 다른 빌드일 수 있다 — 설정 → 연결의 러너 상세 토큰 줄이 「서버와 다른 빌드입니다」로 알려도 npm 판이면 정상이다. 서버와 **같은 빌드**가 필요하면 그 상세 「설치 안내」의 접힌 「서버와 같은 빌드로 설치」에서 서버가 품은 tgz 를 받아 깐다.

## 준비와 실행

1. **러너 토큰** — dodok 앱 설정 → 연결(`/settings/connection`)의 「＋ 연결 추가 → 러너」. 원문 `drn_…` 은 한 번만 보인다. 그 대화상자의 「서버 주소」 값도 함께 둔다.
2. **실행** — `dodok-runner`. 설정 파일(`~/.dodok-runner/config.json`)이 없으면 터미널에서 차례로 묻는다.
   - 서버 주소 · 러너 토큰(화면에 찍히지 않는다 — 설정 파일 옆 `token`, 기본 `~/.dodok-runner/token` 0600 에 쓴다) · 루트(에이전트가 돌 디렉터리 — 경로와 라벨, 여럿 가능) · 권한 상한(`default`·`acceptEdits`·`plan`·`auto`·`bypassPermissions` — 끝의 둘은 승인 카드 없이 돌아 경고 뒤 `y` 로 한 번 더 확인한다)
   - 러너가 쓸 Claude Code(설치본·내장)와 로그인 유무도 보여 준다. 로그인이 없으면 다른 터미널에서 `claude` 를 열어 `/login` 한다 — 러너는 이 머신의 평소 Claude Code 로그인(`~/.claude`)을 쓴다.
   - 「저장하고 시작할까요?」에 Enter 면 저장하고 곧바로 붙는다. `연결됨(서버 …)` 이 보이면 붙은 것이다. 끄기는 `Ctrl+C`.
3. **토큰을 다시 발급했으면** — `dodok-runner token`. 새 토큰만 묻고(화면에 찍히지 않는다) 설정의 `tokenFile` 자리에 쓴다 — 설정 파일은 그대로다. 그다음 러너를 다시 띄운다. 설정이 없거나 `tokenFile` 대신 env `DODOK_RUNNER_TOKEN` 을 쓰면 무엇을 할지 한 줄로 알리고 끝난다.
4. **다시 설정** — `dodok-runner setup`. 덮기 전에 묻고 옛 설정은 `config.json.bak` 으로 둔다. 지금 값(서버 주소·루트·권한 상한)이 기본값이라 Enter 면 그대로이고, 남긴 루트는 `id` 가 바뀌지 않는다(앱의 프로젝트가 그 `id` 로 루트를 가리킨다). 묻지 않는 키(`maxConcurrentRuns`·`browse`·도구 상한·`configDir`·`executable`)도 그대로 둔다.

터미널이 아니면(서비스·파이프) 묻지 않고 끝난다 — 설정 파일을 먼저 만든다.

### 백그라운드로 띄우기

러너는 전경에 머문다. 터미널을 닫아도·재부팅 뒤에도 돌게 하려면 위처럼 한 번 띄워 설정·로그인을 끝낸 뒤 macOS launchd(LaunchAgent)·Linux systemd(사용자 서비스)로 띄운다. 서비스로 띄우면 설정에 `"remoteUpdate": false` 를 넣고, `PATH` 와 `dodok-runner` 의 절대 경로를 서비스에 넘긴다. 종료 코드 2(토큰·판본 문제)는 다시 띄우지 않는다. plist·unit 파일과 명령은 [러너 설치 — 백그라운드로 띄우기](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/docker-deploy.md#러너-설치). `nohup` 은 쓰지 않는다 — 러너가 SIGHUP 을 끄기 신호로 받는다.

### 고급 — 직접 쓰기

설정 파일을 손으로 써도 된다(다른 자리면 `dodok-runner --config <경로>`). 토큰은 본문에 적지 않는다 — `tokenFile`(0600) 또는 env `DODOK_RUNNER_TOKEN`. 러너 전용 로그인을 쓰려면 `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude` 로 로그인하고 `programs.claude` 에 `"configDir": "~/.dodok-runner/claude"` 를 적는다.

```json
{
  "serverUrl": "https://<도메인>",
  "tokenFile": "~/.dodok-runner/token",
  "roots": [{ "id": "src", "path": "~/src", "label": "내 저장소들" }],
  "programs": {
    "claude": { "maxPermissionMode": "default" }
  }
}
```

키 설명은 아래 「자세한 것」의 「러너 설치」 4번.

### 천장

러너의 로컬 설정은 **천장**만 쥔다 — 에이전트가 돌 수 있는 디렉터리(`roots`)·켜 둘 프로그램(`programs`)·권한 상한(`maxPermissionMode`·`allowedToolsCeiling`·`disallowedTools`). 그 루트 안의 **프로젝트와 에이전트는 dodok 앱**(설정 → 연결의 러너·프로젝트 상세, admin 이상)에서 만든다. 서버가 런마다 에이전트 정의를 보내면 러너가 천장 안인지 보고 돌린다 — 서버나 토큰이 털려도 이 파일의 범위를 넘지 못한다.

### 봇의 도구(앱에서 적는 MCP)

봇 상세의 「도구」에 적은 MCP 서버(`.mcp.json` 의 `mcpServers` 꼴)를 이 머신이 어디까지 받을지도 로컬 설정이 정한다. 러너는 서버를 믿지 않고 런마다 다시 판정해, 막은 서버는 빼고 로그에 `bot mcp blocked <이름> <사유>` 한 줄(헤더·env 값 없이)을 남긴다.

- `"appMcp": "http"`(기본) — 원격(http·sse) 서버만. 주소 글자가 `localhost`·`127.0.0.0/8`·`::1`·`10/8`·`172.16/12`·`192.168/16`·`169.254/16`·`fc00::/7`·`fe80::/10` 이면 막는다(이 머신의 로컬 서비스를 부르지 않게). 이름 풀이 뒤의 주소(DNS 리바인딩)까지는 막지 못한다.
- `"appMcp": "off"` — 앱의 MCP 를 모두 막는다.
- `"appMcp": "all"` — stdio(이 머신에서 명령을 띄우는) 서버도 받는다. **이것은 앱의 이 러너 주인·admin 을 이 머신에서 코드를 돌려도 되는 사람으로 믿는다는 뜻이다.** `"appMcpCommands": ["npx", "uvx"]` 를 적으면 `command` 의 마지막 이름(basename)이 그 안에 있을 때만 받지만, 실행 파일만 좁힐 뿐 `args`(`npx -y 아무패키지`)·`env` 로 임의 코드가 돈다. `env` 의 `NODE_OPTIONS`·`LD_PRELOAD`·`LD_LIBRARY_PATH`·`DYLD_*`·`PATH` 는 받지 않는다(명령 목록을 비켜 가는 쉬운 길만 막는다).

```json
{
  "appMcp": "all",
  "appMcpCommands": ["npx", "uvx"]
}
```

앱에서 고른 「묻지 않음」 도구는 `allowedToolsCeiling` 이 있으면 그 목록에 든 이름만 받는다(밖인 이름은 묻지 않음에서 빠져 권한 모드대로 묻고, 서버는 붙는다). 이 설정은 앱이나 봇의 「이 러너 설정 제어」 도구로 바꿀 수 없다.

MCP 설정(헤더·env 값 포함)은 SDK 가 CLI 인자 `--mcp-config` 로 넘겨, CLI 가 도는 동안 같은 머신의 다른 사용자가 `ps` 로 볼 수 있습니다 — 여러 사람이 쓰는 머신에서는 비밀값이 든 서버를 붙이지 마세요.

## 자세한 것

- 설치·설정 키·끊김·업데이트: [docs/guides/docker-deploy.md 「러너 설치」](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/docker-deploy.md#러너-설치)
- 에이전트가 채널에서 받는 것: [docs/guides/agent-guide.md](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/agent-guide.md)
- 이 패키지의 배포 절차: [docs/guides/runner-release.md](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/runner-release.md)

## 라이선스

MIT. Claude Agent SDK 는 이 패키지에 들어 있지 않고 설치할 때 받으며, 그 라이선스를 따른다.
