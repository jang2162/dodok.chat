# 이어 가는 세션에 「최근 대화」를 다시 싣지 않기 — 2026-11-27 결과 (모델 런 0회)

> 사용자 이슈 「openclaw control UI 에서 dodok 으로 대화한 세션을 보니 중복으로 과도하게 많은 내용이 전달된다」를 실물 Gateway 에서 재고 고친 기록. 그 시점 기록이라 고치지 않는다 — 지금 동작은 `docs/guides/agent-guide.md` 「매 턴의 인바운드」의 「이어 가는 세션은 지난 턴 뒤 새 글만 싣는다」를 본다.

**판정: 진단 확인(겹침의 주원인은 매 턴 다시 싣는 「최근 대화」·「스레드 루트」), 고친 뒤 같은 시나리오에서 글·답의 겹침이 3회 → 1회. delivery-mirror 로 인한 중복은 0.**

## 1. 환경

| 항목 | 값 |
| --- | --- |
| OpenClaw | 스크래치 설치 `openclaw@2026.11.10` → `OpenClaw 2026.11.10 (6ea542f)`, `OPENCLAW_HOME=<스크래치>/gw`·포트 19031·`gateway run --auth token --bind loopback`, 설정은 `docs/guides/live-smoke.md` 10절 「새 상태의 Gateway 설정」과 같은 패치(claude-cli 런타임, `cron.enabled false`), 에이전트 `main` |
| 서버 | 이 워크트리 소스 `node --import tsx src/main.ts`, 포트 19130, `DATA_DIR`·`DB_PATH` 스크래치, 설정 키 전부 환경으로 |
| 플러그인 | 「전」은 변경 전 커밋(`8be974c3`)의 `pack:plugin`, 「후」는 이 브랜치 — 둘 다 Gateway 를 내린 뒤 `plugins install --force`, 빌드본·설치본 `dist/index.js` sha256 같음 |
| 가짜 claude CLI | Gateway PATH 맨 앞. `-p` 런이면 stdin 첫 `user` 레코드 글을 적고 `FAKE_REPLY_<시각>` 으로 답한다(모델·MCP 호출 없음) |
| 시나리오 | 대화 하나에 멘션 없는 「준비 글」 → `@main` ALPHA → 멘션 없는 BRAVO → `@main` CHARLIE → `@main` DELTA. 이어서 ALPHA 글을 루트로 스레드에 `@main` TANGO → 멘션 없는 UNIFORM → `@main` VICTOR → `@main` WHISKEY |

세는 범위: OpenClaw 세션 전사(control UI 가 보는 것) — 「전」 대화는 Gateway 의 `openclaw-agent.sqlite` `transcript_events`(읽기 전용), 나머지는 `chat.history`. 수는 그 세션의 user·assistant 글을 이어 붙인 텍스트에서 `grep -c -F` 의 줄 수(한 줄에 한 번씩만 나오는 표식이라 줄 수 = 등장 수).

## 2. 측정 — 전·후

### 대화 세션(턴 셋, 전사 항목 6 — user·assistant 세 쌍)

| 표식 | 전 | 후 | 무엇인가 |
| --- | --- | --- | --- |
| ALPHA(첫 트리거) | 3 | 1 | 턴 1 본문 + 턴 2·3 의 최근 대화 |
| BRAVO(멘션 없는 사람 글) | 2 | 1 | 턴 2·3 의 최근 대화 → 턴 2 만 |
| CHARLIE | 2 | 1 | |
| DELTA | 1 | 1 | |
| 에이전트 첫 답 | 3 | 1 | assistant 항목 + 턴 2·3 의 최근 대화(자기 글) |
| 에이전트 둘째 답 | 2 | 1 | |
| 「준비 글」 | 6 | 4 | 세션 제목 줄 3(그대로) + 최근 대화 3 → 1 |
| 헤더 고정 줄(`참여자:`·`릴레이 규칙:`·`시각 기준:`·`세션:`) | 각 3 | 각 3 | 턴마다 한 번 — 바꾸지 않았다(결정 4) |
| `delivery-mirror` 항목 | 0 | 0 | 정본 답은 플러그인 deliver 경로로만 가 전사에 두 번 들지 않는다 |
| 전사 글자 수(바이트) | 2,020 | 1,694 | |

### 스레드 세션(턴 셋)

| 표식 | 전 | 후 |
| --- | --- | --- |
| 스레드 루트(ALPHA) | 3 | 1 |
| TANGO | 3 | 1 |
| UNIFORM | 2 | 1 |
| VICTOR | 2 | 1 |
| 에이전트 첫 답 | 3 | 1 |
| 에이전트 둘째 답 | 2 | 1 |
| `스레드 루트:` 줄 | 3 | 1 |
| `참여자:` | 3 | 3 |
| 전사 바이트 | 2,222 | 1,850 |

