# ADR 0005 — usage 값: claude-cli 백엔드에서 믿을 수 있는 것과 없는 것

- 상태: 결정. 코드 변경 없음 — `USAGE_TRUSTED`(`apps/server/src/modules/ops/summary.ts`)는 `false` 그대로
- 날짜: 2026-09-25
- 대상: 운영 보강 스펙 `docs/superpowers/specs/2026-09-25-ops-hardening-design.md` 「usage 진단 (스파이크)」 절, 어댑터 매퍼 `mapSessionMessage`(`packages/openclaw-adapter/src/gateway/events.ts`), shared `RunUsage`
- 잰 환경: dev Gateway `OpenClaw 2026.9.5 (ec9c1a1)`(스크래치 설치 — `docs/guides/live-smoke.md` 「전제」), 에이전트 `dev` = `anthropic/claude-opus-5` + claude-cli, Claude Code CLI `2.1.282`
- 근거 원장(git 제외): `.superpowers/sdd/2026-09-25-ops-hardening/o3-t7-report.md`

## 1. 맥락

`runs.usage_json` 은 어댑터 매퍼가 Gateway `session.message`(role `assistant`)의 `message.usage` 에서 `input`·`output`·`cost.total` 을 옮긴 값이다(`CUSTOM openclaw.usage` → 오케스트레이터가 런 행에 쓴다).
운영 화면의 런 표는 그 합을 토큰·금액 열로 보이려 했다. 값이 틀리면 열을 끄고 「측정 불가」를 보인다 — 그 스위치가 `USAGE_TRUSTED` 다.
이 ADR 은 **필드마다 맞는지, 틀리면 어느 층에서 틀리는지**를 가르고 스위치를 정한다.

## 2. 값이 지나가는 층

```text
claude CLI stream-json(stdout)
  ├ stream_event message_start  .event.message.usage   ← 턴 시작 스냅샷(output 은 대개 1)
  ├ assistant                   .message.usage         ← 위 스냅샷을 그대로 싣는다
  ├ stream_event message_delta  .event.usage           ← 최종 output
  └ result                      .usage · .total_cost_usd · .modelUsage   ← 최종 값·비용
        │
OpenClaw claude-cli 파서(9.5 dist cli-live-session-registry-*.mjs 의 handleParsedRecord·readCliUsage)
  · readCliUsage 는 레코드의 message.usage → usage → stats 만 읽는다 — stream_event 의 event.usage 는 읽지 않는다
  · usage 가 이미 있으면 result 의 usage 로 덮지 않고 diagnosticUsage 로 따로 둔다
  · total_cost_usd 는 dist 어디에서도 읽지 않는다
        │
전사(transcript) assistant 메시지 usage = assistant 레코드 스냅샷 + totalTokens(합)·cost(가격표 추정)
        │
Gateway WS session.message  .payload.message.usage       ← usage 를 싣는 유일한 프레임
        │
어댑터 mapSessionMessage → RunUsage { inputTokens, outputTokens, costUsd, model } → runs.usage_json
```

`result` 의 값은 `diagnosticUsage` 를 거쳐 **프로세스 안 진단 이벤트 `model.usage`** 로만 간다(`emitTrustedDiagnosticEvent`). Gateway WS 로 나가지 않고,
플러그인 SDK 의 공개 리스너 `onDiagnosticEvent` 는 trusted 이벤트를 거른다.

## 3. 측정

두 런을 쟀다. **하네스 런**(모델 0)은 가짜 claude CLI 가 층마다 **다른 값**을 내게 해 어느 층의 값이 끝까지 가는지 가른다. **모델 런**은 실제 CLI 가 같은 모양을 내는지 본다. 다시 재는 명령은 「다시 재는 법」 절.

