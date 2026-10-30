# 첨부(Phase 2 ③) 실물 확인 — 2026-09-23 결과 (a3-t11, 모델 런 2회)

> 첨부(Phase 2 ③)를 런 0회 하네스와 실제 모델로 돌린 실연과 결함 A 고침 확인의 기록 — 계획 `docs/superpowers/plans/2026-09-23-attachments.md` 태스크 11·13, 스펙 `docs/superpowers/specs/2026-09-23-attachments-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


11.5 하네스(처음 돌림 — 고친 것은 11.5 ⑤)로 첨부 경로를 모델 없이 두드린 뒤, 사용자 승인 상한(**모델 런 2회**, 웹 5180) 그대로 실제 모델로 두 번 돌렸다.

**판정: 첨부 경로는 실물에서 돈다 — 합격 기준 9/9, 모델 런 ①② 통과. 새 결함 1(중간): 최종 응답의 `MEDIA:` 줄이 스트리밍 델타로 흘러 호스트 경로가 버블·`run_events` 에 남는다(13.4 A).**
→ 결함 A 는 서버에서 고쳤고(a3-t12, `635fe76`) 실물 Gateway 에서 모델 런 0회로 확인했다 — **13.7**.
로그는 워크트리 `data/`(ignored): `dev-gateway.log`(Gateway·플러그인·claude-cli)·`phase2-live-20260923.log`(서버)·`frames-20260923.jsonl`(프레임 덤프)·`h2~h6-send.log`·`wire-watch-run1.log`·`wire-watch-run2.log`. 커밋하지 않는다.

### 13.1 환경 실물

| 항목 | 값 |
| --- | --- |
| Gateway | `OpenClaw 2026.9.5 (f396007)` — 12절과 같다. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-f39600759bec-2026-09-19T05-09-16.000Z"`, scopes 에 `operator.admin` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`(같은 줄 `pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수) |
| 플러그인 번들 | 설치 전 `0b53c75b…`(ADR 0004 고침, 첨부 이전) → `pack:plugin` 빌드본 `f5dc6438fbaf8b5c…` → **Gateway 를 내린 채로** 설치 → 설치본 `f5dc6438…` = 빌드본. `status: "loaded"`. main `b0b1b65` 의 깨끗한 트리에서 빌드했고 probe 는 쓰지 않았다 — **끝난 뒤에도 이 번들이 설치돼 있다** |
| 서버 | `:19100`, `APP_ORIGIN=http://localhost:5180`, DB `data/live-smoke.sqlite`, 프레임 덤프 켬, `LOG_LEVEL=debug` |
| 웹 | Vite 8.3.0 `:5180`(5173 은 다른 프로젝트 — 무접촉), 브라우저 BrowserOS neo |
| 채널 | 하네스 `harness-a3t11`(`01a0cda5-fd39…`, 멤버 `@dev`·`@fin`) · 모델 런 ① `model-a3t11-img`(`01a0cdae-f9de…`) · ② `model-a3t11-file`(`01a0cdae-fb86…`) — 런마다 새 채널(가짜 claude 세션 id 와 섞지 않게) |
| 시험 파일 | `word.png` 900×300 흰 바탕 검은 굵은 글씨 **`PLUMCOMET`**(10,619B) · `chart.png`(971B) · `photo.jpg`(92,415B) · `월간 보고서.pdf`(10,416B) · `big.png` 1700×1700 무작위 픽셀(8,683,839B) — PIL 로 만듦 |
| 모델 | `anthropic/claude-opus-5` + claude-cli. CLI 보고 비용 ① **$0.6055**(새 세션 캐시 생성 60k) · ② **$0.2975**. 내장 cron 은 이번에 돌지 않았다(다음 실행 dev 09-30·fin 09-27) |

