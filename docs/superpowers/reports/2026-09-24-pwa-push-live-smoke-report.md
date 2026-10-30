# 실연 — 2026-09-24 결과 (p4-t9, 계획 태스크 9)

> PWA·푸시(Phase 2 ④)의 멘션 푸시를 실제 dev Gateway·FCM 으로 돌린 실연의 기록 — 계획 `docs/superpowers/plans/2026-09-23-pwa-push.md` 태스크 9, 스펙 `docs/superpowers/specs/2026-09-23-pwa-push-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


11절 하네스(가짜 claude CLI 가 `@owner` 를 멘션하는 답을 낸다)로 실제 dev Gateway·플러그인·서버·실제 FCM 경로를 모델 런 0회로 먼저 돌린 뒤, 사용자 승인 상한(**모델 런 1회**) 그대로 실제 모델로 한 번 돌렸다.

**판정: 경로는 실물에서 돈다 — 런 0회 하네스 7/7 통과(같은 세션에서 여러 번 재현). 모델 런 1회는 합격 기준 3(멘션 파싱)·6(본문 무유출, finalSource=plugin 관찰로 대체 확인)은 통과, 5(브라우저 알림 표시)는 서버 발송·Chromium GCM 계층 수신까지는 확인했으나 관찰 창(약 15초) 안에 알림으로 표시되지 않았다 — 직후 같은 세션에서 하네스로 같은 경로를 재현하면 2초 만에 정상 도착해, dodok 코드 결함으로는 보지 않지만 원인을 특정하지 못한 채 미해결로 남긴다(아래 14.4.4).**
로그는 워크트리 `data/`(ignored, 정리 시 삭제): `dev-gateway.log`·`phase2-live-t9.log`(서버)·`vite-preview-t9.log`·`live-smoke.sqlite`. 브라우저 자동화 스크립트(`playwright-core` 로 여는 컨트롤 서버)는 세션 스크래치 디렉터리에 두고 끝나며 지웠다(레포에 커밋된 것 없음).

#### 14.4.1 환경 실물

| 항목 | 값 |
| --- | --- |
| 워크트리 | `main f92f799`(이 실연 시작 시점의 main HEAD, 코드 변경 없이 그대로) |
| Gateway | `OpenClaw 2026.9.5 (f396007)` — 12·13절과 같다. 서버 로그 `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-f39600759bec-2026-09-19T05-09-16.000Z"`(12·13절과 같은 buildId), scopes 에 `operator.admin`. `"bridge plugin hello"` 도 `gatewayVersion="2026.9.5"`(같은 줄 `pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수) |
| VAPID 주체 warn | 부팅 로그에 정확히 1줄: `"vapidSubject":"mailto:dodok@localhost"` `"msg":"VAPID subject is a local placeholder — Apple Push rejects it (403 BadJwtToken)"`(기본값 그대로 — 스펙 11장 보탬) |
| 플러그인 번들 | **재설치했다** — 브리프는 「`packages/openclaw-plugin` 이 안 바뀌었으면 sha 만 대조」였지만, `git log ae63cf8..HEAD -- packages/openclaw-plugin` 는 0커밋인 반면 `-- packages/shared` 는 2커밋(`e9d2ede`·`b65a247`, 푸시 구독·페이로드 계약·`presence.update`)이었다. `pack:plugin` 은 esbuild 로 `@dodok/shared` 를 번들에 넣으므로, 플러그인 자체 소스가 안 바뀌어도 산출물 sha 가 달라진다 — 실제로 설치 전(`f5dc6438…`, a3-t13 때 빌드) ≠ 이번 빌드(`e4a6284c…`). **Gateway 를 내린 채로** 재설치했고, 설치 뒤 sha 가 빌드본과 같음을 확인했다(아래). `status: "loaded"` |
| 서버 | `:19100`, `APP_ORIGIN=http://localhost:5180`, DB `data/live-smoke.sqlite`, `LOG_LEVEL=debug` |
| 웹 | 빌드본 `vite preview --port 5180 --strictPort`(`DODOK_API_ORIGIN=http://127.0.0.1:19100`) — 5173 은 다른 프로젝트라 무접촉, 3000 도 무접촉 |
| 브라우저 | `playwright-core@1.62.1`(워크트리 `node_modules/.pnpm` 안의 것, 새로 설치하지 않음) + 캐시된 Chromium `chromium-1234`(리비전이 1.62.1 의 `browsers.json` 과 일치, "Google Chrome for Testing" 151.0.7922.34) — **headed**, `--window-position=-2400,-2400`, 영구 프로필은 세션 스크래치 디렉터리(사람의 실제 브라우저 프로필 아님). 권한은 `context.grantPermissions(["notifications"], { origin: "http://localhost:5180" })` |
| 채널 | 하네스 `harness-09240304`(`01a0cf70-620c…`) · 억제/실도착 확인용 `other-09240313`(`01a0cf79-007e…`) · 모델 런 `model-t9-09240333`(`01a0cf8b-0b3c…`) — 런마다 새 채널(가짜 세션 id 와 섞이지 않게, 11.1 주의대로) |
| 사람 | owner(핸들 `owner`, id `01a0cf70-0fec-7665-a303-ad307112077a`) — 실연 서버가 매 부팅 새로 부트스트랩한 계정. 로그인은 `LOCAL_AUTH_TOKEN`(서브셸 변수로만, 로그·argv 에 안 남김) |
| 모델 | `anthropic/claude-opus-5` + claude-cli. CLI 보고 비용 **$0.6010**(새 세션 캐시 생성 59,649 토큰, `duration_api_ms 3893`). dodok `RUN_FINISHED` 자체 집계는 `inputTokens:2 outputTokens:4 costUsd:0` — 5.4·13.3 이월(usage 값 불일치)과 같은 줄기, 이번에 새로 파지 않았다 |

