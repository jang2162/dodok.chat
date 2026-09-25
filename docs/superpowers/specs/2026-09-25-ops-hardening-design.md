# Phase 3 ③ 운영 보강(비용 상한·레이트리밋·안정성·운영 화면) 설계

**상태**: 설계 확정(2026-09-25), 구현·브라우저 검증·Compose 검증 완료(2026-09-25 — 계획 태스크 1~8, 브라우저 11/12 결함 고친 뒤 재검증, 테스트 2762) — 구현이 이 설계와 달라진 것은 「구현과 맞춘 것」 장(판정 R1 「다시 실행」 = 컴포넌트 버튼 등). usage 판정은 `docs/adr/0005-usage-values.md`, 실연은 `docs/guides/live-smoke.md` 16절, 운영 절차는 `docs/guides/deploy.md` 「운영 화면」 절
**범위**:
- 런 수 상한 두 겹(채널 일일 한도를 모든 런으로, 워크스페이스 일일 상한 신설)과 usage 값 진단
- 인증 없는 입구와 로그인 뒤 경로의 레이트리밋, `/healthz` 축소
- 안정성: 처리 안 된 예외·비정상 종료 표지·Gateway 버전 드리프트·디스크 여유·끊김 사건·로그 로테이션·로그 가림·실패한 런 다시 실행
- 운영 사건 기록(`ops_events`)과 owner 전용 운영 화면

**앞선 근거**:
- 계획서 `docs/plan.md` 8장 Phase 3 「에러/재시도·레이트리밋·비용 상한, 로그·메트릭」, 2장 「비용 통제」, 9장 리스크 「에이전트 간 릴레이 무한 루프·비용 폭주」, 8장 「이월」의 usage 값 줄·Gateway 버전 드리프트 줄
- Phase 3 ① 스펙 `2026-09-24-deploy-packaging-design.md`, Phase 3 ② 스펙 `2026-09-24-setup-wizard-design.md`(owner 전용 API·`setup.status` wire 꼴을 따른다), `docs/guides/deploy.md` 「보안」
- `docs/guides/live-smoke.md` 「런 0회 하네스」(가짜 claude CLI)와 usage 값 문제를 적은 절

---

## 0. 결정 (브레인스토밍 2026-09-25)

| # | 결정 | 까닭 |
| --- | --- | --- |
| 1 | **관측은 앱 안 운영 화면(owner 전용)이다.** Prometheus·외부 스택은 두지 않는다 | 1인 셀프호스팅이다. 외부 스택을 띄우지 않아도 「어젯밤 무슨 일이 있었나」에 답해야 한다. |
| 2 | **알림은 운영 화면에만 남긴다** — 푸시·웹훅은 없다. 사이드바 배지로 알아챈다 | 사용자 선택. 운영 사건마다 폰이 울리는 것은 원하지 않는다. |
| 3 | **운영 데이터는 DB 에 둔다** — 사건은 새 테이블 `ops_events`, 숫자는 `runs` 집계. 메모리 카운터·로그 파싱은 쓰지 않는다 | 재시작해도 이력이 남고 백업에 들어간다. 새 의존성이 없다. 로그 형식을 계약으로 만들지 않는다. |
| 4 | **비용 상한은 런 수다.** 금액 상한은 이번에 만들지 않고, usage 값이 틀리는 원인만 모델 런 1~2회로 가린다 | usage 값이 틀린 채로 금액 상한을 두면 엉뚱한 때 멈추거나 안 멈춘다. 런 수는 틀릴 수 없다. |
| 5 | **워크스페이스 일일 런 상한의 기본값은 300** — 비우면 무제한 | 새 배포부터 폭주에 안전망이 있다. 개인 사용으로는 닿기 어려운 값이다. |
| 6 | **레이트리밋 상태는 서버 메모리에 둔다** | 서버 프로세스가 하나다. 재시작하면 풀리는 것은 받아들인다. |

---

## 1. 범위

**한다**
- 채널 `dailyRunLimit` 이 사람 멘션·자동 응답·컴포넌트 상호작용·다시 실행이 만든 런까지 센다
- 워크스페이스 일일 런 상한과 그 설정 화면
- 한도에 걸리면 채널 시스템 메시지(하루 한 번)와 사건
- usage 진단 스파이크(모델 런 1~2회, 사용자 승인 뒤) — 결과는 ADR
- 레이트리밋: `/api/auth/*`, `/bridge` 핸드셰이크·`/bridge/attachments` 실패 카운터, 로그인 뒤 REST 사용자별 상한, wire 이벤트 소켓별 토큰 버킷, 사용자당 소켓 수 상한
- `/healthz` 를 `{ok, db}` 로 줄이고 상세는 owner API 로
- 처리 안 된 예외 핸들러, 비정상 종료 표지, Gateway 버전 드리프트, 디스크 여유 검사, 1분 넘는 끊김 사건
- compose 로그 로테이션·`TRUST_PROXY` 고정, 로그 가림 보강, 운영 로그 줄의 `event` 필드
- 실패한 런 「다시 실행」
- `ops_events`·ops API·`ops.event` wire·웹 운영 화면·사이드바 배지

**하지 않는다**
- 금액·토큰 상한(진단 결과를 보고 따로 정한다)
- 푸시·웹훅 운영 알림, Prometheus `/metrics`
- 푸시 발송 재시도
- 여러 프로세스가 나눠 쓰는 레이트리밋 상태
- Caddy 접근 로그

---

## 2. 구조

### 2.1 서버 — `apps/server/src/modules/ops/`

