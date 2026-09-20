# Phase 2 ① 활동 패널·승인 설계

**상태**: 구현 완료 · 2026-09-20 작성 · 2026-09-21 「구현과 맞춘 것」(11장) 추가
**범위**: 툴 활동 패널, 에이전트 승인(approval) 왕복, 브라우저 알림, shared 계약 정정, Phase 1 이월 정리
**앞선 근거**: 승인 스파이크 `.superpowers/sdd/2026-09-20-phase2-approval-spike/spike-report.md`(실물 프레임·RPC·TTL 실측, 모델 런 1회) · ADR 0001(Gateway WS) · ADR 0002(채널 플러그인) · 웹 MVP 스펙 `2026-09-19-web-mvp-design.md` · 서버 코어 스펙 `2026-09-15-server-core-design.md`

---

## 0. 결정 요약

| # | 결정 | 이유 |
| --- | --- | --- |
| 1 | 승인 정본은 **`plugin.approval.requested`/`resolved`**(전역), `session.approval` 은 재접속 되감기 전용 | 전역이라 세션 구독 경쟁이 없고 `toolCallId` 가 거기에만 있다(스파이크 3.1) |
| 2 | 승인 ↔ 런 상관은 **`sessionKey` + `toolCallId`** | 승인 페이로드의 `runId` 는 항상 `null`(스파이크 3.2) |
| 3 | 서버가 **`allowedDecisions` 를 먼저 검증**하고 벗어나면 Gateway 로 보내지 않는다 | 목록 밖 결정은 Gateway 가 조용히 거절(`malformed-verdict`)로 확정한다(스파이크 4.4) |
| 4 | `awaiting_approval` 동안 **런 타임아웃 시계를 멈춘다** | 대기 중에는 Gateway 가 아무 신호도 보내지 않는다(스파이크 6.3) |
| 5 | 승인 카드는 **메시지 흐름과 활동 탭 양쪽**에 띄운다 | TTL 120초라 한 화면에만 두면 놓친다 |
| 6 | 승인 요구에 **브라우저 알림**(Notification API)을 띄운다. 웹푸시는 Phase 2 ④ | 탭이 열려 있고 다른 채널을 보는 경우가 가장 흔하다. 서비스 워커·VAPID 없이 덮는다 |
| 7 | 활동 패널은 채널 오른쪽 패널의 **두 번째 탭**(`/c/$id/activity`) | 설정과 같은 자리를 나눠 쓴다. 대화를 보면서 툴 로그를 본다 |
| 8 | `@streamdown/cjk` 만 이번에 넣고 `@streamdown/code`(shiki)는 미룬다 | 한국어 강조는 작성기와 렌더가 어긋나 눈에 띈다. 하이라이트는 번들이 크다(첫 화면 0.47MB) |
| 9 | 승인 정책(`ask`)을 켜는 설정 UI 는 범위 밖 | 설정 자리가 셋이고 합성 규칙이 있다(스파이크 8.5) — 별도 설계가 필요하다 |

## 1. 범위

**넣는다**: 활동 패널(런 목록·툴 타임라인), 승인 수신·저장·표시·해결, 재접속 되감기, 브라우저 알림, shared 계약 정정 9건, 프레임 덤프 화이트리스트, `dev:fake` 승인 대본, Phase 1 이월 정리(아래 8장), `@streamdown/cjk`.

**뺀다**: components 셀렉트·모달·미디어·파일(Phase 2 ②), 첨부·이미지(③), 웹푸시·PWA 설치·오프라인 캐시(④), 코드 하이라이트, 승인 정책 설정 UI, `allow-always` 를 켜는 별도 UI(버튼은 `allowedDecisions` 에 있으면 그린다).

## 2. 구조

```
Gateway ──plugin.approval.requested/resolved──▶ adapter(구독·상관·resolve 래퍼)
   │                                                  │ AdapterEvent{approval}
   │                                                  ▼
   └──session.approval(재접속 replay)──▶ 서버 orchestrator ──▶ approvals 테이블
                                                      │           │
                                                      │           └─ wire approval.requested/resolved(채널 룸)
                                                      └─ 런 상태머신(awaiting_approval, 타임아웃 정지)
웹: 승인 스토어 ─▶ 메시지 흐름 카드 · 활동 탭 카드 · 브라우저 알림
    활동 탭 ─▶ GET /channels/:id/runs · GET /runs/:id/events + wire run.event
```

