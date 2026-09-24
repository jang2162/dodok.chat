# Phase 3 ③ 운영 보강 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** 1인 셀프호스팅 서버가 사람이 들여다보지 않아도 비용 폭주·외부 두드림·조용한 고장에 버티고, owner 가 운영 화면에서 「어젯밤 무슨 일이 있었나」에 답할 수 있게 한다.

**Architecture:** 새 서버 모듈 `ops` 가 운영 사건(`ops_events`, 같은 사건은 한 줄로 묶음)과 워크스페이스 운영 설정(`workspaces.ops_json`)을 맡는다. 런을 만드는 모든 경로는 `ops` 의 런 관문(`RunGate`)을 지나 채널·워크스페이스 일일 한도를 검사한다. 레이트리밋은 한 모듈의 토큰 버킷을 REST 인증 preHandler·wire 핸들러가 함께 쓰고, 브리지는 어댑터의 실패 카운터(`BridgeAuthGuard`)를 핸드셰이크와 첨부 HTTP 가 함께 쓴다. owner 전용 ops API 와 wire `ops.event` 를 웹 `features/ops/` 가 그린다.

**Tech Stack:** Fastify 5 · `@fastify/rate-limit` 11.2(이미 있음) · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Router/Query · Node 24 `fs.statfs` — **새 의존성 없음**

**Spec:** `docs/superpowers/specs/2026-09-25-ops-hardening-design.md` — 결정 0장, 구조 2장, 비용·사건 3장, 레이트리밋 4장, 안정성 5장, API 6장, 화면 7장, 보안 8장, 오류 9장, 검증 10장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.**

## Global Constraints

- **새 npm 의존성은 없다.**
- 사건 `detail_json`·집계·로그의 사건 줄에 **메시지 본문·토큰·호스트 경로·IP 전체가 없다.** IP 는 IPv4 /24(`203.0.113.0/24`), IPv6 /48 로 줄인다.
- 사건 묶기: 같은 워크스페이스·`kind`·`key` 이고 `acked_at IS NULL` 이고 `last_at` 이 **1시간(3_600_000ms)** 안이면 `count+1`·`last_at` 갱신. 끊김 사건(`gateway_down`·`plugin_down`)은 `resolved_at IS NULL` 인 동안 한 줄. 보존 **30일**.
- 워크스페이스 일일 런 상한: `ops_json.dailyRunLimit` 키가 **없으면 300**, `null` 이면 무제한, 설정 범위 **1~10000**. 「하루」는 서버 현지 자정(기존 `countRunsToday` 와 같다, `TZ` 가 정한다).
- 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳에만 쓴다(스펙 4장 값 그대로).
- 끊김 사건 임계 **60초**, 디스크 임계 여유 < 1 GiB **또는** < 5% → warn, < 256 MiB → error(+첨부 업로드 507), 디스크 검사 주기 **10분**.
- ops API·`ops.event` 는 **owner 만**(`requireOwner`), 아니면 403. 경로는 `/api/v1/ops/...`.
- 사건 기록 실패는 원래 동작을 막지 않는다 — 로그 error 한 줄로 끝낸다.
- 시크릿 규칙은 `docs/guides/live-smoke.md` 2절. 5173·3000 금지(웹 확인 5180, dev:fake 3100 류).
- **Docker 정리 규칙**: `docker … prune`(image·volume·system·builder, 필터가 있어도) 금지 — 자기가 만든 것만 이름·ID 로 지운다. 다른 compose 프로젝트는 읽기만. 시작·끝 스냅숏(`docker ps -a`·`volume ls`·`images -a`·`network ls`) 대조.
- 프로세스는 **자기가 띄운 PID 로만** 끈다(`pkill -f`·`killall` 금지).
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프. 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 **자기 실행 출력에서** 패키지별로(0개 실행은 통과가 아니다).

## Review Focus

1. **대화 도중 워크스페이스 한도에 닿은 owner** — 사람 멘션이 막혀도 메시지는 저장되고, 채널에 「오늘 런 한도(N)에 도달했습니다 — 내일 0시에 풀립니다」가 **하루에 한 번만** 뜨며, 자정이 지나면 같은 멘션이 다시 돈다. 채널 한도와 워크스페이스 한도가 같은 날 둘 다 걸리면 메시지는 scope 마다 하나. → 태스크 2(주입한 `now` 로 자정 경계 테스트).
2. **깜빡이는 연결** — Gateway·플러그인이 50초 끊겼다 붙기를 되풀이하면 사건 0줄. 60초를 넘기면 정확히 한 줄이 열리고, 붙으면 그 줄이 닫히며(`downMs`) 다음 끊김은 새 줄. → 태스크 4(가짜 타이머).
3. **토큰 교체 직후 옛 토큰으로 되풀이 접속하는 플러그인과 같은 주소의 정상 플러그인** — 10번 실패로 주소가 막히면 60초 동안은 정상 토큰도 거절되지만, **60초 뒤에는 저절로 통과**한다(플러그인 재접속 백오프 상한 10초라 약 70초 안에 붙는다). 막힘이 영구화되거나 성공이 카운터를 비우는 쪽으로 바뀌면 안 된다. → 태스크 3.
4. **빠르게 여러 번 보내다 레이트리밋에 걸린 사람** — 그 메시지는 「너무 빠르게 보내고 있습니다 — 잠시 뒤 다시」로 실패 표시되고, 「다시 보내기」는 같은 `clientMsgId` 라 **에이전트 런이 두 번 뜨지 않는다.** → 태스크 3(서버 ack)·6(웹 문구).
5. **「다시 실행」을 두 탭에서 동시에·두 번 누름, 한도에 걸린 채 누름** — 새 런은 하나(1회용 버튼 소비). 한도에 걸리면 버튼은 **소비되지 않고** `RUN_LIMIT` 로 거절돼 내일 다시 누를 수 있다. 트리거 메시지가 없는 런(상호작용·이어가기)의 실패에는 버튼이 없다. → 태스크 2.

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/common.ts`·`domain/index.ts`·`ops/index.ts`(새)·`wire/index.ts`·`index.ts` | 1 | 계약 |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/0005_*.sql` | 1 | `ops_events`·`workspaces.ops_json` |
| `apps/server/src/modules/ops/{store,service,settings,ip}.ts` | 1 | 사건·설정 |
| `apps/server/src/realtime/{bus,events}.ts`·`app.ts` | 1 | `ops.event` owner 팬아웃·정리 타이머 |
| `apps/server/src/modules/ops/budget.ts`·`router/{decide,service}.ts`·`components/service.ts`·`runs/orchestrator.ts`·`wiring.ts` | 2 | 런 관문·다시 실행 |
| `apps/server/src/modules/ops/{limits,ratelimit}.ts`·`auth/routes.ts`·`realtime/socket.ts`·`modules/attachments/routes.ts`·`app.ts` | 3 | 레이트리밋·`/healthz` |
| `packages/openclaw-adapter/src/bridge/{guard,server}.ts`·`index.ts` | 3 | 브리지 실패 카운터 |
| `infra/compose.yml` | 3·4 | `TRUST_PROXY`·로그 로테이션 |
| `apps/server/src/modules/ops/health.ts`·`main.ts`·`logger.ts`·`app.ts` | 4 | 예외·종료 표지·끊김·버전·디스크·로그 |
| `packages/openclaw-adapter/src/version.ts`(새) | 4 | 저장소 핀 상수 |
| `apps/server/src/modules/ops/{routes,summary}.ts` | 5 | ops API·집계 |
| `apps/web/src/features/ops/*`·`app/router.tsx`·`app/layout/Sidebar.tsx`·`realtime/handlers.ts`·`features/messages/{SystemCard,PendingItem}.tsx`·`features/composer/useSendMessage.ts`·`features/setup/sections.tsx` | 6 | 운영 화면·배지·문구 |
| `docs/adr/0005-*.md`·(맞으면) `modules/ops/summary.ts` 상수 | 7 | usage 진단 |
| `apps/server/scripts/dev-fake.ts` | 8 | 개발 전용 훅 |
| `docs/guides/{deploy,live-smoke}.md`·`docs/project-structure.md`·`docs/plan.md`·스펙 | 9 | 문서 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 계약·사건 저장소 | — |
| B | 2 런 관문·다시 실행 ‖ 3 레이트리밋 | 1 |
| C | 4 안정성 | 3(`app.ts`·첨부 라우트·compose 를 같이 만진다) |
| D | 5 ops API | 2·4 |
| E | 6 웹 운영 화면 ‖ 7 usage 진단 스파이크(모델 런 — 사용자 승인 뒤) | 5 |
| F | 8 dev:fake 훅 + 브라우저 검증 + Compose 확인 | 6 |
| G | 9 실연(런 0) + 문서 | 7·8 |