### 13.2 합격 기준 (런 0회 — 가짜 claude CLI, 11.5)

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 새 번들 설치 | **통과** | 위 표. 설치 전 `0b53c75b…` ≠ 설치 후 `f5dc6438…` = 빌드본 |
| 2 | 인바운드 — `@<ws>/.openclaw-cli-images/<sha>.<ext>`, 크기·magic 이 원본과 같다. 이미지 아닌 첨부는 `[첨부 파일: …]` | **통과** | 웹 작성기로 3장(`word.png`·`chart.png`·`photo.jpg`) + `@dev` → `stdin-record` `contentKind:"string"`, `blocks:[]`, `atRefs` 3개가 **올린 순서대로** 크기 10619·971·92415, magic `89504e47…`·`89504e47…`·`ffd8ffe0…`, **sha256 앞 16자가 원본과 셋 다 같다**, 모두 `.openclaw-cli-images/` 안 0600. `[dodok] inbound-media` `images:3`·`reasons:[]`. PDF 는 릴레이(6)로 `notes:["[첨부 파일: 월간 보고서.pdf]"]` |
| 3 | 툴 `media` — PNG·PDF·한국어 공백 이름, 이름 그대로, 바이트 = 원본, components `artifact://<공백 든 이름>` 이 풀린다 | **통과** | 한 런에서 호출 셋. ① `mediaUrls:[chart.png, 월간 보고서.pdf]` + components(`media` → `artifact://chart.png`, `file`·링크 버튼 → `artifact://월간 보고서.pdf`) → `sent to dodok channel …`, `dodok:tool-send-media {"uploaded":2,"failed":0}`. 메시지 첨부가 그 순서로 `chart.png`(image/png 971)·`월간 보고서.pdf`(application/pdf 10416), REST 로 내려받은 sha 가 원본과 같다(`7ba5f6bd…`·`e1011056…`), `content-disposition` `filename*=UTF-8''%EC%9B%94%EA%B0%84%20…`. 저장된 components 의 url 은 `artifact://월간%20보고서.pdf`(Ruling 4). 웹에서 `media` 블록 `<img src=/api/v1/attachments/<chart id>>`, `file` 블록 「내려받기」·링크 버튼 「보고서 열기」가 **둘 다 PDF 첨부 id** 로 풀렸고 「첨부를 찾을 수 없습니다」·「열 수 없는 링크」는 0(Ruling 5). 카드가 가리킨 첨부는 격자에 다시 나오지 않았다 |
| 4 | 최종 응답 `MEDIA:` 줄 — 첨부로 오고 본문에 `MEDIA:` 없음. **`gateway_final` 스냅샷에 `MEDIA:` 가 남는가**. `finalSource` | **통과 · 전제 확인** | `fake-final.txt` = `결과\n\nMEDIA:<ws>/a3-harness/chart.png` → 메시지 본문 `결과` + 첨부 `chart.png` 1, `[dodok] deliver-media {"uploaded":1,"failed":0}`, `finalSource=plugin`, `gateway snapshot media lines dropped` 0회. **프레임 덤프의 `chat` `state:"final"` 의 `message.content[0].text` 가 `"결과\n\nMEDIA:/Users/…/a3-harness/chart.png"` — 실제 Gateway 스냅샷에 `MEDIA:` 줄이 남는다**(모델 런 ② 도 같다). 정본은 final 뒤 31ms 에 왔다 |
| 5 | 미디어만 있는 응답 — 첨부만, 호스트 경로 0 | **통과**(메시지) · 결함 A 는 별도 | `fake-final.txt` = `MEDIA:<경로>` 한 줄 → `[dodok] deliver {"textLength":0,…,"media":1}` → 메시지 `body=""` + 첨부 `chart.png`. 채널 메시지 전체(REST JSON)에 `/Users/`·`MEDIA:`·`openclaw-dev` **0건**, 웹 `main` 텍스트에도 0 |
| 6 | 플러그인 배선 잠금 셋(a3-t5 M2) | **통과** | ⓐ `shouldDeliverFinal`: 5 로 확인. ⓑ `saveMediaBuffer` 의 `maxBytes`: 릴레이로 **8,683,839B PNG** 가 인바운드됐다(기본 5 MB 였다면 `SaveMediaSourceError` → `[이미지를 불러오지 못했습니다]`) — `inbound-media {"images":1,"notes":1,"reasons":[]}`, CLI 에는 **Gateway 가 재압축한 JPEG 1,848,277B**(`ffd8ffc0…`, 스파이크 1-12 와 같은 동작). 서버에 저장된 `big.png` 는 원본 그대로(8,683,839B). ⓒ `handleAction` 의 `mediaAccess`: `media:"a3-harness/chart.png"`(**워크스페이스 상대 경로**) → `uploaded:1`, 첨부 sha = 원본 |
| 7 | Ruling 1 — ack 시간, 같은 deliveryId 재전송 없음 | **통과(루프백 한정)** | 어댑터 `inbound delivered` `ackMs`: 이미지 3장 **117ms**, 8.7 MB 릴레이 **175ms**, 첨부 없는 런 36~242ms, 새 세션 첫 런 873ms. `retries:0` 전부, `inbound.deliver ack timeout` 0회, 플러그인 `[dodok] ingress` 의 `deliveryId` 중복 0. **느린 링크(장당 30초 근처)는 재지 못했다** — 루프백이라 10초 기본값에도 한참 못 미친다 |
| 8 | 실패 문구 — 고정 문구, 경로 없음 | **통과** | `mediaUrls:[chart.png, "<ws>/a3-harness/없는 파일.pdf"]` → 툴 결과 `{"content":[{"type":"text","text":"dodok: 첨부를 보내지 못했습니다 — 없는 파일.pdf: 파일을 찾을 수 없음"}],"isError":true}`, 로그 `dodok:tool-send-media {"uploaded":1,"failed":1,"details":["file not found"]}` — 경로 0. 먼저 올라간 `chart.png` 는 미묶음 행으로 남았다(설계대로 — 24시간 정리) |
| 9 | 버전 로그 | **통과** | 13.1 — 12절과 같은 `2026.9.5`·같은 buildId |