패키지별 책임: **shared** 계약 · **openclaw-adapter** Gateway 구독과 RPC · **server** 저장·상태·권한·중계 · **web** 표시·응답·알림.

## 3. 계약 정정 (shared)

스파이크가 실물과 어긋남을 찾은 곳만 고친다. 고친 뒤 서버·어댑터·웹이 한 번에 맞춰진다(같은 태스크에서).

### 3.1 도메인

```ts
ApprovalKind   = "exec" | "plugin" | "system-agent"        // generic 삭제
ApprovalStatus = "pending" | "allowed" | "denied" | "expired" | "cancelled"
ApprovalDecision = "allow-once" | "allow-always" | "deny"   // 새 타입
ApprovalReason = "user" | "timeout" | "malformed-verdict" | "no-route"
               | "run-aborted" | "gateway-restart" | "storage-corrupt"

Approval = {
  id: Id                       // 우리 id
  providerApprovalId: string   // "plugin:<uuid>" — 유일 인덱스
  kind: ApprovalKind
  channelId: Id                // sessionKey 에서 푼다
  agentId: Id                  // 우리 에이전트 id
  runId?: Id                   // 없을 수 있다(결정 2)
  toolCallId?: string
  toolName?: string
  pluginId?: string
  title: string                // 최대 200
  description?: string         // 최대 512 — 툴 인자 JSON 원문, 잘려 올 수 있다
  detail?: string              // 최대 16384 — 같은 값의 긴 판
  severity: "info" | "warning" | "critical"
  allowedDecisions: ApprovalDecision[]   // 1개 이상
  urlPath?: string
  status: ApprovalStatus
  decision?: ApprovalDecision
  reason?: ApprovalReason
  decidedBy?: Id               // 우리 사용자(우리가 해결했을 때만)
  decidedAt?: IsoDateTime
  expiresAt: IsoDateTime       // 필수 — 카운트다운의 근거
  createdAt: IsoDateTime
}
```

`description`·`detail` 은 **그대로 저장하되 화면에서는 접는다**(4.3). Gateway 가 380자 초과분을 `… …[+N chars hidden]… …` 로 잘라 주므로 그 표시가 있으면 「잘림」으로 본다.

### 3.2 런 이벤트

```ts
APPROVAL_REQUESTED { approvalId, kind, title, severity, allowedDecisions, toolCallId?, expiresAt }
APPROVAL_RESOLVED  { approvalId, decision, reason, decidedBy? }
```

`expired` 는 따로 두지 않고 `decision: "deny"` + `reason: "timeout"` 으로 정규화한다(Gateway 가 그렇게 준다).

### 3.3 wire

```ts
ApprovalResolve = { approvalId: Id, decision: ApprovalDecision }   // note 삭제 — Gateway 가 받지 않는다
"approval.requested": { approval: Approval }
"approval.resolved":  { approval: Approval }
ChannelSubscribeResult.pendingApprovals: Approval[]                // 그대로, 이제 실제로 채운다
```

### 3.4 RunSignal

`approval_resolved` 에 `decision` 을 싣는다(`{ kind: "approval_resolved"; decision: ApprovalDecision }`). 거절이면 곧바로 `tool` 로 돌아가 오류 결과를 기다린다.

## 4. 서버·어댑터

### 4.1 어댑터 구독

- capability·scope 는 **지금 그대로**(`tool-events`·`approvals`·`session-scoped-events`, `operator.approvals`+`operator.admin`). 스파이크 3.5 에서 이것으로 충분함을 실측했다.
- `plugin.approval.requested`/`plugin.approval.resolved` 를 구독한다. `exec.approval.*`·`openclaw.approval.*` 도 같은 모양으로 받아 `kind` 만 다르게 매핑한다(현재 런타임에서는 오지 않지만 모양이 같다).
- 우리 채널 세션 구독에 `includeApprovals: true` 를 더하고, 응답 `approvalReplay.approvals` 를 **재접속 복구**로 흘린다.
- 같은 승인이 두 경로로 오므로 `providerApprovalId` + `status` 로 중복 제거한다.
- 새 `AdapterEvent` 하나: `{ kind: "approval"; approval: ProviderApproval }`. `ProviderApproval` 은 Gateway 페이로드를 shared 모양으로 정규화한 것(런 상관 전, `channelId`·`agentId` 는 `sessionKey` 에서 푼 값).
- 새 메서드 하나: `resolveApproval(providerApprovalId, kind, decision): Promise<{ status; reason? }>` — `approval.resolve` 래퍼.

