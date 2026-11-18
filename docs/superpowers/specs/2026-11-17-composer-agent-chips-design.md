# 작성기 위 에이전트 칩과 컨텍스트 세부 — 설계

상태: 승인 대기(2026-11-17) · 결정: 사용자와의 대화(2026-11-17), 빌더 확인 1회

## 1. 왜

러너 세션 설정(스펙 `docs/superpowers/specs/2026-11-11-runner-session-settings-design.md`)은 작성기 위에 러너 에이전트마다 글 한 줄(`opus · effort 높음 · 권한 기본 · 컨텍스트 31%`)과 「변경」 팝오버를 두었다. 사용자는 이것을 Orca 채팅 UI 처럼 바꾸고 싶어 한다 — 모델·노력치를 **그 자리의 칩에서 바로** 고르고, 컨텍스트는 원형 게이지로 보이다가 올리면(호버) **항목별 세부**(Messages·System tools·Free space·Autocompact buffer 등, 사용 토큰/창 크기)를 보인다.

같은 사용자 요청 묶음의 다른 둘(같은 git 프로젝트를 워크트리로 나눈 에이전트, Claude·OpenClaw 명령어)은 따로 설계한다 — 이 문서의 범위가 아니다.

## 2. 목표 · 하지 않을 것

**목표**
- 상태 줄의 글과 「변경」 팝오버를 칩 셋(모델·노력치·권한)으로 바꾼다. 칩을 누르면 그 칩의 선택지만 뜨고, 고르면 바로 저장한다(지금 PATCH 그대로).
- 모델 칩의 선택지는 그 러너가 알린 실제 모델 목록(표시 이름 — 예: `Opus 5.5`)이다. 노력치 칩은 고른 모델이 받는 단계만 보인다.
- 컨텍스트는 원형 게이지 + 퍼센트. 호버(키보드 초점 포함)하면 팝오버로 `사용/창` 토큰과 항목별 비율을 보인다.

**하지 않을 것**
- OpenClaw 에이전트에 칩을 그리는 것(조율자 판단 — 이 대화에서 답이 없었고, OpenClaw 의 모델 바꾸기는 Gateway 설정이라 성격이 다르다). 지금처럼 러너 에이전트만.
- 호버할 때 러너에 그 자리에서 묻는 것(사용자가 1안 — 런 끝에 담기 — 을 골랐다).
- 런 도중에 바꾼 값을 그 런에 적용하는 것(지금처럼 다음 런부터).
- 세션 설정의 누가 무엇을 바꾸나(S2)·시작값(S5·S10·S11)을 바꾸는 것 — 그대로 둔다.

**실패로 볼 것(돌아가도)**
- 옛 러너(0.5.0 이하)에 붙은 에이전트의 칩이 비거나 고를 수 없게 되는 것 — 옛 러너는 지금 고정 목록·퍼센트로 그대로 써야 한다.
- 세부를 담느라 런마다 눈에 띄게 느려지거나 토큰 비용이 드는 것(`detail: "full"` 의 항목별 토큰 세기 호출).
- 게이지의 퍼센트와 팝오버의 합계가 서로 다른 수를 말하는 것.

## 3. 결정

