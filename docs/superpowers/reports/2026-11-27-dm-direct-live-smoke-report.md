# 주인 DM `direct` 실연 — 2026-11-27 결과 (모델 런 0회)

> Gateway 주인의 1:1 DM 을 OpenClaw 에 `direct` 로 넘기는 변경(스파이크 `.superpowers/sdd/2026-11-27-dm-identity/spike-report.md` 5.1 (b))을 실물 Gateway 에서 잰 기록. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다.

에이전트 쪽 설명은 `docs/guides/agent-guide.md` 「DM — 주인과 1:1」, 사람 쪽은 `docs/manual/user-guide.md` 「다이렉트 메시지」 「DM 허용」.
스파이크 5.3 의 1~5 를 「런 0회 하네스」(`docs/guides/live-smoke.md` 9절 — 가짜 claude CLI 가 Gateway 가 넘긴 `initialize` 의 `appendSystemPrompt`·`user` 레코드를 받아 적고 모델을 부르지 않는다)로 쟀다. 6(그룹 DM `group`)은 이번 범위 밖이다(그룹 DM 은 `channel` 그대로).
사람의 상태(`~/.openclaw`·`~/.openclaw-dev`·`.env`)는 읽지도 쓰지도 않았다 — Gateway 상태(`OPENCLAW_HOME`)·공유 토큰·서버 DB 를 모두 스크래치에 새로 만들었다.

**판정: 1~5 통과(1 의 「drop」 쪽은 실물이 아니라 핀 SDK 시험으로), 결함 0.**

## 1. 환경 실물

| 항목 | 값 |
| --- | --- |
| OpenClaw | 스크래치 설치 `openclaw@2026.11.10` → `OpenClaw 2026.11.10 (6ea542f)`. CLI 는 PATH 의 Homebrew Node 26.13.1 로 다시 떴다(`Retrying with …/node`) — Gateway 로그 `runtimeVersion` 26.13.1. `OPENCLAW_HOME=<스크래치>/gwA`·포트 19011·`gateway run --auth token --bind loopback`(`--dev` 없음), 설정은 live-smoke 10절 「새 상태의 Gateway 설정」과 같은 `config patch` 한 번(`cron.enabled false` 포함), 기본 에이전트 `main` |
| 서버 | 이 워크트리(커밋 `0def71e0`) 소스 `node --import tsx src/main.ts`, 포트 19100, `DATA_DIR`·`DB_PATH` 스크래치, 설정 키 전부 환경으로(빈 값 포함 — 루트 `.env` 가 끼지 않게) |
| 플러그인 | `pack:plugin` tgz 를 Gateway 를 띄우기 전에 `plugins install --force --accept-capabilities` — 빌드본·설치본 `dist/index.js` sha256 같음(`45a72142…`). 브리지 토큰은 `POST /gateways/<id>/bridge-tokens` 의 `pluginConfig` 를 0600 파일로 `config patch` 뒤 지움(핫 리로드) → `adapter/status` 의 `gateway`·`bridge` 모두 `connected` |
| Gateway 행 | owner 세션으로 `POST /api/v1/gateways` — `ownerUserId` = owner |
| 가짜 claude CLI | Gateway PATH 맨 앞. 9절 스크립트에 둘을 더했다 — `initialize` 의 `appendSystemPrompt` 와 첫 `user` 레코드 글을 턴마다 파일로(스크래치만), `fake-args.json` 이 있을 때만 `message` 툴 호출 |
| 표식 | 에이전트 워크스페이스(`agents list --json` 의 `workspace`)에 `MEMORY.md` — 본문에 `DODOK_MEMORY_MARKER_7Q` |
| 사람·DM | owner ↔ `main` DM(세션 하나), member `mia`(초대 수락으로 만든 사람, Gateway 주인이 아님) ↔ `main` DM(`main` 의 `dmAccess` 를 `everyone` 으로) |

## 2. 결과

세는 범위: 「시스템」은 그 턴의 `appendSystemPrompt` 파일 한 개, 수는 `grep -c -F` 의 줄 수.