#### 14.4.2 합격 기준 — 런 0회 하네스 (11절, 여러 차례 재현)

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 1 | 버전 로그 | **통과** | 위 환경 표 — `gatewayVersion`·`gatewayBuildId` 가 12·13절과 같다. VAPID 로컬 주체 warn 1줄 |
| 2 | 설치 번들 sha = 빌드본 | **통과(재설치 경로로)** | 설치 전 `f5dc6438…` → 재설치 후 `e4a6284c5df128a018841f71ba0ca9f01f6fc4757d9fdf0c917dab25dbe42ebb` = `packages/openclaw-plugin/dist/index.js` 빌드본과 동일. `plugins inspect` `status:"loaded"` |
| 3 | 에이전트 답(플러그인 경로)의 `mentions.users` 에 사람 id | **통과** | 하네스 `message` 툴 호출로 보낸 `"@owner 한마디: 확인해 주세요"` → REST `GET .../messages` 의 그 메시지 `mentions:{agents:[],users:["01a0cf70-0fec-7665-a303-ad307112077a"]}`. wire 로도 `finalSource=plugin`·`runId`·`replyTo` 일치(ADR 0004 6절 기준 재확인) |
| 4 | 보고 있으면 거름 | **통과** | 브라우저가 하네스 채널을 보이게 보는 상태에서 같은 트리거 3회(최초·재확인·GCM 연결 뒤) → `registration.getNotifications()` 매번 `[]` |
| 5 | 다른 채널/탭 닫음 → 실제 FCM 알림 1건 | **통과** | 아래 14.4.3 참고 — 여러 차례 실패 끝에 A 를 걷은 뒤부터는 매번 성공했다(당시 원인으로 함께 꼽은 B 는 p4-c1 이 재현하지 못해 정정했다). 도착 페이로드: `{"title":"dodok","body":"@dev가 #harness-09240304에서 불렀습니다","tag":"mention:01a0cf70-620c-76bd-946b-90dd0fc0f6b0","data":{"url":"/c/01a0cf70-620c-76bd-946b-90dd0fc0f6b0"}}` — 스펙 5.2 문구·url·tag 그대로. 탭을 모두 닫고 SW 컨텍스트로 읽은 것도 같은 페이로드로 도착(p4-t7 방법) |
| 6 | 본문에 유일 문구 없음 | **통과** | 도착한 알림 본문 어디에도 트리거 문구(`"가짜 CLI 프로브"`·`"한마디: 확인해 주세요"`)나 `FAKE_CLI_DONE` 이 없다 — 「누가·어디」만 있다(결정 1) |
| 7 | 로그 위생 | **통과** | 아래 14.4.5 |

**추가로 CDP `ServiceWorker.deliverPushMessage` 로 직접 주입한 테스트 페이로드도 즉시 알림으로 떴다** — 브라우저 쪽 SW·알림 표시 파이프라인 자체는 항상 정상이었다(14.4.3 의 실패가 클라이언트 문제가 아니라는 근거).

#### 14.4.3 새로 찾은 것 — 실제 FCM 전달의 타이밍 제약 (제품 결함 아님, 절차 보탬 — B 는 p4-c1 이 정정)