---

### Task 1: shared 계약 + 사건 저장소

**Files:**
- Modify: `packages/shared/src/common.ts`(ErrorCode), `packages/shared/src/domain/index.ts`(SystemKind·SystemMeta), `packages/shared/src/wire/index.ts`(`ops.event`), `packages/shared/src/index.ts`(re-export)
- Create: `packages/shared/src/ops/index.ts`, `packages/shared/test/ops.test.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`; Create: `apps/server/drizzle/0005_*.sql`(`pnpm -F @dodok/server exec drizzle-kit generate` — 이름은 생성기가 붙인다)
- Create: `apps/server/src/modules/ops/{store,service,settings,ip}.ts`, `apps/server/test/ops.store.test.ts`, `apps/server/test/ops.service.test.ts`
- Modify: `apps/server/src/realtime/bus.ts`·`events.ts`, `apps/server/src/app.ts`

**Interfaces:**
- Produces (shared):

```ts
// common.ts — ErrorCode 에 두 값을 더한다
"RUN_LIMIT", "INSUFFICIENT_STORAGE",

// domain/index.ts
export const SystemKind = z.enum(["relay_limit", "relay_denied", "run_error", "run_limit", "info"]);
export const SystemMeta = z.object({
  kind: SystemKind,
  relay: /* 그대로 */,
  runId: Id.optional(),
  /** run_limit: 막은 범위와 그 한도 */
  limit: z.object({ scope: z.enum(["channel", "workspace"]), limit: z.int().min(1) }).optional(),
});

// ops/index.ts
export const OpsEventKind = z.enum([
  "gateway_down", "plugin_down", "gateway_version_changed", "gateway_version_untested",
  "run_limit", "run_failed", "ratelimit", "bridge_auth_blocked",
  "crash_rejection", "crash_exception", "unclean_shutdown", "disk_low",
]);
export const OpsSeverity = z.enum(["info", "warn", "error"]);
export const OpsEvent = z.object({
  id: Id, kind: OpsEventKind, severity: OpsSeverity, key: z.string().max(200),
  detail: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])),
  count: z.int().min(1), firstAt: IsoDateTime, lastAt: IsoDateTime,
  resolvedAt: IsoDateTime.optional(), ackedAt: IsoDateTime.optional(),
});
export const OpsUnacked = z.object({ warn: z.int().min(0), error: z.int().min(0) });
export const OpsEventsPage = z.object({ events: z.array(OpsEvent), nextCursor: z.string().optional() });
export const OpsSettingsPatch = z.object({ dailyRunLimit: z.int().min(1).max(10_000).nullable() });
export const OPS_DEFAULT_DAILY_RUN_LIMIT = 300;
// OpsStatus·OpsRunsSummary 는 태스크 5 가 이 파일에 더한다

// wire — ServerToClientEvents
"ops.event": (p: { event: OpsEvent; unacked: OpsUnacked }) => void; // owner 사용자 룸에만
```

- Produces (server):

```ts
// modules/ops/service.ts
export type OpsRecordInput = { kind: OpsEventKind; key: string; severity: OpsSeverity; detail?: OpsEvent["detail"] };
export interface OpsService {
  /** 묶기 규칙을 적용해 열린 줄 또는 새 줄을 돌려준다. 실패하면 logger.error 후 null(던지지 않는다) */
  record(input: OpsRecordInput): OpsEvent | null;
  /** 열린 끊김 사건을 닫는다(resolved_at·detail.downMs). 열린 줄이 없으면 null */
  resolve(kind: "gateway_down" | "plugin_down", key: string, at?: Date): OpsEvent | null;
  ack(upTo?: Date): number;
  list(opts: { cursor?: string; severity?: OpsSeverity; limit?: number }): { events: OpsEvent[]; nextCursor?: string };
  unacked(): OpsUnacked;
  sweep(now?: Date): number; // last_at 이 30일 지난 줄 삭제
}
export function createOpsService(deps: { db: Db; bus: ServerBus; logger: Logger; workspaceId: string; now?: () => Date }): OpsService;

// modules/ops/settings.ts
export type OpsSettings = { dailyRunLimit: number | null; lastGatewayVersion?: string };
export function getOpsSettings(db: DbOrTx, workspaceId: string): OpsSettings; // 키 없음 → 300
export function patchOpsSettings(db: DbOrTx, workspaceId: string, patch: Partial<OpsSettings>): OpsSettings;

// modules/ops/ip.ts
export function ipPrefix(ip: string): string; // "203.0.113.7" → "203.0.113.0/24", IPv6 → /48, "::ffff:1.2.3.4" → IPv4 규칙
```

- `service.record`/`resolve`/`ack` 은 바뀐 줄마다 `bus.emit("ops.event", { event, unacked })`, 로그 `logger.info|warn|error({ event: \`ops.${kind}\`, key, count, ...detail }, "ops event")`(severity 를 로그 레벨로).
- `events.ts`: `setup.status` 의 owner 룸 계산(`ownerIds`)을 함수로 빼 `ops.event` 도 같은 방식으로 보낸다.