| 단계 | 조건 | ingress 줄(`dodok:ingress`) | 시스템 글자 수 | `MEMORY` 표식 | `chat_type` | 「Dodok channel」/「direct conversation」 | `trigger-only`·`mostly lurk` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | owner DM, Gateway 행의 `owner_user_id` 를 DB 에서 비움(옛 Gateway·옛 서버와 같은 `channel` 꼴) | `admission dispatch`, `chatType channel` | 47,530 | 0 | `channel` 1 / `direct` 0 | 1 / 0 | 1 / 1 |
| B | 같은 DM·같은 세션, 주인을 되돌림 | `dispatch`, `chatType direct` | 46,701 | **1** | `channel` 0 / `direct` 1 | 0 / 1 | 0 / 0 |
| C | owner DM, 가짜 CLI 가 `message` 툴로 보냄(아래 4) | `dispatch`, `chatType direct` | 안 셈 | 안 셈 | 안 셈 | 안 셈 | 안 셈 |
| D | owner DM 의 명령 `/whoami`·`/status`(아래 5 — 모델 턴 없음) | `dispatch`, `chatType direct` | 해당 없음 | 해당 없음 | 해당 없음 | 해당 없음 | 해당 없음 |
| E | mia ↔ `main` DM(Gateway 주인 아님) | `dispatch`, `chatType channel` | 47,530 | 0 | `channel` 1 / `direct` 0 | 1 / 0 | 1 / — |

C·D 는 ingress 줄만 이 표에 옮겼다 — C 는 툴 전송·mirror 를 재는 턴이라 시스템 글을 세지 않았고(아래 4), D 는 Gateway 가 모델 없이 답해 시스템 글이 없다(아래 5). 「안 셈」·E 의 `—` 는 세지 않은 칸이다(0 이 아니다).

**1. dispatch / drop** — direct 인바운드(B·C·D 의 다섯 턴)가 모두 `admission: "dispatch"`·`decision: "allow"` 였다(ingress 에 `allowFrom: ["*"]`). `allowFrom` 이 없으면 drop 되는 쪽은 실물로 재지 않았다 — 핀 SDK `resolveStableChannelMessageIngress` 를 부르는 시험 `packages/openclaw-plugin/test/channel.test.ts` 「dodokIngressConversation」이 그 자리를 잡는다(`allowFrom` 을 빼면 실패하는 것을 확인했다 — 플러그인 구분력).

**2. 모델 입력** — 위 표. `direct` 에서 `MEMORY.md` 가 실리고 그룹 지침(trigger-only·「mostly lurk」·「stay silent」)이 빠진다. 주인이 아닌 사람의 DM(E)은 지금처럼 `channel` 이고 `MEMORY.md` 가 없다. dodok 헤더(`user` 레코드의 `[dodok context]`·`다이렉트 메시지:` 줄)는 셋 다 같다.

**3. 옛 DM 세션 이어 쓰기** — A 와 B 는 같은 세션 키 `agent:main:dodok:channel:<대화 id>`, Gateway `sessions.list` 의 `sessionId` 가 같다(`28389cda-…`). `chat.history` 는 B 뒤 4건(user·assistant 두 쌍 — A·B 턴)이다. `sessions.list` 의 그 행:

| 시점 | `kind` | `chatType` | `classification` | `displayName` |
| --- | --- | --- | --- | --- |
| A 뒤 | `group` | `channel` | `channel` | 대화 id |
| B 뒤 | `group` | **`direct`** | `channel` | 대화 id |

스파이크 6절 「`mergeSessionOrigin` 이 옛 항목의 `chatType` 을 덮는지」 — 덮는다(첫 direct 턴에서 `direct` 가 됐다). `kind` 는 키의 `:channel:` 때문에 `group` 그대로다(스파이크 2.5 예상대로). 가짜 CLI 는 claude 전사를 만들지 않아 B 의 CLI 세션 id 는 새것이다(Gateway 로그 `missing-transcript` 1회 — 9절 「세션을 잴 때 걸리는 곳」 1, 하네스 한계라 `--resume` 경로는 이 실연으로 못 잰다).