### 4.2 상관과 저장

1. `sessionKey` → `agent:<providerAgentId>:dodok:channel:<channelId>` 를 파싱해 채널·에이전트를 찾는다. 우리 규칙이 아니면 무시하고 `warn` 한 줄.
2. 그 채널·에이전트의 **종료되지 않은 런**이 있으면 그 런에 붙인다 — `findOpenRunBySession(db, sessionKey)`, 즉 그 세션의 **FIFO 맨 앞**(`createdAt`·`id` 오름차순 첫 행)이다.
   「가장 최근」이 아니다: 세션은 직렬이라 대기 중인 앞 런이 먼저 끝나야 뒤 런이 시작하고, 지금 툴을 부르는 것도 그 앞 런이다(p2-t4 리뷰 판정).
3. 런이 없으면 `runId` 없이 저장한다(채널 수준 승인). 카드는 뜬다.
4. `providerApprovalId` 유일 인덱스로 upsert 한다. 이미 확정된 승인에 `pending` 이 늦게 오면 무시한다.
5. 런에 붙은 승인은 `APPROVAL_REQUESTED`/`APPROVAL_RESOLVED` 런 이벤트로도 남긴다(활동 타임라인이 순서대로 읽을 수 있게).

### 4.3 런 상태머신

- `approval_requested` → `awaiting_approval`. 직전 상태를 기억한다.
- `approval_resolved` → 직전 상태로 복귀(대개 `tool`). 거절도 같다 — 런은 툴 오류로 이어진다(스파이크 4.3).
- **타임아웃**: `awaiting_approval` 인 동안 런 무응답 타임아웃을 멈춘다. 대신 승인 `expiresAt` + 5초를 감시해, 그때까지 아무 해결도 안 오면 승인을 `expired` 로 보고 런 타임아웃 시계를 다시 켠다(Gateway 가 `resolved(timeout)` 을 줄 것이므로 보통은 이 보조 타이머가 먼저 쓰이지 않는다).
- 런이 중단되면(사용자 중지) 남은 승인은 `cancelled`(`reason: "run-aborted"`)로 닫는다.

### 4.4 해결 경로 (wire `approval.resolve`)

서버가 문지기다. 순서대로 검사하고 하나라도 어긋나면 **Gateway 로 보내지 않는다**.

| 검사 | 실패 시 |
| --- | --- |
| 세션 사용자가 그 채널의 워크스페이스 멤버 | `FORBIDDEN` |
| 승인이 존재 | `NOT_FOUND` |
| 상태가 `pending` | `CONFLICT`(이미 확정·만료) |
| `expiresAt` 이 지나지 않음 | `CONFLICT` |
| `decision` 이 그 승인의 `allowedDecisions` 안 | `VALIDATION` |
| 어댑터 연결됨 | `ADAPTER_UNAVAILABLE` |

통과하면 `approval.resolve` 를 호출하고, 응답의 terminal 스냅샷으로 행을 갱신한 뒤 `approval.resolved` 를 **워크스페이스 룸**으로 보낸다(아래 4.6). Gateway 가 `resolved` 이벤트도 따로 주므로 **id 로 중복 제거**한다(먼저 온 쪽이 이긴다).

### 4.5 진단

`frame-dump.ts` 의 `DUMPED_EVENTS` 에 `session.approval`·`plugin.approval.requested`·`plugin.approval.resolved`·`exec.approval.requested`·`exec.approval.resolved` 를 더한다. 지금은 승인이 덤프에 하나도 남지 않는다.

### 4.6 팬아웃 범위 — 워크스페이스 룸

`approval.requested`·`approval.resolved` 는 **채널 룸이 아니라 워크스페이스 룸**(`workspace:<id>`)으로 간다. 웹은 한 번에 한 채널만 구독하므로,
채널 룸으로 보내면 5.4 의 「다른 채널을 보고 있어도 알림이 온다」와 9장 완료 기준 3 이 **도달 불가**가 된다(브라우저 검증 D1 이 실측).