| 필드 | 하네스: CLI `message_start`·`assistant` | 하네스: CLI `message_delta`·`result` | 하네스: `session.message` | 하네스: `runs.usage_json` | 모델: CLI `message_start`·`assistant` | 모델: CLI `message_delta`·`result` | 모델: `session.message` | 모델: `runs.usage_json` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| input | 11 | 11 | 11 | 11 | 2 | 2 | 2 | 2 |
| output | 1 | **77** | **1** | **1** | 1 | **48** | **1** | **1** |
| cacheWrite | 5555 | 5555 | 5555 | (옮기지 않음) | 59670 | 59670 | 59670 | (옮기지 않음) |
| cacheRead | 3333 | 3333 | 3333 | (옮기지 않음) | 0 | 0 | 0 | (옮기지 않음) |
| totalTokens | — | — | 8900 (= 11+1+5555+3333) | (옮기지 않음) | — | — | 59673 (= 2+1+59670+0) | (옮기지 않음) |
| 비용 | — | `total_cost_usd` **0.1234** | `cost.total` **0** | `costUsd` **0** | — | `total_cost_usd` **0.59791** | `cost.total` **0** | `costUsd` **0** |
| model | — | — | `claude-opus-5` | `claude-opus-5` | — | `modelUsage` 키 `claude-opus-5` | `claude-opus-5` | `claude-opus-5` |

- **usage 를 싣는 Gateway 프레임은 `session.message`(assistant) 하나다.** `chat` 은 델타·`final` 모두 `usage` 가 없고, `agent` lifecycle 의 `data` 키는 `phase`·`startedAt`·`model`·`provider`·`endedAt`·`executionSettled`·`terminalReply` 뿐이다.
  `session.message` 최상위 세션 필드 `inputTokens`·`outputTokens`·`estimatedCostUsd`·`totalTokens` 는 `null` 이다.
- **Gateway 의 집계 RPC 도 같은 스냅샷이다.** `sessions.usage`(모델 런 세션 키)는 `output 1`·`totalCost 0`·`missingCostEntries 1`·`missingCostByModel {"claude-cli/claude-opus-5": 1}` — 가격표에 claude-cli 모델이 없어 추정 비용도 0 이다.
- 두 런 모두 매퍼는 받은 `session.message` 값을 그대로 옮겼다 — 매퍼에서 달라지는 값은 없다.

## 4. 판정 — 필드별

| 필드 | 믿을 수 있나 | 까닭(층) |
| --- | --- | --- |
| 입력(`inputTokens`, 비캐시 입력) | **있다** | 입력은 요청 때 정해져 `message_start` 스냅샷과 최종 값이 같다 |
| 캐시 쓰기·읽기(`cacheWrite`·`cacheRead`) | **있다** — 단 `RunUsage` 에 자리가 없어 매퍼가 버린다 | 입력과 같은 까닭 |
| 출력(`outputTokens`) | **없다** — 늘 스냅샷(대개 1) | OpenClaw 파서가 `message_delta` 를 읽지 않고, `result` 값을 `diagnosticUsage` 로만 둔다 |
| `totalTokens` | **없다** — 실제 출력만큼 모자란다 | 입력 + 캐시 + **스냅샷 출력**의 합이다 |
| 비용(`costUsd`) | **없다** — 늘 0 | CLI `total_cost_usd` 는 어느 프레임에도 오지 않고, OpenClaw 가격표에 `claude-cli/<모델>` 이 없어 추정도 0 이다 |
| `model` | 있다 | — |

틀린 값은 모두 **OpenClaw 층**에서 생긴다. 어댑터 매퍼 오류가 아니다.

## 5. 결정

1. **`USAGE_TRUSTED` 는 출력 토큰과 비용이 둘 다 맞을 때만 `true` 다.** 「맞다」는 `runs.usage_json` 의 `outputTokens`·`costUsd` 가 같은 턴 CLI `result` 의 `usage.output_tokens`·`total_cost_usd` 와 같은 것이다.
   입력·캐시만 맞는 것으로는 켜지 않는다 — 런 표의 토큰 열은 입력 + 출력의 합이고, 금액 열은 비용 그 자체다. 지금은 둘 다 틀리므로 `false` 그대로이고, 운영 화면은 「측정 불가 — ADR 0005」를 보인다.