- [ ] **Step 1: shared 스키마 테스트** — `packages/shared/test/ops.test.ts`: `OpsEvent` 가 detail 의 객체·배열 값을 거절, `OpsSettingsPatch` 가 0·10001·소수를 거절하고 `null` 을 받음, `SystemMeta` 가 `limit.scope` 두 값만 받음, `SystemKind` 에 `run_limit`. 실패 확인 → 구현 → 통과.
- [ ] **Step 2: 마이그레이션** — `ops_events`(`id` text pk, `workspace_id` → workspaces, `kind`, `severity`, `key`, `detail_json`, `count` int default 1, `first_at`·`last_at`·`resolved_at`·`acked_at` ts, 인덱스 `ops_events_ws_last(workspace_id, last_at)`·`ops_events_open(workspace_id, kind, key, acked_at)`), `workspaces.ops_json` text not null default `'{}'`. `drizzle-kit generate` 로 SQL 생성(손으로 쓰지 않는다), 생성된 SQL 을 열어 두 변경만 있는지 본다.
- [ ] **Step 3: store·service 테스트(실패 먼저)** — `ops.store.test.ts`/`ops.service.test.ts`, 메모리 DB + 주입 `now`:
  - 같은 kind·key 를 59분 간격으로 두 번 → 1줄 `count 2`; 61분 뒤 → 새 줄; ack 뒤 곧바로 → 새 줄.
  - 다른 key → 다른 줄.
  - `gateway_down` 열린 줄이 있으면 2시간 뒤 record 도 같은 줄; `resolve` 뒤 record → 새 줄; `resolve` 는 `detail.downMs = resolvedAt - firstAt`.
  - `sweep`: `last_at` 30일+1ms 전 줄만 지운다.
  - `list`: `last_at` 내림차순, `limit` 50 기본, 커서로 다음 페이지, severity 필터.
  - `unacked`: warn·error 만 센다(info 는 세지 않음).
  - **폭주**: 1000번 record → 1줄 `count 1000`, `bus` emit 은 1000번이어도 된다(웹이 받는다) — 대신 DB 행은 1.
  - record 가 DB 오류(닫힌 DB)면 throw 하지 않고 null + logger.error.
  - `ipPrefix`: `203.0.113.7`→`203.0.113.0/24`, `2001:db8:1:2::5`→`2001:db8:1::/48`, `::ffff:198.51.100.9`→`198.51.100.0/24`, 빈 문자열·쓰레기 → `"unknown"`.
- [ ] **Step 4: 구현** — store(drizzle, 한 트랜잭션에서 「열린 줄 찾기 → 갱신 또는 삽입」), service, settings(`ops_json` 을 Zod 로 파싱 — 망가진 값이면 `{}` 로 보고 warn), ip.
- [ ] **Step 5: 팬아웃·배선** — `bus.ts` 에 `"ops.event"`, `events.ts` owner 룸 함수 공용화 + `ops.event`. `app.ts`: `createOpsService` 를 만들고 `Services`/앱 반환값에 노출(`app.ops`), 부팅 때 `sweep()` 한 번 + 24시간 `setInterval(...).unref()`(close 때 해제). 통합 테스트 하나: owner 소켓만 `ops.event` 를 받고 member 소켓은 못 받는다(설정 마법사의 `setup.status` 테스트 꼴을 따른다).
- [ ] **Step 6: 검사·커밋** — 루트 검사 4종. `feat(shared,server): 운영 사건 계약과 ops_events 저장소`.

---

### Task 2: 런 관문 + 다시 실행

**Files:**
- Create: `apps/server/src/modules/ops/budget.ts`, `apps/server/test/ops.budget.test.ts`, `apps/server/test/integration/ops-limits.test.ts`
- Modify: `apps/server/src/modules/router/{decide,service}.ts`, `apps/server/src/modules/components/service.ts`, `apps/server/src/modules/runs/{orchestrator,store}.ts`, `apps/server/src/wiring.ts`(RunPlan 은 `router/decide.ts` 에 있다 — `parentRunId` 를 거기 더한다), 기존 `decide` 테스트

**Interfaces:**
- Consumes: 태스크 1 `OpsService.record`, `getOpsSettings`, `SystemMeta.limit`, ErrorCode `RUN_LIMIT`.
- Produces:

```ts
// modules/ops/budget.ts
export type LimitHit = { scope: "channel" | "workspace"; limit: number };
export interface RunGate {
  /** 한도 안이면 null. 넘으면 LimitHit — 그 채널에 오늘 같은 scope 의 run_limit 시스템 메시지가 없으면 남기고 사건 run_limit 을 기록한다 */
  check(channelId: string): LimitHit | null;
  /** check 가 null 이면 orchestrator.enqueueRun, 아니면 null */
  enqueue(plan: RunPlan & { channelId: string }, trigger: EnqueueTrigger): Promise<Run | null>;
}
export function createRunGate(deps: {
  db: Db; bus: ServerBus; ops: Pick<OpsService, "record">; workspaceId: string;
  enqueue: Orchestrator["enqueueRun"]; now?: () => Date;
}): RunGate;

// runs/store.ts
export function countRunsTodayInWorkspace(db: DbOrTx, now: Date): number; // 서버는 워크스페이스 하나 — 전체 runs
// (기존 countRunsToday(db, channelId, now) 는 그대로)

// router/service.ts — RouterDeps.enqueue 를 RunGate["enqueue"] 로
// components/service.ts — InteractDeps 에 gate: RunGate(enqueue 대신)
export const RETRY_RUN_ITEM = "retry_run"; // run_error 시스템 메시지 버튼(router/service 의 CONTINUE_RELAY_ITEM 옆)
```

