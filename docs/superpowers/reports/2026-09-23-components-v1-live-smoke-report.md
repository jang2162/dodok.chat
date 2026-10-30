# components v1(Phase 2 ②) 실물 확인 — 2026-09-23 결과

> components v1(Phase 2 ②)을 실제 모델로 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-21-components-v1.md` 태스크 11, 스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


**상태(2026-09-23)**: 실제 dev Gateway·실제 플러그인 번들·실제 모델로 components 를 돌렸다. 모델 런은 사용자 승인 상한 그대로 **3회**.
**모델은 v1 스키마에 맞는 카드를 처음부터 만들어 냈고(10.3), 카드를 눌러 제출한 값을 다음 런이 읽고 일을 이어갔다(런 3 — Phase 2 완료 기준 통과).
그러나 모델 런 안에서 부른 `message` 툴 전송이 실물에서 매번 실패해, 에이전트는 스스로는 카드를 채널에 올리지 못했다(10.4 결함 1).**
런 3 은 모델이 만든 components 를 **운영자 `tools.invoke` 로 대신 보내** 올린 카드로 돌렸다(모델 런 0회, 10.2 (d)).
로그는 `data/phase2-live-20260923.log`(서버)·`data/dev-gateway.log`(Gateway·플러그인·claude-cli)·`data/wire-watch-20260923.log`(wire-cli `watch`). 커밋하지 않는다.

### 10.1 환경 실물

| 항목 | 값 |
| --- | --- |
| Gateway | OpenClaw **`2026.9.5 (f396007)`**(앱 자동 업데이트 — 저장소 핀·스파이크는 `2026.9.4`), 번들 Node 24.19.0, `:19001` loopback, token 인증. 기동 → `http server listening` 약 3s(플러그인 14개) |
| 플러그인 | `pack:plugin` 번들 sha256 `9520de1f…` = 설치본과 일치(이전 설치본 `4b0ecc34…`), `status: "loaded"`, `trust.reason: "provenance-invalid"` |
| 서버 | `:19100`, `OPENCLAW_TARGET=dev`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug`, 프레임 덤프 켬. 브리지 `ready` 는 서버 listen 뒤 약 8s(백오프 6번째 시도) |
| 웹 | Vite 8.3.0, **`:5180`**(아래), `DODOK_API_ORIGIN=http://127.0.0.1:19100`, 브라우저 BrowserOS neo |
| 모델 | `anthropic/claude-opus-5` + claude-cli, thinking high. 우리 런 3회 CLI 보고 비용 **$0.650·$1.239·$1.434**(합 $3.32) + 내장 cron $0.193 |
| 내장 cron | `cron list`: `skill-collection-review-dev` 다음 실행 **2026-09-23 09:47:31 KST**(Gateway 기동 2분 뒤 — 예정대로 1회 돌았다, 5 턴·$0.193), `…-fin` 다음 2026-09-27 13:44 KST |

**웹을 5180 으로 띄운 까닭**: 5173 은 같은 머신의 다른 프로젝트 Vite 가 쓰고 있었다(`strictPort` 라 겹치면 안 뜬다). 포트를 바꿀 때는 `APP_ORIGIN`·브라우저 주소·`--port` 셋을 같이 바꾼다.

### 10.2 절차 — 3절·7.1 에 더할 것

(a) 3절 (a)~(e) 를 그대로 하되 `data/live-smoke.env` 의 `APP_ORIGIN` 을 웹 포트와 맞춘다(`http://localhost:5180`). 프레임 덤프(`OPENCLAW_FRAME_DUMP_PATH`)도 켠다(7.1).

(b) 웹: `DODOK_API_ORIGIN=http://127.0.0.1:19100 pnpm -F @dodok/web dev --port 5180` — pnpm 11 은 스크립트 뒤 인자를 그대로 `vite` 에 넘긴다(`$ vite --port 5180`). 브라우저는 `http://localhost:5180`. 로그인은 7.1 의 `/@fs` 방법.

(c) 준비(런 0회): `/settings/agents` → 「에이전트 가져오기」 → `dev` 만 등록(`fin` 은 릴레이로 런을 더 쓴다) → 채널 만들기 → 설정 「멤버」에서 `@dev — C3-PO` 추가.
런 중 wire 이벤트는 `pnpm -s wire-cli http://127.0.0.1:19100 watch <채널 id> --watch-ms 3600000 > data/wire-watch-<날짜>.log` 을 백그라운드로 두면 시각표가 한 파일에 남는다.