이 둘은 dodok 코드가 아니라 **자동화 헤드리스/headed Chromium + 실제 Google 푸시 인프라**의 특성이다. 14.1 의 CDP `deliverPushMessage`(가짜 주입)로 확인하던 이전 검증(p4-t7)은 이 경로를 두드리지 않아 못 봤다.

- **A. `--disable-background-networking` 가 실제 GCM 연결을 막는다.** Playwright 의 기본 자동화 인자에 이 플래그가 들어 있다(`ps aux` 로 확인). 이 플래그가 있는 채로는 `chrome://gcm-internals` 가 `GCM Client State: LOADING`·`Connection Client Created: false` 에서 멈췄고(수 분 대기·45초 대기 재시도 모두 실패), 실제 FCM 발송이 브라우저에 전혀 닿지 않았다(서버는 발송을 시도하지만 알림이 안 뜬다). `chromium.launchPersistentContext(..., { ignoreDefaultArgs: ["--disable-background-networking"] })` 로 그 인자만 뺀 뒤에는 `Connection State: CONNECTED`(`mtalk.google.com`)까지 갔고, 그 뒤로는 실제 FCM 발송이 매번(하네스 재현 포함) 도착했다. **다만 이 플래그 하나가 유일한 원인인지 A/B 로 엄밀히 가르진 않았다** — 플래그 제거 전에는 최대 45초 대기까지도 실패했고, 제거 뒤에는 몇 차례(약 15~30초, 처음 구독을 만들고 실제 체크인까지는 더 걸릴 수도 있다) 만에 성공한 정황 증거다.
- **B. ~~탭을 닫으면 소켓 정리가 최대 45초 걸려 그 채널 푸시가 억제된다~~ — p4-c1 이 재서 재현되지 않았다(정정).** p4-t9 는 「탭을 닫은 직후 트리거 → 도착 0 → 45초 뒤 재현 → 도착」을 보고 engine.io 핑 시간(25s+20s)으로 설명했지만, 그때 서버는 걸렀는지·보냈는지를 로그로 남기지 않아 **도착 여부로만** 판단했고 같은 실연의 A(GCM 연결 지연)와 겹쳤다. p4-c1 은 `dev:fake`(3100)+빌드본 preview(5180)에서 headed Chromium(Chrome for Testing, 1.62.1)으로 서버 소켓의 connect·`presence.update`·disconnect·발송 시각을 직접 기록했다(닫은 뒤 곧바로 `@dev 나 불러` 트리거):

  | 경로 | 닫기 방식 | 서버 disconnect(닫기 호출부터) | `visible:false` 도착 | 트리거 발송 |
  | --- | --- | --- | --- | --- |
  | 앱(SW·푸시 켬), preview 프록시 경유 — 고치기 전 | `page.close({runBeforeUnload:true})` · CDP `Target.closeTarget` · `page.close()` · `goto about:blank` · `goto` 다른 오리진 | 9~68ms(`transport close`) | 5종 모두 disconnect 전(3~26ms) | 5/5 보냄(630~676ms) |
  | 앱, 같은 조건 — 고친 뒤(pagehide) | 같은 5종 + 닫기 3종 한 번 더 | 11~123ms | 8/8 disconnect 전(1~14ms) | 8/8 보냄(621~749ms), 서버 debug `push sent` 201 |
  | 최소 프로브(앱과 같은 presence 규칙), 프록시 경유 | `runBeforeUnload` · `Target.closeTarget` · `goto` 다른 오리진, pagehide 전송 유무 각각 | 4~590ms | 6/6 disconnect 전 | 6/6 보냄 |
  | 최소 프로브, 서버 3100 직접 | 같은 6조합 | 50~81ms | 6/6 disconnect 전 | 6/6 보냄 |

  탭을 닫든 다른 주소로 가든 브라우저가 웹소켓을 곧바로 닫고(React 정리가 안 돌아도 된다), vite preview 프록시도 늦추지 않는다. Chromium 은 언로드 때 `pagehide`(이때 `visibilityState` 는 아직 `visible`) 다음 `visibilitychange` hidden 을 보내고, 그 뒤에 소켓이 닫힌다. 웹은 이제 `pagehide` 에서도 「안 보임」을 강제로 보낸다(`WireProvider` `attachPresence` — 언로드 때 `visibilitychange` 가 오지 않는 엔진 대비, Chromium 에서는 결과가 같다). **남는 최대 45초 창은 close 가 서버에 가지 않는 경우 — 네트워크 단절·절전·프로세스 멈춤 — 뿐이다**(스펙 10장 트레이드오프, `pagehide` 로도 못 막는다).
  실제 알림 도착: 데워진 프로필에서는 닫기 3종 3/3 이 닫은 뒤 1.7~1.9초에 SW `getNotifications` 로 잡혔다. 새 프로필 첫 몇 분에는 5건 중 2건만 20초 안에 잡혔다(서버는 5건 모두 201) — A 와 같은 GCM 준비 쪽으로 보이며, 같은 `Topic` 의 대기 메시지가 다음 발송에 밀려 풀린 것처럼 보이는 꼴이었지만 원인은 가르지 않았다.
  **이제 서버가 가른다** — `LOG_LEVEL=debug` 면 디스패처가 거를 때 `push skipped — watching`(`userId`·`channelId`·`kind`), 푸시 서비스가 받으면 `push sent`(`subscriptionId`·`transport`·`result`)를 한 줄씩 남긴다(HTTP 상태는 디스패처 줄에 없다 — 통로가 거절·실패를 받았을 때만 그 통로가 `statusCode` 와 고정 문구 `reason` 을 warn 으로 남긴다). 다음 실연은 「걸렀다·보냈다·보냈는데 안 왔다」를 이 두 줄과 `chrome://gcm-internals` 로 가른다. `dev:fake` 진입점은 로그 수준을 `info` 로 고정하므로 debug 줄을 보려면 `startDevFake({ logLevel: "debug" })` 로 감싸 띄운다.

