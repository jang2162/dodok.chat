# 웹(Phase 1 ②) 실물 확인 — 2026-09-20 결과

> 웹 MVP(Phase 1 ②)를 실제 dev Gateway·모델 위에 얹어 본 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-19-web-mvp.md` 태스크 15, 스펙 `docs/superpowers/specs/2026-09-19-web-mvp-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


**상태(2026-09-20)**: 실제 dev Gateway·실제 플러그인 번들·실제 모델(`claude-opus-5` + claude-cli)로 웹을 한 번 돌렸다. 모델 런은 사용자 승인 상한 그대로 **4회**(3회 + 중지 재시도 1회).
**시나리오 4·5 는 통과, 6(중지)은 두 번 다 계측이 빗나가 「실물 중지 미확인」으로 남았다**(7.4 의 ❗). 절차는 7.1~7.2, 결과는 7.3~7.8. 로그는 `data/phase1-live-20260920.log`(서버 pino)·`data/dev-gateway.log`(Gateway·플러그인·claude-cli)·
`data/frames-20260920.jsonl`(Gateway 원본 프레임)·`data/cdp-*.jsonl`(브라우저 콘솔·WS 프레임). 전부 `data/` 안에 두고 커밋하지 않는다.

### 7.1 준비 — 3절에 더할 것

3절 (a)~(e)를 그대로 하고 아래를 더한다.

- `data/live-smoke.env` 의 `APP_ORIGIN` 은 웹 dev 서버 주소와 **글자까지 같아야 한다**(`http://localhost:5173`). wire 는 핸드셰이크 `Origin` 이 `APP_ORIGIN` 과 같을 때만 세션 쿠키를 받는다(웹 스펙 9.1).
- 웹을 띄운다. 서버 포트가 3000 이 아니므로 프록시 대상을 준다.

```bash
DODOK_API_ORIGIN=http://127.0.0.1:$PORT pnpm -F @dodok/web dev      # 5173, strictPort
```