- **판정 순서**(스펙 3.2): 워크스페이스(`countRunsTodayInWorkspace >= limit`) → 채널(`channel.relayPolicy.dailyRunLimit` 이 있고 `countRunsToday >= 그 값`). 워크스페이스 설정이 `null` 이면 건너뛴다.
- 시스템 메시지: `createSystemMessage(db, bus, { channelId, kind: "run_limit", bodyMd, systemMeta: { kind: "run_limit", limit: hit } })`. 본문 — workspace: `오늘 런 한도(${limit})에 도달했습니다 — 내일 0시에 풀립니다`, channel: `이 채널의 오늘 런 한도(${limit})에 도달했습니다 — 내일 0시에 풀립니다`. 「오늘 이미 있음」은 그 채널의 `messages` 에서 `created_at >= 오늘 0시` 이고 `system_meta.kind = run_limit` 이고 `limit.scope` 가 같은 행으로 가린다.
- 사건: `ops.record({ kind: "run_limit", key: scope === "workspace" ? "workspace" : \`channel:${channelId}\`, severity: "warn", detail: { limit } })`.
- **라우터**: `decideRuns` 에서 `daily_limit` 사유와 `todayRunCount` 입력을 뺀다(관문으로 옮김 — 스펙 3.2). 라우터는 계획마다 `gate.enqueue` 를 부르고 `null` 이면 조용히 넘어간다(관문이 알렸다).
- **다시 실행 — 판정 R1(스펙 5.6 과 다름)**: 새 wire 이벤트 `run.retry` 대신 **run_error 시스템 메시지의 1회용 컴포넌트 버튼**(`RETRY_RUN_ITEM`, 라벨 「다시 실행」)으로 만든다. 까닭: 1회용 소비가 「한 번만·두 탭 동시」를 트랜잭션으로 이미 보장하고, 누가 눌렀는지 결과 줄·`component.interact` 레이트리밋·웹 렌더를 그대로 쓴다. 스펙 「구현과 맞춘 것」에 적는다(태스크 9).
  - `orchestrator.notifyRunError` 가 시스템 메시지를 만들 때, 그 런에 `triggerMessageId` 가 **있을 때만** `components: { blocks: [{ type: "actions", items: [{ type: "button", id: RETRY_RUN_ITEM, label: "다시 실행", style: "primary" }] }] }` 를 붙인다(재사용 아님 — 1회용).
  - `components/service.ts` `resolveTarget`: 시스템 메시지이고 `itemId === RETRY_RUN_ITEM` 이면 `systemMeta.runId` 의 런을 읽어 `{ agentId: run.agentId, triggerKind: "retry", run }` — 런이 없거나 `status !== "error"` 거나 `triggerMessageId` 가 없으면 `VALIDATION`.
  - **관문 먼저**: `interact` 는 트랜잭션 **전에** 대상 채널로 `gate.check(channelId)` 를 부르고 막히면 `apiError("RUN_LIMIT", …)` 로 던진다 — 상호작용을 저장·소비하지 않는다(Review Focus 5). 모든 상호작용 런(interaction·continue·retry)에 같은 선검사를 둔다.
  - retry 의 enqueue: `gate.enqueue({ agentId, channelId, triggerKind: run.triggerKind, rootMessageId: run.rootMessageId, relayDepth: run.relayDepth, parentRunId: run.id }, { message: getMessage(tx, run.triggerMessageId) })`. `RunPlan` 에 `parentRunId?: Id`, `enqueueRun` 이 `insertRun` 에 넘긴다.

- [ ] **Step 1: 관문 단위 테스트(실패 먼저)** — `ops.budget.test.ts`, 주입 `now`:
  - 키 없는 설정 → 300 에서 막힘(299 번째 통과, 300 번째 막힘).
  - `null` → 1000개여도 통과.
  - 워크스페이스·채널 둘 다 넘으면 `scope: "workspace"`.
  - 같은 날 두 번 막힘 → 시스템 메시지 1개(scope 별), 사건은 1줄 `count 2`.
  - 23:59:59 에 막힘 → 00:00:00(다음 날, 그날 런 0개)에 통과, 그날 첫 막힘에 메시지가 다시 생긴다(Review Focus 1).
  - 채널 한도만 걸린 채널 A 와 걸리지 않은 채널 B — B 는 통과.
- [ ] **Step 2: 라우터·decide 테스트 갱신** — `daily_limit` 관련 decide 테스트는 관문 테스트로 옮기고, 라우터 테스트에 「사람 멘션·자동 응답이 워크스페이스 한도에 막힘 → 런 0·메시지 저장됨·시스템 메시지 1」.
- [ ] **Step 3: 다시 실행 테스트(실패 먼저)** — 서버 통합 `integration/ops-limits.test.ts`(가짜 Gateway·플러그인, 기존 `integration/` 도우미):
  - 디스패치 실패로 끝난 멘션 런 → run_error 메시지에 「다시 실행」 버튼 → `component.interact` → 새 런 `parentRunId = 원래`, `triggerMessageId` 같음.
  - 같은 버튼 두 번째 → `CONSUMED`; 두 소켓 동시 → 새 런 1개.
  - 워크스페이스 한도를 채운 상태에서 누름 → ack `RUN_LIMIT`, 상호작용 행 0, 버튼 미소비; 한도를 올리면(`patchOpsSettings`) 다시 눌러 통과.
  - 이어가기 런(트리거 메시지 없음)이 실패한 run_error 메시지 → `components` 없음.
  - 워크스페이스 한도 도달 → 사람 멘션 → 런 0 · 시스템 메시지 1 · 사건 1줄.
- [ ] **Step 4: 구현** — budget.ts, store `countRunsTodayInWorkspace`, router·components·orchestrator·wiring(`createRunGate` 를 wiring 에서 만들어 라우터·상호작용에 준다), `RunPlan.parentRunId`.
- [ ] **Step 5: 검사·커밋** — 루트 검사 4종. `feat(server): 런 관문 — 채널·워크스페이스 일일 한도와 다시 실행`.

---

### Task 3: 레이트리밋 + `/healthz` 축소

**Files:**
- Create: `apps/server/src/modules/ops/{limits,ratelimit}.ts`, `apps/server/test/ops.ratelimit.test.ts`, `apps/server/test/integration/ops-ratelimit.test.ts`
- Create: `packages/openclaw-adapter/src/bridge/guard.ts`, `packages/openclaw-adapter/test/bridge-guard.test.ts`
- Modify: `packages/openclaw-adapter/src/bridge/server.ts`(옵션 `authGuard`), `packages/openclaw-adapter/src/index.ts`(export)
- Modify: `apps/server/src/auth/routes.ts`(`requireSession` 버킷·`/api/auth/*` 상한), `apps/server/src/realtime/socket.ts`, `apps/server/src/modules/attachments/routes.ts`, `apps/server/src/app.ts`(healthz·가드 배선), `apps/server/test/app.healthz.test.ts`, `infra/compose.yml`(`TRUST_PROXY: "true"`)

**Interfaces:**
- Consumes: `OpsService.record`, `ipPrefix`.
- Produces:

```ts
// modules/ops/limits.ts — 스펙 4장 숫자의 유일한 자리
export const LIMITS = {
  betterAuthPerMin: 30,
  restPerMin: 300,
  uploadPerMin: 30,
  wire: {
    heavy: { perMin: 30, burst: 10 },   // message.send·component.interact·run.abort·run.events.replay
    approval: { perMin: 60, burst: 20 }, // approval.resolve
    chatter: { perMin: 120, burst: 30 }, // typing·presence.update
  },
  socketsPerUser: 20,
  bridgeFail: { maxFailures: 10, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 },
} as const;

// modules/ops/ratelimit.ts
export class TokenBucket { constructor(opts: { perMin: number; burst: number; now?: () => number }); take(): boolean }
export class KeyedLimiter { // 키별 고정 창(분당 N) — REST
  constructor(opts: { perMin: number; maxKeys?: number; now?: () => number });
  take(key: string): boolean;
}

// adapter bridge/guard.ts
export class BridgeAuthGuard {
  constructor(opts?: { maxFailures?: number; windowMs?: number; blockMs?: number; maxAddresses?: number });
  isBlocked(address: string, nowMs: number): boolean;
  /** 실패 하나를 센다. 이번 실패로 막히기 시작했으면 true */
  fail(address: string, nowMs: number): boolean;
}
// BridgeServerOptions 에 authGuard?: BridgeAuthGuard, onBlocked?: (address: string) => void
```