#### 14.4.4 모델 런 (상한 1, 실제 1)

`model-t9-09240333` 채널에서 `"@dev owner 에게 한마디 해 줘 — 답에 @owner 을 꼭 넣어"` 를 보냈다. 브라우저는 `other-09240313` 채널을 보고 있었다(A·B 를 걷은 뒤 안정적으로 통과하던 그 세션과 같은 브라우저 인스턴스).

| # | 기준 | 결과 | 증거 |
| --- | --- | --- | --- |
| 3 | 모델 답의 `mentions.users` 에 사람 id, `finalSource: plugin` | **통과** | 모델 답: `"@owner 님, 오늘도 무사히 컴파일되는 하루 되시길 바랍니다! 🤖\n\n혹시 스택 트레이스가 47층까지 쌓이거든 주저 말고 부르십시오. 저는 육백만 가지 에러 메시지에 능통하니까요. 물론... 성공 확률은 3,720 대 1 정도겠지만, 그래도 함께 해보는 겁니다.\n\n오 메이커시여, 오늘의 빌드에 축복을! ⚠️"`. REST 로 그 메시지의 `mentions:{agents:[],users:["01a0cf70-0fec-7665-a303-ad307112077a"]}`. wire `run.state` 가 `finalSource=plugin`·`hasCanonical`, `RUN_FINISHED` 의 `messageIds` 가 그 메시지와 일치 |
| 5 | 실제 FCM 알림 도착 | **미확인(서버 발송·GCM 계층 수신까지만 확인)** | 서버가 발송을 시도했다는 것은 `lsof` 로 그 순간 dodok 서버 프로세스가 `172.217.211.101:443`(Google) 에 새 TCP 연결을 여는 것으로 간접 확인했다(하네스 발송 때도 같은 패턴). `chrome://gcm-internals` 의 **Receive Message Log** 에 우리 구독의 app id(`wp:http://localhost:5180/#4CF2BA56-AD13-4A58-9924-DAC3E54AA-V2`)로 **`Data msg received` 723 bytes** 가 모델 런 종료 약 1초 뒤(런 종료 03:33:44 무렵 → 수신 로그 03:33:45)에 찍혔다 — Chromium 이 실제로 그 발송을 받았다는 증거다. 그런데 그 뒤 약 15초(수신 직후·+5초·+10초 3회) 동안 `registration.getNotifications()` 는 계속 `[]` 였다. GCM 연결은 이미 5분 넘게 전에 `CONNECTED` 였고(같은 브라우저 인스턴스, 그 사이 다른 발송은 성공), 이 브라우저가 모델 채널을 본 적이 없어 presence 거르기로도 설명되지 않는다(14.4.3-B 는 p4-c1 이 재현하지 못했다) — 즉 14.4.3-A 도 이 건의 원인이 아니다. **모델 런은 1회로 제한돼 있어 재시도하지 않았다.** 대신 같은 세션·같은 브라우저에서 하네스로 같은 경로(다른 채널을 보며 `@owner` 멘션 트리거)를 바로 재현했더니 **2초 만에** 정상 도착했다 — 그래서 dodok 코드(트리거·발송·프레즌스 로직)의 결함으로 보지 않고, 이 한 번의 자동화 브라우저 전달 유실로 본다. 원인은 특정하지 못했다(짐작 가는 파일 없음 — 발송은 서버가 했고 수신은 Chromium 내부 GCM 파이프라인이라 dodok 코드 밖이다) |
| 6 | 본문에 모델 답 원문 없음 | **간접 확인** | 알림이 뜨지 않아 알림 자체로는 못 쟀다. 다만 알림 본문은 `triggers.ts` 의 `targetsForMessage` 가 메시지 종류와 무관하게 항상 `"{작성자}가 #{채널}에서 불렀습니다"` 템플릿만 만든다(모델의 실제 텍스트를 읽지 않는다) — 이 코드 경로는 하네스에서 같은 함수로 여러 번 통과 확인했다(위 14.4.2-6). 이번 모델 답 원문(`"컴파일되는 하루"`·`"스택 트레이스"` 등)이 알림 페이로드에 실릴 경로 자체가 없다 |