| # | 결정 | 출처 |
| --- | --- | --- |
| C1 | 컨텍스트 세부를 이번에 넣는다 — 러너 새 판(0.6.0)과 함께 배포 | 사용자(A) |
| C2 | 세부는 런이 끝날 때 러너가 SDK `Query.getContextUsage({ detail: "summary" })` 로 받아 런 사용량에 실어 보낸다. 서버는 그 런 행에 저장하고, 호버는 저장된 마지막 값을 보인다(러너가 꺼져 있어도 보인다) | 사용자(1안) |
| C3 | 모델 목록은 러너가 hello 의 프로그램 상태에 싣는다 — SDK `supportedModels()` 의 `value`·`displayName`·`supportedEffortLevels`. 서버는 메모리에만 둔다(hello 의 다른 값과 같다) | 조율자 제안, 사용자 이의 없음 |
| C4 | 옛 러너(목록·세부를 안 싣는 러너) — 모델 칩은 지금 고정 목록(`sonnet`·`opus`·`haiku`·직접 입력), 노력치 칩은 다섯 단계 전부, 게이지는 퍼센트만(호버하면 `사용/창` 만, 항목 없음) | 조율자 제안, 사용자 이의 없음 |
| C5 | OpenClaw 에이전트는 이번 범위 밖 | 조율자 판단(2장) |
| C6 | `detail: "summary"` 만 쓴다 — `full` 은 항목마다 토큰 세기 API 를 불러 런마다 비용·지연이 든다 | 조율자 판단 |
| C7 | 세부는 `run.final` 에 함께 싣는다 — 러너가 `result` 를 받으면 `end()`(입력 닫기) **전에** `getContextUsage` 를 상한 2초로 기다린 뒤 final 을 보낸다. 답 글은 이미 흘러 나와 있어 final 이 최대 2초 늦는 것은 받아들인다. final 뒤에 따로 보내는 길(새 wire 이벤트·늦은 도착 규칙·저장된 행 고치기)은 만들지 않는다 | 조율자 판단(빌더 확인 Q1) |
| C8 | 창(분모)은 `getContextUsage` 의 `maxTokens`, 퍼센트는 그 응답의 `percentage`(100 을 넘으면 100 으로 잘라 `contextPercent` 에 — 팝오버에는 넘은 사실을 「창 초과」로 보인다). 항목 비율은 `tokens / maxTokens`. 세부가 없는 런(옛 러너·세부 실패)은 지금 계산(`contextTokens/contextWindow`) 그대로 — 두 정의가 다를 수 있는 것은 옛 러너 동안만이라 받아들인다. 빌더는 런 0회 하네스에서 `maxTokens`·`rawMaxTokens` 와 `used+free+buffer` 합을 찍어 `maxTokens` 가 그 합과 맞는지 확인하고, 안 맞으면 합을 분모로 쓴다 | 조율자 판단(빌더 확인 Q2) |
| C9 | 모델 「기본」(null) — `supportedModels()` 의 `value` 가 `default` 인 줄은 따로 보이지 않고 「기본」 선택지에 합친다. 저장 값은 지금처럼 null, 「기본」일 때 노력치 칩은 그 `default` 줄의 단계(없으면 다섯 단계 전부) | 조율자 판단(빌더 확인 Q3) |
| C10 | 모델 목록은 러너·프로그램 단위로 한 번 받는다(프로젝트별이 아님). 프로젝트 설정(`availableModels`)으로 막힌 모델이 칩에 보일 수 있다 — 고르면 런에서 CLI 가 거절하고 지금 오류 길로 간다. 목록을 받는 query 의 cwd 는 러너의 첫 루트 | 조율자 판단(빌더 확인 Q4) |
| C11 | `models` 는 `RunnerProgramStatus` 에 두므로 `GET /runners`·제어 MCP 응답에도 함께 나간다 — 모델 이름이라 감출 것이 없어 스키마를 나누지 않는다. 세부도 사용량 CUSTOM 이벤트(`dodok.usage`)로 웹에 그대로 나간다 — 경로·이름을 뺀 모양(5.1)이라 괜찮다 | 조율자 판단(빌더 확인 Q5) |

## 4. 방법(고른 것과 버린 것)

1. **런 끝에 담기(고름).** 러너가 결과 메시지를 받은 뒤 같은 query 에서 `getContextUsage` 를 한 번 부르고 런 사용량에 싣는다. 장점: 호버가 바로 뜨고 러너가 꺼져도 보인다, 서버 저장 자리(`runs.usage`)와 지금 퍼센트 계산 길(`contextPercentOf`)을 그대로 쓴다. 단점: 마지막 런 기준이다 — 지금 퍼센트도 같다.
2. **호버할 때 묻기(버림).** 늘 최신이지만 러너가 붙어 있어야 하고 세션을 다시 열어야 해서 느리고, 호버마다 비용이 든다.
3. **세부 없이 게이지만(버림).** 웹만 고치면 되지만 사용자가 세부를 이번에 원했다(C1).

## 5. 설계

### 5.1 러너(`packages/claude-runner`, 0.6.0)

