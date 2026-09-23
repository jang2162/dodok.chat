# ADR 0004 — 플러그인의 인스턴스를 넘는 상태는 전역 레지스트리에 둔다 (2026.9.5 번들 이중 평가)

- 상태: 결정·구현·**실물 확인됨**(2026-09-23). 6절 합격 기준 1~6 을 `oc 2026.9.5 (f396007)` 위에서 런 0회 하네스로 통과(c2-t16)
- 날짜: 2026-09-23
- 대상: `docs/guides/live-smoke.md` 10.4 결함 1·2, ADR 0002 5.2(`message` 툴 — `handleAction`), 불변 규칙 「OpenClaw 패키지 3종 정확 핀」
- 산출 코드: `packages/openclaw-plugin/src/bridge-registry.ts`(새 순수 모듈)·`channel.ts`(모듈 스코프 Map 둘을 레지스트리로),
  `packages/openclaw-plugin/test/bridge-registry.test.ts`(회귀), `packages/openclaw-adapter/src/{openclaw-adapter.ts,gateway/connection-manager.ts}`(Gateway 버전 로그)
- 근거 원장(git 제외): `.superpowers/sdd/2026-09-21-components-v1/c2-t14-report.md`(원인 가르기, **모델 런 0회**) · `c2-t15-report.md`(이 결정의 구현)

## 1. 맥락

components v1 실연(2026-09-23, `live-smoke.md` 10절)에서 **모델 런 안의 `message` 툴 전송이 매번 `dodok: account "default" bridge is not running` 으로 실패**했다.
브리지는 붙어 있었고, 같은 인자를 운영자 `tools.invoke` 로 보내면 성공했다. 그날 dev Gateway 는 앱 자동 업데이트로 **`2026.9.5 (f396007)`** 였다(저장소 핀·스파이크는 `2026.9.4`).

c2-t14 가 가짜 claude CLI(모델 0)로 원인을 갈랐다. 확정한 것(F1~F6)과 판단(J1)을 섞지 않는다.

| # | 명제 | 근거 |
| --- | --- | --- |
| F1 | 9.5 Gateway 는 dodok 번들을 **pid 하나·realm 하나에서 두 번 평가**한다. 매번 다른 임시 복사 경로(`$TMPDIR/openclaw-plugin-build-XXXX/…/dist/index.js`)라 Node 는 다른 ESM 모듈로 본다 | 세대 식별 probe: 인스턴스 id 다름, `globalThis` 표식 같음, 평가 횟수 1→2 (기동 3번 모두) |
| F2 | 세대 1 = `loadGatewayPlugins`(Gateway 기동) — **`startAccount` 는 세대 1 에서만** 돈다. 세대 2 = `loadAgentRuntimePluginRegistryHandle ← prepareWorkspacePluginRegistries`(에이전트 prepared-runtime) | 로드 스택 60줄 |
| F3 | **모델 런(claude-cli → 루프백 `/mcp` → run grant)의 `message` → `handleAction` 은 세대 2 에서 돈다** — 모듈 스코프 `bridges` 가 비어 있다 | 가짜 CLI: `handle-action instance=<세대 2> bridgeKeys=[] found=false`, 툴 결과 원문이 실연과 글자까지 같다 |
| F4 | 같은 인자를 운영자 `tools.invoke` 나 `attach.grant` 루프백으로 보내면 세대 1 에서 돌아 성공한다 | probe `found=true` ×2, 카드 도착 |
| F5 | **9.4** 도 레지스트리를 두 번 만든다. 그러나 번들 평가는 **1회**이고 두 등록이 **같은 모듈 인스턴스**를 쓴다(설치 경로를 그대로 import → Node 모듈 캐시) | 9.4 실물: `module-eval evals=1`, `set-runtime` 2회 모두 같은 인스턴스 |
| F6 | 결함 2(`ask_user`)의 「bridge is not running」도 같은 뿌리다 — `ask_user` → `sendDurableMessageBatchCore` → `sendText` 가 세대 2 에서 돈다 | 가짜 CLI: `send-text instance=<세대 2> found=false` |
| J1 | 「prepared-runtime 인스턴스가 계정 수명주기 없이 채널 액션을 받는다」는 upstream 이 채널 플러그인을 덜 고려한 모서리일 **공산**이 있다 | 같은 9.5 안에서 `tools.invoke`·attach grant 는 세대 1, run grant 는 세대 2. 버그로 단정할 근거는 없다 |

인스턴스별 격리 자체는 **9.5 의 의도된 설계**다 — `docs/plugins/sdk-runtime.md` 「A managed plugin instance owns its registered callables, runtime-store slots, and loaded source generation」,
CHANGELOG 9.5 「Live plugin management: install and reload … without restarting the Gateway」. 되돌아오지 않는다.