(d) **모델 없이 `message` 툴을 두드리는 법**(10.4 결함 1 을 가를 때, 그리고 모델이 만든 카드를 올릴 때). 토큰은 env 로만, `--url` 대신 `--port`:

```bash
ARGS='{"action":"send","target":"channel:<채널 id>","message":"…","components":{…}}'   # 모델이 낸 인자는 run_events 의 TOOL_CALL_ARGS 에 그대로 있다
PARAMS=$(jq -cn --argjson a "$ARGS" --arg sk "agent:dev:dodok:channel:<채널 id>" '{name:"message", args:$a, sessionKey:$sk, agentId:"dev", idempotencyKey:"probe-1"}')
( env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$(cat data/dev-gateway.token)" PATH="$OCBIN:$PATH" \
    openclaw --dev gateway call tools.invoke --port 19001 --json --params "$PARAMS" )
# {"ok":true,"toolName":"message","output":{…"sent to dodok channel … (<messageId>)"…},"source":"core"}
```

⚠ 이렇게 올린 카드는 **그 세션의 모델이 모른다** — 모델의 전사에는 툴이 실패한 기록만 있다. 런 3 의 모델은 「툴은 두 번 다 에러였는데 카드는 도착했네요」라고 잘못 결론지었다. 다음 런의 답을 읽을 때 감안한다.