- `store.ts` — `ops_events` 읽기·쓰기. `record(workspaceId, {kind, key, severity, detail})` 는 묶기 규칙(3.1)을 적용하고 열린 줄 또는 새 줄을 돌려준다. `resolve(workspaceId, kind, key, detail)` 는 끊김 사건을 닫는다. `ack(workspaceId, upTo)`, `list(cursor, severity)`, `unackedCounts()`, `sweep(olderThan)`.
- `service.ts` — 다른 모듈이 부르는 입구(`ops.record`·`ops.resolve`). 기록한 뒤 owner 소켓에 `ops.event` 를 보낸다. 로그에도 `event: "ops.<kind>"` 줄을 남긴다.
- `budget.ts` — 런 수 상한 판정(3.2). 런을 만드는 모든 경로가 이 관문 하나를 지난다.
- `health.ts` — 디스크 검사 타이머, 비정상 종료 표지, Gateway 버전 기억.
- `routes.ts` — `/api/v1/ops/*`(6장), owner 만.
- `limits.ts` — 레이트리밋 숫자(4장)를 한곳에 둔 상수.

### 2.2 DB — 마이그레이션 0005

- 새 테이블 `ops_events`
  - `id`, `workspace_id`, `kind`, `severity`(`info`·`warn`·`error`), `key`, `detail_json`, `count`, `first_at`, `last_at`, `resolved_at`(끊김 사건), `acked_at`
  - 인덱스 `(workspace_id, last_at)`, `(workspace_id, kind, key, acked_at)`
- `workspaces.ops_json` 열(기본 `{}`) — `{ dailyRunLimit?: number | null, lastGatewayVersion?: string }`. `dailyRunLimit` 키가 **없으면 300**, `null` 이면 무제한.

### 2.3 shared

- `SystemKind` 에 `run_limit`. 시스템 메시지 `detail` 에 `{ scope: "channel" | "workspace", limit: number }`.
- `OpsEvent`·`OpsStatus`·`OpsRunsSummary`·`OpsSettingsPatch` 스키마(Zod), 사건 `kind` 열거.
- wire: 서버→클라이언트 `ops.event`(owner 만), 클라이언트→서버 `run.retry {runId}`(ack 로 새 runId). 오류 코드 `RATE_LIMITED`·`RUN_LIMIT`.

### 2.4 어댑터 — `packages/openclaw-adapter`

- 브리지 실패 카운터(4.1)를 어댑터에 두고, 핸드셰이크와 서버의 `/bridge/attachments` 인증이 같은 카운터를 쓴다.
- Gateway·브리지 연결 상태 변화를 서버가 들을 수 있게 둔다(1분 넘는 끊김 판정은 서버 `ops`).

### 2.5 웹 — `apps/web/src/features/ops/`

- `/settings/operations` 페이지, 사이드바 「운영」(「연결」 옆)과 배지.
- 작성기의 `RATE_LIMITED` 실패 문구, `run_error` 시스템 메시지의 「다시 실행」 버튼, `run_limit` 시스템 메시지의 owner 전용 「운영에서 한도 바꾸기」 링크.

### 2.6 infra

- `infra/compose.yml`: `app`·`caddy` 에 `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }`, `app.environment` 에 `TRUST_PROXY: "true"`.

---

## 3. 비용 상한과 사건

### 3.1 운영 사건 묶기·보존

- 같은 워크스페이스의 같은 `kind`+`key` 줄이 **확인 전(`acked_at` 없음)이고 `last_at` 이 1시간 안**이면 새 줄을 만들지 않고 `count`·`last_at` 만 올린다. 확인한 뒤에 다시 나면 새 줄이다.
- 끊김 사건(`gateway_down`·`plugin_down`)은 `resolved_at` 이 채워지기 전까지 열린 한 줄이다. 복구되면 `resolved_at` 과 `detail.downMs` 를 적는다. 닫힌 뒤 다시 끊기면 새 줄이다.
- `last_at` 이 30일 지난 줄은 부팅 때와 하루 한 번 지운다.
- `detail_json` 에는 id·코드·수치만 넣는다. 메시지 본문·토큰·호스트 경로는 넣지 않는다. IP 는 IPv4 /24, IPv6 /48 로 줄인다.

| kind | severity | key | 언제 |
| --- | --- | --- | --- |
| `gateway_down` | warn | `gateway` | Gateway 연결이 60초 넘게 끊김(복구 때 닫힘) |
| `plugin_down` | warn | `plugin` | 플러그인 브리지가 60초 넘게 끊김(복구 때 닫힘) |
| `gateway_version_changed` | warn | `gateway` | 접속 때 받은 버전이 `lastGatewayVersion` 과 다름 |
| `gateway_version_untested` | info | `gateway:<버전>` | 받은 버전이 저장소 핀(서버가 빌드한 `@openclaw/gateway-client` 버전)과 정확히 같지 않음 |
| `run_limit` | warn | `workspace` 또는 `channel:<id>` | 한도 때문에 런을 만들지 않음 |
| `run_failed` | warn | `agent:<id>` | 런이 `error` 로 끝남(`detail.code`) |
| `ratelimit` | info | 경로 또는 이벤트 이름 | 레이트리밋이 걸림(`detail.ipPrefix`) |
| `bridge_auth_blocked` | warn | `bridge` | 브리지 실패 카운터가 주소를 막음 |
| `crash_rejection` | error | `process` | `unhandledRejection` |
| `crash_exception` | error | `process` | `uncaughtException`(기록 뒤 종료) |
| `unclean_shutdown` | warn | `process` | 부팅 때 직전 종료가 깨끗하지 않았음 |
| `disk_low` | warn 또는 error | `data` | 디스크 여유가 임계값 아래(5.4) |

### 3.2 런 수 상한

- **관문 하나**: 라우터(멘션·자동 응답·릴레이), 컴포넌트 상호작용, 다시 실행 — 런을 만드는 모든 경로가 `budget.admit(channelId, n)` 을 지난다. 돌려받은 수만큼만 런을 만든다.
- **세는 것**: 서버 현지 자정 이후 만들어진 런(상태 무관). 한도로 막혀 만들지 않은 런은 세지 않는다.
- **순서**: 워크스페이스 상한을 먼저, 그다음 채널 `dailyRunLimit`. 둘 중 하나라도 넘으면 막는다.
- **막혔을 때**
  - 런을 만들지 않는다.
  - 그 채널에 오늘 같은 `scope` 의 `run_limit` 시스템 메시지가 없으면 하나 남긴다: 「오늘 런 한도(N)에 도달했습니다 — 내일 0시에 풀립니다」(scope 가 channel 이면 「이 채널의」를 붙인다).
  - 사건 `run_limit` 을 기록한다.
  - 이어가기 버튼은 없다. 웹은 owner 에게만 「운영에서 한도 바꾸기」 링크를 붙인다.