우리 쪽 원인은 **「플러그인 모듈은 프로세스에 한 번만 평가된다」는 문서에 없는 가정**이다. `channel.ts` 의 모듈 스코프 상태는 둘뿐이었다(`src/*.ts` 전수).

- `bridges` — 계정 id → 브리지 연결. `startAccount`(세대 1)가 넣고 `handleAction`·`sendText`(세대 2)가 찾는다.
- `correlations` — 세션 키 → 마지막 인바운드의 `runId`·`replyToInboundId`. `dispatchInbound`(세대 1, `startAccount` 클로저)가 넣고 `handleAction`(세대 2)이 찾는다.
  이것이 비면 카드는 가도 **런에 안 묶인다**(`runId` 없음 → 서버의 런 dedupe·활동 탭·`replyTo` 가 빠진다).

`getDodokRuntime()` 은 인스턴스별 슬롯이지만 세대 2 도 `setRuntime` 을 받으므로 문제가 없다.

## 2. 결정

**길 A — 두 Map 을 `globalThis` 의 `Symbol.for` 키에 둔다.** `packages/openclaw-plugin/src/bridge-registry.ts`.

1. **둘 다 옮긴다.** 키는 `Symbol.for("dodok.openclaw-plugin.bridges.v1")`·`Symbol.for("dodok.openclaw-plugin.correlations.v1")`.
   F1 이 「같은 realm」을 확인했으므로 두 세대가 같은 Map 을 본다. 번들 채널(telegram)도 `Symbol.for("openclaw.telegram.pollingLeases")` 같은 프로세스 전역 키에 인스턴스를 넘는 상태를 둔다(9.5 dist) — upstream 의 관행이다.
2. **삭제 가드를 API 로 강제한다.** 지우는 함수는 `releaseBridge(accountId, bridge)` 하나이고, **등록된 것이 그 객체일 때만** 지운다.
   핫 리로드(9.5 live plugin reload)에서 새 세대 `startAccount` 가 옛 세대 `finally` 보다 먼저 돌면, 가드가 없는 `delete(accountId)` 는 **새 브리지를 지운다**. 호출자가 잊을 수 있는 `delete(id)` 는 내보내지 않는다.
3. **키에 버전(`v1`)을 둔다.** 핫 리로드 때 서로 다른 플러그인 버전이 한 Map 을 볼 수 있다. 레지스트리를 넘어 공유되는 표면(`BridgeClient`·`OutboundCorrelation` 모양)을 바꾸면 올린다.
4. **SDK 의 `openclaw/plugin-sdk/global-singleton`(`resolveGlobalMap`)은 쓰지 않는다** — 9.5 `sdk-subpaths.md` 가 「Private-local after July 2026」로 적었다. 같은 일을 우리 코드 몇 줄로 한다.
5. 레지스트리 모듈은 **SDK 를 import 하지 않는다**(타입만). 그래서 단위 테스트가 된다 — `vi.resetModules()` 뒤 다시 `import` 하면 다른 모듈 인스턴스가 나와 이중 평가를 흉내 낸다.
   잠근 것: 세대 1 등록 → 세대 2 가 같은 브리지 · `correlations` 도 같은 객체 · 새 브리지로 덮은 뒤 옛 세대의 release 는 새 브리지를 남긴다 · 같은 객체로 release 하면 지워진다.

곁들여, 원격 Gateway 가 9.5 인지 알 수 있게 **서버가 이미 받는데 버리던 버전 둘을 로그에 싣는다**: `"gateway connected"` 의 `gatewayVersion`(hello-ok `server.version` — 프로토콜 스키마의 필수 필드)·`gatewayBuildId`(`server.buildId` — 선택 필드라 없으면 `null`. 같은 버전 문자열의 두 빌드 `3a9d69d`·`f396007` 을 가른 값),
`"bridge plugin hello"` 의 `gatewayVersion`(플러그인의 `runtime.version`). 같은 줄의 옛 `sdkVersion` 은 **빌드 때 박힌 devDependency 상수**라 9.5 위에서도 `2026.9.4` 로 찍혀 `pluginBuiltWithSdk` 로 이름을 바꿨다.

## 3. 버린 길

