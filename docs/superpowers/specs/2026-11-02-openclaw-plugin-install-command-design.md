# OpenClaw 플러그인 설치 명령 한 줄로 — 설계

날짜: 2026-11-02 · 슬러그 `plugin-install-cmd` · 상태: 사람 승인(2026-11-02)

## 의도

러너는 `npm i -g @dodok/runner` 한 줄로 설치가 끝난다(커밋 `4fa5634`·`9a638b1`·`467200f`). OpenClaw 플러그인은 아직 연결 페이지에서 「플러그인 받기」로 tgz 를 PC 에 받고, sha256 을 눈으로 대조하고, Gateway 호스트로 `scp` 하고, 설치 명령을 붙여 넣고, 발급 대화상자의 「플러그인 설정」 조각을 파일로 저장해 `openclaw config patch --file` 하고, Gateway 를 손으로 내렸다 올린다. 사람의 요청(원문):

> opencalw 플러그인도 설치 명령어 간단하게 바꿔줘 플러그인 받기 버튼 두지 말고 명령어에 다운로드 명령어까지 추가해줘

사람이 고른 목표: **Gateway 호스트에서 명령 하나를 붙여 넣으면 다운로드·설치·토큰 설정까지 끝난다.**

## 목표

- 「플러그인 받기」 버튼(그리고 PC 로 받기·`scp`)을 없앤다.
- 브리지 토큰 발급 대화상자가 **붙여 넣기 한 번**으로 끝나는 설치 명령을 보인다. 그 명령이 다운로드 → 파일 sha256 대조 → Gateway 내리기 → 설치 → 번들 sha256 대조 → 계정 설정(bridgeUrl·토큰) → Gateway 올리기를 다 한다.
- 업데이트(「다른 빌드입니다」)와 토큰 교체도 같은 명령 하나로 한다.
- 설치 절차의 정본을 하나로 줄인다 — 지금은 웹 `installCommands`·`docker-deploy.md` [B] 블록·`llms.txt` 「OpenClaw Gateway 호스트」 절 세 곳이 글자 대조 시험으로 맞춰져 있다.

## 목표가 아닌 것

- 연결 페이지에서 플러그인 블록이 **어느 탭·어느 섹션**에 놓이는가 — 병렬 워커 `settings-connect-merge` 몫이다. 이 설계는 블록·대화상자의 **내용**만 정한다.
- 플러그인 npm 레지스트리 배포(`@dodok/openclaw-plugin` 은 `private: true` 그대로).
- 사람이 손으로 따라 치는 단계별 설치 절차의 유지 — 스크립트가 정본이고, 사람은 스크립트 본문을 읽을 수 있다.
- 옛 토큰 자동 폐기 — 사람이 카드에서 「폐기」한다(지금과 같다).

## 실패로 칠 것(동작해도)

- 토큰이 명령 줄 인자로 넘어가 `ps` 에 보인다.
- sha256 이 어긋났는데 설치가 이어진다.
- 스크립트가 중간에 실패해 Gateway 가 내려간 채로 남는다(실패해도 올릴 수 있으면 다시 올린다).
- 일부만 받은 스크립트가 실행된다(`curl | bash` 가 도중에 끊긴 경우).

## 제약

- `GET /api/v1/setup/plugin.tgz` 는 owner 세션 또는 브리지 토큰(Bearer)으로만 받는다(`apps/server/src/modules/setup/installer-auth.ts` `requireOwnerOrToken`). 이 규칙은 그대로 둔다.
- 브리지 토큰 원문은 발급 대화상자(`IssueTokenDialog.tsx` → `IssuedToken`)에서 한 번만 보인다. 그래서 토큰이 든 명령은 그 대화상자에만 나올 수 있다.
- OpenClaw 2026.9.4 CLI 에 있는 것(스크래치 설치본의 `--help` 로 확인):
  - `openclaw gateway stop` / `start` / `restart` — launchd·systemd 서비스를 다룬다. `stop` 은 비대화형 셸에서 `--force` 가 있어야 한다.
  - `openclaw config patch --stdin` — JSON5 패치를 표준 입력으로 받는다. 임시 파일이 필요 없다.
  - `openclaw config patch` 는 `channels.dodok` 를 플러그인 설치 **뒤에만** 받는다(설치 전에는 `unknown channel id: dodok`).
  - `openclaw config get` 은 비밀 값을 `__OPENCLAW_REDACTED__` 로 가린다 — 호스트에 이미 있는 토큰을 꺼내 재사용할 수 없다.