- 릴레이의 기존 차단 사유(`disabled`·`pair_not_allowed`·`max_turns`·`repeat`)는 그대로이고, `daily_limit` 사유는 관문의 판정으로 옮긴다.
- `TZ` 가 「하루」의 경계를 정한다. `docs/guides/deploy.md` 의 `.env` 표에 적는다.

### 3.3 usage 진단 (스파이크)

- dev Gateway 에서 모델 런 1~2회(사용자 승인 뒤), `OPENCLAW_FRAME_DUMP_PATH` 로 원본 프레임을 남기고 우리 `runs.usage_json` 과 대조한다.
- 결과는 ADR 0005 로 남긴다: 값이 맞는가, 틀리면 어느 층(claude-cli 스냅숏·Gateway 매핑·어댑터 매핑)인가.
- **맞으면** `/api/v1/ops/runs` 에 토큰·금액 합계를 켜고 운영 화면에 열을 보인다. **틀리면** 그 필드를 빼고 화면에 「측정 불가 — ADR 0005」를 보인다. 어댑터 매핑 층의 오류면 이번 범위에서 고친다. 그 밖의 층이면 이월한다.

---

## 4. 레이트리밋

숫자는 `modules/ops/limits.ts` 한곳에 둔다. 키는 로그인 전에는 `request.ip`(`TRUST_PROXY` 를 따른다), 로그인 뒤에는 사용자 id 다.

### 4.1 인증 없이 닿는 입구

| 입구 | 상한 | 넘으면 |
| --- | --- | --- |
| `POST /api/v1/auth/local` | IP 당 분당 5(지금 그대로) | 429 |
| `/api/auth/*`(Better Auth) | IP 당 분당 30 | 429 |
| `/bridge` 핸드셰이크 | **실패만 센다** — 한 주소가 60초에 10번 틀리면 그 주소를 60초 동안 토큰 검사 없이 거절 | 핸드셰이크 거절, 사건 `bridge_auth_blocked` |
| `/bridge/attachments` | 핸드셰이크와 같은 실패 카운터 | 막힌 주소는 429 |
| `/healthz` | 없음 | 응답을 `{ok, db}` 로 줄인다(상태 코드 규칙은 그대로) |

- 성공한 인증은 카운터를 비우지 않는다. 막힌 주소에서 오는 정상 토큰도 60초 동안은 거절된다.
- 실패 카운터가 기억하는 주소는 최대 1024개, 넘으면 가장 오래된 것부터 버린다.

### 4.2 로그인 뒤

- REST `/api/v1/*`: 사용자당 분당 300. 첨부 업로드(`POST /api/v1/attachments` 류)는 분당 30. 넘으면 429 `{code: "RATE_LIMITED"}`.
- wire 이벤트 — 소켓마다 토큰 버킷:

| 이벤트 | 분당 | 연속 |
| --- | --- | --- |
| `message.send`·`component.interact`·`run.abort`·`run.retry`·`run.events.replay` | 30 | 10 |
| `approval.resolve` | 60 | 20 |
| `typing`·`presence.update` | 120 | 30 |

- 넘으면 ack `{ok:false, code:"RATE_LIMITED"}`. ack 없는 이벤트(`typing`·`presence.update`)는 조용히 버린다.
- 사용자당 동시 wire 소켓 20개. 넘는 새 연결은 핸드셰이크에서 `RATE_LIMITED` 로 거절한다.
- 레이트리밋이 걸리면 사건 `ratelimit`(key 는 경로 또는 이벤트 이름)을 남긴다. 묶기 규칙 덕에 폭주도 한 줄이다.

---

## 5. 안정성

### 5.1 처리 안 된 예외·비정상 종료

- `unhandledRejection`: error 로그 + 사건 `crash_rejection`, 계속 돈다.
- `uncaughtException`: error 로그 + 사건 `crash_exception` 을 **동기로** 쓴 뒤 기존 종료 경로로 내리고 종료 코드 1. compose `restart: unless-stopped` 가 다시 올린다.
- 종료 표지: 부팅 때 `DATA_DIR/run-state.json` 에 `{clean: false, startedAt}` 을 쓰고, 깨끗한 종료(SIGINT·SIGTERM 경로 끝) 때 `clean: true` 로 바꾼다. 부팅 때 파일이 있고 `clean: false` 면 사건 `unclean_shutdown`.

### 5.2 Gateway 버전 드리프트

- 어댑터가 접속할 때 받은 `gatewayVersion` 을 `workspaces.ops_json.lastGatewayVersion` 에 둔다. 다르면 사건 `gateway_version_changed {from, to}`.
- 저장소 핀과 정확히 같지 않으면 사건 `gateway_version_untested`(버전마다 한 번). 운영 화면과 연결 페이지의 Gateway 줄에 「저장소가 검증한 버전(<핀>)과 다릅니다」.

### 5.3 끊김 사건

- Gateway 연결 또는 플러그인 브리지가 60초 넘게 끊겨 있으면 사건을 연다. 60초 안에 돌아오면 남기지 않는다. 복구되면 같은 줄을 닫는다(3.1).
- 서버가 막 부팅해 아직 한 번도 붙지 않은 상태도 60초가 지나면 같은 사건이다.

### 5.4 디스크 여유

- 부팅 때와 10분마다 `fs.statfs(DATA_DIR)` 로 잰다.
- 여유가 1 GiB 미만 **또는** 5% 미만이면 `disk_low` warn, 256 MiB 미만이면 error.
- 256 MiB 미만이면 첨부 업로드(사람·브리지 둘 다)를 507 `{code: "INSUFFICIENT_STORAGE"}` 로 거절한다 — SQLite 가 쓸 자리를 남긴다.

### 5.5 로그