- **세부 받기.** Claude 드라이버의 런(`drivers/claude/run.ts` 의 `attempt`)이 결과(`result`) 메시지를 받은 뒤, **`end()` 로 입력을 닫기 전에**(지금은 `result` 처리 중 바로 `end()` 가 CLI 를 끝낸다 — 순서를 바꾼다) `getContextUsage({ detail: "summary" })` 를 한 번 부르고 final 에 싣는다(C7). 상한 2초, 실패·시간 초과·중지된 런이면 세부 없이 지금처럼 끝낸다 — **세부 때문에 런이 실패하지 않는다.**
- **보낼 모양.** SDK 응답을 그대로 보내지 않고 줄인다: `model`, `totalTokens`, `maxTokens`(응답 `SDKControlGetContextUsageResponse` 의 camelCase 필드 — C8), `percentage`(0~100+), `categories: [{ name, tokens, kind }]`(`kind` 는 `used`·`free`·`buffer`·`deferred`). `mcp_tools`·`memory_files`·`agents`·`skills` 의 줄별 목록은 싣지 않는다 — 경로·이름이 머신 정보를 드러내고 화면에 쓰지 않는다. 항목 수·이름 길이에 상한을 둔다(계약 스키마).
- **모델 목록.** 러너가 시작할 때(그리고 다시 붙을 때) Claude 프로그램의 `supportedModels()` 를 받아 hello 의 그 프로그램 상태에 싣는다: `[{ value, displayName, efforts }]`. 받으려면 query 가 하나 필요하다 — 받는 방법(가벼운 query 를 열었다 닫기, 캐시 시점)은 빌더가 정한다. 실패하면 목록 없이 hello 를 보낸다(C4 로 떨어진다). 목록 받기가 모델 런(토큰 사용)이 되면 안 된다.
- **SDK 포트.** `drivers/claude/sdk.ts` 의 `SdkQuery` 와 시험의 가짜 query(`test/helpers/fake-query.ts`)에 `getContextUsage`·`supportedModels` 를 더한다.
- **런 0회 하네스.** 가짜 Messages API(`packages/claude-runner/scripts/fake-messages-api.ts`)로 두 호출이 모델 런 없이 지나는지 본다(`docs/guides/live-smoke.md` 「Claude 러너 런 0회 하네스」).

### 5.2 계약(`packages/shared`)

- 선택 필드 `contextBreakdown`(5.1 의 줄인 모양)을 **세 곳**에 더한다: 러너 wire `RunnerRunFinal.usage`, 러너 어댑터 `onRunFinal` 의 필드별 복사(`packages/runner-adapter/src/runner-adapter.ts` — 손으로 옮기므로 빠지면 말없이 사라진다), 도메인 `RunUsage`. 옛 러너는 싣지 않는다.
- `RunnerProgramStatus` 에 선택 필드 `models: [{ value, displayName, efforts: RunnerEffort[] }]` 를 더한다. 개수·길이 상한.
- 둘 다 선택 필드라 러너 프로토콜 판(`RUNNER_PROTOCOL`)은 올리지 않는다. 확인됨(빌더 확인): `RunnerHello` 는 `strictObject` 지만 그 안의 `RunnerProgramStatus`·`RunnerRunFinal.usage` 는 평범한 `z.object` 라 옛 서버가 모르는 키를 지운다 — **hello 최상위에는 새 키를 두지 않는다**(거절된다).

### 5.3 서버(`apps/server`)

- 런 사용량 저장은 그대로(`runs.usage` JSON) — 새 필드가 함께 들어간다. 마이그레이션은 필요 없을 것이다(JSON 칸) — 빌더가 확인한다. 지금 `runs.usage` 는 입력·출력 토큰이나 비용이 있을 때(`measured`)만 저장한다 — 세부만 있는 런이 생기는지 빌더가 보고, 생기면 세부도 저장 조건에 넣는다.
- `ConversationAgentSettings`(대화 설정 응답)에 `context`(마지막 런의 세부 — 없으면 null)를 더한다. 퍼센트(`contextPercent`)는 세부가 있으면 **세부의 `percentage`** 로, 없으면 지금처럼 `contextTokens/contextWindow` 로 낸다 — 게이지와 팝오버가 같은 수를 말하게(2장 실패 셋째).
- 모델 목록은 웹이 에이전트별로 받아야 한다. member 는 남의 러너가 `GET /runners` 에 없으므로(세션 설정 스펙 리뷰 건 1), `ceiling` 처럼 **대화 설정 응답과 `GET /channels/:id/agent-ceilings`(새 세션 창)에 그 에이전트 프로그램의 `models`** 를 싣는다. 러너가 끊겼으면 빈 목록 → 웹은 C4 로.