#### 14.4.5 로그 위생

| 검사 | `phase2-live-t9.log`(서버) | `vite-preview-t9.log` | `dev-gateway.log`(Gateway/플러그인) |
| --- | --- | --- | --- |
| `p256dh` | 0 | 0 | 0 |
| 구독 endpoint(`fcm/send` 부분 문자열) | 0 | 0 | 0 |
| VAPID 비밀 키 값 | 0 | 0 | 0 |
| 알림 본문 문구(`불렀습니다`) | 0 | 0 | 0 |
| 모델 답 원문(`컴파일되는 하루`·`스택 트레이스`) | 0 | 0 | **2** |

마지막 줄이 dodok 서버·어댑터 로그는 아니다 — `dev-gateway.log` 는 `OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1`(live-smoke 3절 (c), 우리가 디버깅용으로 켠 Gateway 자체 옵션)로 claude-cli 의 stdout(`assistant`·`result` 레코드) 이 그대로 찍힌 것이다 — dodok 코드가 로그에 쓴 것이 아니라 OpenClaw CLI 백엔드 표준출력 캡처다. 이 파일은 워크트리 `data/`(ignored, 커밋 안 됨)에만 있었고 정리 때 지웠다. dodok 이 직접 쓰는 서버·웹 로그 기준으로는 7번 기준 그대로 **통과**다.

#### 14.4.6 사람이 볼 것

14.3 의 표 그대로(이번 실연은 전부 자동화 스크립트로 돌렸다 — 실제 macOS 알림 클릭·앱 설치 끝까지·iOS/안드로이드 실기기는 여전히 사람 몫, Phase 3).

#### 14.4.7 정리·잔여물

- 서버(SIGINT)·tsx watch/pnpm 부모·Gateway(SIGTERM) 를 내렸다. **19001·19100·5180 LISTEN 0(3100·3000 은 이번 실연이 쓰지 않았다), 5173 은 1 그대로**(다른 프로젝트, 무접촉).
- 설치본은 `e4a6284c…`(main `f92f799` 빌드), `status: loaded`, `channels.dodok.channels` 는 설정된 적 없음(이미 비어 있었다). 계정·에이전트·승인 정책 무변경.
- 가짜 claude CLI·컨트롤 서버 스크립트·Chromium 영구 프로필은 세션 스크래치 디렉터리에서 지웠다(레포·워크트리 밖).
- `~/.openclaw-dev/workspace`·`~/.openclaw-dev/media` 에 이번 세션이 새로 만든 파일은 없다(모델 런이 파일을 만들지 않는 요청이었다).
- 워크트리 `data/`(로그·DB·`vapid.json`·`live-smoke.env`·`wire-cli-session.json`) 를 통째로 지웠다. 저장소 최상위 `data/` 는 애초에 건드리지 않았다.
- **남긴 것**: dev 채널 세션 3개(하네스·`other`·모델 런 채널 — REST 로 만든 실연 채널, 실제 claude 전사 1건은 `~/.claude/projects/…` 에 있다, 읽지도 고치지도 않았다). 시크릿(`BRIDGE_TOKEN`·dev Gateway 토큰·`LOCAL_AUTH_TOKEN`) 값의 로그·DB 노출 0(위 14.4.5 와 같은 확인 범위).
- 검사: 루트 `pnpm fmt:check` exit 0. (이번 태스크는 코드를 고치지 않았으므로 `pnpm test`·`typecheck`·`lint` 는 다시 돌리지 않았다 — main `f92f799` 기준 그대로다.)