**4. DM 에서 `message` 툴 → delivery-mirror** — C 턴에서 가짜 CLI 가 run grant 로 `message {action: send, target: channel:<대화 id>}` → `sent to dodok channel <대화 id> (<메시지 id>)`. 서버의 그 메시지는 `runId` = 그 런, `replyTo` = 방금 보낸 owner 글. 그 뒤 `chat.history` 6건 중 `model: "delivery-mirror"` 1건이 **같은 DM 세션**에 들었고, `sessions.list` 는 여전히 그 키 하나뿐(`agent:main:main` 없음)·`chatType: direct` 그대로였다 — 아웃바운드 경로가 peer `channel` 에 chatType 만 `direct` 를 냈다.

**5. 명령(C12 갈래)** — owner DM(direct)의 `/whoami` 는 모델 없이 Gateway 가 답했다(가짜 CLI 턴 수 그대로): `🧭 Identity / Channel: dodok / User id: user:owner / AllowFrom: user:owner`. `/status` 도 `🦞 OpenClaw 2026.11.10 (6ea542f) …` 로 답했다. mia DM(channel)의 `/whoami` 도 `User id: user:mia / AllowFrom: user:mia` 로 답했다 — 두 꼴 모두 명령이 허가됐다. 핀 SDK 를 직접 부른 비교(시험 같은 파일)에서도 `direct + allowFrom ["*"]` 의 `commandAccess.authorized` 는 `channel` 과 같은 `true` 이고, `commands.ownerAllowFrom` 을 둔 설정에서도 같았다(ingress 단계 — 명령 실행 뒤 단계의 주인 판정은 재지 않았다).

## 3. 새로 찾은 것 (판정은 하지 않았다)

- C 턴은 `message` 툴로 보낸 글 하나만 정본으로 남고(`RUN_FINISHED messageIds` 에 그것 하나), 가짜 CLI 의 마지막 답 `FAKE_CLI_DONE` 은 글이 되지 않았다. 같은 대상에 툴로 이미 보낸 런의 최종 답을 Gateway·플러그인이 거르는 동작으로 보이나 `channel` 꼴과 견주지 않았다.
- 명령 런(D)의 `RUN_FINISHED` 는 답 글 뒤 약 10초에 왔다(에이전트 명령 이월 「「완료」 줄까지 10초」와 같은 결).

## 4. 실물로 못 본 것

- 실제 모델이 `direct` 꼴과 `MEMORY.md` 를 어떻게 읽는지 — 모델 런(사용자 승인)이 필요하다.
- 원격 Gateway 판에서의 같은 흐름, 옛 플러그인 바이너리 + 새 서버(새 서버는 `dm` 안에 선택 필드 `direct` 를 더할 뿐이고, 옛 플러그인의 shared 스키마는 `z.object` 라 모르는 키를 버리고 받는다 — 코드로만 확인).
- `allowFrom` 없는 direct 의 실물 drop(위 1).

## 5. 띄운 것 / 끈 것

- 띄운 것: 스크래치 Gateway(포트 19011, `OPENCLAW_HOME` 스크래치), 스크래치 서버(포트 19100). 가짜 claude CLI 는 Gateway 가 턴마다 띄우고 끝났다. 웹·러너·가짜 Messages API 는 띄우지 않았다.
- 끈 것: 둘 다 — 끈 뒤 두 포트 모두 LISTEN 없음. 스크래치 디렉터리(설치본·Gateway 상태·DB·기록)는 지웠고, 이 워크트리의 `data/wire-cli-session.json`·`packages/openclaw-plugin/dist` 도 지웠다.
- 시크릿: Gateway 공유 토큰·로컬 로그인 토큰·두 세션 토큰이 서버·Gateway 로그, 가짜 CLI 기록, 공용 `/tmp/openclaw/openclaw-stdout.log` 에 0회(`grep -c -F`).
- 사람의 상태: `find ~/.openclaw ~/.openclaw-dev -maxdepth 2 -newer <시작 표식>` 비어 있음.