### 13.3 모델 런 (상한 2, 실제 2)

| # | 채널 | 입력 | 런 id | 모델이 한 것 | 소요 | 결과 |
| --- | --- | --- | --- | --- | --- | --- |
| ① | `model-a3t11-img` | 웹 작성기로 `word.png` + `@dev 이 이미지에 쓰인 단어가 뭐야?` | `01a0cdaf-cf69` | **툴 호출 0** — CLI 가 `@경로` 를 네이티브 첨부로 읽었다 | `RUN_STARTED` → 첫 델타 3.4s → 정본 4.8s(ack 873ms, 새 세션) | **통과** — `PLUMCOMET 입니다. 흰 배경에 굵은 산세리프 대문자로 딱 한 단어만 쓰여 있네요.` |
| ② | `model-a3t11-file` | `@dev 작은 텍스트 파일을 만들어 이 채널에 첨부로 보내 줘.` | `01a0cdb0-8736` | `Write{file_path:"<ws>/hello-c3po.txt"}` → **최종 응답 끝에 `MEDIA:<ws>/hello-c3po.txt` 줄**(스파이크 런 2 는 `message` 툴을 골랐다 — 이번엔 다른 입구를 탔다) | 첫 툴 5.6s → 정본 8.8s(ack 89ms) | **통과** — 본문 「@owner 파일 생성 완료입니다! `hello-c3po.txt`, … 첨부로 함께 보냅니다 …」 + 파일 카드 `hello-c3po.txt`(269 B, 텍스트). `deliver-media {"uploaded":1}`, `finalSource=plugin`, 본문·첨부 이름에 경로 0. 웹 카드 「내려받기」로 받은 바이트 sha = 워크스페이스 원본(`2809c2fe…`), `content-disposition: attachment` |

- 두 런 모두 `RUN_FINISHED usage` 가 `inputTokens:2, outputTokens:1|4, costUsd:0` 이다(CLI 는 $0.61·$0.30 을 보고) — 5.4 이월(usage 값)과 같은 줄기로 보인다. 이번엔 파지 않았다.
- **두 입구가 모두 실물 모델 런에서 돌았다**: 툴 `media`(스파이크 런 2)와 최종 응답 `MEDIA:` 줄(이번 런 ②). 런 ② 의 실제 `gateway_final` 스냅샷도 `…\n\nMEDIA:/Users/…/hello-c3po.txt` 였고 정본이 45ms 뒤에 와서 폴백·연장은 쓰이지 않았다.
- 웹(5180): ① 이미지 칩 → 보내기 → 메시지 격자에 `word.png`, ② 파일 카드 표시·내려받기를 눈으로 봤다. 탭은 닫았다.