**노출 범위는 늘지 않는다**: `channel.subscribe` 는 **워크스페이스 소속만** 검사하고 채널 멤버십을 보지 않는다(저장소 전체에 사람 멤버십 검사가 없다).
접속한 소켓은 이미 어느 채널이든 구독해 같은 페이로드(`detail` 포함)를 받을 수 있다 — 채널 룸은 프라이버시 경계가 아니다.
워크스페이스에 사람이 여럿이 된 뒤에도 같은 경계라면 채널 멤버 `userRoom` 팬아웃으로 좁히면 된다(`userRoom` 은 이미 있고 접속 때 join 한다).

**재접속 복구는 아직 채널 단위다.** 구독 ack 의 `pendingApprovals` 는 그 채널 것만 싣는다 — 다른 채널의 미해결 승인은 새로고침 뒤 돌아오지 않는다(`docs/plan.md` 8장 이월).

## 5. 웹

### 5.1 오른쪽 패널 탭

- 라우트 둘: `/c/$channelId/settings`(있음) · `/c/$channelId/activity`(새로). 패널 셸이 탭 머리(「설정」·「활동」)를 그리고 `<Outlet/>` 으로 내용을 바꾼다. 좁은 화면은 지금처럼 전체 화면 시트다.
- 활동 탭 기본 선택은 **가장 최근 런**. 채널을 옮기면 선택을 버린다.

### 5.2 런 목록과 타임라인

- 목록: `GET /channels/:id/runs`(최근 50) + 실시간 `run.state` 병합. 한 줄에 에이전트 핸들·상태 배지·시작 시각·소요.
  **「툴 수」는 뺐다**(Ruling 6): `Run`·`RunState` 계약 어디에도 없고 REST 가 주지 않는다 — 세려면 목록의 런마다 `GET /runs/:id/events` 를 불러야 하고(최대 50회)
  그 응답은 상한이 없어 텍스트 델타까지 통째로 온다. 정보는 타임라인의 툴 행이 이미 보여 주고, 390px 에서 런 한 줄은 이미 빽빽하다.
  나중에 정말 필요하면 싼 길이 있다 — 서버에서 `run_events` 를 `type='TOOL_CALL_START'` 로 `group by run_id` 집계해 **목록 응답에만** 곁들인다(`Run` 계약 무변경) + 웹 한 줄.
- 타임라인: `GET /runs/:id/events` + 실시간 `run.event`. 행은 툴 호출(이름·상태·소요), 단계(`STEP_*`), 서브에이전트(`SUBAGENT_*`), 승인, 오류. 텍스트 델타는 **타임라인에 넣지 않는다**(대화가 이미 보여 준다).
- 툴 인자·결과는 **접힘이 기본**. 펼치면 `<pre>` 로 보여 주고, `[+N chars hidden]` 표시가 있으면 「잘렸습니다」 한 줄을 붙인다.
- 런이 진행 중이면 맨 아래에 붙어 따라간다(메시지 목록과 같은 규칙).

### 5.3 승인 카드

- 자리 둘: 채널 메시지 흐름(시스템 카드 자리, 시간 순서) · 활동 탭 맨 위(고정). 같은 승인이므로 **하나의 스토어**를 본다.
- 내용: 제목(`title`), `severity` 색(info 회색·warning 주황·critical 빨강), 툴 이름, 접힌 인자, **남은 시간 카운트다운**(1초 간격, `expiresAt` 기준), 버튼은 `allowedDecisions` 에 있는 것만(`allow-once` 「이번만 허용」 · `allow-always` 「항상 허용」 · `deny` 「거절」).
- 누르면 잠그고 ack 를 기다린다. 실패는 코드별 문구를 토스트로(`CONFLICT` 「이미 처리되었거나 만료되었습니다」 · `VALIDATION` 「이 승인이 받지 않는 선택입니다」 · `FORBIDDEN` · `ADAPTER_UNAVAILABLE` 「Gateway 에 연결되지 않았습니다」).
- 확정되면 카드가 결과 한 줄로 바뀐다(「허용됨 · 방금」 / 「거절됨」 / 「만료됨」). 사라지지 않는다 — 기록이다.
- **다만 그 탭이 살아 있는 동안만이다.** 구독 ack 의 `pendingApprovals` 에는 **미해결만** 실리므로, 새로 연 탭·새로고침 뒤에는 확정된 카드가 메시지 흐름에 없다.
  기록은 **활동 탭 타임라인의 승인 행**(「허용됨」·「거절됨」·「만료됨」·「취소됨」)이 맡는다 — 그쪽은 런 이벤트라 서버에 남는다.