「후」의 턴별 블록(가짜 CLI 가 받은 글): 대화 턴 1 `최근 대화:` + 준비 글, 턴 2 `최근 대화(지난 턴 뒤):` + BRAVO, 턴 3 `최근 대화: (지난 턴 뒤 새 글 없음)`. 스레드 턴 1 `스레드 루트:` 만, 턴 2 `스레드 최근(지난 턴 뒤):` + UNIFORM, 턴 3 `스레드 최근: (지난 턴 뒤 새 글 없음)`. 플러그인 `dodok:ingress` 줄의 `continuing` 은 true 4(각 세션 둘째·셋째)·false 2(각 세션 첫 턴). Gateway 를 다시 띄운 뒤 같은 대화의 첫 턴(ECHO)은 `continuing:false` 로 최근 대화를 전부 실었다(기억이 없으면 전부).

턴이 늘면 겹침은 「전」에서 글마다 최대 20번(`RECENT_MESSAGES_MAX`)까지 자란다 — 3턴 시나리오의 3배는 그 시작이다. 「후」는 턴 수와 무관하게 1번이다.

### 다른 중복 원인 — 찾은 것

- **delivery-mirror** — 없다(위 표). 툴 전송(`message` 툴) 런의 mirror 는 지난 실연(`2026-11-27-dm-direct-live-smoke-report.md` 4)에서 본 대로 툴로 보낸 글 하나를 전사에 남기는 것이고 정본 답과 겹치지 않는다(이번에는 툴을 부르지 않았다).
- **헤더 고정 줄** — 턴마다 약 400바이트(세션·참여자·릴레이 규칙·시각 기준). 결정 4 대로 그대로 두었다 — 보고만.
- **「스레드 소식」에 에이전트 자기 스레드 답** — 대화 세션 턴의 스레드 소식에 `@main: FAKE_REPLY…`(자기 스레드 답)가 실린다. 그 답은 스레드 세션 전사에만 있고 대화 세션 전사에는 없어 중복은 아니다 — 고치지 않았다.

## 3. 고친 것

- **서버** — `agent_sessions.delivered_up_to`(마이그레이션 `0049`) — 받아들여진 런이 실은 마지막 글의 시각(메시지 트리거는 그 글, 상호작용·이어가기는 카드가 달린 글, 명령·추가 응답 런은 올리지 않음 — `runs/context.ts` `deliveredCursorOf`). 리액션 커서와 같은 자리(받아들여진 뒤, 뒤로 가지 않음 — `sessions/service.ts` `advanceDeliveredCursor`)에서 올리고, 다음 런의 `context.deliveredUpTo` 로 싣는다(갱신 판정 뒤의 행을 다시 읽어 — `withDeliveredUpTo`). 새 세션 행은 null, `renewSessionOnPromptChange` 는 비운다. 기존 행은 null 로 시작해 다음 런이 전부 싣고 그 뒤부터 채워진다.
- **공용 문구** — shared `formatConversationBlock`(`packages/shared/src/bridge/index.ts`): `continuing && deliveredUpTo` 일 때만 `ts <= deliveredUpTo` 인 글과 isSelf 에이전트 글을 빼고 제목에 `(지난 턴 뒤)`, 남는 게 없으면 `…: (지난 턴 뒤 새 글 없음)`, 스레드면 `스레드 루트:` 를 뺀다. 플러그인 헤더와 러너 프롬프트가 같이 쓴다.
- **플러그인** — `packages/openclaw-plugin/src/session-continuity.ts`·`channel.ts`: 전달마다 기억을 먼저 지우고, `onAgentRunStart` 에 그 세션 항목의 `sessionId`·`compactionCount` 를 적는다. 다음 전달에서 지금 항목의 둘이 같고 코어 리셋 정책으로 이번 인바운드에 리셋되지 않을 때만 이어 간다. 세션을 못 읽으면 전부. 기억은 최근 1,000 세션(LRU).
- **러너** — `packages/claude-runner/src/drivers/claude/run.ts`: `runTurn` 의 `continuing` = resume 으로 연 프로세스(`sessionExists` 가 참이거나 「이미 있는 세션」 재시도)·붙든 프로세스. 새로 연 세션이면 전부.

### 판정 근거(핀 SDK `packages/openclaw-plugin/node_modules/openclaw` 2026.11.10)

- 세션 항목 읽기 — `dist/config-contracts-CmjbWZfI.d.ts:44899` `PluginRuntime.agent.session.getSessionEntryAsync`. 항목의 `sessionId` 68402·`updatedAt` 68405·`compactionCount` 68707.
- 리셋 예측 — `dist/plugin-sdk/session-store-runtime.d.ts:3` 이 내보내는 `evaluateSessionFreshness`(`config-contracts-*.d.ts:27078`)·`resolveSessionResetPolicy`(27072)·`resolveSessionResetType`(27085)·`resolveChannelResetConfig`(27097). 구현 `dist/reset-CqsVqwh1.mjs`(한 줄 — `DEFAULT_RESET_MODE=\`none\``: 설정이 없으면 늘 신선). 코어 인바운드의 같은 판정은 `dist/entry-freshness-6h3utM16.mjs` `resolvePreparedSessionEntryResetFreshness` 이고, 그 함수를 감싼 `runtime.channel.session.resolveEntryResetFreshnessAsync` 는 런타임에 있으나 공개 타입(`PluginRuntime["channel"]["session"]`, `config-contracts-*.d.ts:65378` 부근)에 없어 쓰지 않았다.
- 틀리는 방향 — 코어는 정책이 설정되지 않은 provider-owned 세션을 늘 신선으로 보는데(`hasProviderOwnedSession`) 플러그인은 그 예외를 따르지 않는다 → 「전부 싣기」 쪽으로만 틀린다. 플러그인이 쓰는 `lastInteractionAt`·`sessionStartedAt` 은 항목의 값이라 코어의 생명주기 시각보다 늦지 않아 유휴 판정도 같은 쪽으로만 틀린다.