### 13.4 틀린 것·고칠 것

**A. [결함·중간] 최종 응답의 `MEDIA:` 줄이 스트리밍 델타로 흘러, 호스트 경로가 채널 버블에 잠깐 보이고 `run_events` 에 영구히 남는다.**
- **재현**: 모델 런 ②. `run_events`(런 `01a0cdb0-8736…`) seq 26~28 의 `TEXT_MESSAGE_CONTENT` delta 가 `MEDIA:/Users/<사용자>` · `/.openclaw-d` · `ev/workspace/hello-c3po.txt`(09:55:01.715~.867), 정본 `message.created` 는 09:55:02.27 — **약 0.5초** 동안 채널을 보는 모든 사람의 스트리밍 버블에 호스트 경로가 그려진다. 하네스 c·d 에서도 wire `TEXT_MESSAGE_CONTENT` 에 `MEDIA:/Users/…` 가 그대로 실렸다(가짜 CLI 는 한 델타로 흘려 창이 ~30ms).
- **왜**: 서버 폴백(`stripMediaLines`, 스펙 4.6)과 플러그인 정본은 `MEDIA:` 를 걷지만 델타 경로는 걷지 않는다. 웹 `apps/web/src/features/runs/runStore.ts:18-19` 가 델타를 그대로 이어 붙이고, `bubblePhase.ts:25-32` 가 streaming·finalizing 에서 `textVisible: true` 다. 서버는 델타를 `run_events.payload_json` 에 저장한다.
- **영향**: 스펙 9장 「채널 어디에도 호스트 경로가 나타나지 않는다」가 잠깐 깨진다. 업로드가 느리면(큰 파일, Ruling 2 로 finalizing 최대 120초) 노출이 그만큼 길어진다. 경로가 줄 경계에서 델타 여럿으로 쪼개져 오므로(위 셋) 델타 하나씩 걷는 방식으로는 못 막는다 — 줄 단위로 버퍼링하거나 웹 표시에서 `MEDIA:` 로 시작하는 줄을 숨기는 쪽을 봐야 한다. 코드는 고치지 않았다.
- 활동 탭이 런 텍스트를 보여 주는지, 재접속 때 델타가 다시 재생되는지는 재지 않았다.
- **고침(a3-t12, `1d6a06a`·`635fe76`)**: 서버가 텍스트 델타를 코얼레싱(= `run_events` 저장·wire 팬아웃의 입구)에 넣기 **전에** 런별 줄 단위 필터로 거른다(`apps/server/src/modules/runs/media-lines.ts`, 스펙 11장 Ruling 6). 줄 처음 조각이 `MEDIA:` 이거나 그 접두일 수 있으면 붙잡고, 줄이 끝나면 `MEDIA:` 줄은 줄바꿈째 버린다. 대소문자는 가리지 않는다(코어와 같다). `TEXT_MESSAGE_REPLACE` 본문도 같은 필터를 지난다. 붙잡힌 조각은 저장도 팬아웃도 되지 않은 상태라 재접속 재생(DB 만 읽는다)에도 경로가 없다.
- **실물 확인(a3-t13, 모델 런 0회) — 13.7**: 실제 Gateway 가 `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/workspace/…/chart.png` 세 델타로 쪼개 보낸 것(런 ② 와 같은 모양)을 서버가 wire·`run_events` 어디에도 싣지 않았다. 소문자 `media:`·`Media: ` 줄도 같다. 보통 줄 델타는 Gateway 프레임 뒤 53~58ms(코얼레싱 창 50ms)에 그대로 나갔다.

**B. [관찰] Gateway 가 프롬프트에 스테이징 호스트 경로를 스스로 붙인다.** 이미지 인바운드 때 CLI 프롬프트에 `[media attached 1/3: ~/.openclaw-dev/workspace/media/inbound/openclaw-staged-<uuid>/input-word---<uuid>… ]` 줄이 장마다 붙는다(가짜 CLI `hostPathLines`). 우리 텍스트가 아니라 OpenClaw 코어가 넣는 것이다. 모델이 이 경로를 답에 옮기면 채널 본문에 호스트 경로가 들어간다 — 우리 쪽 방어는 없다(스펙 10장 「사람이 채팅에 쓴 호스트 경로」와 같은 계열).