(e) **모달의 date 칸**: 자동화 도구의 키 입력(`type`·`press`)으로는 세그먼트가 채워지지 않았다(값 `""`). 네이티브 setter 로 넣고 `input`·`change` 를 쏘면 된다
(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(d,'2026-09-30')` → `validity.badInput=false`). 사람이 칠 때의 롤오버는 여전히 사람 몫(이월 그대로).

(f) 정리는 3절 (f) + 7.8. 이번에도 `channels.dodok.channels` 는 `Config path not found`(서버가 채널 설정을 쓰지 않았다 — 깨끗함). 승인 정책은 켜지 않았다(`agents.entries.dev.tools.exec.ask` unset 그대로).
**시크릿 개수 확인은 로그만이 아니라 `data/*.sqlite`·`data/frames-*.jsonl` 까지**(2절 ⚠).

### 10.3 런 표 (상한 3, 실제 3)

채널 `컴포넌트실연`(id `01a0cbbb-d86f…`), 멤버 `@dev`(C3-PO) 하나, 턴 상한 기본 4(에이전트가 하나라 릴레이 없음).

| # | 입력 | 런 id | 모델이 한 것 | 소요 | 결과 |
| --- | --- | --- | --- | --- | --- |
| 1 | `@dev 보고서 형식을 고르게 셀렉트 하나로 물어봐 줘. 선택지는 PDF·마크다운·HTML.` (브리프 문구 그대로) | `01a0cbbd-0fd9` | **`message` 가 아니라 OpenClaw 내장 `mcp__openclaw__ask_user`** 를 골랐다 — `questions:[{id:"report_format", header:"보고서 형식", options:[마크다운 (Recommended)·PDF·HTML, 각 description]}]`. 전달이 `ask_user prompt delivery failed \| dodok: bridge is not running` 으로 실패하자 평문으로 되물었다 | 13.3s | done·plugin. **카드 0** (결함 1·2) |
| 2 | `@dev message 툴의 components 로 카드 하나만 보내 줘. 보고서 형식을 고르는 셀렉트(PDF·마크다운·HTML)와, 새 작업을 받는 모달(제목 필수·설명·기한)을 함께. ask_user 는 쓰지 마.` | `01a0cbbf-6816` | `mcp__openclaw__message` 에 **v1 에 맞는 components** 를 실어 2번 보냈다(아래). 둘 다 플러그인 검증 통과(`tool-send … hasComponents:true, ok:true`) 뒤 `dodok: account "default" bridge is not running` 으로 실패. 사이에 Bash 6번으로 원인을 찾았다(`openclaw status`·`lsof :19100`·`~/.openclaw-dev` 탐색) | 85.0s | done·plugin. 「카드는 만들었는데 전송이 막혔습니다」 + 카드 내용을 글로 설명. **카드 0** (결함 1) |
| — | (모델 런 아님) 런 2 의 첫 components 를 10.2 (d) 로 전송 | — | — | 서버 `message.created` 는 플러그인 `tool-send` 뒤 약 7ms | 카드가 `@dev` 이름으로 채널에 섰다 — `components.id = cmp_01a0cbc3-8f8d…`, 셀렉트·모달 둘 다 |
| 3 | 위 카드의 **모달 「새 작업 등록」 제출** — 제목 「9월 배포 회고 보고서」, 설명 「9월 배포 3건의 장애·롤백을 정리하고 재발 방지책을 제안해 주세요. 분량은 A4 두 장 이내.」, 기한 2026-09-30 | `01a0cbc5-2ea2` | 받은 입력: `[dodok interaction] user=@owner kind=modal component=cmp_01a0cbc3-… item=new_task` + 「@owner 님이 "새 작업 등록" 양식을 제출했습니다.」 + `- 제목: …`·`- 설명: …`·`- 기한: 2026-09-30`. 첫 툴이 `memory_search {"query":"9월 배포 장애 롤백 인시던트 기록"}` | 24.4s | done·plugin. **통과** — 답이 세 값을 그대로 옮기고(「기한: 2026-09-30 (오늘 기준 7일)」) **같은 카드의 형식 셀렉트가 아직 미선택**임을 짚어 고르라고 한 뒤, 재료 출처를 물었다 |

**모델이 낸 components(런 2, 두 번 모두 같은 구조 — 섹션 문구만 조금 다름)**:
`blocks = [section("**보고서 형식을 골라 주세요.** …"), actions{id:"format_row", items:[select{id:"report_format", placeholder:"보고서 형식 선택", options:[markdown·pdf·html, 각 label·description]}]}, separator, section("**새 작업을 넘기실 것이 있나요?** 아래 버튼으로 …")]`,
`modal = {id:"new_task", title:"새 작업 등록", triggerLabel:"새 작업 등록", fields:[text{id:"title", required:true, placeholder}, textarea{id:"description", required:false}, date{id:"due_date", required:false}]}`, `ttlMs: 1800000`.
- **스키마 위반 0**: `id` 모두 유일·패턴 맞음 · 셀렉트는 **자기 액션 로우에 혼자**(버튼 ≤5 **또는** 셀렉트 1 을 지켰다) · 옵션 3(≤25) · 필드 3(≤5) · 모달 트리거를 **따로 버튼으로 만들지 않고 `triggerLabel` 로** 썼다(설계 그대로).
  `components: v1 스키마 위반 — …` 문구는 한 번도 나오지 않아 **그 문구가 모델에게 쓸모 있는지는 이번에도 못 쟀다**.
- 요청하지 않은 것도 알맞게 채웠다: 옵션 `description`, 모달 칸 `placeholder`, `message` 에 카드 제목(→ 서버 본문·알림 대체 텍스트 자리).
- 스크린샷 `…/screens/t11-1-card-from-model-components.png`(카드: 셀렉트는 옵션 6개 이하라 라디오 목록 + 「보내기」 비활성·「하나를 고르세요」, 모달 트리거), `t11-2-modal-filled.png`, `t11-3-result-line.png`(원장 폴더, git 제외).

### 10.4 틀린 것·고칠 것

1. **[결함·높음] 모델 런 안의 `message` 툴 전송이 실패한다 — `dodok: account "default" bridge is not running`.** 브리지는 `connected`(어댑터 상태·웹 점 초록), 정본 답(`deliver`)도 같은 브리지로 정상 도착했다.
   → **원인 확정·고침·실물 확인 완료(2026-09-23, 12절)**: 9.5 가 번들을 같은 realm 에서 두 번 평가하고 모델 런의 `handleAction` 이 `startAccount` 를 돌지 않은 두 번째 인스턴스로 간다(c2-t14, 모델 런 0회). 브리지·상관관계를 전역 레지스트리로 옮겼다 — ADR 0004. 실물 확인은 11절 하네스(아래 추정은 기록으로 남긴다).
   - **재현**: 3절대로 띄우고 채널에 `@dev message 툴의 components 로 카드 하나만 보내 줘 …`(런 2). Gateway 로그에 `dodok:tool-send {"action":"send","accountId":"default",…,"hasComponents":true,"ok":true}` 가 찍히고
     wire 에 `TOOL_CALL_RESULT {"content":"dodok: account \"default\" bridge is not running","ok":false}` 가 온다. 로그 줄은 `packages/openclaw-plugin/src/channel.ts` 의 `handleAction` — `bridges.get(accountId)` 가 `undefined`.
   - **가른 것**: 같은 인자를 운영자 `tools.invoke`(10.2 (d))로 보내면 **같은 `handleAction` 이 브리지를 찾고 성공한다**. 즉 실패는 **claude-cli → MCP 루프백으로 들어온 툴 호출에서만** 난다.
   - **추정 원인(확정 아님)**: 그 경로가 받는 채널 플러그인 객체가 브리지를 띄운(`startAccount`) 인스턴스와 다르다 — `bridges` 는 모듈 스코프 `Map` 이라 모듈이 두 번 평가되면 빈 쪽을 본다.
     (로그 머리가 `[dodok] …` 와 `dodok:tool-send` 로 다른 것은 증거가 아니다 — 앞은 런타임 `logger`, 뒤는 `console.info` 를 쓰는 코드 차이다.) 스파이크(ADR 0002 5.2, **2026.9.4**)에서는 모델 런(B1)의 같은 경로가 됐으므로
     **2026.9.5 로 바뀐 앱이 원인일 공산이 크다**(버전 드리프트 — 불변 규칙의 정확 핀이 dev 환경에서 깨져 있었다). 고치는 길은 둘: 브리지 레지스트리를 `globalThis[Symbol.for("dodok.bridges")]` 처럼 인스턴스를 넘어 공유하거나, dev Gateway 를 `2026.9.4` 로 맞춰 먼저 재현을 가른다.
   - **영향**: 실물에서 **에이전트가 카드를 스스로 보낼 수 없다** — components v1 전체가 dev 실물에서 쓸 수 없는 상태다. 가짜 Gateway·통합 시나리오는 플러그인을 한 인스턴스로 불러 이 경로를 못 본다.
2. **[결함·중간] `ask_user` 가 dodok 채널에서 깨진다.** 코어 `ask_user` 는 질문을 채널 `outbound.sendText` 로 보내는데(`ask-user-tool-*.mjs` → `sendDurableMessageBatchCore`), 우리 `sendText` 도 `bridges.get(…)` 이 비어
   `dodok: bridge is not running` 을 던진다(결함 1 과 같은 뿌리로 보인다). 설령 브리지를 찾아도 `sendText` 는 **텍스트만** 보내고 `agentId: "unknown"` 이라 질문의 **선택지 컨트롤이 없다** — dodok 은 `ask_user` 를 카드로 그릴 길이 없다.
   → 이어서 볼 곳: 첫 층(`sendText` 도 두 번째 인스턴스) → ADR 0004, 뒷 두 층(`agent not found`·선택지 컨트롤 없음) → `docs/guides/plan.md` 8장 「플러그인·OpenClaw 버전」.
3. **[관찰·중요] 모델은 `components` 보다 `ask_user` 를 먼저 고른다(발견 가능성).** 「셀렉트로 물어봐 줘」처럼 자연스러운 요청에 모델은 `message` 툴의 components 가 아니라 `ask_user` 를 불렀다(런 1).
   `components` 는 `message` 툴 스키마의 한 속성일 뿐이라 「사용자에게 묻는다」는 의도에 먼저 걸리는 쪽은 이름부터 그 일인 `ask_user` 다. 결함 1·2 를 고쳐도 **우리 카드가 실무에서 잘 안 쓰일 수 있다**.
   손댈 곳: `components-schema.ts` 의 `COMPONENTS_DESCRIPTION`(「사용자에게 선택·입력을 받을 때는 이것을 쓴다」를 앞에), 채널 프롬프트, 또는 `ask_user` 를 dodok 이 카드로 받아 그리는 길(결함 2) — 어느 쪽으로 갈지는 판단이 필요하다.
4. **[관찰] 막히면 모델이 자기 환경을 뒤진다.** 런 2 에서 모델은 전송 실패 뒤 Bash 6번으로 `openclaw status`·`lsof`·`~/.openclaw-dev` 설정 파일을 살폈고, 그 결과(`BRIDGE_TOKEN` 값 1회 포함)가 런 이벤트로 저장·표시됐다(2절 ⚠, 10.6).
   그리고 끝에 `dodok.capabilities.inlineButtons` 를 켜야 한다는 **확인되지 않은 처방**을 사용자에게 내놓았다(우리 플러그인에는 그런 설정이 없다).
5. **[관찰·경미] 운영자가 보낸 카드가 앞 런에 붙는다.** 10.2 (d) 로 보낸 카드 메시지의 `runId`·`replyTo` 가 **이미 끝난 런 2** 와 그 사람 메시지로 채워졌다 — 플러그인 상관(세션키당 마지막 인바운드)이 운영자 전송에도 붙는다. 실사용 경로는 아니다.
6. **[관찰·경미] `component_interactions.delivered_at` 이 늘 null 이다.** 제출이 다음 런으로 잘 넘어갔는데도 비어 있다 — 스키마(`schema.sqlite.ts:231`)에만 있고 쓰는 코드가 없다. 쓸지 지울지는 뒤에 정한다.

### 10.5 곁들여 본 것 (모델 런 0회)

- **셀렉트 「보내기」 확정식**은 실물 카드에서도 그대로다 — 고르기 전 「보내기」 비활성 + 「하나를 고르세요」. 런이 모자라 셀렉트 제출은 하지 않았다(런 3 을 모달에 썼다).
- **모달**: 트리거 → 대화상자 「새 작업 등록」, 제목(필수 표시)·설명(textarea)·기한(date, 한국어 로캘 세그먼트) — 모델이 준 칸 셋 그대로. 제출 뒤 대화상자가 닫히고 트리거가 「이미 처리되었습니다」로 비활성.
- **결과 줄**: 카드 안에 「@owner — 새 작업 등록: 제목: … · 설명: … · 기한: 2026-09-30」. **새로고침 뒤에도 남는다**(결과 줄·「이미 처리되었습니다」 둘 다).
- **콘솔**: 런 1~3 과 새로고침 구간에서 **앱 예외 0**(`error`·`unhandledrejection`·`console.error` 가로채기).
- **지연**(wire-cli `watch` 시각):

| 측정 | 런 1 | 런 2 | 런 3 |
| --- | --- | --- | --- |
| 사람 메시지(또는 제출) 서버 수신 → `RUN_STARTED` | 571ms(ackMs 547 — 새 세션 구독 포함) | 129ms(ackMs 125) | 72ms(ackMs 67) |
| `RUN_STARTED` → 첫 툴 호출 | 6.0s(`ask_user`) | 12.6s(`message`) | 8.9s(`memory_search`) |
| `RUN_STARTED` → 정본 `message.created` | 12.8s | 84.9s(툴 8회) | 24.3s(툴 2회) |
| 제출 서버 수신 → 카드 `message.updated`(consumed) | — | — | 3ms |

  `tools.invoke` 로 보낸 카드: 플러그인 `tool-send` → 서버 `message.created` 약 7ms. **모달 제출 클릭 → 서버 수신은 재지 못했다** — 자동화 도구의 클릭이 정착 대기로 몇 초 늦게 실제로 눌려, 도구 쪽 시각이 믿을 수 없었다.

### 10.6 정리·잔여물

- 서버·Gateway(`shutdown completed cleanly`)·Vite(5180)·wire-cli `watch` 를 내렸다. 5173 의 다른 프로젝트 Vite 는 건드리지 않았다. 브라우저 탭은 닫았다.
- `~/.openclaw-dev`: `extensions/dodok` 새 번들(`9520de1f…`) · `openclaw.json` 백업 회전 · `state/openclaw.sqlite` · `agents/dev/agent/openclaw-agent.sqlite`(채널 세션 `agent:dev:dodok:channel:01a0cbbb-d86f-7162-8d82-5bb4c06b238c` 전사) ·
  내장 cron `dev` 실행 기록. `channels.dodok.channels` 는 없음(원래 없었다), 계정 `default`·승인 정책 그대로.
- ⚠ **`BRIDGE_TOKEN` 값이 새어 들어간 곳**(런 2 에서 모델이 Bash 로 읽음): 서버 DB `run_events` 1행 → **가렸다**(`[REDACTED-BRIDGE-TOKEN]`, WAL 체크포인트·VACUUM 뒤 0회) · 프레임 덤프 → **지웠다** ·
  claude-cli 전사 `~/.claude/projects/-Users-jang2162--openclaw-dev-workspace/<세션>.jsonl` 1회 → **남아 있다**(모델 제공자에게도 이미 갔다). 로컬 루프백 브리지 토큰이지만 **교체를 권한다**(`.env` 와 dev 계정 토큰을 함께 — 3절 (e) 의 패치 파일 방법).
- 워크트리 `data/`(ignored): 서버·Gateway·Vite·wire 로그, `live-smoke.env`(시크릿), `live-smoke.sqlite`(가림), `openclaw-device-dev.json`, `wire-cli-session.json`, `cron-list.json`, `run2-message-args.jsonl`(모델이 낸 `message` 인자). **Gateway 토큰은 전부 0회, `BRIDGE_TOKEN` 은 가린 뒤 0회**.