- compose 로그 로테이션(2.6) — 서비스당 최대 50 MB.
- 가림 목록에 `set-cookie`·`*.*.*.token`·`req.headers["x-*-token"]` 꼴을 더한다(pino redact 가 받는 경로로 풀어 적는다).
- 사건을 기록하는 줄에 `event: "ops.<kind>"` 필드를 붙인다 — `grep '"event":"ops.'` 한 번으로 모인다.

### 5.6 실패한 런 다시 실행

- `run_error` 시스템 메시지에 「다시 실행」. 그 채널의 사람 멤버 누구나 누른다.
- wire `run.retry {runId}`: 원래 런이 `error` 로 끝났을 때만. 같은 트리거(트리거 종류·메시지 또는 상호작용·`rootMessageId`·`relayDepth`)로 새 런을 만들고 `parentRunId` 에 원래 런을 적는다. 관문(3.2)을 다시 지난다.
- 원래 런을 `parentRunId` 로 가리키는 런이 이미 있으면 새로 만들지 않고 그 runId 를 돌려준다(두 번 누름·두 탭).
- 버튼은 누르면 비활성, 다시 실행 런이 있으면 「다시 실행함」.

---

## 6. API·wire (모두 owner 만, 아니면 403)

| 경로 | 내용 |
| --- | --- |
| `GET /api/v1/ops/status` | 서버 버전·가동 시간·직전 종료 상태, DB 파일 크기, 디스크 여유·임계 상태, Gateway 상태·버전·핀·드리프트, 플러그인 상태, 오늘 런 수와 워크스페이스 상한, 확인 안 한 사건 수(`{warn, error}`) |
| `GET /api/v1/ops/runs?days=1\|7` | `runs` 집계 — 채널별·에이전트별 런·실패(`error`)·중지(`aborted`)·한도 차단(`run_limit` 사건 count) 수. usage 가 맞으면(3.3) 토큰·금액 합계 |
| `GET /api/v1/ops/events?cursor&severity` | 사건 목록, `last_at` 내림차순, 페이지 50 |
| `POST /api/v1/ops/events/ack` | 지금까지의 사건을 모두 확인 처리 |
| `PATCH /api/v1/ops/settings` | `{dailyRunLimit: number \| null}` — 1~10000 또는 `null`(무제한) |

- 기존 어댑터 상세(`/healthz` 에서 뺀 것)는 `ops/status` 에 들어간다.
- wire `ops.event {event, unacked}` 는 owner 소켓에만 간다(`setup.status` 와 같은 방으로).

---

## 7. 운영 화면 — `/settings/operations`

- **상태 카드**: 연결(Gateway·플러그인), 버전(드리프트 한 줄), 디스크 여유, 직전 종료. 문제가 있는 줄만 강조한다.
- **런 표**: 「오늘 / 7일」 전환. 채널별·에이전트별 런·실패·중지·차단. 채널 이름을 누르면 그 채널로 간다. usage 가 맞으면 토큰·금액 열.
- **한도**: 워크스페이스 일일 상한 입력(비우면 무제한), 오늘 사용량 막대. 채널별 한도는 채널 설정에 있다는 링크.
- **최근 사건**: 심각도 필터, 「모두 확인」. 한 줄 = `kind` 의 고정 문구 + count + 마지막 시각(끊김은 끊긴 시간). 더 보기로 다음 페이지.
- **배지**: 사이드바 「운영」 옆에 확인 안 한 warn·error 수(99+). `ops.event` 로 실시간.
- member 는 사이드바에 「운영」이 없고, 직접 주소는 「권한이 없습니다」.
- 390px 에서 표는 가로 스크롤 없이 카드 목록으로 바뀐다.

---

## 8. 보안

- ops API·`ops.event` 는 owner 만(설정 마법사와 같은 `requireOwner`).
- 사건·집계에 메시지 본문·토큰·호스트 경로·IP 전체가 없다.
- `/healthz` 는 워크스페이스 id·어댑터 상세를 내놓지 않는다.
- 레이트리밋 키는 `TRUST_PROXY=true` 일 때만 XFF 를 따른다. compose 가 그 값을 고정하고, Caddy 가 클라이언트 XFF 를 덮는 전제(`docs/guides/deploy.md` 「보안」)를 그대로 쓴다.

---

## 9. 오류 처리

| 상황 | 동작 |
| --- | --- |
| 사건 기록이 실패(DB 오류) | 로그 error 한 줄로 끝낸다. 원래 동작(런 판정·연결 처리)을 막지 않는다 |
| `run.retry` 대상이 `error` 가 아님 | ack `{ok:false, code:"VALIDATION"}` |
| `run.retry` 가 한도에 걸림 | ack `{ok:false, code:"RUN_LIMIT"}`, 시스템 메시지 규칙(3.2)은 그대로 |
| `statfs` 실패 | 디스크 상태 「알 수 없음」, 업로드 거절 안 함, warn 로그 |
| `run-state.json` 읽기·쓰기 실패 | warn 로그, 부팅 계속 |
| `PATCH ops/settings` 범위 밖 | 400 `VALIDATION` |

---

## 10. 테스트·검증

- **서버 단위**: 사건 묶기(1시간 창·확인 뒤 새 줄·끊김 열고 닫기)와 30일 정리, 관문(모든 트리거 종류·워크스페이스 먼저·하루 한 번 메시지·기본 300·`null` 무제한), 토큰 버킷, 브리지 실패 카운터(성공은 세지 않음·1024 상한), 다시 실행(한 번만·한도 재검사·대상 상태), 버전 드리프트, 디스크 임계(`statfs` 주입), 종료 표지.
- **서버 통합**(가짜 Gateway·플러그인): 워크스페이스 상한 도달 → 사람 멘션도 막힘 → 시스템 메시지 1회 → 사건 1줄 / `/bridge` 무차별 대입 → 막힘 → 60초 뒤 정상 토큰 통과 / wire 폭주 → `RATE_LIMITED` / 런 실패 → 다시 실행 → `parentRunId` / Gateway 60초 넘는 끊김 → 사건 열림 → 복구로 닫힘 / `ops.event` 는 owner 소켓에만 / `/healthz` 가 id 를 내놓지 않음.
- **웹 단위**: 운영 페이지(상태·표·한도·사건·390px), 배지, 작성기 `RATE_LIMITED` 문구, 「다시 실행」, owner 링크.
- **브라우저 검증**(`dev:fake`): 개발 전용 훅(사건 주입·가짜 Gateway 끊기·디스크 임계 흉내)을 더해 390·1280px.
- **로컬 Compose**: 로그 로테이션 설정이 컨테이너에 먹는지(`docker inspect`), `TRUST_PROXY` 로 XFF 위조가 레이트리밋을 우회하지 못하는지, `/healthz` 축소.
- **실연**(dev Gateway): 런 0회 하네스로 한도 차단·다시 실행. usage 진단은 3.3(모델 런 1~2회).