**C. [관찰] 활동 탭의 툴 인자·결과에 호스트 경로가 있다.** 런 ② 의 `Write` 인자 `file_path` 와 결과 `File created successfully at: /Users/…` 가 `TOOL_CALL_ARGS`·`TOOL_CALL_RESULT` 로 저장·표시된다. Phase 2 ① 부터의 설계(툴 타임라인은 원문)이지만 「호스트 경로를 드러내지 않는다」를 활동 탭까지 넓힐지는 판단이 필요하다.

**D. [관찰] Ruling 1·2 의 전제.** Ruling 2 의 전제(실제 `gateway_final` 스냅샷에 `MEDIA:` 줄이 남는다)는 **맞았다** — 하네스 c 와 모델 런 ② 모두. 정본은 final 뒤 31·45ms 에 와서 연장이 실제로 필요한 경우는 못 봤다. Ruling 1 은 루프백에서 ack 가 0.1~0.2초라 **정상 경로에서 재전송이 안 난다는 것만** 확인했고, 느린 링크의 이중 디스패치 여부는 여전히 못 쟀다(원격 Gateway 실연 몫).

**E. [관찰] 아웃바운드 스테이징 사본.** 툴 `media` 와 `MEDIA:` 줄은 Gateway 코어를 지나며 `~/.openclaw-dev/media/outbound/<이름>---<uuid>.<ext>` 사본을 남긴다(이번 8개 — 툴로 보낸 `big.png` 는 **JPEG 4,047,716B** 사본도 생겼다, 서버에는 원본 PNG 가 갔다). Gateway 가 24h 뒤 지운다(스파이크 보고서 「언제 지워도 되는가」 — `OUTBOUND_STAGING_TTL_MS`, 코드 읽기. `MEDIA:` 줄의 사본은 스파이크 2-7, 툴 `media` 의 사본은 이번에 처음 봤다). 11.5 「끝나면」에 넣었다.

### 13.5 사람이 볼 것

9.3 그대로(실제 OS 클립보드 붙여넣기·끌어다 놓기). 13.4 A 는 서버가 wire 에 싣지 않게 고쳤고 wire 에서 0건을 확인했으므로(13.7), 버블에서 `MEDIA:/…` 를 눈으로 찾을 일은 더 없다. 고치기 전 코드(`1d6a06a` 이전 — `1c8ffc1` 까지)로 돌릴 때만 해당한다 — **긴 답 끝에 파일을 붙이는 런**에서 스트리밍 버블 마지막 줄에 `MEDIA:/…` 가 잠깐 보이는지 눈으로 한 번. 자동화 도구로는 0.5초 창을 안정적으로 잡지 못했다.

### 13.6 정리·잔여물