2. **매퍼·계약은 바꾸지 않는다.** 매퍼는 받은 값을 그대로 옮긴다. 틀린 층에서 고쳐지기 전까지 매퍼가 할 수 있는 것은 없다(「버린 길」 절).
3. **금액·토큰 상한은 이 값 위에 만들지 않는다.** 비용 상한은 런 수로 한다(운영 보강 스펙 「결정」 절 — 「비용 상한은 런 수다」).

## 6. 다시 재는 법

OpenClaw 판을 올렸을 때 **모델 런 0회**로 먼저 잰다. 하네스에서 `session.message` 의 `output` 이 `77` 이거나 `cost.total` 이 0 이 아니면 층이 바뀐 것이다 — 그때만 모델 런으로 확인한다.

**준비**: `docs/guides/live-smoke.md` 「런 0회 하네스」 절의 준비·가짜 claude CLI 를 그대로 쓰고, 서버 환경 파일에 `OPENCLAW_FRAME_DUMP_PATH=data/frames-<이름>.jsonl` 을, Gateway 에 `OPENCLAW_CLI_BACKEND_LOG_OUTPUT=1` 을 준다. 가짜 CLI 의 턴 본문(「가짜 claude CLI 스크립트」 절의 `startTurn`)을 아래로 바꿔 층마다 다른 값을 낸다.

```js
out({ type: "system", subtype: "init", session_id: SID, model: "fake", tools: [] });
await sleep(300);
const MID = "msg_fake_" + Date.now(), se = (event) => out({ type: "stream_event", session_id: SID, event });
const startUsage = { input_tokens: 11, output_tokens: 1, cache_creation_input_tokens: 5555, cache_read_input_tokens: 3333 };
se({ type: "message_start", message: { id: MID, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, usage: startUsage } });
se({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
for (const text of ["FAKE_", "USAGE_", "DONE"]) { await sleep(200); se({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }); }
se({ type: "content_block_stop", index: 0 });
se({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 77 } });
se({ type: "message_stop" });
out({ type: "assistant", session_id: SID, message: { id: MID, type: "message", role: "assistant", model: "fake", content: [{ type: "text", text: "FAKE_USAGE_DONE" }], stop_reason: "end_turn", usage: startUsage } });
out({ type: "result", subtype: "success", is_error: false, result: "FAKE_USAGE_DONE", session_id: SID, total_cost_usd: 0.1234,
      usage: { input_tokens: 11, output_tokens: 77, cache_creation_input_tokens: 5555, cache_read_input_tokens: 3333 } });
```

모델 런을 같은 Gateway 에서 이어 돌리려면 가짜 CLI 첫머리에서 「스크래치의 표식 파일이 있으면 진짜 `claude` 로 넘긴다」로 가르고, 런 직전에 표식을 만들고 직후에 지운다 — Gateway 재기동이 없어 claude-cli 캐시가 식지 않는다. 채널은 하네스 채널과 따로 만든다.

**읽기** — 본문은 옮기지 않고 수치만 본다.

```bash
# Gateway 프레임: usage 를 싣는 것은 session.message(assistant) 의 .frame.payload.message.usage
jq -c 'select(.frame.event=="session.message" and .frame.payload.message.role=="assistant")
       | .frame.payload.message.usage' data/frames-<이름>.jsonl
# 다른 프레임에 usage 가 있는가(0 이어야 지금과 같다)
jq -c 'select(.frame.event!="session.message") | [.. | objects | select(has("usage")) | .usage | select(. != null)] | length' data/frames-<이름>.jsonl | sort | uniq -c
# CLI 원본(Gateway 로그): message_start·assistant·message_delta·result 의 usage 와 total_cost_usd
sed 's/\x1b\[[0-9;]*m//g' data/dev-gateway.log | node -e '
  require("readline").createInterface({ input: process.stdin }).on("line", (l) => {
    const i = l.indexOf("{"); if (i < 0) return; let o; try { o = JSON.parse(l.slice(i)); } catch { return; }
    if (o.type === "stream_event" && ["message_start", "message_delta"].includes(o.event.type))
      console.log(o.event.type, JSON.stringify(o.event.message?.usage ?? o.event.usage));
    else if (o.type === "assistant") console.log("assistant", JSON.stringify(o.message?.usage));
    else if (o.type === "result") console.log("result", JSON.stringify(o.usage), o.total_cost_usd);
  });'
# 우리 값
sqlite3 -readonly data/live-smoke.sqlite "select id, usage_json from runs order by created_at;"
# Gateway 집계(토큰은 env 로만 — live-smoke 「시크릿 규칙」)
( . ./.env; env -u OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_DEV_GATEWAY_TOKEN" PATH="$OCBIN:$PATH" \
    openclaw --dev gateway call sessions.usage --port 19001 --json --params '{"key":"agent:dev:dodok:channel:<CH>"}' ) \
  | jq -c '.totals | {input, output, cacheWrite, cacheRead, totalCost, missingCostByModel}'
```