### 5.4 웹(`apps/web/src/features/composer`)

`AgentSettingsBar`·`AgentSettingsPopover` 를 고친다.

```
@coder  [Opus 5.5 ⌄] [높음 ⌄] [기본 권한 ⌄]   ◔ 31%
                                            └ 호버: 248.5k / 800k
                                                    Messages        26.9%
                                                    System tools     2.2%
                                                    Free space      64.8%
                                                    Autocompact      4.1%
                                                    ── 창 밖(불러올 때만) ──
                                                    MCP tools (deferred) 21.9k
```

- **칩.** 각 칩은 드롭다운(`ui/dropdown-menu.tsx`). 고르면 바로 저장(대화가 있으면 PATCH, 새 세션 창이면 지금처럼 `pending`). 「기본」 선택지는 그대로 둔다. 저장 실패 문구·권한 잠금(`RAISE_LOCKED`)·상한 거절은 지금 팝오버의 것을 칩 옆에 그대로 보인다.
- **모델 칩.** 목록이 있으면 표시 이름, 없으면 C4. 저장된 모델 값이 목록에 없으면(직접 입력했던 값, 다른 러너로 옮긴 프로젝트) 그 값을 그대로 칩에 보이고 선택지 맨 위에 둔다 — 사라지게 두지 않는다. 「직접 입력」은 남긴다.
- **노력치 칩.** 고른 모델의 `efforts` 만. 지금 노력치가 새 모델이 받지 않는 단계면 칩에 그대로 보이되 경고 표시를 한다(빌더가 모양을 정한다) — 저장된 값을 말없이 바꾸지 않는다.
- **권한 칩.** 지금 팝오버의 권한 선택지·잠금 규칙 그대로.
- **게이지.** SVG 원형, 퍼센트 글. 런이 없으면 「—」. 호버·초점에 팝오버(`ui/tooltip.tsx` 또는 팝오버 — 키보드로 열 수 있어야 한다). `kind` 가 `used`·`free`·`buffer` 인 줄은 창 비율, `deferred` 는 「불러올 때만」 아래에 토큰 수로. 토큰은 `248.5k` 꼴. 0 토큰 줄은 숨긴다.
- **접기.** 러너 에이전트가 셋 넘으면 접는 지금 동작(`FOLD_OVER`)은 그대로. → 2026-11-18 작성기 도구 줄 스펙 T1~T6 으로 바뀜(`docs/superpowers/specs/2026-11-18-composer-toolbar-design.md`)
- **좁은 화면(390px).** 칩 줄이 넘치면 줄바꿈 — 가로 스크롤이 생기면 안 된다.

## 6. 남은 것(빌더 몫)

- `getContextUsage` 상한 시간, 모델 목록을 받는 query 의 모양과 캐시 시점.
- 계약 스키마의 상한 값(항목 수·이름 길이·모델 수).
- 노력치 경고 표시의 모양, 게이지 색 구간.
- 시험: 러너(세부 실패해도 런 성공, 줄인 모양, 목록 실패 시 hello), shared(새 필드 파싱·옛 페이로드), 서버(세부 있음·없음의 퍼센트, member 가 받는 models), 웹(칩 저장·옛 러너 폴백·목록에 없는 저장값·게이지 팝오버 키보드). 브라우저 확인은 `dev:fake` 위 — 가짜 러너가 목록·세부를 싣게 `dev:fake` 대본을 늘린다.
- 문서: `docs/manual/user-guide.md`(작성기 위 칩), `docs/guides/plan.md` 8장, 러너 판 올리기는 `docs/guides/runner-release.md`.