- 서버(SIGINT)·Gateway(`shutdown completed cleanly`)·Vite 5180·wire-cli `watch` 를 내렸다. **19001·19100·5180 LISTEN 0, 5173 은 1 그대로**(다른 프로젝트, 무접촉). 브라우저 탭은 닫았다.
- 설치본: `~/.openclaw-dev/extensions/dodok` = `f5dc6438…`(main `b0b1b65` 빌드, 첨부 든 번들), `status: loaded`. `channels.dodok.channels` 는 unset 그대로. 계정·에이전트·승인 정책 무변경.
- dev 프로필에서 이번에 만든 것만 지웠다(모두 18:40 이후 생성 확인): `<ws>/a3-harness/`·`<ws>/hello-c3po.txt`(런 ②)·`<ws>/.openclaw-cli-images/`·`<ws>/media/`(둘 다 이번에 새로 생김)·`~/.openclaw-dev/media/inbound/`(새로 생김)·`media/outbound/` 안 파일 8개(디렉터리는 남김).
- **남긴 것**: dev·fin 채널 세션 4개(하네스 채널 dev·fin — 가짜 세션 id `…a311` 가 박힘, 모델 채널 둘) · 실제 claude 전사(런 ①②, `~/.claude/projects/…` 는 읽지도 고치지도 않음) · `/tmp/openclaw/openclaw-dev-2026-09-23.log` · 워크트리 `data/`(ignored: 위 로그들, `live-smoke.{env,sqlite}`, `openclaw-device-dev.json`, `wire-cli-session.json`, `attachments/`(서버 블롭), `check-*.log`) · `packages/openclaw-plugin/dist/`(ignored, 깨끗한 빌드). 가짜 CLI·시험 이미지·스크래치는 지웠다.
- 시크릿: `BRIDGE_TOKEN`·dev Gateway 토큰·`LOCAL_AUTH_TOKEN` 값의 출현 수 **0** — `data/*.log`·`data/*.jsonl`·`data/*.json`·`data/live-smoke.sqlite*`(WAL 체크포인트 뒤)·가짜 CLI 출력·`/tmp/openclaw/…log`. 이번 모델 런은 설정 파일을 뒤지지 않았다.
- 검사: 루트 `pnpm test` exit 0(shared 101 · plugin 108 · adapter 206 · server 562 · web 996 = **1973**) · `pnpm typecheck` exit 0 · `pnpm lint` exit 0 · `pnpm fmt:check` exit 0.

### 13.7 결함 A 고침의 실물 확인 — 2026-09-23 (a3-t13, 모델 런 0회)

13.4 A 를 서버에서 고친 뒤(a3-t12 — 스펙 11장 Ruling 6), 실제 dev Gateway 위에서 11.5 하네스 c·d 꼴을 **델타를 쪼개** 다시 돌렸다. 가짜 claude CLI 가 `stream_event` 로 조각을 600ms 간격으로 흘린다(11.5 ⑤ 정정). **모델 런 0회**. 가짜 CLI 의 `-p` 런 3회는 모두 `costUsd:0`·usage 0이다. `-p` 없는 호출 4회(버전·인증 확인)는 진짜 `claude` 로 넘어갔지만 모델을 부르지 않는다.

**판정: 고쳐졌다.** 실제 Gateway 가 `MEDIA:` 줄을 세 델타로 쪼개 보냈다(런 ② 와 같은 모양). 서버는 그 줄을 wire 에도 `run_events` 에도 싣지 않았다. 소문자 `media:`(세 델타)·`Media: `(두 델타) 줄도 싣지 않았다. 첨부는 셋 다 오고, 본문에 경로는 0이다. 보통 줄은 늦어지지 않았다. dodok 코드 결함 0.
로그는 워크트리 `data/`(ignored)에 있다: `dev-gateway.log`·`phase2-live-a3t13.log`(서버)·`frames-a3t13.jsonl`(프레임 덤프)·`wire-raw-{c,d,e}.jsonl`(아래 원시 감시)·`h-{c,d,e}-send.log`·`h-messages.json`·`fake-claude-a3t13.jsonl`.

| 항목 | 값 |
| --- | --- |
| Gateway | `OpenClaw 2026.9.5 (f396007)`. 서버 로그 `gatewayVersion="2026.9.5"`, `gatewayBuildId` 는 13.1 과 같고 scopes 에 `operator.admin` 이 있다 |
| 플러그인 | **재설치하지 않았다.** 설치본 `f5dc6438…` 는 13.1 그대로다. `b0b1b65..635fe76` 에서 `packages/openclaw-plugin` 은 바뀌지 않았다(diff 0줄). `status: "loaded"` |
| 서버 | 워크트리 `a3-t13` = main `635fe76`, `:19100`, 새 DB `data/live-smoke.sqlite`, 프레임 덤프 켬. 웹은 띄우지 않았다(5173·5180 무접촉) |
| 채널 | 하네스 전용 `harness-a3t13`(멤버 `@dev`), 가짜 세션 id `…0a3013` |
| 시험 파일 | `<ws>/a3-harness/chart.png` 64×32 3,858B(sha `c5cdc0f6…`) |
| wire 원시 감시 | `wire-cli` 는 델타를 뭉쳐 찍는다(4절). 그래서 `socket.io-client` 로 구독만 하는 스크래치 스크립트를 따로 썼다. `run.event`·`message.*` 를 받은 시각(epoch ms)과 함께 JSONL 로 적는다. 세션 토큰은 `data/wire-cli-session.json` 에서 읽고 출력하지 않는다 |