### 5.4 브라우저 알림

- 트리거는 **승인 요구 하나뿐**이다(메시지·멘션 알림은 Phase 2 ④).
- 권한은 사용자가 사이드바 하단 「알림 켜기」를 누를 때만 요청한다. `denied` 면 버튼을 숨기고 다시 묻지 않는다.
- 내용: 「승인 필요 — @dev 가 Write 를 실행하려 합니다」. 누르면 그 채널로 이동하고 활동 탭을 연다. 탭이 이미 보이는 상태(`document.visibilityState === "visible"`)이고 같은 채널을 보고 있으면 띄우지 않는다.
- 권한·지원 여부가 없어도 앱은 그대로 돈다(카드가 정본).

**알려진 동작(결함 아님)**

- 중복 차단은 **한 탭 안**만이다 — 탭을 둘 열면 탭마다 1건씩 뜬다. `tag` 가 `approval:<id>` 로 같아 알림 센터에서는 겹치지만(`renotify` 기본 false) 소리는 브라우저에 달렸다.
  Phase 2 ④ 웹푸시는 「탭당 1건, tag 동일」을 전제로 하면 된다.
- 새로고침 직후 **이미 대기 중이던** 승인은 울리지 않는다. 구독 ack 의 `pendingApprovals` 는 카드를 되살리는 길이지 알림 경로가 아니다 — 알림은 `approval.requested` 프레임에만 달렸다.

### 5.5 상태

승인은 런 스토어와 별도로 `approvalStore`(zustand)에 채널별로 둔다. 승인이 들어오는 길은 둘 — 구독 ack 의 `pendingApprovals`(`syncPending`)와 wire `approval.requested`/`resolved`(`apply`)다. 활동 탭은 스토어를 읽기만 한다. 만료는 클라이언트 시계로 계산해 표시만 바꾸고, 서버 사실이 오면 덮어쓴다.

그래서 **클라이언트 시계로 만료된 짧은 순간에는 화면 글(「만료됨」)과 `data-status`(아직 `pending`)가 어긋난다** — 서버가 정본이고 그 사실이 오면 맞춰진다.
평상시에는 한 프레임 안에 따라잡히고, 서버가 끊긴 동안에는 오래 간다. **선택자·단언은 `data-status` 가 아니라 보이는 글로 짠다.**

타임라인의 툴 행과 승인을 잇는 것은 **승인 레코드(스토어)** 다. 실물 요구 짝 순서에서는 런 이벤트 `APPROVAL_REQUESTED` 가 `toolCallId` 를 잃을 수 있어,
런 이벤트만 보면 이음이 끊긴다(계약은 바꾸지 않았다 — 태스크 6 판정).

## 6. 오류 처리

| 원인 | 화면 |
| --- | --- |
| `approval.resolve` ack 실패 | 4.4 표의 코드별 문구 토스트, 카드는 잠금 해제 |
| 승인 대기 중 wire 끊김 | 기존 재연결 배너. 재연결하면 구독 ack 의 `pendingApprovals` 로 카드를 다시 맞춘다 |
| 끊긴 동안 승인이 `no-route` 로 만료 | 카드가 「만료됨(연결 끊김)」. 운영 문서에 「Gateway 연결이 끊기면 에이전트 툴이 막힌다」를 적는다 |
| 런 없는 승인 | 카드만, 활동 탭에서는 「런 없음」 묶음 |
| 타임라인 조회 실패 | 패널 안 상태 문구 + 「다시 시도」(전역 토스트와 이중 표시 금지 — `meta: { silent: true }`) |

## 7. 검증

- **단위·통합(가짜 Gateway)**: 요청 → 저장 → wire 중계, 승인 → Gateway RPC → 런 재개, 거절 → 툴 오류로 이어짐, 만료(`timeout`), `allowedDecisions` 밖 값이 서버에서 막힘, 재접속 `approvalReplay` 복구, 런 중단 시 `cancelled`, 두 경로 중복 제거.
- **`dev:fake`**: 키워드 「승인」 대본을 더한다 — 툴 호출 중 승인을 요구하고, 허용하면 이어가고 거절하면 오류로 끝난다. TTL 은 짧게(20초) 둬 만료도 볼 수 있게 한다.
- **브라우저 검증(워커)**: 활동 탭 런 목록·타임라인·접기, 승인 카드 두 자리·카운트다운·허용·거절·만료, 알림 권한 켜기와 도착, 390px, 콘솔 오류 0.
- **실물(선택)**: 스파이크에서 실물 승인을 이미 한 번 봤다. 필요하면 모델 런 1회로 「승인 → 런 재개」만 다시 본다.