- 브라우저는 **`http://localhost:5173`** 으로 연다. 웹을 `--host 127.0.0.1` 로 띄운 뒤 `127.0.0.1:5173` 으로 열면 `Origin` 이 달라 wire 가 `UNAUTHORIZED` 를 주고, 앱은 REST 세션이 살아 있는 것을 보고
  재연결을 멈춘 뒤 「실시간 연결이 거부되었습니다 — 이 주소(http://127.0.0.1:5173)가 서버의 APP_ORIGIN 과 다릅니다」 배너를 띄운다(설계대로다 — 헷갈리지 말 것).
  Vite 기본값(`localhost`)은 macOS 에서 `::1` 에만 열려 `127.0.0.1:5173` 은 그 전에 연결 거부(`ERR_CONNECTION_REFUSED`)다 — 배너를 일부러 보려면 웹을 `--host 127.0.0.1` 로 띄운다.
- **로그인 토큰을 화면·전사에 남기지 않고 넣는 법.** 토큰은 `data/live-smoke.env` 의 `LOCAL_AUTH_TOKEN`(실연 전용으로 새로 뽑은 값 — `.env` 의 것이 아니다)이다.
  Vite dev 서버는 워크스페이스 안 파일을 `/@fs<절대경로>` 로 **같은 출처**에 서빙하므로, 페이지 안에서

  ```js
  const env = await (await fetch('/@fs' + REPO + '/data/live-smoke.env')).text();
  const tok = env.match(/^LOCAL_AUTH_TOKEN=(.+)$/m)[1].trim();   // 입력칸에 넣고 제출
  ```

  하면 값이 셸 출력·도구 전사 어디에도 남지 않는다. Vite 기본 `server.fs.deny` 는 `.env`·`.env.*` 라 `live-smoke.env` 는 걸리지 않는다.
  **토큰을 다른 파일로 복사하지 않는다**(`data/` 밖으로 나가고, 에이전트 도구가 「자격 증명 복제」로 막기도 한다). Vite 를 내리면 이 경로도 닫힌다.
  입력칸은 제어 컴포넌트라 `value` 를 그냥 넣으면 React 가 되돌린다 — `HTMLInputElement.prototype` 의 네이티브 setter 로 넣고 `input` 이벤트를 쏜다.
- ⚠ **검증 탭은 앞으로 꺼낸다.** 배경 탭은 타이머를 ~1s 로 조인다 — 페이지에 심은 `setInterval` 표본기가 스트리밍 창(이번에 런당 **0.2~1.5s**, 7.5)을 통째로 놓친다.
  2026-09-20 에 중지 클릭이 이것 때문에 불발했다(앱 결함이 아니라 계측 결함). **폴링은 페이지 타이머가 아니라 브라우저 바깥**(neo `run` 런타임·CDP)에서 돌리고,
  사람이 누르는 것을 흉내 내는 확인은 탭을 앞으로 꺼낸 뒤 한다(CDP `Page.bringToFront`). 델타 렌더 자체는 배경 탭에서도 정상이다 — WS 수신은 조이지 않는다.
- **프레임 원본은 늘 남긴다.** `data/live-smoke.env` 에 `OPENCLAW_FRAME_DUMP_PATH=data/frames-<날짜>.jsonl` 을 더한다(파일은 Gateway 연결마다 `<경로>.<연결 id>` — `.env` 의 Gateway 는 `data/frames-<날짜>.jsonl.env`). usage 출처(5.4-2)는 이 덤프로 갈랐다 — 7.6.
- 3절 (a) 가 `Config path not found: channels.dodok.channels. Nothing was changed.` 를 찍으면 **이미 깨끗하다는 뜻**이다(정상 — 오류가 아니다).
- 에이전트는 웹에서 등록한다: `/settings/agents` → 「에이전트 가져오기」 → `dev`·`fin`. dev 의 표시 이름은 `C3-PO` 이고 **핸들 칸은 `dev` 로 채워진다**(멘션은 `@dev`).
- **스크린샷·콘솔·WS 프레임.** BrowserOS neo 는 스크린샷을 파일로 주지 않고 `console.log`·네트워크·WS 프레임을 못 본다(browser-verification.md).
  저장소 `.mcp.json` 의 `playwright-neo` 가 세션에 붙지 않았으면, neo 의 CDP(`~/Library/Application Support/BrowserClaw/.browseros/config.json` 의 `ports.cdp`, 기본 9110)에
  **Node 24 내장 `WebSocket`** 으로 직접 붙어 `Page.captureScreenshot`·`Runtime.enable`·`Network.enable` 로 대신한다 — 의존성이 필요 없다(2026-09-20 에 그렇게 했다).

### 7.2 시나리오와 런 배분 — **모델 런 3회 이하**

⚠ **사람 메시지에 `@fin` 을 쓰면 릴레이가 아니다.** 라우터는 사람 메시지의 멘션을 전부 depth 0 런으로 만든다(`router/decide.ts`) — `@dev @fin …` 은 릴레이 체인이 아니라
**병렬 런 2개**가 되고, 각자의 답이 또 릴레이를 켜서 상한을 넘긴다. 릴레이를 보려면 **`fin` 앞의 `@` 를 뺀다**: `@dev fin 에게 …`.

⚠ **`자동 응답`은 멘션이 하나도 없는 사람 메시지에만 걸린다**(같은 파일). `@…` 로 시작하는 우리 문장들은 자동 응답 런을 만들지 않으므로 켜 두어도 예산에 영향이 없다.

| # | 입력 | 턴 상한 | 런 | 볼 것 |
| --- | --- | --- | --- | --- |
| 4 | `@dev 안녕하세요. 한 문장으로 자기소개 해줘` | **0** | 1 | 대기 → 델타가 버블에 쌓임 → 정본 교체 때 버블 0·메시지 1, 목록이 끝에 붙어 있음 |
| 5 | `@dev fin 에게 오늘 할 일을 한 줄로 전해줘` | **1** | 2·3 | dev 답의 `@fin` 이 멘션 칩 → fin 런(relay·depth 1) → fin 답의 `@dev` 가 상한에 막혀 `relay_limit` 카드 + 「이어가기」(**누르지 않는다** — 런이 하나 더 생긴다) |
| 6 | 런 3 스트리밍 중 버블의 중지 | 1 | — | 「중지됨」으로 끝나는지, **중지 뒤 늦은 정본이 오는지** |

- **런 1 앞에서는 턴 상한을 0 으로 둔다** — 에이전트 답 속 멘션이 런을 하나 더 만들지 않게(5.2 의 런 4·5 와 같은 방식). 런 2 앞에서 1 로 올린다.
  설정 저장·에이전트 등록·채널 만들기는 런을 쓰지 않는다.
- 상한을 바꾸면 채널 프롬프트 리비전이 오르고 다음 인바운드에 `ChannelPromptContext` 가 실린다(설계대로).

### 7.3 환경 실물 (2026-09-20)

| 항목 | 값 |
| --- | --- |
| Gateway | OpenClaw `2026.9.4 (3a9d69d)`, 번들 Node 24.19.0, `:19001` loopback, token 인증. 기동 → `http server listening` 1.3s(플러그인 14개) |
| 플러그인 | `pack:plugin` 번들 sha256 `4b0ecc34…` = 설치본과 일치, `status: "loaded"`, `trust.reason: "provenance-invalid"`(archive 설치) |
| 서버 | `:19100`(계정 `default` 의 bridgeUrl 포트), `OPENCLAW_TARGET=dev`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`, 프레임 덤프 켬 |
| 웹 | Vite 8.3.0, `:5173`, `DODOK_API_ORIGIN=http://127.0.0.1:19100`, 브라우저 BrowserOS neo(Chrome 151.0.8162.137) |
| 저장소 | Node 24.21.0 · pnpm 11.16.0 |
| 브리지 | 서버 listen 뒤 **10.2s** 에 `ready`(플러그인 백오프 6번째 시도). 2026-09-15 의 21.5s 보다 짧다 — 백오프 상한을 30s → 10s 로 낮춘 효과(5.2) |
| 페어링 | `OPENCLAW_DEVICE_IDENTITY_PATH=` 빈 값 → `data/openclaw-device-dev.json` 새로 생성, 첫 시도 접속. capabilities `sessionReset·agentsList·configSet` 모두 true |
| 모델 | `anthropic/claude-opus-5` + claude-cli. 우리 런 **4회** CLI 보고 비용 합 **$2.575**(런1 $0.564·런2 $0.603·런3 $0.208·런4 $1.199) + 내장 cron $0.105 |

### 7.4 런 표 (상한 4, 실제 4)

채널 `실연`(id `01a0bd25-264c…`), 멤버 `@dev`(C3-PO)·`@fin`, `allowPairs: all`, fin 자동 응답 켬.

| # | 시나리오 | 입력 | 런 id | 에이전트·트리거·depth | 소요(created→ended) | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 4 | `@dev 안녕하세요. 한 문장으로 자기소개 해줘` | `01a0bd28-49c8` | dev·mention·0 | 4.22s | done·`finalSource: plugin`. 델타 **17개**(평균 77ms)가 버블에 쌓이고 정본으로 교체, 버블 0·메시지 1 |
| 2 | 5 | `@dev fin 에게 오늘 할 일을 한 줄로 전해줘` | `01a0bd2c-7382` | dev·mention·0 | 2.96s | done. 답 「**@fin** 오늘 할 일을 한 줄로 알려주세요.」 — 일을 넘길 때만 `@` 를 쓰라는 `relayRules`(5.4-5) 대로 썼다 |
| 3 | 5 | (릴레이) | `01a0bd2c-7f13` | fin·**relay**·1 | 4.82s | done. 답 끝의 `@dev` 가 상한 1 에 막혀 `relay_limit` 시스템 카드 + 「이어가기」 — 누르지 않았다 |
| 4 | 6 시도 | `@dev 너가 하는 일과 성격을 다섯 문장으로 길게 설명해줘` (턴 상한 **0**) | `01a0bd72-1c0e` | dev·mention·0 | 12.02s | done. **창을 넓히는 데는 성공**(델타 93개·평균 78ms·스트리밍 창 **7149ms**) 했으나 중지를 누르지 못했다 — 아래 ❗ |

- 세 런 모두 `status: done`, `finalSource: plugin`, `error: null`. 승인 요청(`approval.requested`)은 한 번도 오지 않았다.
- ❗ **시나리오 6(중지)은 「실물 중지 미확인」으로 남았다. 두 번 시도했고 두 번 다 계측이 빗나갔다 — 앱 결함이 아니다.**
  - **1차(런 3)**: 중지를 누를 표본기를 페이지 `setInterval(150ms)` 로 심었는데 **배경 탭에서 ~1s 로 조여져**(7.1 ⚠) 스트리밍 창 1526ms 를 통째로 놓쳤다.
  - **2차(런 4)**: 1차의 교훈대로 탭을 앞으로 꺼내고(CDP `Page.bringToFront`) 폴링을 **브라우저 바깥**(neo `run` 런타임)에서 돌렸다 — 조임은 사라져 표본이 ~50ms 간격으로 잡혔고,
    「다섯 문장으로」가 창을 **7149ms** 로 넓혀 누를 시간도 넉넉했다. 그런데 클릭 조건에 쓴 **버블 길이 선택자(`중지` 버튼의 `closest('article')`)가 빈 값을 줘**
    게이트가 한 번도 열리지 않았고, 루프 반복 상한(140회 ≈ 6.8s)을 먼저 소진했다. 중지 버튼 자체는 전송 0.2s 뒤부터 계속 눌 수 있는 상태였다(`run.abort` 프레임 0건).
  - **다음에 볼 때는** 게이트를 단순하게 둔다: **「중지 버튼이 보이면 1.5초 뒤 누른다」** 로 충분하다(길이 재기 금지). 탭 앞으로·바깥 폴링·긴 답 요구는 2차 방식 그대로 쓴다.
  - 따라서 **중지 뒤 「중지됨」 표시와 늦은 정본**(실물 OpenClaw 는 중단 뒤에도 부분 답을 보낼 수 있다 — web-t1 이월)은 **여전히 실물에서 확인되지 않았다**.
- 정본이 온 뒤 `relay_limit` 시스템 메시지가 **+19ms** 에 붙었다. 카드 문구는 「릴레이 한도(1턴)에 도달했습니다. 계속하려면 사람이 멘션하거나 이어가기를 누르세요.」
- 우리 런 밖 모델 사용 1회: OpenClaw 내장 cron(`trigger=cron`, 세션키 `agent:fin:cron:…`)이 Gateway 기동 2분 뒤 1회. 14.3s·$0.105 — 5.4-7 이 예고한 fin 것이다.

### 7.5 지연 측정

브라우저 WS 프레임(CDP `Network.webSocketFrame*`, `data/cdp-*.jsonl`)의 시각이다. `t=0` 은 클라이언트가 `message.send` 를 emit 한 순간.

| 측정 | 런 1 | 런 2 | 런 3(릴레이) | 런 4(긴 답) |
| --- | --- | --- | --- | --- |
| ⓪ `message.send` → wire ack | 31ms | 18ms | — (사람 전송 없음) | 16ms |
| ① 서버 `inbound delivered` ackMs(플러그인이 ack 하기까지) | 177ms | 53ms | 81ms | 68ms |
| ② ack → 첫 델타(`TEXT_MESSAGE_CONTENT`) | 2565ms | 2447ms | 2984ms¹ | 4518ms |
| ③ 첫 델타 → 정본 `message.created` | 1618ms | 493ms | 1829ms | 7480ms |
| 델타 개수 · 평균 간격 · **스트리밍 창** | 17 · 77ms · **1230ms** | 4 · 69ms · **206ms** | 18 · 90ms · **1526ms** | 93 · 78ms · **7149ms** |
| 런 전체(서버 `run ended` durationMs) | 4216ms | 2964ms | 4817ms | 12015ms |

¹ 런 3 은 사람 전송이 없으므로 **런 2 의 정본 도착**을 기준으로 잰 값이다(릴레이가 다음 턴을 시작하기까지).

- ①: 플러그인 ack 는 53~177ms — 10s 타임아웃과 부딪히지 않는다(5.3 ① 과 같은 결론).
- ②: 대부분이 CLI 기동 + 모델 첫 토큰이다. **화면에서 2.5초는 견딜 만했다** — 보낸 즉시(205ms) 아바타·대기 버블·중지 버튼이 서고, 그 뒤에 글자가 흐른다.
- ③·델타 알갱이: 이번 claude-cli 는 런당 델타를 **17·4·18·93개, 평균 간격 77·69·90·78ms** 로 줬다(2026-09-15 은 런당 3~11개).
  **간격은 답 길이와 무관하게 ~78ms 로 일정하고, 개수만 길이를 따라간다.** 버블에 글자가 매끄럽게 쌓이고, 커서가 끝에 붙어 따라온다.
- ⚠ **스트리밍 창(첫 델타 → 마지막 델타)이 답 길이에 정비례한다 — 1230ms·206ms·1526ms 에 견줘 「다섯 문장으로」는 7149ms.**
  짧은 답에는 사람도 중지를 누를 틈이 거의 없고 자동 검증은 창을 통째로 놓친다. **중지를 볼 때는 반드시 길게 답하라고 시켜 창을 넓힌다**(7.4 의 ❗).
- 정본 교체는 눈에 띄는 튐 없이 끝났다(web-t13 이 고친 경로 — 교체 뒤 `scrollHeight - clientHeight - scrollTop = 0`).

### 7.6 틀린 것·고칠 것

1. **[해결·5.4-2 의 「다음 확인」] usage 값의 출처를 프레임 덤프로 갈랐다.** 모델 런을 더 쓰지 않고 `data/frames-20260920.jsonl`(24 프레임)로 확인했다.
   - **`chat` 이벤트에는 usage 가 아예 없다** — 델타·`final` 18 프레임 모두 `usage: null`. (ADR 0001 6.3 의 관찰과 같다.)
   - **`agent` `group` 이벤트에도 없다** — `data` 키는 시작 `{phase, startedAt}`, 끝 `{endedAt, executionSettled, phase, startedAt, terminalReply}` 뿐이다.
   - **`session.message`(role `assistant`) 하나만 싣는다.** 런 1 의 값:
     `message.usage = { input: 2, output: 1, totalTokens: 56194, cacheRead: 0, cacheWrite: 56191, cost: { input:0, output:0, cacheRead:0, cacheWrite:0, total:0 } }`.
     같은 턴 claude-cli `result` 는 `input 2 · output 101 · cache_creation 56191 · cache_read 0 · total_cost_usd 0.5644`.
     ⇒ **`input`·`cacheRead`·`cacheWrite`·`totalTokens` 는 맞고, `output` 은 `message_start` 스냅샷이라 틀리며(1 vs 101), `cost.*` 는 claude-cli 백엔드라 전부 0 이다.**
   - 최상위 세션 누계 `inputTokens`·`outputTokens` 는 **null** 이고 `estimatedCostUsd` 는 0 이다 — 턴 전후 차이로도 메울 수 없다.
   - **남는 결론**: 진짜 출력 토큰 수와 비용을 싣는 Gateway 프레임은 **없다**(OpenClaw 쪽 한계 — claude-cli `message_delta`·`result` 값이 Gateway 를 넘어오지 않는다).
     다만 매퍼(`packages/openclaw-adapter/src/gateway/events.ts:227-229`)는 `usage.input`·`.output`·`.cost.total` 만 옮기고 **맞는 값인 `cacheRead`·`cacheWrite`·`totalTokens` 를 버린다** —
     활동 패널이 토큰을 보여 줘야 할 때 쓸 수 있는 유일한 실수치다. 계약(`RunUsage`)에 캐시 토큰 자리를 만들지는 Phase 2 판단. 출력 토큰·비용은 OpenClaw 쪽에 올린다.
     `totalTokens` 는 스냅샷 출력으로 만든 합이라 맞지 않는다 — 필드별 판정의 정본은 `docs/adr/0005-usage-values.md`.
2. **[문서·고침] 사람 메시지의 `@fin` 은 릴레이가 아니다.** 7.2 의 ⚠ 로 올렸다. 이 절의 옛 시나리오 표는 괄호로만 경고했는데, 그대로 따라 쓰면 병렬 런 2개가 되어 3회 상한을 넘긴다.
3. **[절차·고침] 런 1 앞에서 턴 상한을 0 으로 둔다.** 옛 7.2 는 상한을 언제 바꾸는지 적지 않아, 런 1 의 답에 멘션이 섞이면 예고 없이 런이 하나 더 생긴다.
4. **[절차·더함] 검증 탭의 배경 타이머 조임.** 7.1 의 ⚠. 2026-09-20 에 중지 검증이 이것 때문에 한 번 불발했다.
5. **[절차·더함] 로그인 토큰을 전사에 남기지 않고 넣는 법**(7.1) · **neo 의 CDP 로 스크린샷·콘솔·WS 를 보는 법**(7.1). 둘 다 옛 절차에 빠져 있었다.
6. **[남음·환경] 내장 cron 이 실연에 섞인다.** 이번엔 fin 것이 Gateway 기동 2분 뒤 1회($0.105). dev 프로필에서 실연을 반복하면 매주 한 번씩 섞인다(5.4-7 에 적었다).
   같은 날 Gateway 를 다시 껐다 켰을 때는 돌지 않았다 — 주간 몫은 한 번뿐이다.
7. **[절차·더함] 중지를 볼 때의 조건은 단순하게.** 7.4 의 ❗. 버블 길이로 게이트를 걸다 두 번 놓쳤다 — **「중지 버튼이 보이면 1.5초 뒤 누른다」** 면 충분하다.
   창을 넓히는 문장(「다섯 문장으로 길게」)과 탭 앞으로·바깥 폴링을 함께 쓴다.
8. **[남음] 캐시가 식으면 런 값이 비싸진다.** 같은 채널이라도 Gateway 를 재기동하면 claude-cli 캐시가 날아가 다음 런이 `cache_creation` 을 다시 쓴다
   (런 4 는 재기동 뒤라 `cw 57863`·**$1.199** — 이어 돌린 런 3 의 $0.208 과 견주면 6배다). 실연을 쪼개 돌릴수록 비싸진다 — **한 번 띄웠을 때 볼 것을 다 본다.**

### 7.7 곁들여 본 것 (모델 런 0회)

- **연결 점·배너가 실제 어댑터 상태를 보인다.** Gateway 만 `kill` 했을 때(wire 는 살아 있음):
  점 「Gateway 다시 연결 중」(주황)·「플러그인 끊김」(빨강), 배너 「OpenClaw 에 연결되지 않아 에이전트가 답하지 못합니다. 메시지는 저장됩니다.」 — **틀린 초록이 아니다**(web-t13 결함 6 수정이 실물에서도 맞다).
  서버 쪽은 `gateway connection closed; reconnecting`(code 1012) → `bridge down` 이 +3ms. 다시 띄우니 `bridge connected` → `gateway connected`(+80ms) → 세션 2개 복구(`messages` 4·2),
  화면은 배너가 내려가고 점 둘 다 초록으로 돌아왔다(5.5 의 S6b 와 같은 경로).
- **새로고침**: 로그인 유지(쿠키), 메시지 7행 복구, `relay_limit` 카드 유지, 끝에 붙은 채로 뜬다(`gap 0`) — web-t13 fix2 경로가 실물에서도 맞다.
  **구독도 복구된다**: 새로고침 뒤에 Gateway 를 죽였더니 배너·점이 실시간으로 바뀌었다(= 새 소켓이 `channel.subscribe` 를 마치고 `adapter.status` 를 받고 있었다).
- **멘션 작성기**: `@dev` 를 치면 「멘션 후보」 listbox 가 뜨고 **Enter 가 전송이 아니라 멘션 확정**에 쓰인다(web-t9 설계대로). 확정된 것은 진짜 노드다
  (`data-type="mention" data-id="a:<uuid>"`) — 저장 본문은 `<@a:uuid>` 토큰이 된다. 목록에서는 `data-mention` 칩으로 그려진다(이번 대화에서 4개).
- **에이전트 답의 평문 `@핸들` 은 서버가 토큰으로 바꾼다**: dev 가 쓴 `@fin` 이 저장 본문에서 `<@a:01a0bd23-902d…>` 였다(`PLAIN_MENTION_RE` → `tokenize`).
  그래서 릴레이 판정과 화면 칩이 사람 멘션과 같은 길을 탄다.
- **`relay_limit` 카드는 components v1 액션 로우다**: 시스템 메시지(`authorType: "system"`)에 `components.id = cmp_…`, `reusable: false`, `ttlMs: 1800000`, 아이템 1개
  `{ type: "button", id: "continue_relay", label: "이어가기", style: "primary" }`. 누르지 않았으므로 `componentState.consumed` 는 `[]` 로 남아 있다(누르면 런이 하나 더 돈다).
- **components TTL 이 실물에서 동작한다**(런 0회로 덤으로 확인): 카드가 선 지 30분이 지나자 「이어가기」가 **스스로 비활성**이 됐다(`disabled`, opacity 0.5, `pointer-events: none`).
  근거는 서버가 주는 `componentState.expiresAt`(`04:56:49` 생성 → `05:26:49` 만료)이고, 웹은 `ActionButtons` 의 `useExpired` 가 그 시각에 맞춰 한 번 다시 그린다 — `ttlMs` 를 웹이 직접 읽지는 않는다.
  **릴레이 정책과는 무관하다**(상한을 0↔1 로 되돌려도 비활성 그대로였다). 즉 「이어가기」는 **30분 안에 눌러야 한다.**
- **서술 속 멘션**(5.4-5): dev 도 fin 도 **일을 넘길 때만** `@` 를 썼다(dev → `@fin`, fin → `@dev`). 뜻 없는 멘션으로 런이 헛돌지 않았다 — 고친 `relayRules` 문구가 실물에서 먹는다.
- **콘솔·네트워크**: 런 1 구간·런 2·3 구간 모두 **JS 예외 0·`console.error` 0·4xx/5xx 0**. 나온 것은 Vite HMR `connecting/connected` 와 React DevTools 안내뿐이다.
- **작성기 한글 IME**(조합 중 Enter 가 전송하지 않는지)는 **확인하지 못했다.** CDP·자동화는 실제 IME 조합 이벤트를 만들지 못한다 — 사람이 두벌식으로 「안녕」을 치다가
  조합 중 Enter 를 눌러 확정만 되는지 한 번 봐야 한다.
- **채널 프롬프트·「새 대화」의 반영**은 모델 런이 더 필요해 이번 3회 예산에서 뺐다(ADR 0003 의 결론은 2026-09-15 실연에서 이미 확인했다 — 5.5).

### 7.8 정리·잔여물

3절 (f)에 웹 것을 더한다: Vite(5173) 종료, 열었던 탭·브라우저 정리, `data/` 의 실연 파일(`live-smoke.env`·`*.sqlite`·로그·프레임 덤프·`cdp-*.jsonl`)은 `data/` 안에 두거나 지운다 — 커밋하지 않는다.
⚠ 포트로 죽일 때는 `lsof -nP -iTCP:<포트> -sTCP:LISTEN -t` 로 **LISTEN 만** 고른다(그냥 `lsof -ti:3000` 은 그 포트에 붙은 Vite 까지 죽인다).

- `~/.openclaw-dev`: `extensions/dodok` 가 새 번들(`4b0ecc34…`)로 바뀜 · `openclaw.json` 백업 회전 · `state/openclaw.sqlite` ·
  `agents/{dev,fin}/agent/openclaw-agent.sqlite`(채널 세션 `agent:{dev,fin}:dodok:channel:01a0bd25-264c-71cb-a023-83a28648671f` 전사) · 내장 cron `fin` 실행 기록.
  끝에 `channels.dodok.channels` 는 해제했고 계정 `default` 는 그대로다.
- 워크트리 `data/`(ignored): 서버 로그·Gateway 로그·Vite 로그 · `frames-20260920.jsonl`(본문 포함) · `cdp-{run1,run23,run4,gwdown}.jsonl`(본문 포함) · `live-smoke.env`(시크릿) ·
  `live-smoke.sqlite` · `openclaw-device-dev.json` · `wire-cli-session.json`. **로그·덤프 8개 모두 토큰 값 0회**(`grep -c -F` 로 4종 확인).
- 중지 재시도 때 Gateway·서버·Vite 를 한 번 더 껐다 켰다. **DB(`live-smoke.sqlite`)와 `live-smoke.env` 를 그대로 두면 채널·에이전트·대화·로그인이 살아 있어** 준비 단계를 건너뛸 수 있다(약 1분).
  대신 claude-cli 캐시가 식어 다음 런이 비싸진다(7.6-8).