**런 셋**(가짜 CLI `fake-stream.json` 의 `deltas`, `<u>` 는 사용자 이름)

| # | 조각 | 뜻 |
| --- | --- | --- |
| c | `첫 줄은 ` · `보통 글입니다.\n` · `M` · `arkdown 은 두 번째 글자에서 풀린다.\n\n` · `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/workspace/a3-harness/chart.png` | 13.2-4 꼴 + 줄 머리 `M` |
| d | `me` · `dia:/Users/<u>` · `/.openclaw-d` · `ev/workspace/a3-harness/chart.png` | 13.2-5 꼴(미디어만), **소문자** |
| e | `앞 줄입니다.\n` · `Media: ` · `/Users/<u>/.openclaw-d` · `ev/workspace/a3-harness/chart.png\n` · `뒤 줄도 ` · `곧바로 나옵니다.` | 가운데 줄, 대소문자 섞임, 뒤에 글 |

**결과**

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 입력이 정말 쪼개져 왔는가 | **그렇다** | 프레임 덤프 `chat` `state:"delta"` 의 `deltaText`: c `MEDIA:/Users/<u>`·`/.openclaw-d`·`ev/workspace/a3-harness/chart.png`(19:33:02.201·02.801·03.402), d `media:/Users/<u>`·`/.openclaw-d`·`ev/…/chart.png`, e `Media: /Users/<u>/.openclaw-d`·`ev/…/chart.png\n`. `gateway_final` 스냅샷에도 그 줄이 그대로 있다(13.2-4 와 같다) |
| 2 | wire `TEXT_MESSAGE_CONTENT`·`TEXT_MESSAGE_REPLACE` 에 `/Users/`·`MEDIA:`·`media:` 0 | **0** | 원시 감시 세 파일 전체에서 `/Users/`·`MEDIA:`·`media:`·`Media:` 가 모두 0건이다. `TEXT_MESSAGE_CONTENT` 는 c 3·d 0·e 3건이고 모두 보통 글이다. d 는 `TEXT_MESSAGE_START` → `END` 뿐이다. `TEXT_MESSAGE_REPLACE` 는 0건이다 — Gateway 가 `replace` 를 내지 않아 **REPLACE 경로는 실물에서 두드려지지 않았다**(단위 테스트만) |
| 3 | `run_events` 에 같은 검색 0 | **0** | 33행 중 `TEXT_MESSAGE_CONTENT` 는 6행이고 모두 보통 글이다. `instr(payload_json,'/Users/')` 0, `payload_json LIKE '%media:%'`(SQLite LIKE 는 ASCII 대소문자를 가리지 않는다) 0, `openclaw-dev` 0, `TEXT_MESSAGE_REPLACE` 0. `messages.body_md` 도 0이다 |
| 4 | 채널에 첨부가 오고 본문에 경로 0, `finalSource` | **통과** | c 본문 `첫 줄은 보통 글입니다.\nMarkdown 은 두 번째 글자에서 풀린다.` + `chart.png` · d 본문 `""` + `chart.png` · e 본문 `앞 줄입니다.\n뒤 줄도 곧바로 나옵니다.` + `chart.png`. REST 로 내려받은 세 첨부의 sha 가 원본과 같다(`c5cdc0f6…`). 채널 메시지 REST JSON 전체에서 `/Users/`·`media:`(대소문자 무시)·`openclaw-dev` 는 0이다. 세 런 모두 `finalSource=plugin` 이다. 플러그인 `[dodok] deliver-media` 는 `uploaded:1,failed:0` 을 세 번 찍었다. 서버 `gateway snapshot media lines dropped` 는 0회, `stream media lines dropped` 는 `mediaLinesDropped:1` 로 세 번 찍혔다 |
| 5 | 스트리밍이 느려지지 않았는가 | **그렇다 — 늘어난 지연 없음** | 아래 시각 표. 보통 줄 델타는 Gateway 프레임을 받은 뒤 **53~58ms** 에 wire 에 나왔다. 이 값은 코얼레싱 창 `coalesceMs: 50`(결함 A 이전부터 있다)에 해당한다. 고치기 전 코드로 같은 기준선을 다시 재지는 않았다 |

