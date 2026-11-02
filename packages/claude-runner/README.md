# @dodok/runner

[dodok](https://github.com/jang2162/dodok.chat) 의 러너 CLI `dodok-runner`. 사람의 머신에서 dodok 앱이 만든 에이전트를 그 머신의 프로젝트 디렉터리에서 돌려(지금 프로그램은 Claude Code — [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) dodok 채널에 붙인다. 러너는 서버로 **나가는** 연결 하나(Socket.IO `/runner`)만 쓰고, 머신 쪽 포트는 열지 않는다.

## 설치

Node 22 이상(저장소가 재는 판은 24), macOS 또는 Linux.

```bash
npm i -g @dodok/runner
dodok-runner --version
```

설치할 때 npm 이 Claude Agent SDK(과 플랫폼별 번들 CLI, 약 225 MB)를 받는다 — 러너 번들은 SDK 를 품지 않는다.

npm 판은 서버와 다른 빌드일 수 있다 — 설정 → 연결의 러너 상세 토큰 줄이 「서버와 다른 빌드입니다」로 알려도 npm 판이면 정상이다. 서버와 **같은 빌드**가 필요하면 그 상세 「설치 안내」의 접힌 「서버와 같은 빌드로 설치」에서 서버가 품은 tgz 를 받아 깐다.

## 준비와 실행

1. **러너 토큰** — dodok 앱 설정 → 연결(`/settings/connection`, owner)의 「＋ 연결 추가 → 러너」. 원문 `drn_…` 을 `~/.dodok-runner/token` 에 한 줄로 두고 `chmod 600 ~/.dodok-runner/token`(또는 env `DODOK_RUNNER_TOKEN`).
2. **Claude 로그인** — 러너는 이 머신의 평소 Claude Code 로그인(`~/.claude`)을 쓴다. `claude` 로 로그인돼 있으면 건너뛰고, 아니면 `claude` 를 열어 `/login` 을 마치고 나온다. 러너 전용 로그인을 따로 쓰려면 그 디렉터리로 로그인하고 설정의 `programs.claude` 에 `"configDir": "~/.dodok-runner/claude"` 를 적는다(대화 기록도 그 디렉터리에 따로 남는다).
   ```bash
   claude                                            # 평소 로그인 — /login 을 마치고 나온다
   CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude   # 전용 로그인을 원할 때만
   ```
3. **설정 파일** `~/.dodok-runner/config.json`(다른 자리면 `dodok-runner --config <경로>`). 토큰 발급 대화상자가 뼈대를 준다.
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
4. **실행** — `dodok-runner`. `연결됨(서버 …)` 이 보이면 붙은 것이다. 끄기는 `Ctrl+C`.

### 천장

러너의 로컬 설정은 **천장**만 쥔다 — 에이전트가 돌 수 있는 디렉터리(`roots`)·켜 둘 프로그램(`programs`)·권한 상한(`maxPermissionMode`·`allowedToolsCeiling`·`disallowedTools`). 그 루트 안의 **프로젝트와 에이전트는 dodok 앱**(설정 → 연결의 러너·프로젝트 상세, admin 이상)에서 만든다. 서버가 런마다 에이전트 정의를 보내면 러너가 천장 안인지 보고 돌린다 — 서버나 토큰이 털려도 이 파일의 범위를 넘지 못한다.

## 자세한 것

- 설치·설정 키·끊김·업데이트: [docs/guides/docker-deploy.md 「러너 설치」](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/docker-deploy.md#러너-설치)
- 에이전트가 채널에서 받는 것: [docs/guides/agent-guide.md](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/agent-guide.md)
- 이 패키지의 배포 절차: [docs/guides/runner-release.md](https://github.com/jang2162/dodok.chat/blob/main/docs/guides/runner-release.md)

## 라이선스

MIT. Claude Agent SDK 는 이 패키지에 들어 있지 않고 설치할 때 받으며, 그 라이선스를 따른다.