---

## 11. 완료 기준

- 워크스페이스·채널 한도가 모든 런에 먹는다.
- 밖에서 두드려도(로그인·Better Auth·브리지) 로그와 CPU 가 폭주하지 않는다.
- 운영 화면에서 「어젯밤 무슨 일이 있었나」에 답할 수 있다 — 끊김·실패·차단·비정상 종료·디스크.
- usage 원인이 가려졌다(맞든 틀리든 ADR 0005).
- 서버 통합·웹 단위·브라우저 검증 결함 0, 검사 4종 통과, 실연 통과.

---

## 12. 열린 문제 (범위 밖 기록)

- 금액·토큰 상한 — ADR 0005 결과를 보고 정한다.
- 운영 사건 푸시·웹훅 알림.
- 푸시 발송 재시도.
- 여러 서버 프로세스가 나눠 쓰는 레이트리밋 상태.
- 레이트리밋 상한 숫자를 화면에서 바꾸기(지금은 상수).

---

## 13. 구현과 맞춘 것 (2026-09-25)

구현(계획 태스크 1~8)·리뷰·브라우저 검증과 그 수정 라운드에서 이 설계와 달라지거나 설계가 정하지 않은 것을 정한 자리만 모았다. main `99d9f6b` 기준이다.
정본 근거는 실행 원장 `.superpowers/sdd/2026-09-25-ops-hardening/ledger.md`(git 제외)의 판정 R1~R6·R3b 와, 원장이 가리키는 보고서·리뷰(`o3-t*`·`o3-c1`)다. 보고서의 커밋 해시는 워크트리 것이라 main 에서는 다르다 — 아래 해시는 main 의 것이다.
운영 절차는 `docs/guides/deploy.md` 「운영 화면」 절, usage 판정은 `docs/adr/0005-usage-values.md`, 실연은 `docs/guides/live-smoke.md` 16절, 남은 문제는 `docs/plan.md` 8장 「이월」 한곳에 있다. 각 파일이 왜 그렇게 생겼는지는 그 파일의 머리 주석이 정본이다.

**런 관문·다시 실행(태스크 2 — `5931f9c`·`c4b2c5b`·`c777646`)**

- **R1 — 「다시 실행」은 wire `run.retry` 가 아니라 run_error 시스템 메시지의 1회용 컴포넌트 버튼이다**(2.3·4.2·5.6·9장 정정). 버튼 id `retry_run`(`RETRY_RUN_ITEM`)을 `component.interact` 로 누르면 components 서비스가 원래 런의 트리거 메시지로 `parentRunId` 를 단 새 런을 만든다. 1회 소비·결과 줄(「@owner — 다시 실행」)·권한(채널의 사람 멤버)·wire 레이트리밋(heavy 버킷)을 components 에서 그대로 물려받는다 — 그래서 5.6 의 「이미 있으면 그 runId 를 돌려준다」 대신 두 번째 누름은 `CONSUMED`(웹 「이미 처리되었습니다」)이고, 「다시 실행함」 대신 결과 줄이 남는다. 9장의 오류도 `component.interact` 의 ack 다 — 대상이 `error` 가 아니거나 트리거가 없으면 `VALIDATION`, 한도면 `RUN_LIMIT`. shared 에 `run.retry` 는 없다. 틀리면 wire 이벤트 하나를 더해 되돌린다.
- **버튼은 트리거 메시지가 있는 런에만 붙는다** — 상호작용·이어가기 런은 다시 만들 트리거가 없다. **봇 루프 보호(`DROPPED:bot-loop-protection`)로 떨어진 런에도 없다** — 다시 실행해도 플러그인이 같은 사유로 떨어뜨린다(o3-t2 리뷰 D1). run_error 는 전처럼 `TIMEOUT`·`ADAPTER_UNAVAILABLE`·`ADAPTER_PROTOCOL`·`DROPPED:*`·`ADAPTER_ERROR:*` 에만 난다 — `dev:fake` 대본의 「실패」(코드 `unknown`)는 카드를 만들지 않는다.
- **버튼 수명은 24시간(components 계약 `ttlMs` 상한)이다**(`c4b2c5b`). 기본 30분이면 한도에 막혀 버튼을 남겨 둔 사람이 한도가 풀린 뒤 누를 수 없다. 24시간도 「다음 날」을 다 덮지는 못한다 — 막힌 뒤 24시간 넘게 지나면 사람이 다시 멘션한다(이월).
- **R2 — 다시 실행은 사람의 행위다.** 이어가기처럼 릴레이 턴 상한·반복 감지는 다시 보지 않는다. 쌍 허용(`allowPairs`)은 이어가기로도 못 뚫는 차단이므로, relay 런을 다시 실행하면 원래 쌍(트리거 메시지를 쓴 에이전트 → 대상)을 지금 정책으로 다시 판정하고 막히면 `VALIDATION`(버튼은 남는다). 쌍 판정은 라우터와 같은 `isPairAllowed` 다. 대상 에이전트가 비활성이거나 채널에서 빠졌으면 `VALIDATION`(미소비).
- **관문의 모양은 `admit(channelId, n)` 이 아니라 `RunGate.check(channelId)`·`enqueue(plan, trigger)`**(2.1·3.2 구체화, `modules/ops/budget.ts` 의 `createRunGate`). 라우터·components 가 `orchestrator.enqueueRun` 대신 `gate.enqueue` 를 부르고, decide 의 `daily_limit` 사유·`todayRunCount` 는 없어졌다 — 그래서 채널 `dailyRunLimit` 이 릴레이뿐 아니라 사람 멘션·자동 응답에도 걸린다.
- **상호작용의 순서는 검사 → 관문 → 저장·소비다.** 트랜잭션 밖에서 검사(`NOT_FOUND`→`EXPIRED`→`FORBIDDEN`→`CONSUMED`→`VALIDATION`)를 한 번 돌고, `gate.check` 에 막히면 `RUN_LIMIT`(소비하지 않는다 — 한도가 풀리면 다시 누른다), 통과하면 트랜잭션 안에서 다시 검사하고 저장·소비한다. 관문을 맨 앞에 두면 이미 소비·만료된 버튼에도 `RUN_LIMIT` 과 한도 알림이 난다. 관문을 트랜잭션 안에서 부르면 던질 때 롤백이 관문이 남긴 시스템 메시지까지 지운다.
- **「오늘 이미 남겼나」는 시스템 메시지의 `created_at` 으로 가린다** — `createSystemMessage` 에 선택 인자 `createdAt` 을 더해 관문이 자기 시계를 넘긴다(주입한 `now` 로 자정 경계를 재는 테스트).
- **`RUN_LIMIT` 의 HTTP 상태는 429**(`RELAY_LIMIT` 은 409 그대로). 다시 실행 런에는 `triggerInteractionId` 가 없다 — 누가 눌렀는지는 run_error 카드의 결과 줄에만 있다.

