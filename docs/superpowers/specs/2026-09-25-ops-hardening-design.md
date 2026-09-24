# Phase 3 ③ 운영 보강(비용 상한·레이트리밋·안정성·운영 화면) 설계

**상태**: 설계 확정(2026-09-25)
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