- **REST**: `requireSession` 이 사용자를 확인한 뒤 `ctx.restLimiter?.take(userId)` 가 false 면 `apiError("RATE_LIMITED", "요청이 너무 많습니다")`(429 — `HttpError` 상태 매핑 확인). 첨부 업로드 핸들러는 그 위에 `uploadLimiter.take(userId)` 한 번 더. 걸리면 `ops.record({ kind: "ratelimit", key: \`rest:${routePattern}\`, severity: "info", detail: { ipPrefix } })`.
- **Better Auth**: `auth/routes.ts` 의 `/api/auth/*` 라우트에 `config: { rateLimit: { max: LIMITS.betterAuthPerMin, timeWindow: "1 minute" } }`.
- **wire**: 소켓마다 버킷 셋(heavy·approval·chatter)을 `connection` 때 만든다. 핸들러 맨 앞에서 `take()` 가 false 면 ack 있는 이벤트는 `reply(ack, { ok: false, error: { code: "RATE_LIMITED", message: "too many requests" } })` 하고 끝, ack 없는 이벤트는 버린다. `message.send` 는 **저장 전에** 막는다(라우팅도 안 한다). 사건 key 는 `wire:<이벤트>`.
- **소켓 상한**: 인증 미들웨어에서 `io.in(userRoom(userId)).fetchSockets()` 수가 `LIMITS.socketsPerUser` 이상이면 `connectError("RATE_LIMITED", "too many connections")`.
- **브리지**: 핸드셰이크에서 `authGuard.isBlocked(address)` 면 토큰을 보지 않고 `UNAUTHORIZED` 로 거절(거절 로그 스로틀은 그대로). 검증 실패면 `authGuard.fail(address)`, true 면 `onBlocked(address)`. **성공은 카운터를 건드리지 않는다.** 서버 `modules/attachments/routes.ts` 의 `requireBridge` 도 같은 가드 인스턴스(`app.ts` 가 하나 만들어 둘에 준다) — 막힌 주소는 429, 실패는 `fail`. `onBlocked` → `ops.record({ kind: "bridge_auth_blocked", key: "bridge", severity: "warn", detail: { ipPrefix } })`.
- **`/healthz`**: `{ ok, db }` 만(상태 코드 규칙 그대로). `workspace`·`adapter` 는 태스크 5 의 `ops/status` 로 간다. `app.healthz.test.ts` 를 새 모양으로 고치고 「본문에 workspace·adapter 키가 없다」를 단언.
- **compose**: `app.environment` 에 `TRUST_PROXY: "true"`(`DODOK_PLUGIN_DIR` 옆, 같은 까닭의 주석).

- [ ] **Step 1: 버킷·가드 단위 테스트(실패 먼저)** — `TokenBucket`: burst 10 연속 통과 후 11번째 false, 2초(30/분 → 1토큰) 뒤 1개 통과. `KeyedLimiter`: 키마다 따로, 창이 지나면 다시, `maxKeys` 넘으면 가장 오래된 키 버림. `BridgeAuthGuard`: 60초 안 10번째 실패에서 `fail` 이 true·`isBlocked` true, 59.999초 뒤 여전히 막힘, 60초 뒤 풀림(Review Focus 3), 창 밖 실패는 새로 셈, 주소 1025개면 가장 오래된 것 버림, 성공 경로에는 API 가 없다(카운터를 비우는 메서드가 없음).
- [ ] **Step 2: 통합 테스트(실패 먼저)** — `integration/ops-ratelimit.test.ts`:
  - `message.send` 11번 연속 → 11번째 ack `RATE_LIMITED`, 저장된 메시지 10개, 런 10개 이하(라우팅 안 됨), 같은 `clientMsgId` 로 1분 뒤 다시 → 저장 1개 더(멱등 — Review Focus 4).
  - 틀린 토큰 10번 핸드셰이크 → 11번째는 정상 토큰도 거절 → 가짜 시계 60초 뒤 정상 토큰 통과. 같은 주소로 `/bridge/attachments` 틀린 토큰 → 막힌 뒤 429.
  - REST 301번째 요청 → 429 `RATE_LIMITED`(가짜 시계로 줄여도 된다 — `LIMITS` 를 주입 가능하게).
  - 같은 사용자 소켓 21번째 → `connect_error` `RATE_LIMITED`.
  - 레이트리밋이 수백 번 걸려도 `ops_events` 는 key 당 1줄.
  - `/healthz` 본문 키가 정확히 `ok`·`db`.
- [ ] **Step 3: 구현** — limits·ratelimit·guard·배선. `LIMITS` 는 `createApp` 의 `AppDeps.limits?: Partial<…>` 로 테스트가 줄일 수 있게.
- [ ] **Step 4: 검사·커밋** — 루트 검사 4종. `feat(server,adapter): 레이트리밋 — REST·wire·브리지 실패 카운터, /healthz 축소`.

---

### Task 4: 안정성

**Files:**
- Create: `apps/server/src/modules/ops/health.ts`, `apps/server/test/ops.health.test.ts`, `packages/openclaw-adapter/src/version.ts`, `packages/openclaw-adapter/test/version.test.ts`
- Modify: `apps/server/src/main.ts`, `apps/server/src/app.ts`(`watchGatewayReconnecting` 옆에 연결 감시·디스크 타이머·종료 표지·run_failed), `apps/server/src/logger.ts`, `apps/server/src/modules/attachments/routes.ts`(507), `infra/compose.yml`(logging), `apps/web` 없음

**Interfaces:**
- Consumes: `OpsService`, `patchOpsSettings`/`getOpsSettings`(`lastGatewayVersion`).
- Produces:

```ts
// adapter version.ts — 저장소 핀. 테스트가 package.json 의 @openclaw/gateway-client 버전과 같은지 본다
export const OPENCLAW_PINNED_VERSION = "2026.9.4";

// modules/ops/health.ts
export const DISCONNECT_EVENT_MS = 60_000;
export const DISK_CHECK_INTERVAL_MS = 600_000;
export type DiskState = { freeBytes: number; totalBytes: number; level: "ok" | "warn" | "error" } | { level: "unknown" };
export function diskLevel(freeBytes: number, totalBytes: number): "ok" | "warn" | "error";
/** Gateway·브리지 상태를 보고 60초 넘는 끊김에 사건을 열고 복구 때 닫는다. 부팅 직후 한 번도 안 붙은 상태도 60초 뒤 연다 */
export function watchConnections(adapter: Pick<AgentAdapter, "status" | "onEvent">, ops: Pick<OpsService, "record" | "resolve">, delayMs?: number): { close(): void };
/** 접속 때 받은 Gateway 버전을 기억과 핀에 대조해 사건을 남긴다 */
export function observeGatewayVersion(version: string | null, deps: { db: Db; workspaceId: string; ops: Pick<OpsService, "record"> }): void;
export function createDiskMonitor(deps: { dataDir: string; ops: Pick<OpsService, "record">; statfs?: (p: string) => Promise<{ bavail: bigint | number; bsize: bigint | number; blocks: bigint | number }>; intervalMs?: number }): { current(): DiskState; close(): void };
/** 부팅: 직전 표지를 읽고(clean:false 면 unclean_shutdown) 새 표지 {clean:false,startedAt} 를 쓴다. markClean 은 종료 끝에 */
export function startRunState(dataDir: string, ops: Pick<OpsService, "record">, logger: Logger): { markClean(): void; previousClean: boolean | null };
```