- 2026.9.5 는 떠 있는 Gateway 에 설치하면 라이브 리로드에 실패하면서 파일도 바꾸지 않는다(`docs/guides/live-smoke.md` 「(b) 플러그인 최신 번들 재설치」). 그래서 내리고 설치한다.
- 사람의 Gateway 호스트는 우분투 서버에 `openclaw gateway` 서비스(systemd)로 설치되어 있다. 우분투 기본 `~/.bashrc` 는 `HISTCONTROL=ignoreboth` 이다.

## 접근

두 길을 견줬고 사람이 **B** 를 골랐다.

- **A — 대화상자에 전체 명령 블록(10줄 남짓).** 웹이 지금의 `installCommands` 처럼 명령을 조립한다. 서버는 그대로. 돌리기 전에 무엇을 하는지 다 보이지만 길고, 정본이 세 곳으로 남는다.
- **B — 서버가 설치 스크립트를 내주고, 명령은 한 줄(골랐다).** 스크립트가 bridgeUrl·두 sha256 을 품고 절차를 다 한다. 웹·`docker-deploy.md`·`llms.txt` 는 그 스크립트를 가리키기만 한다. 러너의 `npm i -g` 처럼 짧다. 서버에 엔드포인트·스크립트·시험이 새로 생기고, 사람은 돌리기 전에 본문을 바로 보지 못한다(`curl …/plugin-install.sh | less` 로 볼 수 있다).
- (뺐다) 발급 응답에 명령 문자열을 실어 주는 길 — A 와 길이가 같으면서 wire 계약만 바뀐다.

## 사람이 정한 것

1. **명령 하나가 다운로드·설치·토큰 설정까지 다 한다.**
2. **붙여 넣기 한 번.** 토큰은 명령 안에 들어간다. 셸 히스토리는 명령 맨 앞 공백 한 칸으로 피한다(우분투 기본 bash). 다른 셸에서는 남을 수 있다는 것을 화면에 적는다. (견준 안: `read -s` 로 토큰을 따로 묻기 — 어느 셸에서도 안 남지만 붙여 넣기가 두 번이라 버렸다.)
3. **업데이트도 같은 명령.** 「다른 빌드입니다」면 그 Gateway 카드에서 새 토큰 발급 → 명령 붙여 넣기 → 옛 토큰 폐기. 업데이트마다 토큰이 교체된다.
4. **발급 대화상자에서 「플러그인 설정」 JSON 조각을 뺀다.** 설치 명령이 대신한다.
5. **접근 B**(서버 스크립트 + 한 줄 명령).

## 설계

### 1. 서버 — `GET /api/v1/setup/plugin-install.sh`

- **인증 없음**, `/llms.txt` 와 같은 IP 버킷(`llmsLimit`)과 같은 머리(`content-type: text/plain; charset=utf-8`·`x-content-type-options: nosniff`). 본문에는 `llms.txt` 에 이미 공개된 것(공개 오리진·bridgeUrl·두 sha256)만 있고 토큰·Gateway·사람은 없다. *(내 판단 — 근거: 같은 정보가 이미 `/llms.txt` 로 공개돼 있고, 인증을 걸면 한 줄 명령에서 토큰을 두 번 실어야 한다.)*
- 부팅 때 `llms.txt` 처럼 한 번 렌더해 둔다(입력: `origin`·`bridgeUrl`·`pluginFile` 의 `sha256`·`bundleSha256`). 렌더 함수는 `apps/server/src/modules/setup/` 안 새 모듈(예: `plugin-install-script.ts`)에 둔다.
- 품은 tgz 가 없으면(`pluginFile === null`) **404 `PLUGIN_FILE_MISSING`** — `plugin.tgz` 와 같은 코드.