| 길 | 버린 이유 |
| --- | --- |
| **B. dev Gateway 를 2026.9.4 로 고정** | **반쪽이다.** ① 앱이 스스로 업데이트한다(09-20 에 그랬다 — 끄는 설정은 확인하지 않았다). ② 원격 Gateway 가 9.5 로 오르면 배포에서 같은 결함이 난다. ③ 9.5 의 격리는 되돌아오지 않는다. 불변 규칙(정확 핀)과는 맞으므로 **원격 버전을 확인한 뒤 핀 정책과 함께 따로** 정한다 — A 를 대신하지 못한다 |
| **C. 인스턴스 무관 전송** — `handleAction`·`sendText` 가 브리지 소켓 대신 서버 HTTP(브리지 오리진 + 토큰)로 아웃바운드를 보내고, 상관은 서버가 세션 키의 활성 런으로 정한다 | 격리가 realm·워커·프로세스로 가도 산다. 플러그인 쪽 `correlations` 가 필요 없어지고, 「운영자가 보낸 카드가 끝난 런에 붙는다」(live-smoke 10.4-5)도 서버에서 정리된다. 그러나 새 엔드포인트·인증·dedupe·스펙 변경이 들고, **브리지 단일 연결 원칙에 두 번째 통로**를 둘지 먼저 정해야 한다. 지금 하기엔 크다 → **이월**(`docs/plan.md` 8장) |
| **D. upstream 보고만** | 우리 일정 밖이고, 버그라는 확신도 없다(J1). A 와 함께 할 수는 있다 — 보류 |

## 4. 결과·위험

- **9.4·9.5 둘 다에서 고친다**(9.4 는 원래 한 인스턴스라 무해). 결함 2 의 **첫 층**(`sendText` 의 「bridge is not running」)도 같이 닫혔다 — 실물에서 `ask_user` 가 다음 층(`agent not found`)까지 갔다(c2-t16).
  결함 2 의 뒷 두 층 — `sendText` 가 `agentId:"unknown"` 이라 서버가 `agent not found` 로 거절(c2-t14 F7), 선택지 컨트롤이 없음 — 은 **A 로 안 닫힌다**(이월).
- **9.5 의 인스턴스 격리를 의도적으로 넘는다.** 문서는 「lifecycle fencing applies to the managed callable surfaces, not every object a plugin can retain」이라 금지 대상은 아니다. 대신 **수명주기 책임이 우리에게 온다** —
  세대 교체 때 옛 세대의 핸들을 지우는 것은 우리 몫이고, 2절 2 의 가드가 그 최소 조건이다. 라이브 재로드에서 브리지 소켓이 세대를 넘어가는 순서(옛 세대 abort → 새 세대 start)는 **재지 않았다**.
- **`correlations` 는 지우는 자리가 없다**(전에도 없었다). 세션 키 수만큼 남는다 — 채널 × 에이전트라 실용상 문제없다. 세션 리셋·에이전트 제거 때 지울지는 C 와 함께 본다.
- **별도 realm·워커·프로세스 격리가 오면 깨진다.** 9.5 CHANGELOG 의 「worker-backed keyed and conditional state operations」가 방향 신호다. 그러면 번들 telegram 의 전역 상태도 같이 깨지므로 upstream 이 예고 없이 하기는 어렵지만 0 은 아니다 —
  **그때는 C 로 간다.** 버전을 올릴 때 5절 하네스를 한 번 돌리면 먼저 안다.
- 가짜 Gateway 통합 테스트는 플러그인을 한 인스턴스로 불러 이 결함을 **원리상 못 잡는다**. 회귀 테스트는 레지스트리의 성질만 잠그고, 실물은 5절 하네스가 잰다.
  `channel.ts` 를 두 번 import 하는 테스트(SDK 서브패스 4개 `vi.mock`)는 값보다 비용이 커서 하지 않았다.

## 5. 런 0회 하네스 둘

c2-t14 가 만든 두 하네스는 모델을 부르지 않고 실물 Gateway 의 루프백 `/mcp` 를 두드린다. 명령 단위 절차는 `docs/guides/live-smoke.md` 11절.

1. **`attach.grant`** — 모델 런이 쓰는 바로 그 루프백 서버에 세션 grant 로 붙는다. 툴 노출·`components` 스키마 확인용. run 문맥이 없어 **세대 1 로 가므로 결함은 재현하지 않는다**.
2. **가짜 claude CLI(정본)** — Gateway 가 claude-cli 를 PATH 의 `claude` 로 띄우는 점을 이용한다. 가짜 CLI 가 run grant 로 `message`(와 `ask_user`)를 한 번씩 부르고 끝낸다. **결함 1·2 를 모델 0 으로 그대로 재현했다**.

## 6. 실물 합격 기준 (다음 태스크)

5절 2 의 가짜 CLI 하네스를 새 번들로 돌려:
- `tools/call message` 결과가 `sent to dodok channel <채널 id> (<messageId>)` 이다.
- 서버에 카드 `message.created` 가 오고, 그 메시지의 **`runId` 가 그 가짜 런**이며 **`replyTo` 가 그 사람 메시지**다 — `correlations` 까지 공유됐는지를 이것으로 본다.
- `ask_user` 는 다음 층(`agent not found`)에서 막히는 것이 **정상**이다(결함 2 의 뒷반쪽, 이월).
- 서버 로그 `"bridge plugin hello"`·`"gateway connected"` 에 `gatewayVersion` 이 실제 값(`2026.9.5` 등)으로 찍힌다.
