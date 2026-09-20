# Phase 2 ① 활동 패널·승인 설계

**상태**: 승인 대기 · 2026-09-20 작성
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
2. 그 채널·에이전트의 **종료되지 않은 런**이 있으면 그 런에 붙인다. 여럿이면 가장 최근에 시작한 것.
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

통과하면 `approval.resolve` 를 호출하고, 응답의 terminal 스냅샷으로 행을 갱신한 뒤 `approval.resolved` 를 채널 룸에 보낸다. Gateway 가 `resolved` 이벤트도 따로 주므로 **id 로 중복 제거**한다(먼저 온 쪽이 이긴다).

### 4.5 진단

`frame-dump.ts` 의 `DUMPED_EVENTS` 에 `session.approval`·`plugin.approval.requested`·`plugin.approval.resolved`·`exec.approval.requested`·`exec.approval.resolved` 를 더한다. 지금은 승인이 덤프에 하나도 남지 않는다.

## 5. 웹

### 5.1 오른쪽 패널 탭

- 라우트 둘: `/c/$channelId/settings`(있음) · `/c/$channelId/activity`(새로). 패널 셸이 탭 머리(「설정」·「활동」)를 그리고 `<Outlet/>` 으로 내용을 바꾼다. 좁은 화면은 지금처럼 전체 화면 시트다.
- 활동 탭 기본 선택은 **가장 최근 런**. 채널을 옮기면 선택을 버린다.

### 5.2 런 목록과 타임라인

- 목록: `GET /channels/:id/runs`(최근 50) + 실시간 `run.state` 병합. 한 줄에 에이전트 핸들·상태 배지·시작 시각·소요·툴 수.
- 타임라인: `GET /runs/:id/events` + 실시간 `run.event`. 행은 툴 호출(이름·상태·소요), 단계(`STEP_*`), 서브에이전트(`SUBAGENT_*`), 승인, 오류. 텍스트 델타는 **타임라인에 넣지 않는다**(대화가 이미 보여 준다).
- 툴 인자·결과는 **접힘이 기본**. 펼치면 `<pre>` 로 보여 주고, `[+N chars hidden]` 표시가 있으면 「잘렸습니다」 한 줄을 붙인다.
- 런이 진행 중이면 맨 아래에 붙어 따라간다(메시지 목록과 같은 규칙).

### 5.3 승인 카드

- 자리 둘: 채널 메시지 흐름(시스템 카드 자리, 시간 순서) · 활동 탭 맨 위(고정). 같은 승인이므로 **하나의 스토어**를 본다.
- 내용: 제목(`title`), `severity` 색(info 회색·warning 주황·critical 빨강), 툴 이름, 접힌 인자, **남은 시간 카운트다운**(1초 간격, `expiresAt` 기준), 버튼은 `allowedDecisions` 에 있는 것만(`allow-once` 「이번만 허용」 · `allow-always` 「항상 허용」 · `deny` 「거절」).
- 누르면 잠그고 ack 를 기다린다. 실패는 코드별 문구를 토스트로(`CONFLICT` 「이미 처리되었거나 만료되었습니다」 · `VALIDATION` 「이 승인이 받지 않는 선택입니다」 · `FORBIDDEN` · `ADAPTER_UNAVAILABLE` 「Gateway 에 연결되지 않았습니다」).
- 확정되면 카드가 결과 한 줄로 바뀐다(「허용됨 · 방금」 / 「거절됨」 / 「만료됨」). 사라지지 않는다 — 기록이다.

### 5.4 브라우저 알림

- 트리거는 **승인 요구 하나뿐**이다(메시지·멘션 알림은 Phase 2 ④).
- 권한은 사용자가 사이드바 하단 「알림 켜기」를 누를 때만 요청한다. `denied` 면 버튼을 숨기고 다시 묻지 않는다.
- 내용: 「승인 필요 — @dev 가 Write 를 실행하려 합니다」. 누르면 그 채널로 이동하고 활동 탭을 연다. 탭이 이미 보이는 상태(`document.visibilityState === "visible"`)이고 같은 채널을 보고 있으면 띄우지 않는다.
- 권한·지원 여부가 없어도 앱은 그대로 돈다(카드가 정본).

### 5.5 상태

승인은 런 스토어와 별도로 `approvalStore`(zustand)에 채널별로 둔다. 들어오는 길 셋: 구독 ack 의 `pendingApprovals`, wire `approval.requested`/`resolved`, 활동 탭의 REST 조회. 만료는 클라이언트 시계로 계산해 표시만 바꾸고, 서버 사실이 오면 덮어쓴다.

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

## 8. Phase 1 이월 정리 (이 프로젝트에 끼워 넣는다)

**서버**: `channel.created` wire 이벤트 추가(다른 탭에 새 채널이 보이게) · 시스템 메시지 조사 병기형(「@dev 이(가)」) · `CONFLICT` 에 `details.field`(핸들 vs `providerAgentId`) · `GET /auth/me` 에 워크스페이스 이름.

**웹**: 목록 뷰포트가 줄 때 끝에 다시 붙기(스크롤러 `ResizeObserver`) · 서버가 끊은 소켓 재연결에 백오프 · vite `advancedChunks` → `codeSplitting` · 큰 테스트 파일 둘 분할 · `@streamdown/cjk` 적용.

**도구**: `wire-cli` 를 루트 typecheck 에 편입(웹이 wire 계약을 타입으로 쓴다).

## 9. 완료 기준

1. 에이전트가 승인이 필요한 툴을 부르면 카드가 뜨고, 허용하면 런이 이어지고 거절하면 오류로 이어지며, 120초가 지나면 만료로 바뀐다 — 가짜 Gateway 통합 테스트와 `dev:fake` 브라우저 검증 모두에서.
2. 활동 탭에서 런 목록과 툴 타임라인을 보고, 인자·결과를 펼칠 수 있다.
3. 알림을 켠 사용자는 다른 채널을 보고 있어도 승인 요구를 받는다.
4. 8장 이월이 모두 정리되고 루트 네 검사가 통과한다.

## 10. 열린 문제 (범위 밖 기록)

- `exec`·`system-agent` 종류 승인과 `allow-always`·`cancelled` 는 아직 실물을 못 봤다(스파이크 9장). 모양이 같다고 보고 구현하되, 실연에서 보이면 확인한다.
- 승인 정책(`ask`)을 앱에서 켜는 UI — 설정 자리가 셋이고 합성 규칙(`security=min, ask=max`)이 있다. 별도 설계.
- 웹푸시(Phase 2 ④)가 들어오면 알림 트리거를 한곳으로 합친다.