### 2. 스크립트가 하는 일(순서)

토큰은 환경 변수 `DODOK_BRIDGE_TOKEN` 으로만 받는다.

0. **본문 전체를 함수 하나로 감싸고 맨 끝 줄에서 부른다** — `curl | bash` 가 도중에 끊겨도 반쪽이 실행되지 않는다. `set -eu`(필요하면 `pipefail`).
1. 전제 확인 — `DODOK_BRIDGE_TOKEN` 이 비지 않았고 `dbt_` 꼴인지, `openclaw`·`curl`·sha256 도구(`sha256sum`, 없으면 `shasum -a 256`)가 있는지. 없으면 무엇이 없는지 말하고 멈춘다.
2. `mktemp -d "${TMPDIR:-/tmp}/dodok.XXXXXX"` 자리를 만들고 `trap` 으로 끝날 때 지운다.
3. tgz 다운로드 — 토큰은 `printf 'header = "Authorization: Bearer %s"\n' "$DODOK_BRIDGE_TOKEN" | curl -fsS -K - <origin>/api/v1/setup/plugin.tgz -o "$dir/…"` 처럼 **표준 입력으로만** curl 에 간다(`printf` 는 셸 내장이라 `ps` 에 안 보인다). 401 이면 「토큰이 틀렸거나 폐기됐습니다 — 카드에서 새로 발급하세요」, 404·409 면 서버 문구에 맞춘 안내.
4. 파일 sha256 대조 — 어긋나면 멈춘다(Gateway 는 아직 건드리지 않았다).
5. `openclaw gateway stop --force`. 실패하면(서비스가 아닌 Gateway) 설치하지 않고 멈추며 「Gateway 를 직접 내린 뒤 `DODOK_GATEWAY_SERVICE=0` 을 붙여 다시 돌리세요」라고 알린다. `DODOK_GATEWAY_SERVICE=0` 이면 stop·start 를 건너뛰고 마지막에 「Gateway 를 직접 올리세요」. *(내 판단 — 서비스 설치가 이 사람의 환경이고, 나머지 환경은 탈출구 하나로 둔다.)*
6. `openclaw plugins install "$dir/…" --force --accept-capabilities`.
7. 로드 확인(`openclaw plugins inspect dodok --json` 의 status `loaded`, channelIds 에 `dodok`)과 **번들 sha256 대조**(설치된 `dist/index.js` — 경로는 inspect 결과에서 얻을 수 있으면 그것, 아니면 기본 상태 디렉터리 `~/.openclaw/extensions/dodok/dist/index.js`). `jq` 에 기대지 않는다 — `openclaw` 가 Node 로 돌므로 JSON 은 `node -e` 로 읽는다.
8. 계정 설정 — `{"channels":{"dodok":{"accounts":{"default":{"bridgeUrl":"<bridgeUrl>","token":"<토큰>"}}}}}` 을 `openclaw config patch --stdin` 으로 넣는다(토큰은 `printf` 로 만든 표준 입력).
9. `openclaw gateway start`. 끝 문구: 연결 페이지 그 Gateway 카드의 「플러그인」이 「접속됨」·「서버와 같은 빌드입니다」인지 보고, 기기 페어링 대기가 보이면 `openclaw devices approve <요청 id>`, 옛 토큰이 있으면 「이제 폐기해도 됩니다」가 뜬 뒤 폐기.
- **5번 뒤 어디서든 실패하면** Gateway 를 다시 올리고(5번에서 내렸을 때만) 실패를 알린 뒤 0 이 아닌 코드로 끝난다. 8번 실패면 「쓰지 않은 토큰은 카드에서 폐기하세요」를 덧붙인다.
- 스크립트는 토큰을 화면·파일에 찍지 않고, 쓰고 나면 `unset DODOK_BRIDGE_TOKEN`.
- `curl | bash` 로 돌면 bash 의 표준 입력은 스크립트 본문이 흐르는 파이프다. 표준 입력을 쓰지 않는 호출(`openclaw`·`curl` 다운로드 등)은 `</dev/null` 로 막아, 자식이 본문을 먹거나 입력을 기다리지 않게 한다. 같은 까닭으로 `openclaw gateway stop` 에는 `--force` 가 필요하다(비대화형 셸).