**사건 저장소·서비스(태스크 1 — `6e3b740`·`57063e0`·`1f9e43d`, 태스크 4 의 N3)**

- **`ops_events` 는 `OpsService` 로만 쓴다** — 확인 안 한 수(`unacked`)를 메모리에 두고 새 줄·심각도 상승·ack·sweep 때만 다시 센다. 라우트·dev:fake 훅도 `app.ops` 를 거친다.
- **같은 줄의 emit·로그는 1초 창으로 모은다**(`OPS_EMIT_COALESCE_MS`). 창이 없을 때의 기록은 즉시, 창 안에서 묶이기만 한 기록은 창 끝에 마지막 상태로 한 번(로그에 `coalesced: n`). 새 줄·심각도 상승·resolve·ack 는 창 안이어도 즉시. DB count 는 매번 정확하다. 그래서 웹은 같은 줄의 `ops.event` 를 최대 1초 늦게 받는다.
- **R3b — 레이트리밋이 걸릴 때마다 사건 DB 쓰기(select+update) 한 번은 받아들인다**(이월에 고칠 방향).
- **저장 전 모양 검사** — `key`·`detail` 이 shared `OpsEvent` 모양(평평한 원시값, 200자)을 어기면 저장하지 않고 `ops record rejected`(error, key 는 로그에 싣지 않는다) 뒤 null. 묶을 때·resolve 때는 합친 detail 을 한 번 더 본다. key 는 라우트 패턴·wire 이벤트 이름처럼 고정된 값이다 — ratelimit 은 `rest:<라우트 패턴>`·`wire:<이벤트>`(소켓 상한은 `wire:connect`).
- **묶을 때 detail 은 합치고 심각도는 높은 쪽을 남긴다** — `disk_low` 가 오류 → 주의로 회복돼도 확인 전까지 그 줄은 오류다(이월).
- **끊김 사건의 열린 줄은 `resolved_at IS NULL` 이면 확인 여부와 무관하다.** resolve 는 `last_at` 도 닫은 때로 올린다(목록 맨 위, 보존 기준도 복구 시각).
- **ack 는 확인한 줄마다 `ops.event`** 를 보낸다(unacked 는 마지막 상태로 같다).
- **N3 — `close()` 뒤의 record** 는 DB·로그·emit 을 즉시 하고 창·타이머를 열지 않는다(종료 도중 `uncaughtException` 기록이 타이머를 남기지 않게).
- `workspaces.ops_json` 은 drizzle json 모드가 아닌 text — 망가진 값을 `{}` 로 읽고 warn 하려고. 패치는 모르는 키를 보존하고 범위 밖이면 저장하지 않고 400.

**레이트리밋·`/healthz`(태스크 3 — `8880da7`·`fadec00`)**

- **R3 — `run.events.replay` 는 자기 버킷 {분당 120, 연속 30} 이다**(4.2 표 정정). 웹이 채널 입장·재접속·resync 때 활성 런마다 스스로 부르므로, heavy 를 나눠 쓰면 채널 몇 번 오가는 것만으로 `message.send` 가 막혔다(실측). 지금 heavy 는 `message.send`·`component.interact`·`run.abort`(다시 실행은 `component.interact`)이다. 브라우저 검증에서 네 채널 48번 전환 뒤 곧바로 보낸 메시지가 성공했다.
- **REST 상한은 컨텍스트가 아니라 앱 데코레이션 `request.server.restLimits` 로 찾는다** — `requireSession` 을 부르는 라우트 모듈이 여럿이라, 컨텍스트로 넘기면 하나만 빠뜨려도 그 라우트만 조용히 상한이 없다. 데코레이션은 스코프 플러그인에도 물려받아진다. 세션을 확인한 뒤 센다.
- **첨부 업로드 상한은 `onRequest`(세션 뒤)** — 5 MiB 본문을 받기 전에 거절한다.
- **검증 함수가 던진 거절(DB 오류)은 브리지 실패로 세지 않는다**(핸드셰이크·첨부 둘 다) — 플러그인 잘못이 아닌데 정상 주소가 막히지 않게. 거절 자체는 그대로다.
- **로컬 로그인 상한도 `LIMITS.localLoginPerMin` 에 있고, 걸리면 사건을 남긴다**(4.1 표의 「지금 그대로」 구체화). `/api/auth/*`·로컬 로그인의 `@fastify/rate-limit` 은 앱 시계를 따르지 않는다.
- **시계는 단조 시계다**(`monotonicNow` — `AppDeps.limitClock` 기본). 벽시계가 뒤로 가면 버킷 빚·창 연장·막힘 연장이 생겼다(o3-t3 리뷰 M1). 주입한 시계가 역행해도 늘지 않게 보충·창을 막았다. `perMin: 0` 은 모두 거절이다.
- **사용자당 소켓 상한은 느슨하다** — 동시에 도착한 핸드셰이크는 방에 들기 전이라 서로를 못 봐 조금 넘을 수 있다.
- **`/healthz` 는 `{ok, db}`**(200 `{"ok":true,"db":"ok"}`, DB 실패 503). 워크스페이스 id·어댑터 상세는 `ops/status` 로 옮겼다.