## 8. Phase 1 이월 정리 (이 프로젝트에 끼워 넣는다) — **완료**(태스크 0·1, 2026-09-20)

**서버**: `channel.created` wire 이벤트 추가(다른 탭에 새 채널이 보이게) · 시스템 메시지 조사 병기형(「@dev 이(가)」) · `CONFLICT` 에 `details.field`(핸들 vs `providerAgentId`) · `GET /auth/me` 에 워크스페이스 이름.

**웹**: 목록 뷰포트가 줄 때 끝에 다시 붙기(스크롤러 `ResizeObserver`) · 서버가 끊은 소켓 재연결에 백오프 · vite `advancedChunks` → `codeSplitting` · 큰 테스트 파일 둘 분할 · `@streamdown/cjk` 적용.

**도구**: `wire-cli` 를 루트 typecheck 에 편입(웹이 wire 계약을 타입으로 쓴다).

## 9. 완료 기준

1. 에이전트가 승인이 필요한 툴을 부르면 카드가 뜨고, 허용하면 런이 이어지고 거절하면 오류로 이어지며, 120초가 지나면 만료로 바뀐다 — 가짜 Gateway 통합 테스트와 `dev:fake` 브라우저 검증 모두에서.
   → **확인**: 통합 시나리오 9a~9f(`apps/server/test/integration/approvals.test.ts`) · 브라우저 검증 시나리오 2·3·4(p2-t10). `dev:fake` 의 TTL 은 20초로 줄여 만료를 볼 수 있게 했다.
2. 활동 탭에서 런 목록과 툴 타임라인을 보고, 인자·결과를 펼칠 수 있다. → **확인**: 브라우저 검증 시나리오 1.
3. 알림을 켠 사용자는 다른 채널을 보고 있어도 승인 요구를 받는다. → **처음엔 도달 불가였다**(브라우저 검증 D1) — 팬아웃을 워크스페이스 룸으로 옮겨 고쳤다(4.6). 재검증은 p2-t13.
4. 8장 이월이 모두 정리되고 루트 네 검사가 통과한다. → **확인**: 아홉 건 모두 정리, 루트 네 검사 exit 0(테스트 1381).

## 10. 열린 문제 (범위 밖 기록)

- `exec`·`system-agent` 종류 승인과 `allow-always`·`cancelled` 는 아직 실물을 못 봤다(스파이크 9장). 모양이 같다고 보고 구현하되, 실연에서 보이면 확인한다.
- 승인 정책(`ask`)을 앱에서 켜는 UI — 설정 자리가 셋이고 합성 규칙(`security=min, ask=max`)이 있다. 별도 설계.
- 웹푸시(Phase 2 ④)가 들어오면 알림 트리거를 한곳으로 합친다.

## 11. 구현과 맞춘 것 (2026-09-21)

구현·리뷰·브라우저 검증에서 이 설계와 달라진 결정만 모았다. 정본 근거는 실행 원장(`.superpowers/sdd/2026-09-20-activity-approvals/ledger.md`)의 판정 기록이다.

**계약·서버**