### 3. 웹 — 발급 대화상자(`IssueTokenDialog.tsx`)

순서: 토큰 원문 → **설치 명령(새)** → 「AI 에게 맡기기」. 「플러그인 설정」 조각(`testId="plugin-config"`)은 없앤다.

설치 명령(한 줄, 맨 앞 공백 한 칸 포함):

```
 curl -fsS <공개 오리진>/api/v1/setup/plugin-install.sh | DODOK_BRIDGE_TOKEN='dbt_…' bash
```

- `<공개 오리진>` 은 대화상자가 이미 받는 `origin`(`publicOriginOf`).
- 설명 문구(제안): 「Gateway 호스트에서 붙여 넣으면 플러그인을 받아 설치하고 이 토큰을 넣은 뒤 Gateway 를 다시 올립니다. 맨 앞 공백은 우분투 기본 bash 가 이 줄을 히스토리에 남기지 않게 합니다(다른 셸에서는 남을 수 있습니다). 토큰이 들어 있으니 원문처럼 다루세요.」 문구 다듬기는 병렬 워커 `settings-connect-merge` 의 설명 정리와 겹친다.
- 서버에 tgz 가 없으면(`status.pluginFile.available === false`) 설치 명령 대신 지금의 「서버에 플러그인 파일이 없습니다…」 + `PACK_COMMAND`. 대화상자가 `status` 를 어떻게 받을지(prop 또는 쿼리)는 구현자 몫.
- 같은 대화상자 머리 설명(`description`)의 「원문은 발급 직후 한 번만 보입니다」는 그대로.

### 4. 웹 — OpenClaw 블록 머리(`sections.tsx` `PluginDownload`)

- 버튼·파일 sha256·번들 sha256·크기·`/tmp` 설치 명령을 없앤다. 컴포넌트 이름·제목(지금 「플러그인 받기」)도 내용에 맞게 바꾼다(제안: 「플러그인 설치」).
- 남는 것: 「설치·업데이트는 각 Gateway 카드의 「새 토큰 발급」이 주는 명령 한 줄로 합니다」 한 줄. tgz 가 없으면 지금처럼 「만드는 명령」.
- 쓰지 않게 되는 것 — `installCommands`·`downloadError`·`useDownloadPlugin`·`downloadPluginFile`(러너가 같이 쓰는 `downloadPackedFile` 은 남긴다). 서버 `GET /api/v1/setup/plugin.tgz` 는 스크립트가 쓰므로 남긴다.
- 카드의 「다른 빌드입니다 — 받아서 다시 설치하세요」 문구는 「새 토큰을 발급해 설치 명령을 다시 돌리세요」 쪽으로 바꾼다(정확한 문구는 구현자, `settings-connect-merge` 의 문구 정리와 맞춘다).

### 5. `llms.txt` 「OpenClaw Gateway 호스트」 절

절차를 스크립트로 바꾼다. AI 규칙 1(토큰을 명령 줄 인자에 찍지 않는다)을 지키도록 토큰은 지금처럼 0600 파일 `~/.dodok-bridge-token` 에 두고:

```bash
curl -fsS <origin>/api/v1/setup/plugin-install.sh -o "$dir/install.sh"   # 읽어 보고
DODOK_BRIDGE_TOKEN="$(cat ~/.dodok-bridge-token)" bash "$dir/install.sh"; rm -f ~/.dodok-bridge-token
```

- AI 는 받아서 읽은 뒤 돌릴 수 있게 `-o` 로 받는다(사람용 한 줄과 다른 점).
- Gateway 가 서비스가 아니면 스크립트가 멈추므로 사람에게 묻는다(규칙 3과 같다).
- 「AI 에게 맡기기」 한 줄(`llmsHandoffLine("bridge", …)`)은 그대로.

### 6. 문서