**안정성(태스크 4 — `4b33041`·`0c2b844`)**

- **R4 — `downMs` 는 실제로 끊긴 때부터다.** 줄은 끊긴 지 임계(60초) 뒤에 열리므로 record 가 `detail.thresholdMs` 를 싣고 resolve 가 `downMs = 닫은 때 − first_at + thresholdMs` 로 계산한다(상태가 DB 에 있어 앞 프로세스가 연 줄도 맞다). `firstAt` 은 줄이 열린 때이고, 웹은 「끊긴 때」를 `firstAt − detail.thresholdMs` 로 보인다.
- **`stop_grace_period: 15s`**(2.6 보탬). 앱의 종료 상한(`PROCESS_EXIT_TIMEOUT_MS`·`APP_CLOSE_TIMEOUT_MS` 10초)과 Docker 기본 유예가 같아, 닫기가 오래 걸리면 SIGKILL 이 먼저 와 깨끗한 종료 표지를 못 쓸 수 있었다.
- **처리기는 `src/process-handlers.ts`**(main.ts 는 최상위 스크립트라 테스트하려고 뺐다). `uncaughtException` 은 로그 두 줄(스택 줄 + 사건 줄 — 둘 다 `"event":"ops.crash_exception"`)이고, 사건을 close **전에** 동기로 쓴다. `listen` 실패(포트 충돌)도 Node 24 ESM 에서는 `uncaughtException` 으로 와 같은 길로 내려가고 다음 부팅에 `unclean_shutdown` 이 뜬다.
- **Gateway 핀은 `packages/openclaw-adapter/src/version.ts` 의 상수 `OPENCLAW_PINNED_VERSION`**(5.2 구체화) — package.json 의 정확 핀과 같은지 테스트가 본다. `gateway_version_untested` 는 버전을 key(`gateway:<버전>`)에만 싣는다.
- **`run_failed` 는 부팅 정리(`recoverOnBoot`)가 error 로 닫는 런도 센다** — 비정상 종료 뒤 부팅이면 `unclean_shutdown` 과 함께 뜬다. detail 은 `code` 만(200자).
- **디스크 507 의 순서** — 사람 업로드는 세션 → 업로드 상한 → 디스크, 브리지 업로드는 브리지 인증 → 디스크, 모두 본문 전(onRequest). 인증 전이면 디스크 상태를 누구에게나 알려 주고, 상한 앞이면 507 을 받고 곧바로 다시 보내는 클라이언트가 상한을 쓰지 않는다. 부팅은 첫 측정을 기다린다(`disk.ready`).
- **로그 가림**(5.5 정정) — 깊이 0~3 의 token 류와 `set-cookie`(괄호 표기). `x-*-token` 꼴은 넣지 않았다 — 그런 헤더가 저장소에 없다(브리지 토큰은 `Authorization`·핸드셰이크 auth). 새로 만들면 `logger.ts` 에 이름을 적는다(redact 는 헤더 이름 와일드카드를 받지 못한다).

**ops API(태스크 5 — `e187dd1`)**

- **`OpsStatus` 에 `workspaceId`·`adapter`(AdapterStatus 그대로)·`blockedToday` 가 더 있다**(6장 보탬) — 앞 둘은 `/healthz` 에서 뺀 것의 자리, `blockedToday` 는 오늘 워크스페이스 상한으로 막힌 수(사건 count 합). 채널 한도 차단은 런 표 행의 `blocked` 다(에이전트 행은 늘 0).
- **런 표의 차단 수는 사건 표를 읽는 `OpsService.countsSince` 하나로** 센다 — 기간은 줄의 `last_at` 으로 가린다(1시간 창으로 묶인 줄이 기간 직전에 시작했으면 통째로 들어온다).
- **usage 합계의 출처는 저장 모양 `RunUsage`** 다(`inputTokens + outputTokens`, `costUsd`). R5 로 지금은 꺼져 있다.
- **모든 응답은 shared 스키마로 한 번 더 파싱**한다 — 어기면 500 `INTERNAL` 이고 어긴 값은 응답에 싣지 않는다. `SetupStatus.gateway` 에도 `pinned`·`drift` 가 들어가 연결 페이지가 같은 판정을 쓴다.
- `db.bytes` 는 `page_count × page_size`(체크포인트 전 WAL 은 빠진다).

**usage 진단(태스크 7 — `7a7c04c`)**

- **R5 — 진단 범위는 모델 런 1회 + 층별 값 하네스였다**(3.3 의 「1~2회」 중 1회로 충분 — 2026-09-20 덤프가 이미 갈랐고 9.5 에서 같은 모양이었다). 입력·캐시 토큰은 맞고, 출력 토큰은 `message_start` 스냅샷, 비용은 0 이다. 원인은 OpenClaw claude-cli 파서 층이라(어댑터 매퍼가 아니다) 이번 범위에서 고치지 않았다. `USAGE_TRUSTED = false` — 출력 토큰·비용이 CLI `result` 와 같을 때만 true 로 바꾼다. 그래서 `ops/runs` 행에 토큰·금액이 없고 운영 화면은 「토큰·금액은 측정 불가 — … (ADR 0005)」 한 줄이다. 판정·다시 재는 법·후속은 ADR 0005.

**웹(태스크 6 — `49d81e5`·`4949dbd`·`837534a`, o3-c1 — `44993e3`·`99d9f6b`)**