- **예외**(`main.ts`): `process.on("unhandledRejection", (err) => { logger.error({ err, event: "ops.crash_rejection" }, …); app.ops.record({ kind: "crash_rejection", key: "process", severity: "error", detail: { name } }) })` — 계속 돈다. `process.on("uncaughtException", …)` — 같은 기록(**동기 — better-sqlite3 라 record 가 동기다**) 뒤 기존 종료 경로(`app.close()` → `process.exit(1)`, 10초 상한 그대로). 깨끗한 종료(SIGINT·SIGTERM 경로에서 `app.close()` 가 끝난 뒤)에 `markClean()`.
- **연결 감시**: Gateway `status !== "connected"` 가 60초 이어지면 `record({kind:"gateway_down", key:"gateway", severity:"warn"})`, `connected` 가 되면 `resolve("gateway_down","gateway")`. 브리지 `down` 60초 → `plugin_down`/`plugin`. 60초 안 복구면 아무것도 안 남긴다(Review Focus 2). 기존 `watchGatewayReconnecting`(system.notice)은 그대로 둔다.
- **버전**: 어댑터 `setup` 이벤트 또는 `status` 가 connected 일 때 `setupDetail().gateway.version` 이 바뀌었으면 `observeGatewayVersion`. 기억(`lastGatewayVersion`)이 있고 다르면 `gateway_version_changed {from,to}`(warn), 핀과 다르면 `gateway_version_untested`(info, key `gateway:<버전>`), 그리고 기억 갱신.
- **디스크**: `fs.promises.statfs(DATA_DIR)` — free = `bavail*bsize`, total = `blocks*bsize`. `diskLevel`: free < 256 MiB → error, free < 1 GiB 또는 free/total < 0.05 → warn. warn·error 면 `record({kind:"disk_low", key:"data", severity: level, detail:{freeBytes}})`. 실패 → `unknown` + warn 로그. 첨부 업로드(사람·브리지)는 `current().level === "error"` 면 507 `INSUFFICIENT_STORAGE`(`httpStatusToErrorCode` 에 507 추가).
- **run_failed**: 버스 `run.state` 에서 `status === "error"` 로 **바뀐** 런마다 `record({kind:"run_failed", key:\`agent:${agentId}\`, severity:"warn", detail:{code}})`.
- **로그**: `SECRET_KEYS` 에 `set-cookie`, 경로 `*.*.*.<키>` 한 겹 더, `req.headers["x-*-token"]` 은 pino 가 와일드카드 헤더 이름을 못 받으므로 실제로 쓰는 헤더 이름(`x-bridge-token` 등 — grep 으로 찾는다)을 적는다. 테스트: 깊이 3 토큰·`set-cookie` 가 `***`.
- **compose**: `app`·`caddy` 에 `logging: { driver: json-file, options: { max-size: "10m", max-file: "5" } }`.

- [ ] **Step 1: 단위 테스트(실패 먼저)** — `ops.health.test.ts`(가짜 타이머):
  - 끊김 50초 → 붙음 → 50초 끊김 되풀이 5번 → 사건 0(Review Focus 2). 61초 → 1줄 열림, 붙으면 `resolvedAt`·`downMs`, 다시 61초 → 새 줄.
  - 부팅 뒤 한 번도 안 붙음 61초 → `gateway_down` 1줄.
  - `diskLevel`: 255 MiB→error, 900 MiB/100 GiB→warn, 3 GiB/100 GiB→warn(3%), 3 GiB/10 GiB→ok, `statfs` 던짐→unknown.
  - `observeGatewayVersion`: 처음 `2026.9.5` → untested 1줄·changed 0; 같은 값 다시 → 0; `2026.9.6` → changed 1(from·to)·untested 1(새 key).
  - `startRunState`: 파일 없음 → `previousClean null`·사건 0; `clean:false` 파일 → `unclean_shutdown` 1; `markClean` 뒤 다시 시작 → 0; 망가진 JSON → warn·사건 0·새로 씀.
  - `version.test.ts`: `OPENCLAW_PINNED_VERSION === pkg.dependencies["@openclaw/gateway-client"]`.
- [ ] **Step 2: 통합 테스트** — 가짜 Gateway 를 61초(가짜 시계) 끊음 → `ops_events` 1줄·owner 소켓 `ops.event` → 다시 붙임 → 닫힘. 디스크 error 흉내(`statfs` 주입) → 첨부 업로드 507. 런이 error 로 끝남 → `run_failed` 1줄.
- [ ] **Step 3: 구현** — health.ts·version.ts·main.ts·app.ts 배선·logger·첨부 507·compose.
- [ ] **Step 4: 번들 스모크** — `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke` exit 0(부팅 경로가 바뀌었다).
- [ ] **Step 5: 검사·커밋** — 루트 검사 4종. `feat(server): 운영 안정성 — 예외·종료 표지·끊김·버전·디스크 사건, 로그 로테이션`.

---

### Task 5: ops API

**Files:**
- Create: `apps/server/src/modules/ops/{routes,summary}.ts`, `apps/server/test/ops.routes.test.ts`, `apps/server/test/ops.summary.test.ts`
- Modify: `packages/shared/src/ops/index.ts`(`OpsStatus`·`OpsRunsSummary`), `apps/server/src/app.ts`(라우트 등록), `apps/server/src/modules/setup/status.ts`(Gateway 줄에 핀·드리프트 — 웹 태스크 6 이 연결 페이지에 쓴다)

**Interfaces:**
- Produces:

```ts
// shared ops
export const OpsStatus = z.object({
  server: z.object({ version: z.string(), startedAt: IsoDateTime, previousClean: z.boolean().nullable() }),
  db: z.object({ bytes: z.int().min(0) }),
  disk: z.discriminatedUnion("level", [
    z.object({ level: z.enum(["ok", "warn", "error"]), freeBytes: z.int(), totalBytes: z.int() }),
    z.object({ level: z.literal("unknown") }),
  ]),
  gateway: z.object({ state: z.enum(["connected", "reconnecting", "down"]), version: z.string().nullable(), pinned: z.string(), drift: z.boolean() }),
  plugin: z.object({ state: z.enum(["connected", "down"]) }),
  runsToday: z.int().min(0),
  dailyRunLimit: z.int().nullable(),
  unacked: OpsUnacked,
});
export const OpsRunsRow = z.object({
  id: Id, name: z.string(), runs: z.int(), failed: z.int(), aborted: z.int(), blocked: z.int(),
  tokens: z.int().optional(), costUsd: z.number().optional(), // USAGE_TRUSTED 일 때만
});
export const OpsRunsSummary = z.object({ days: z.union([z.literal(1), z.literal(7)]), byChannel: z.array(OpsRunsRow), byAgent: z.array(OpsRunsRow), usageTrusted: z.boolean() });

// modules/ops/summary.ts
export const USAGE_TRUSTED = false; // 태스크 7(ADR 0005)이 맞다고 판정하면 true 로
export function runsSummary(db: Db, opts: { days: 1 | 7; now: Date; ops: Pick<OpsService, "list"> }): OpsRunsSummary;
```

- 경로(스펙 6장): `GET /api/v1/ops/status` · `GET /api/v1/ops/runs?days=1|7`(그 밖 값 400) · `GET /api/v1/ops/events?cursor&severity` · `POST /api/v1/ops/events/ack`(본문 없음, `{acked: n}`) · `PATCH /api/v1/ops/settings`(`OpsSettingsPatch`, 범위 밖 400). 모두 `requireOwner`. 응답은 shared 스키마로 한 번 파싱해서 보낸다(계약 위반은 500 INTERNAL — 기존 `parseStored` 꼴).
- `runs` 집계: 기간 시작 = 오늘 0시(`days=1`) 또는 6일 전 0시(`days=7`). `runs` 를 `channel_id`·`agent_id` 로 묶어 `count(*)`·`sum(status='error')`·`sum(status='aborted')`. `blocked` 는 기간 안 `run_limit` 사건의 `count` 합(채널은 key `channel:<id>`, 워크스페이스 key 는 채널별로 못 나누므로 byChannel 에 넣지 않고 status 의 합계에만 — 행 `blocked` 는 채널 한도만). `USAGE_TRUSTED` 면 `usage_json` 의 토큰·`cost.total` 합.
- `setup/status.ts`: `SetupStatus.gateway` 에 `pinned`·`drift` 를 더한다(shared `setup` 스키마도).

- [ ] **Step 1: 테스트(실패 먼저)** — `ops.routes.test.ts`: 다섯 경로 모두 member 403·익명 401, `status` 모양(스키마 파싱 통과)·`dailyRunLimit` 기본 300·PATCH 뒤 반영·`null`, `events` 페이지·커서·severity, `ack` 뒤 `unacked` 0, `days=3` 400. `ops.summary.test.ts`: 오늘·7일 경계(주입 now), 채널·에이전트 합계, `usageTrusted:false` 면 `tokens` 키 없음.
- [ ] **Step 2: 구현** — routes·summary·shared·setup status.
- [ ] **Step 3: 검사·커밋** — 루트 검사 4종. `feat(server,shared): ops API — 상태·런 집계·사건·설정`.

---

### Task 6: 웹 운영 화면

**Files:**
- Create: `apps/web/src/features/ops/{OpsPage,StatusCard,RunsTable,LimitForm,EventList,queries,mutations,copy}.tsx|ts`, 테스트 `apps/web/src/features/ops/*.test.tsx`
- Modify: `apps/web/src/app/router.tsx`(`/settings/operations`), `apps/web/src/app/layout/Sidebar.tsx`(「운영」+배지), `apps/web/src/realtime/handlers.ts`(`ops.event`), `apps/web/src/api/keys`(qk), `apps/web/src/features/messages/SystemCard.tsx`(`run_limit` 모양·owner 링크), `apps/web/src/features/composer/useSendMessage.ts`·`features/messages/PendingItem.tsx`(실패 사유), `apps/web/src/features/setup/sections.tsx`(Gateway 줄 드리프트)

**Interfaces:**
- Consumes: 태스크 5 API·스키마, wire `ops.event`, `useIsOwner`(setup 과 같은 것).
- 배지 수: `ops/status` 의 `unacked.warn + unacked.error` 를 쿼리 캐시(`qk.opsStatus`)로 두고, `ops.event` 가 `unacked` 로 덮는다(setup 의 `setup.status` 처리 꼴). member 는 쿼리를 부르지 않는다.
- 사건 한 줄 문구(`copy.ts`, kind → 고정 문구): `gateway_down` 「Gateway 연결 끊김」, `plugin_down` 「플러그인 연결 끊김」, `gateway_version_changed` 「Gateway 버전이 바뀜 ({from} → {to})」, `gateway_version_untested` 「검증 안 된 Gateway 버전 ({version})」, `run_limit` 「런 한도 도달」, `run_failed` 「런 실패 ({code})」, `ratelimit` 「요청 제한 발동」, `bridge_auth_blocked` 「브리지 인증 실패가 반복돼 주소를 막음」, `crash_rejection` 「처리 안 된 오류」, `crash_exception` 「서버가 오류로 종료됨」, `unclean_shutdown` 「직전 종료가 비정상」, `disk_low` 「디스크 여유 부족」. 끊김은 「(n분 동안)」·열려 있으면 「(지금도)」. count>1 이면 「×n」.
- 작성기: ack 오류 코드가 `RATE_LIMITED` 면 pending 항목에 `reason: "rate_limited"` 를 두고 `PendingItem` 이 「너무 빠르게 보내고 있습니다 — 잠시 뒤 다시」를 보인다(그 밖 실패는 지금 문구). 「다시 보내기」는 그대로.
- `SystemCard`: `run_limit` 은 주의 모양, `systemMeta.limit` 이 있고 owner 면 「운영에서 한도 바꾸기」 링크(`/settings/operations`). 「다시 실행」 버튼은 컴포넌트라 새로 그릴 것이 없다 — 테스트만.
- 연결 페이지 Gateway 줄: `drift` 면 「저장소가 검증한 버전({pinned})과 다릅니다」.
- 390px: 런 표는 카드 목록(가로 스크롤 없음), 사건 줄은 줄바꿈.

- [ ] **Step 1: 테스트(실패 먼저)** — 페이지(상태 카드의 문제 줄 강조·표 전환·한도 저장·빈 값=무제한·범위 밖 오류 문구·사건 필터·모두 확인·더 보기), member 는 사이드바에 「운영」 없음·직접 주소 「권한이 없습니다」, 배지(`ops.event` 로 증가·99+·확인 뒤 0), 작성기 `RATE_LIMITED` 문구와 다시 보내기, `run_limit` 카드의 owner 링크(member 에게는 없음), run_error 카드에 「다시 실행」 버튼이 컴포넌트로 보임, 연결 페이지 드리프트 줄, 390px 카드 목록.
- [ ] **Step 2: 구현.**
- [ ] **Step 3: 검사·커밋** — 루트 검사 4종 + `pnpm -F @dodok/web build`. `feat(web): 운영 화면 — 상태·런 집계·한도·사건·배지`.