`sessions.usage` 는 첫 호출에 `cacheStatus: "refreshing"` 과 0 을 줄 수 있다 — `"fresh"` 가 될 때까지 다시 부른다.
OpenClaw 층을 직접 볼 때는 설치본 dist 에서 `grep -rl total_cost_usd`(지금은 0개)와 `handleParsedRecord` 의 `diagnosticUsage` 대입을 본다.

## 7. 버린 길

| 길 | 버린 이유 |
| --- | --- |
| 매퍼가 `totalTokens − input − cacheRead − cacheWrite` 로 출력을 되살린다 | `totalTokens` 자체가 스냅샷 출력으로 만든 합이라 같은 1 이 나온다 |
| 우리 가격표로 토큰에서 비용을 추정한다 | 출력 토큰이 틀려 추정도 틀린다. 출력이 입력보다 몇 배 비싼 값이라 오차가 가장 큰 자리가 틀린다 |
| OpenClaw 응답 usage 꼬리줄(세션 `responseUsage`)을 켠다 | 꼬리줄을 만드는 `resolveResponseUsageLine` 도 같은 스냅샷 `usage` 를 받는다. 답 본문에 줄이 붙는 부작용도 있다 |
| Gateway 집계 RPC `sessions.usage` 를 읽는다 | 전사와 같은 스냅샷이다(「측정」 절). 비용은 `missingCostByModel` 로 0. `usage.cost` 는 부르지 않았다 — 같은 전사를 읽는지는 확인하지 않았다 |

## 8. 후속 — 이번에 구현하지 않는다

1. **캐시 토큰을 계약에 싣는다.** `RunUsage` 에 `cacheReadTokens`·`cacheWriteTokens`(선택)를 두고 매퍼가 `message.usage.cacheRead`·`cacheWrite` 를 옮긴다. 맞는 값이라 「입력 쪽 토큰」은 셀 수 있다 — 출력·비용이 없는 채로 화면에 무엇을 보일지와 함께 정한다.
2. **upstream 요청.** claude-cli 백엔드가 `result` 의 `usage`·`total_cost_usd` 를 전사 assistant 메시지의 `usage`(또는 `chat` `final`)에 반영하게 해 달라고 OpenClaw 에 올린다. 반영되면 「다시 재는 법」 절의 하네스에서 `output 77`·`cost.total 0.1234` 가 보이고, 그때 `USAGE_TRUSTED` 를 다시 판정한다.
3. **플러그인 쪽 우회는 확인이 먼저다.** 정확한 값을 담은 `model.usage` 진단 이벤트는 trusted 라 공개 `onDiagnosticEvent` 로는 보이지 않는다. `openclaw/plugin-sdk/diagnostic-runtime` 이 `onInternalDiagnosticEvent` 도 내보내지만 이름대로 내부용이다 — 채널 플러그인이 써도 되는지, 그 이벤트의 `costUsd` 가 claude-cli 에서 0 이 아닌지(가격표에 모델이 없으면 같은 0 이다)를 확인한 뒤에만 길로 삼는다.