- **R6 — 상태 카드의 연결 두 줄(Gateway·플러그인)은 wire 어댑터 상태를 읽는다**(7장 구체화). wire 가 connected 이고 어댑터 캐시가 있으면 `useAdapterStatus`(배너·연결 점과 같은 캐시), 아니면 `ops/status` 값. 그 밖 칸은 `ops.event` 가 오면 `unacked` 를 곧바로 덮은 뒤 상태를 다시 받고, 운영 화면을 보는 동안 30초마다(`OPS_STATUS_POLL_MS`, 탭이 가려지면 쉰다) 다시 받는다. 사이드바 배지·좁은 화면 점은 주기 재조회를 하지 않는다. 브라우저 검증이 「사건 목록은 끊김 (지금도), 카드는 연결됨」을 찾아(D1) 정했다. 틀리면 주기만 조정한다.
- **wire 가 다시 붙으면 어댑터·운영 상태·사건 목록을 다시 받는다**(재검증 N1, `99d9f6b`) — 서버는 접속 때 `adapter.status` 를 보내지 않고 변화만 팬아웃하므로, 끊긴 사이 바뀐 상태를 놓쳐 낡은 「연결됨」이 보였다(배너·연결 점도). 첫 연결은 무효화하지 않는다.
- **채널별 한도는 링크가 아니라 안내 문장이다**(7장 「채널 설정에 있다는 링크」 정정) — 가리킬 채널이 하나가 아니다. 「채널별 한도는 각 채널 설정의 「릴레이 정책」에 있습니다」, 채널로 가는 길은 런 표의 채널 이름.
- **run_limit 시스템 메시지의 owner 링크는 범위를 따른다**(2.5 구체화) — workspace 면 「운영에서 한도 바꾸기」(`/settings/operations`), channel 이면 「채널 설정에서 한도 바꾸기」(`/c/<id>/settings`).
- **모르는 값은 폴백한다** — 모르는 사건 kind 는 「알 수 없는 사건 (kind)」, 모르는 severity 는 정보 아이콘과 원문 라벨, 모르는 SystemKind 는 정보 모양. 옛 PWA 가 새 서버의 값을 받아도 페이지 전체가 `RouteError` 로 떨어지지 않는다.
- **「모두 확인」 뒤 배지를 0 으로 덮지 않는다** — 서버는 ack 를 처리한 때까지만 확인하므로, 상태·목록을 다시 받아 서버 값으로 맞춘다.
- **사건 문구** — 런 한도 줄은 「(워크스페이스)」·「(#채널 이름)」·「(채널)」로 범위를 가른다(O2), 확인한 줄은 흐리게(O5), 끊긴 시간은 분 단위 반올림(최소 1분 — 임계가 60초라 늘 1분 이상).
- **좁은 화면 배지**(7장 보탬, O3) — 사이드바가 서랍이라 닫혀 있으면 배지가 안 보여, 메뉴 버튼에 빨간 점과 「채널 목록 열기 (확인 안 한 운영 사건 N)」.
- **문구** — `component.interact` 의 `RUN_LIMIT`·`RATE_LIMITED` 토스트가 한국어다(D2 — 전에는 서버 영어 문구). 첨부 업로드 507 은 본문과 무관하게 칩에 「서버 디스크 여유가 부족해 올리지 못했습니다」(O1).
- 쿼리 키는 `apps/web/src/api/queries.ts` 의 `qk`(opsStatus·opsRuns·opsEvents·opsEventsAll). ops 쿼리는 오프라인 사본에서 먼저 뺀다.

**dev:fake 운영 훅(태스크 8 앞 — `238af79`)**

- 10장 「개발 전용 훅」의 답: `POST /__devfake/ops/event`·`/__devfake/gateway`·`/__devfake/disk`, 끊김 임계 `DODOK_DEVFAKE_DISCONNECT_MS`, 종료 표지 `<dataDir>/dev-fake-run/`. 설명·호출 예는 `docs/project-structure.md` 의 `apps/server` 절. Gateway down 은 소켓 끊기가 아니라 connect 를 `UNAVAILABLE` 로 거절한다 — 끊기만 하면 `@openclaw/gateway-client` 가 자기 백오프(최대 30초)로 속에서 재시도해 어댑터 백오프(dev:fake 만 상한 1초 — `AppDeps.gatewayBackoff`)가 안 먹었다. 운영 코드에는 선택 입력 둘(`App.checkDisk`·`AppDeps.gatewayBackoff`)만 더했다. 기존 `plugin-token` 도 함께 비 JSON 415·경로 정확 일치가 됐다.

**검증이 확인한 것**

- 서버 통합 `apps/server/test/integration/ops-events.test.ts`·`ops-limits.test.ts`·`ops-ratelimit.test.ts`·`ops-health.test.ts`(10장 서버 통합 항목 — 60초는 가짜 타이머 단위 테스트, 통합은 줄인 임계 `disconnectEventMs`), 웹 단위, 태스크마다 독립 리뷰(변이)·수정·범위 재리뷰(태스크 5 리뷰는 구현과 같은 세션이 해 설계 판단의 독립성이 약하다 — 변이 결과만 객관 근거로 받았다).
- `dev:fake` 위 브라우저 검증 11/12(390·1280px — 확인 불가 1: member 화면, dev:fake 에 두 번째 사용자가 없다), 결함 D1·D2 와 관찰 O1·O2·O3·O5 를 고친 뒤 재검증, 재검증이 찾은 N1 을 고쳤다. 로컬 Compose(`LogConfig` json-file 10m×5·`StopTimeout 15`·`TRUST_PROXY=true`, XFF 를 바꿔도 여섯째 로그인 429, `/healthz` 키 둘, `stop` → `start` 뒤 `previousClean: true`).
- 실연(dev Gateway, 모델 런 0)은 `docs/guides/live-smoke.md` 16절.
- 테스트 2762(shared 151·plugin 112·adapter 252·server 992·web 1255 — 루트 `pnpm test` 의 패키지별 `Tests` 줄).