## 4. 호환

- 옛 서버(필드 없음) + 새 플러그인·러너 → `deliveredUpTo` 가 없어 지금처럼 전부(플러그인은 세션을 읽지도 않는다).
- 새 서버 + 옛 플러그인·러너 → 옛 shared 스키마(`z.object`)가 모르는 키를 버리고 전부. 이번 실연의 「전」 스레드가 바로 이 꼴이었다(새 서버 + 옛 플러그인).
- 러너 hello 능력은 더하지 않았다 — 필드만 본다.

## 5. 시험·구분력

- `pnpm lint`·`pnpm fmt:check`·`pnpm typecheck`(7/7) 통과. `pnpm exec turbo run test --continue` 7/7 — shared 881·runner 687·runner-adapter 147·openclaw-plugin 255·openclaw-adapter 339·server 4,656(+4 skipped)·web 3,006, 합 9,971.
- 구분력(되돌려 깨지는지, 파일 사본으로 복구 — `git stash` 없음): 서버 커서 올림 제거 → 오케스트레이터 2 실패, 리셋 때 비우기 제거 → `sessions.renew` 1 실패, 공용 거름 무력화 → shared 5·플러그인 context 2 실패, 플러그인 세대 비교 제거 → 3 실패, 판정 전 기억 지우기 제거 → channel 1 실패, 러너 `continuing: resume` → `true` → 러너 1 실패.

## 6. 남은 위험(판정은 하지 않았다)

- **claude-cli 의 CLI 세션 리셋** — OpenClaw `sessionId` 가 같아도 Gateway 가 Claude CLI 세션을 새로 열 수 있다(`dist/prepare.runtime-CxT6KfJg.mjs` — `missing-transcript`·`orphaned-tool-use`·`system-prompt` 드리프트, 로그 `cli session reset: provider=claude-cli reason=…`). 그 턴에 플러그인은 「이어 감」으로 보고 새 글만 싣는다. 코어는 그때 `loadCliSessionPromptContext`(`dist/context-engine-turn-D9LUOTP-.mjs`)로 틈 안내(「이 채팅의 앞 글 N개 — `sessions_history` 로 읽으라」)나 재시드를 붙이지만, 모델이 앞 글을 인용으로 바로 보지는 못한다. 이 하네스의 가짜 CLI 는 claude 전사를 만들지 않아 9턴 모두 `missing-transcript` 였다 — 진짜 claude 는 전사를 남겨 `--resume` 으로 잇는다. 틈 안내가 실제로 어느 자리(시스템·사용자 글)에 실렸는지는 가짜 CLI 기록으로 가르지 못했다.
- 실제 모델이 `최근 대화(지난 턴 뒤):`·`(지난 턴 뒤 새 글 없음)` 을 어떻게 읽는지 — 모델 런이 필요하다.
- OpenClaw `/new`·`/reset`·일일·유휴 리셋·컴팩션은 실물로 일으키지 않았다 — 플러그인 시험(`session-continuity.test.ts`·`channel.test.ts`)이 핀 SDK 함수로 잡는다.
- 러너 쪽은 단위 시험(가짜 SDK)만 — 런 0회 하네스(가짜 Messages API)로 resume 경로를 돌리지 않았다.

## 7. 띄운 것 / 끈 것

- 띄운 것: 스크래치 Gateway(포트 19031), 스크래치 서버(포트 19130). 가짜 claude CLI 는 Gateway 가 턴마다 띄우고 끝났다. 웹·러너·가짜 Messages API 는 띄우지 않았다.
- 끈 것: 둘 다 — 끈 뒤 두 포트 LISTEN 없음, 스크래치 경로를 쥔 프로세스 없음. 이 워크트리의 `data/wire-cli-session.json`·`packages/openclaw-plugin/dist` 는 지웠고 스크래치 디렉터리도 지웠다.
- 시크릿: Gateway 공유 토큰·로컬 로그인 토큰이 서버·Gateway 로그, 가짜 CLI 기록, 공용 `/tmp/openclaw/openclaw-*.log` 에 0회(`grep -c -F`).
- 사람의 상태: `find ~/.openclaw ~/.openclaw-dev -maxdepth 2 -newer <시작 표식>` 비어 있음. 원격 Gateway 는 만지지 않았다.