- `docs/guides/docker-deploy.md` 체크리스트 4 「[웹 → B] 플러그인 설치·브리지 토큰」: 「플러그인 받기」·[PC] `shasum`·`scp`·「플러그인 설정」 붙여 넣기·[B] 블록을 「카드에서 새 토큰 발급 → 대화상자의 설치 명령을 [B] 에 붙여 넣기」로 바꾼다. 스크립트가 하는 일 목록(위 2절)과 `DODOK_GATEWAY_SERVICE=0` 탈출구, `--accept-capabilities`·`security.installPolicy` 주의, 첨부 설정 주의는 남긴다. 「브리지 토큰 교체」 절과 「업데이트」 절(724행 근처)·문제 표·「사람이 한 번 따라 한 결과」 표 4번 줄도 같은 흐름으로.
- `docs/manual/user-guide.md` 476·479·480행 근처 — 「플러그인 받기」와 「플러그인 설정 조각」 설명을 새 흐름으로.
- `docs/guides/plan.md` 8장 — 완료 항목에 한 줄, 「이월」의 「설정 JSON 상자가 스크롤된다」(조각이 없어지므로 해당 부분)와 「발급 조각의 bridgeUrl」(이제 스크립트의 bridgeUrl) 문구를 고친다.

### 7. 시험

- 서버: 스크립트 엔드포인트 — 인증 없이 200·머리·본문에 bridgeUrl·두 sha256·`plugin.tgz` 주소가 들어 있음, tgz 없으면 404 `PLUGIN_FILE_MISSING`, 레이트리밋 버킷. 본문에 토큰 자리 외의 비밀이 없음.
- 스크립트 동작: 가짜 `openclaw`·서버를 PATH·로컬 포트에 둔 셸 시험(자리는 구현자 — `scripts/test/` 의 `stub-orca.sh` 꼴을 참고) — 정상 흐름의 호출 순서(stop → install → inspect → patch → start), 파일 sha 어긋남이면 Gateway 를 건드리지 않음, 설치 실패면 start 가 다시 불림, `stop` 실패면 설치하지 않음, `DODOK_GATEWAY_SERVICE=0`, 토큰이 어떤 프로세스의 argv 에도 없음, 잘린 본문(끝 줄 없음)이 아무것도 하지 않음. **`bash -n` 문법 검사**도 서버 시험에 둔다.
- 웹: 발급 대화상자 — 설치 명령이 맨 앞 공백 + 오리진 + 토큰을 품은 한 줄, 「플러그인 설정」 없음, tgz 없으면 만드는 명령. 지금의 `connection.test.tsx` 「설치 명령이 docker-deploy.md [B] 블록과 글자 그대로」 대조는 「대화상자의 한 줄 꼴(토큰·오리진 자리만 다름)이 docker-deploy.md 의 예시 줄과 같다」로 바꾼다.
- `llms.txt`: `setup.llms.test.ts` 를 새 절차에 맞춘다(절 제목은 그대로 — `llmsHandoffLine` 대조).
- 실연: dev:fake 로는 스크립트를 못 잰다(가짜 플러그인). `docs/guides/live-smoke.md` 의 스크래치 OpenClaw CLI 로 dev Gateway 에 스크립트를 한 번 돌려 「같은 빌드」·접속까지 보는 것을 계획의 마지막 단계로 둔다(모델 런 0).

## 구현자에게 맡긴 것

- 스크립트 렌더 모듈의 이름·자리, 셸 문구, 오류 메시지의 정확한 글.
- 설치 경로를 inspect 에서 얻는 방법(얻을 수 없으면 기본 경로 + 「기본 상태 디렉터리가 아니면 직접 대조하세요」).
- 대화상자가 `status.pluginFile` 을 받는 방법.
- 셸 시험의 자리와 가짜 서버 꼴.

## 다른 워커와 겹치는 곳

- `settings-connect-merge`: OpenClaw 블록 머리 한 줄과 발급 대화상자의 설명 문구는 이 설계가 내용을 정하고, 그 워커가 배치와 문구 다듬기를 정한다. 「다른 빌드입니다」 문구도 함께 본다.
- `messenger-basics`: 겹치지 않는다.