**시각** — 서버가 Gateway 프레임을 받은 시각(프레임 덤프 `receivedAt`)과 원시 감시가 wire 이벤트를 받은 시각이다. 둘 다 같은 머신의 시계다. 가짜 CLI 의 조각 방출 → Gateway 프레임은 1~7ms 였다(합쳐진 조각은 뒤 조각 기준).

| 런 | Gateway `deltaText` (받은 시각) | wire (받은 시각) | 차이 |
| --- | --- | --- | --- |
| c | `첫 줄은 ` (19:32:59.791) | seq 5 `첫 줄은 ` (59.849) | 58ms |
| c | `보통 글입니다.\n` (00.393) | seq 6 (00.447) | 54ms |
| c | `Markdown 은 …\n\n` (01.597) | seq 7 (01.652) | 55ms |
| c | `MEDIA:/Users/<u>` · `/.openclaw-d` · `ev/…/chart.png` (02.201·02.801·03.402) | **없음** | — |
| c | `final` (04.311) | `TEXT_MESSAGE_END` seq 9 (04.312) → 정본 `message.created` 는 그 뒤 67ms | — |
| e | `앞 줄입니다.\n` (19:34:58.307) | seq 5 (58.361) | 54ms |
| e | `Media: /Users/<u>/.openclaw-d` · `ev/…/chart.png\n` (59.513·00.113) | **없음** | — |
| e | `뒤 줄도 ` (00.714) | seq 6 (00.767) | 53ms |
| e | `곧바로 나옵니다.` (01.318) | seq 7 (01.372) | 54ms |

**관찰**
- **Gateway 가 짧은 줄 머리 조각을 스스로 합친다.** 가짜 CLI 가 따로 낸 `M`(c)·`me`(d)·`Media: `(e)를 Gateway 는 프레임으로 따로 내지 않았다. 다음 조각과 합쳐 `Markdown 은 …`·`media:/Users/<u>`·`Media: /Users/<u>/.openclaw-d` 로 냈다(600ms 뒤). 까닭은 파지 않았다.
  그래서 서버 필터의 **접두 붙잡기**(`M` → 다음 글자에서 풀림)는 이 실물 경로에서 두드려지지 않았다. 그 동작은 단위 테스트(a3-t12)가 잠근다. 합친 뒤의 `MEDIA:` 줄은 Gateway 가 그대로 델타로 흘린다 — 서버 필터는 여전히 필요하다.
- 붙잡힌 채 재접속하는 경우와 활동 탭 표시는 재지 않았다(웹을 띄우지 않았다). 재생은 DB 만 읽으므로 3번이 그 몫을 대신한다(a3-t12 리뷰 질문 2).

**정리**: 서버(SIGINT)와 tsx watch·pnpm 부모를 내렸다. Gateway 는 `shutdown completed cleanly` 로 내렸다. **19001·19100·5180 LISTEN 0, 5173 은 1 그대로**(무접촉). 설치본은 `f5dc6438…`, `status: loaded` 이고 `channels.dodok.channels` 는 unset 이다.
dev 프로필에서는 이번에 만든 것만 지웠다(19:31 이후 생성 확인): `<ws>/a3-harness/`, `~/.openclaw-dev/media/outbound/` 의 `chart---<uuid>.png` 3개(관찰 E 의 사본 — 런마다 하나). 가짜 CLI·스크래치는 지웠다. 하네스 채널의 dev 세션(가짜 세션 id)은 남겼다.
시크릿(`BRIDGE_TOKEN`·dev Gateway 토큰·`LOCAL_AUTH_TOKEN`)의 출현 수는 0이다. 확인 범위는 `data/*.log`·`*.jsonl`·`*.json`·`live-smoke.sqlite*`·가짜 CLI 출력이다.