- **중지 때 이벤트 순서는 보장되지 않는다**(Ruling A) — 로컬 abort 신호와 Gateway `aborted` 프레임이 경주한다. **순서에 기대는 화면을 만들지 않는다.** 통합 테스트는 모든 승인 프레임 순서를 전역으로 뒤집어도 같은 결과가 나오는 것으로 이 불변을 잠갔다.
- **만료의 `decision`**(Ruling B) — 두 경로(Gateway 확정·서버 감시) 모두 `deny` + `reason: "timeout"` 이다. **취소(`cancelled`)는 `decision` 을 비운다** — 제공자가 보고한 결정만 담는다. 화면은 `status` 가 정본이다.
- **승인 중복은 버리지 않고 병합한다**(Ruling C) — 같은 `providerApprovalId` 가 두 경로로 오므로, 나중에 온 프레임이 **빈 칸을 채우면** 행을 갱신하고 **다시 발행**한다(`toolCallId` 는 정본 프레임에만 있다). 「같으면 무시」로 두면 보조 프레임이 먼저 온 경우 툴 이음이 영영 안 생긴다.
- **런 상관은 `findOpenRunBySession`**(세션 FIFO 맨 앞) — 설계 초안의 「가장 최근에 시작한 런」이 아니다(4.2).
- **상한 초과 입력은 fail-open** — 계약 길이 상한을 넘어도 승인을 버리지 않는다. 승인이 통째로 사라지면 사용자는 카드도 못 보고 TTL 이 끝난 뒤 만료만 본다. 다만 **필드에 따라 다르다**: 보여 주는 값(`title`·`description`·`detail`·`toolName`·`pluginId`·`urlPath`)은 **잘라서** 끝에 `…` 를 붙이고, 상관 키 `toolCallId` 는 **자르지 않고 통째로 버린다** — 잘린 id 는 어느 툴 호출과도 안 맞으므로 없는 셈 치고 채널 수준 승인이 된다.
- **요구·확정은 워크스페이스 룸으로 낸다**(Ruling 7) — 4.6. 초안의 「채널 룸」으로는 5.4·완료 기준 3 이 도달 불가였다.
- **`cancelForRun` 은 런의 terminal 전이 *전에*** 부른다 — 뒤에 부르면 `APPROVAL_RESOLVED` 신호가 드롭된다.
- **런 없는 승인**도 저장한다(채널 수준). 서버 재기동 중 대기하던 승인은 메모리의 `resumeTo` 가 사라져 `tool` 로 가정한다 — 잘못 가정해도 다음 신호가 상태를 맞춘다.

**웹**

- **툴 행과 승인을 잇는 정본은 승인 레코드(스토어)** 다 — 런 이벤트가 아니다(5.5). 실물 요구 짝 순서에서 `APPROVAL_REQUESTED` 가 `toolCallId` 를 잃기 때문이고, 계약은 바꾸지 않았다.
- **활동 패널의 바깥 틀은 `app/layout/PanelTabs`** 가 맡는다 — 설정 패널과 같은 셸을 나눠 쓴다. 탭을 옮겨도 머리가 살아 있어야 초점이 `<body>` 로 떨어지지 않는다(브라우저 검증 D3). 셸의 선택자는 `data-testid="page-channel-panel"`(두 탭 공용 — 옛 이름 `page-channel-settings` 는 활동 탭에도 붙어 오해를 샀다).
- **종료를 한 번 본 런은 목록에 붙들어 둔다** — 끝난 런은 몇 초 뒤 런 스토어에서 빠지는데 REST 재조회는 그보다 늦어, 그 틈에 선택이 옛 런으로 넘어가고 `key` 리마운트로 펼침·스크롤이 날아갔다(D2·D9).
- **재구독 ack 의 `pendingApprovals` 는 미해결의 정본**이다 — 목록에 없는 로컬 `pending` 은 닫는다(D8). 단 **ack 직전에 도착한 승인은 지우지 않는다**: 서버가 룸 join 뒤 스냅샷을 읽는 순서 때문에 방금 받은 요구가 ack 에 없을 수 있어, `emitAck` 전에 찍은 목록으로 지울 후보를 좁힌다.
- **진행 중 런의 소요는 `useNowTick` 로 흐른다** — 흐르는 값이 하나도 없으면 타이머를 걸지 않는다(D7).
- **확정·만료 안내에만 `aria-live="polite"`** 를 붙인다 — 카운트다운 span 에는 붙이지 않는다(1초마다 읽히면 못 쓴다).

**범위에서 뺀 것**

- **런 목록의 「툴 수」**(Ruling 6) — 5.2. 계약에 없고 세려면 런마다 REST 한 번이다.
- **승인 정책(`ask`)을 앱에서 켜는 UI** — 10장 그대로 범위 밖. 실물에서 승인을 보려면 CLI 로 켠다(`docs/guides/live-smoke.md` 8절).

**남긴 것** — `docs/plan.md` 8장 「이월」: D4(확정 순간 카드 점프) · D6(카운트다운 둘이 1초 어긋남) · D11(로그아웃 전이 401, Phase 1 유래) · 다른 채널의 미해결 승인이 새로고침 뒤 안 돌아옴(4.6).
사람만 확인할 수 있는 것(소리·OS 알림 클릭·권한 팝업·잠금 화면·VoiceOver)은 `docs/guides/live-smoke.md` 9절.