---

### Task 7: usage 진단 스파이크 (모델 런 1~2회 — 사용자 승인 뒤)

- [ ] 조율자가 **사용자에게 모델 런 상한을 승인받은 뒤** 디스패치한다.
- [ ] live-smoke 2·3절 규칙으로 dev Gateway(스크래치 `openclaw@2026.9.5`, live-smoke 「전제」 절)·서버(`OPENCLAW_FRAME_DUMP_PATH` 켬). 런 0회 하네스로 경로를 먼저 확인한 뒤 모델 런 1회(짧은 답), 필요하면 2회째(툴 한 번 쓰는 답).
- [ ] 프레임 덤프의 usage(원본)·Gateway `session.message` 의 usage·`runs.usage_json` 을 나란히 적는다. 어느 층에서 달라지는지 가른다(claude-cli 스냅숏·Gateway 매핑·어댑터 `gateway/events.ts` 매핑).
- [ ] 결과를 `docs/adr/0005-usage-values.md` 로. 어댑터 매핑 오류면 이 태스크에서 고치고(테스트 포함) `USAGE_TRUSTED = true`. 그 밖의 층이면 `false` 그대로, ADR 에 「측정 불가」와 까닭.
- [ ] 덤프 파일은 본문을 담으므로 커밋하지 않고 끝나면 지운다(개수만 적는다).

---

### Task 8: dev:fake 훅 + 브라우저 검증 + Compose 확인

- [ ] `apps/server/scripts/dev-fake.ts` 에 개발 전용 훅(운영 번들에 없음 — 기존 `POST /__devfake/plugin-token` 과 같은 HTTP 리스너 감싸기, owner 세션): `POST /__devfake/ops/event {kind,key,severity,detail?}`(사건 주입), `POST /__devfake/gateway {state:"down"|"connected"}`(가짜 Gateway 끊기·붙이기), `POST /__devfake/disk {freeBytes,totalBytes}|{reset:true}`(디스크 흉내). 테스트: 운영 앱에는 없다(번들 grep `__devfake` 0 + 실제 fetch 404).
- [ ] 브라우저 검증(`dev:fake` 3100 대 + 웹 5180, Playwright headless 스크래치 프로필, 390·1280px, **네가 연 탭·브라우저는 네가 닫아라**): 운영 화면 상태·표·한도 변경 → 한도 도달 시스템 메시지 1회·owner 링크 → 사건 주입 → 배지 실시간 → 모두 확인 → 배지 0 · 끊김 훅 61초 → 사건 열림/닫힘 · 디스크 error → 첨부 업로드 거절 문구 · 빠른 연속 전송 → 「너무 빠르게…」 → 다시 보내기 · run_error 「다시 실행」(두 탭) · member 화면은 dev:fake 에 둘째 사용자가 없으면 「확인 불가」로.
- [ ] 로컬 Compose(`127.0.0.1:8443`, Docker 정리 규칙): `docker inspect` 로 두 컨테이너 `LogConfig`(json-file·10m·5), 컨테이너 env `TRUST_PROXY=true`, XFF 를 바꿔 가며 `POST /api/v1/auth/local` 6회 → 429(우회 불가), `/healthz` 본문 키 `ok`·`db` 만, `bash infra/check-caddy.sh https://localhost:8443` PASS.
- [ ] 결과는 보고서. 결함은 조율자가 수정 태스크로.

### Task 9: 실연(런 0) + 문서

- [ ] 실연(dev Gateway, **모델 런 0** — 가짜 claude CLI, live-smoke 「런 0회 하네스」): 워크스페이스 한도를 2로 → 멘션 셋 → 셋째가 막힘·시스템 메시지 1·사건 1 → 가짜 CLI 가 실패하게 해 run_error → 「다시 실행」 → 새 런 `parentRunId` → Gateway 를 내렸다 70초 뒤 올림 → `gateway_down` 열림·닫힘 → 운영 화면 확인. Gateway 버전 드리프트 사건(9.5 ≠ 핀 9.4)이 한 번 뜨는지. 결과 `docs/guides/live-smoke.md` 새 절.
- [ ] 문서: `docs/guides/deploy.md`(`.env` 표에 `TZ`, compose 가 `TRUST_PROXY`·로그 로테이션을 고정한다는 줄, 「운영 화면」 절 — 한도·사건·배지, `/healthz` 본문, 디스크 507), `docs/project-structure.md`(`modules/ops/`·`features/ops/`·`ops_events`·0005·`bridge/guard.ts`·`version.ts`·dev:fake 훅), `docs/plan.md` 8장(Phase 3 ③ 완료·확인 방법·이월), 스펙 「구현과 맞춘 것」(판정 R1 다시 실행 = 컴포넌트 버튼, 그 밖 구현 중 판정). `CLAUDE.md` 는 조율자.

---

## Self-Review (계획 작성 때 한 것)

- **스펙 대조**: 3.1 사건·묶기·보존 → T1 · 3.2 관문 → T2 · 3.3 usage → T7(+T5 `USAGE_TRUSTED`) · 4.1 입구 → T3 · 4.2 로그인 뒤 → T3 · 5.1 예외·종료 표지 → T4 · 5.2 버전 → T4(+T5 setup status·T6 연결 페이지) · 5.3 끊김 → T4 · 5.4 디스크 → T4 · 5.5 로그 → T4(compose 로테이션)·T3(`TRUST_PROXY`) · 5.6 다시 실행 → T2(판정 R1) · 6장 API → T5 · 7장 화면 → T6 · 8장 보안 → T1(ip·detail)·T3·T5 · 9장 오류 → 각 태스크 테스트 · 10장 검증 → T1~T9.
- **스펙과 달라진 것(판정)**: R1 — 다시 실행은 wire `run.retry` 가 아니라 run_error 시스템 메시지의 1회용 컴포넌트 버튼. 까닭은 태스크 2. 태스크 9 가 스펙 「구현과 맞춘 것」에 적는다.
- **자리표시 검사**: 마이그레이션 파일 이름만 생성기가 정한다(`0005_*.sql`) — 의도한 것.
- **타입 일관성**: `OpsService.record/resolve/list/unacked`(T1) = T2~T5 소비 · `RunGate.check/enqueue`(T2) = router·components · `LIMITS`(T3) = socket·auth·attachments · `BridgeAuthGuard.isBlocked/fail`(T3) · `USAGE_TRUSTED`(T5) = T7 · `OPENCLAW_PINNED_VERSION`(T4) = T5 status.
- **Review Focus**: 1 → T2 Step 1 · 2 → T4 Step 1 · 3 → T3 Step 1·2 · 4 → T3 Step 2·T6 Step 1 · 5 → T2 Step 3.
