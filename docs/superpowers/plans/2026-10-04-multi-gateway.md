# 멀티 Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나. 태스크마다 main 에 병합해도 초록이어야 한다.

**Goal:** OpenClaw Gateway 연결을 연결 페이지(owner)에서 추가·수정·끄기·삭제하고 DB 에 두며, 한 워크스페이스에 Gateway 여럿을 붙이고, 에이전트를 Gateway 별로 구분한다.

**Architecture:** 레지스트리는 「제공자당 어댑터 하나」 그대로 두고, OpenClaw 어댑터가 Gateway 연결 여럿을 품는 연결 관리자가 된다(러너 어댑터와 같은 모양). 어댑터 계약에 **연결 id**(OpenClaw = `gateways.id`, 러너 = 러너 토큰 id)를 들여, 런·세션·승인 메서드가 받고 어댑터 이벤트가 싣는다. 서버는 세션 키 하나 대신 「연결 id + 세션 키」로 런·에이전트·승인을 찾는다. `/bridge` 는 토큰 → Gateway 로 플러그인 연결을 나눠 받고 「활성 플러그인 하나」를 Gateway 마다 둔다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8 · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Router/Query · `@openclaw/gateway-client`(핀 그대로). **새 의존성 없음.**

**Spec:** `docs/superpowers/specs/2026-10-04-multi-gateway-design.md` — 결정 0장, 범위 1장, 구성 2장, 데이터 모델 3장, 어댑터 계약 4장, 어댑터·브리지 5장, 서버 6장, 웹 7장, 오류 8장, 검증 9장, 완료 기준 10장. **태스크를 시작하기 전에 스펙의 해당 장을 읽는다.** 본보기는 러너 어댑터(`packages/runner-adapter` — 연결 여럿·에이전트 묶기·끊김 때 런 닫기·첨부 범위 R5).

## Global Constraints

- **배포 이력이 없다 — env 이어받기·기존 DB 이행 코드를 만들지 않는다.** 마이그레이션 파일은 스키마 변경을 담은 새 파일 하나(생성기로)면 되고, 옛 행을 옮기는 SQL 을 쓰지 않는다.
- 세션 키 형식은 그대로, 만들고 푸는 것은 shared `dodokSessionKey`·`parseDodokSessionKey` 로만.
- **연결 id**: OpenClaw 에이전트는 `agents.gateway_id`, 러너 에이전트는 `agents.runner_token_id`. 서버가 에이전트 행에서 꺼내는 함수는 하나(`connectionIdOf(agent)`)뿐이다.
- Gateway 공유 토큰은 DB 평문, **API 응답·로그·사건·wire 어디에도 원문을 싣지 않는다**(`tokenSet: true` 만). 브리지 토큰 규칙(`dbt_` + 해시만 저장, 원문은 발급 응답 한 번)은 그대로.
- Gateway 주소는 `ws://`·`wss://` 만. 이름 1~32자, 워크스페이스 안 유일.
- 핸들은 워크스페이스 유일(그대로). OpenClaw 에이전트 `(gateway_id, provider_agent_id)` 유일, 러너 에이전트 `(workspace_id, provider, provider_agent_id)` 유일. 제공자를 가로지르는 유일 규칙(러너 스펙 R2) 없음.
- 역할: Gateway CRUD·브리지 토큰·에이전트 Gateway 옮기기 = owner, 에이전트 찾기·등록 = admin 이상, 운영 화면 Gateway 줄 = admin 이상, 연결 점·배너 = 누구나. 역할 검사는 `auth/roles.ts` 의 기존 도구로.
- 플러그인(`packages/openclaw-plugin`)은 바꾸지 않는다.
- 외부 입력(HTTP 본문·쿼리·브리지 프레임)은 경계에서 Zod 파싱. shared 는 Node 전용 API 금지.
- 디바이스 아이덴티티는 `DATA_DIR/gateways/<id>/`(디바이스 파일·디바이스 토큰 파일). 백업은 이 디렉터리를 통째로.
- 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳.
- 웹 문구는 합쇼체, 서버 오류 문구를 그대로 보이지 않는다. 스펙 7장의 문구를 그대로 쓴다.
- 시크릿 규칙 `docs/guides/live-smoke.md` 「시크릿 규칙」. 포트 5173·3000 금지(사용자 인스턴스 3100·5180 도 건드리지 않는다 — 워커는 브리프가 주는 포트). 프로세스는 자기 PID 로만, `pkill` 금지. Docker `prune` 금지. **모델 런은 태스크 10 에서만, 실행 직전 사용자 승인.**
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프(`feat(server): …`·`feat(openclaw-adapter): …`·`feat(web): …`). 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 생성물(drizzle SQL·meta)은 생성기(`pnpm -F @dodok/server exec drizzle-kit generate`)로. 생성 SQL 을 SQLite 가 받지 않으면 손으로 쓰고 다음 generate 가 「No schema changes」인지 확인한다.
- 문서·주석을 쓰기 전에 `docs/guideline/base/03-comments.md`·`04-citation.md` 를 읽는다.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`, 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`.

## 계획 판정 (스펙과 맞춘 것)

조사한 코드에 맞춰 스펙을 구체화한 것. 태스크 10 이 스펙 「구현과 맞춘 것」 장으로 옮긴다.

- **PG1 — 태스크 1 은 동작 변화가 없다.** 계약·스키마·대조를 먼저 연결 단위로 바꾸고, OpenClaw 어댑터는 아직 env 의 Gateway 하나를 쓴다. 그동안 그 연결 id 는 서버가 넘기는 고정값 `OPENCLAW_ENV_CONNECTION_ID = "env"`(서버 `config.ts`)이고, OpenClaw 에이전트 행의 `gateway_id` 가 null 이면 서버가 이 값을 쓴다. **태스크 3 이 이 상수와 null 대체를 지운다.**
- **PG2 — `messages.external_id` 는 전역 유일 그대로.** 플러그인이 `dodok-reply-<uuid>`·`dodok-tool-<uuid>`·`dodok-out-<uuid>` 로 만든다(`packages/openclaw-plugin/src/channel.ts`).
- **PG3 — `runs.provider_run_id`·`approvals.provider_approval_id` 는 연결 안 유일**(`(connection_id, provider_…)` 유일 인덱스). 런 대기열 키는 `${connectionId}\u0000${sessionKey}`.
- **PG4 — `send` 결과의 `connectionId`.** `AdapterSendResult` 에 `connectionId?: string` 을 더한다(`ok` 일 때 필수). 러너 어댑터는 실제로 런을 받은 러너의 토큰 id, OpenClaw 어댑터는 받은 연결 id. 오케스트레이터는 이 값을 `runs.connection_id` 에 쓴다.
- **PG5 — 연결이 사라질 때 열린 런 닫기**는 러너가 끊길 때와 같은 경로다(어댑터가 그 연결의 열린 런마다 지금 러너 어댑터가 내는 것과 같은 실패 신호를 낸다 — 서버는 `ADAPTER_UNAVAILABLE` + 「다시 실행」). OpenClaw 어댑터는 Gateway 끄기·삭제·주소 변경 때, 그 연결의 열린 런에 이 신호를 낸다.
- **PG6 — 브리지 토큰 API 는 Gateway 아래로 옮기고 옛 경로를 지운다**: `GET/POST /api/v1/gateways/:id/bridge-tokens`, `DELETE /api/v1/gateways/:id/bridge-tokens/:tokenId`. `/api/v1/setup/bridge-tokens*` 는 없어진다. 플러그인 tgz(`/api/v1/setup/plugin.tgz`)와 설정 상태(`/api/v1/setup/status`)는 그대로 자리.
- **PG7 — `SetupStatus` 의 OpenClaw 부분은 `gateways: GatewaySetup[]`** 로 바꾸고(`GatewaySetup = { id, name, url, enabled, gateway: {state, host, version, pinned, drift, pairing}, bridge: {state, plugin}, pluginMatches }`), `bridge.publicUrl`·`pluginFile` 은 Gateway 와 상관없는 머리 값으로 남긴다. `envTokenIgnored` 는 없앤다.
- **PG8 — 둘째 실물 dev Gateway 확인**은 태스크 10 의 첫 단계다: 스크래치 CLI 의 `openclaw --help` 에서 프로필(상태 디렉터리 분리) 옵션을 찾아, 다른 상태 디렉터리·포트로 둘째 Gateway 를 띄울 수 있으면 실물 둘로 실연한다. 없으면 실물 하나 + dev:fake 가짜 하나로 짝을 맞추고 그 사실을 기록한다.
- **PG9 — Gateway 삭제는 한 트랜잭션**(브리지 토큰 삭제 — FK cascade, 에이전트 `gateway_id` 비움, Gateway 행 삭제) 뒤에 `removeGateway` 를 부른다. 응답 `{ unboundAgents, deletedTokens }`.
- **PG10 — 채널 프롬프트 동기화 대상**은 「그 채널의 에이전트 멤버가 속한 Gateway 집합」. 채널에 에이전트를 넣을 때 그 Gateway 가 집합에 새로 들어오면 그 Gateway 에 한 번 보낸다. 플러그인 hello 때 다시 보내는 기존 동작이 있으면 그 Gateway 의 채널만 다시 보낸다.

## Review Focus

1. **진행 중 런이 있는 Gateway 의 이름만 바꿈 / 주소·토큰을 바꿈** — 이름만 바꾸면 다시 붙지 않고 런이 그대로 간다. 주소·토큰을 바꾸면 그 Gateway 만 다시 붙고 그 Gateway 의 열린 런만 「다시 실행」 카드로 닫힌다. 다른 Gateway 의 런은 그대로. → 태스크 2(어댑터)·3(API → `upsertGateway`).
2. **같은 채널의 두 Gateway `main`(핸들 `main-office`·`main-home`)끼리 릴레이하고 둘 다 승인을 냄** — 두 Gateway 가 우연히 같은 승인 id·런 id 를 내도 각자 맞는 에이전트·런으로 간다. 런 대기열이 서로를 막지 않는다. → 태스크 1(대조)·8(통합).
3. **꺼진 Gateway 의 브리지 토큰으로 플러그인이 붙음 / 플러그인이 붙어 있는데 Gateway 를 끄고 다시 켬** — 끄면 끊기고 접속은 거절된다. 다시 켜면 플러그인이 자기 백오프로 다시 붙어 런이 돈다. 다른 Gateway 의 플러그인은 한 번도 끊기지 않는다. → 태스크 2.
4. **에이전트가 들어 있는 채널이 있는 Gateway 를 지움** — 에이전트 행·채널 멤버십·이력은 남고, 멘션하면 서버가 죽지 않고 `ADAPTER_UNAVAILABLE` 카드가 뜬다. 다른 Gateway 로 옮긴 뒤 「다시 실행」이 통한다. 옮길 대상에 같은 id 가 있으면 막힌다. → 태스크 3·4·8.
5. **Gateway 0개** — 서버가 뜨고, 연결 페이지는 빈 상태, 연결 점은 회색, 배너 없음, 운영 화면 Gateway 줄 없음, 에이전트 가져오기의 OpenClaw 는 「Gateway 를 먼저 추가하세요」. → 태스크 3·5·6·7.

각 줄의 테스트는 해당 태스크의 단계에 들어 있다.

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/adapter/index.ts` | 1 | `AgentAdapter` 메서드의 `connectionId`, `AdapterEvent.connectionId`, `AdapterSendResult.connectionId`, OpenClaw `AdapterStatus`·`OpenClawSetupDetail` 를 Gateway 목록으로 |
| `packages/shared/src/gateways/index.ts`(새)·`setup/index.ts`·`ops/index.ts`·`domain/index.ts`·`wire/index.ts`·`index.ts` | 1 | Gateway API Zod(`CreateGatewayBody`·`UpdateGatewayBody`·`GatewaySummary`·`DeleteGatewayResult`), `SetupStatus.gateways`, `OpsStatus.gateways`, `Agent.gateway`, `CreateAgentBody.gatewayId`, 찾기 쿼리 `gatewayId` |
| `apps/server/src/db/schema.sqlite.ts`·`drizzle/0012_*` | 1 | `gateways` 표, `bridge_tokens.gateway_id`, `agents.gateway_id`, `runs.connection_id`, `approvals.connection_id`, 유일 인덱스 |
| `apps/server/src/adapters/connection.ts`(새) | 1 | `connectionIdOf(agent)` |
| `apps/server/src/modules/{runs/orchestrator,runs/store,approvals/service,sessions/service}.ts`·`wiring.ts` | 1 | 「연결 id + 세션 키」 대조, `runs.connection_id`, 복구 대상을 연결별로 |
| `packages/runner-adapter/src/*` | 1 | 계약 맞춤(연결 id = 러너 토큰 id, `send` 결과·이벤트에 싣기) |
| `packages/openclaw-adapter/src/{openclaw-adapter,connection/*,bridge/*,gateway/*}.ts` | 2 | 연결 관리자·Gateway 연결·`upsertGateway`·`removeGateway`·토큰 → Gateway 브리지·Gateway 별 디바이스 디렉터리 |
| `apps/server/src/modules/gateways/`(새)·`config.ts`·`app.ts`·`modules/setup/*`·`backup.ts`·`.env.example`·`infra/local.env.example`·`scripts/bundle-smoke.mjs`·`test/helpers/*`·`scripts/dev-fake.ts`(한 Gateway 로 맞춤) | 3 | Gateway API·부팅·env 제거·브리지 토큰을 Gateway 아래로·설정 상태·백업 |
| `apps/server/src/modules/{agents,attachments,channels}/*` | 4 | 찾기·등록·옮기기·Gateway 요약, 브리지 첨부 범위, 채널 프롬프트 동기화 대상 |
| `apps/server/src/modules/ops/*`·`modules/adapter/routes.ts`·`realtime/*`·`app.ts`(감시) | 5 | Gateway 별 사건 키·버전·상태·재연결 알림·wire |
| `apps/web/src/features/setup/*` | 6 | 연결 페이지 Gateway 카드 |
| `apps/web/src/features/{agents,composer,ops}/*`·`app/layout/{Banners,ConnectionDots}.tsx`·`api/queries.ts`·`realtime/handlers.ts` | 7 | 가져오기·옮기기·Gateway 이름·배너·연결 점·운영 화면 |
| `apps/server/scripts/dev-fake.ts`·`apps/server/test/fakes/*`·`apps/server/test/*multi-gateway*`(새) | 8 | 가짜 Gateway·플러그인 둘, 훅, 통합 시나리오 |
| (워커 검증) | 9 | dev:fake 브라우저 검증 |
| 문서 | 10 | deploy·user-guide·project-structure·live-smoke·CLAUDE.md, 실연 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 계약·스키마·대조(동작 변화 없음) | — |
| B | 2 OpenClaw 어댑터 연결 관리자·브리지 | 1 |
| C | 3 서버 Gateway 모듈·부팅·env 제거 | 2 |
| D | 4 에이전트 API·첨부 범위·프롬프트 동기화 ‖ 5 운영·상태·wire | 3 |
| E | 6 웹 연결 페이지 ‖ 7 웹 에이전트·표시·운영 화면 ‖ 8 dev:fake 둘·통합 시나리오 | 4·5 |
| F | 9 브라우저 검증 | 6·7·8 |
| G | 10 문서·실연 | 9 |

---

### Task 1: 계약·스키마·대조를 연결 단위로 (동작 변화 없음)

**Files:**
- Modify: `packages/shared/src/adapter/index.ts`, `packages/shared/src/domain/index.ts`, `packages/shared/src/index.ts`
- Modify: `apps/server/src/db/schema.sqlite.ts`; Create(생성기): `apps/server/drizzle/0012_*.sql`·meta
- Create: `apps/server/src/adapters/connection.ts`
- Modify: `apps/server/src/modules/runs/{orchestrator,store}.ts`, `modules/approvals/service.ts`, `modules/sessions/service.ts`, `modules/channels/service.ts`(리셋), `wiring.ts`, `config.ts`(PG1 상수), `app.ts`(OpenClaw 어댑터에 연결 id 를 넘김)
- Modify: `packages/runner-adapter/src/*`, `packages/openclaw-adapter/src/openclaw-adapter.ts`(시그니처만), `packages/openclaw-adapter/src/fake-adapter.ts`, 서버 테스트의 가짜 어댑터
- Test: `apps/server/test/connection-routing.test.ts`(새), `packages/runner-adapter/test/runner-adapter.test.ts`, 마이그레이션 이행 테스트

**Interfaces:**
- Produces(shared `adapter/index.ts`):

```ts
export type ConnectionId = string;
export type SendOptions = { connectionId: ConnectionId | null; providerSessionId?: string };
export type AdapterSendResult = InboundDeliverResult & { queued?: boolean; connectionId?: ConnectionId }; // ok 면 connectionId 필수

export interface AgentAdapter {
  // …기존 그대로인 것: provider·connect·close·status·capabilities·setupDetail·revokeTokenSessions·sessionKeyFor·onEvent·forgetRun
  listAgents(connectionId: ConnectionId): Promise<Array<{ providerAgentId: string; name?: string; hint?: string }>>;
  supports(providerAgentId: string, connectionId: ConnectionId | null, capability: "threads"): boolean;
  send(input: InboundDeliver, opts: SendOptions): Promise<AdapterSendResult>;
  abort(runId: string, sessionKey: string, connectionId: ConnectionId | null): Promise<void>;
  resetSession(sessionKey: string, connectionId: ConnectionId | null): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"], connectionId: ConnectionId): Promise<ConfigSetResult>;
  resolveApproval(providerApprovalId: string, kind: ApprovalKind, decision: ApprovalDecision, connectionId: ConnectionId): Promise<ProviderApproval>;
}

export type AdapterEvent =
  | { kind: "run_event"; runId: string; connectionId: ConnectionId; event: RunEventBody }
  | { kind: "run_signal"; runId: string; connectionId: ConnectionId; signal: RunSignal; snapshotText?: string }
  | { kind: "canonical"; connectionId: ConnectionId; message: OutboundMessage }
  | { kind: "status"; status: AdapterStatus; capabilities: AdapterCapabilities }
  | { kind: "approval"; connectionId: ConnectionId; approval: ProviderApproval }
  | { kind: "setup" };
```

- Produces(서버 `adapters/connection.ts`):

```ts
/** 에이전트를 맡은 연결 — OpenClaw 는 gateway_id, 러너는 runner_token_id. 없으면 null */
export function connectionIdOf(agent: { provider: string; gatewayId: string | null; runnerTokenId: string | null }): string | null;
```

- Produces(DB — 스펙 3.1·3.2): `gateways`(id·workspace_id·name·url·token·enabled·owner_user_id·last_version·created_at·updated_at, `(workspace_id, name)` 유일), `bridge_tokens.gateway_id`(이 태스크에서는 **nullable** — 태스크 3 이 필수로 바꾼다, ON DELETE CASCADE), `agents.gateway_id`(nullable, ON DELETE SET NULL), `runs.connection_id`(nullable text), `approvals.connection_id`(nullable text), 유일 인덱스 `agents (gateway_id, provider_agent_id)` WHERE provider='openclaw'·`agents (workspace_id, provider, provider_agent_id)` WHERE provider='claude'(기존 `(ws, provider, provider_agent_id)` 를 대신함), `runs (connection_id, provider_run_id)`·`approvals (connection_id, provider_approval_id)`(기존 전역 유일을 대신함). `runs (connection_id, session_key, status)` 인덱스.
- 서버 대조:
  - `findOpenRunBySession(db, connectionId, sessionKey)`.
  - 런 대기열 키 `${connectionId}\u0000${sessionKey}`(PG3).
  - `agentIdFor(msg, provider, connectionId)` — 채널 + provider + `connectionIdOf(agent) === connectionId` + `providerAgentIdIs`.
  - `approvals.ingest(approval, provider, connectionId)` — 같은 조건으로 에이전트를 찾고 `approvals.connection_id` 를 쓴다.
  - `send` 결과의 `connectionId` 를 `runs.connection_id` 에(PG4). `send` 전에 끝난 런은 `connectionIdOf(agent)`.
  - `sessionRecoverTargets(db)` 가 `Map<connectionId, RecoverTarget[]>` 를 돌려준다(OpenClaw 에이전트 세션만).
  - 제공자를 가로지르는 유일 검사(`createAgent` 의 R2)를 지운다.
- 러너 어댑터: 연결 id = 러너 토큰 id. `send` 의 `connectionId` 가 null 이면 지금 규칙으로 러너를 고르고 결과에 고른 러너의 토큰 id. 이벤트에 그 런 러너의 토큰 id.
- OpenClaw 어댑터(PG1): 옵션에 `connectionId: string` 을 받아 이벤트·`send` 결과에 싣고, 받은 `connectionId` 인자는 아직 무시한다. 서버는 `OPENCLAW_ENV_CONNECTION_ID = "env"` 를 넘기고, `connectionIdOf` 는 OpenClaw 에이전트의 `gateway_id` 가 null 이면 이 값을 돌려준다.

- [ ] **Step 1: 실패하는 테스트** — `connection-routing.test.ts`(가짜 어댑터 — `FakeAdapter` 에 「이벤트에 실을 연결 id 를 고르는」 도우미를 더한다):
  - 같은 채널에 OpenClaw 에이전트 둘(`providerAgentId` 둘 다 `main`, `gateway_id` 가 `g1`·`g2`, 핸들 `main-office`·`main-home`)을 DB 에 직접 넣고, 각각 멘션 → 두 런의 `connection_id` 가 `g1`·`g2`, 세션 키는 같다.
  - `g2` 연결로 최종 답(canonical)을 내면 `main-home` 의 메시지로 저장되고 `g1` 의 런은 열린 채다.
  - 두 연결이 **같은 `providerApprovalId`** 로 승인을 내면 승인 두 행이 각자 맞는 런·에이전트에 붙는다(Review Focus 2).
  - 두 연결이 **같은 `providerRunId`** 를 내도 유일 인덱스 충돌 없이 각 런에 기록된다.
  - `g1` 의 런이 진행 중일 때 `g2` 에이전트 멘션은 대기열에서 기다리지 않는다.
  - 러너 쪽: 묶임 없는 러너 에이전트 멘션 → 결과의 `connectionId`(러너 토큰 id)가 `runs.connection_id` 에 남고, 그 러너의 런 이벤트가 같은 런으로 이어진다.
  - 이행 테스트: 0011 까지 적용된 DB 에 0012 가 얹힌다.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** 기존 테스트는 전부 그대로 초록(OpenClaw 는 여전히 env 의 Gateway 하나 — 동작 변화 없음). `runner-adapter` 테스트는 새 시그니처로만 바꾸고 단언은 그대로.
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `refactor(shared): carry a connection id through the adapter contract`, `feat(server): match runs, agents and approvals by connection and session key`.

---

### Task 2: OpenClaw 어댑터 — 연결 관리자·브리지

**Files:**
- Create: `packages/openclaw-adapter/src/connection/{manager,gateway-connection}.ts`
- Modify: `packages/openclaw-adapter/src/openclaw-adapter.ts`, `src/bridge/{server,session}.ts`, `src/gateway/{client,connection-manager,device-identity}.ts`, `src/frame-dump.ts`, `src/fake-adapter.ts`, `src/index.ts`
- Modify(최소): `apps/server/src/app.ts` — env 의 Gateway 하나를 `upsertGateway({ id: OPENCLAW_ENV_CONNECTION_ID, … })` 로 넣는다(태스크 3 전까지)
- Test: `packages/openclaw-adapter/test/multi-gateway.test.ts`(새), 기존 어댑터·브리지 테스트

**Interfaces:**
- Consumes: 태스크 1 계약.
- Produces:

```ts
export type GatewayConnectionConfig = { id: string; name: string; url: string; token: string; enabled: boolean };

export interface OpenClawAdapter extends AgentAdapter {
  readonly provider: "openclaw";
  /** 없으면 만들고, url·token 이 바뀌었으면 그 연결만 다시 붙고(주소가 바뀌면 디바이스 토큰을 지움), enabled=false 면 끊는다. 이름만 바뀌면 다시 붙지 않는다 */
  upsertGateway(config: GatewayConnectionConfig): void;
  /** 연결·플러그인 세션을 끊고 디바이스 디렉터리를 지운다. 열린 런은 PG5 신호로 닫는다 */
  removeGateway(id: string): Promise<void>;
}

export type OpenClawAdapterOptions = {
  dataDir: string; // 디바이스 아이덴티티는 `${dataDir}/gateways/<id>/`
  bridge: { io: SocketIOServer; verifyToken: BridgeTokenVerifier; /* …기존 */ };
  sessionKeysToRecover: (connectionId: string) => RecoverTarget[];
  onCanonical: (m: OutboundMessage, connectionId: string) => void;
  frameDumpPath?: string; // 연결마다 `<path>.<id>`
  backoff?: …;
};
export type BridgeTokenVerifier = (presented: unknown) => { tokenId: string; gatewayId: string } | null;
```

- 상태: `status()` 는 `{ provider: "openclaw", gateways: Array<{ id; name; enabled; gateway: <기존 상태 값 + "disabled">; bridge: "connected" | "down" }> }`, `setupDetail()` 은 Gateway 마다 지금의 `gateway`·`bridge.plugin` 블록을 담은 목록(`id`·`name`·`url`·`enabled` 포함).
- 연결 관리자: 연결마다 자기 Gateway WS·백오프·페어링·복구(`sessionKeysToRecover(id)`)·버전·플러그인 세션·`OutboundDedupe`·진행 중 전달 기록. 한 연결의 예외는 그 연결 안에서 잡고 상태로만 드러낸다.
- 브리지: `/bridge` 하나, 미들웨어가 `verifyToken` 결과의 `gatewayId` 가 **켜진 연결**이 아니면 거절. hello 때 같은 Gateway 의 활성 플러그인만 `replaced`. `revokeTokenSessions(tokenId)` 는 그 토큰의 소켓만. `current()`·`requireActive()` 는 연결별로.
- `send(input, { connectionId })`: null·모르는 id·꺼진 연결이면 `AdapterError("ADAPTER_UNAVAILABLE")`, 결과에 `connectionId`. `listAgents(connectionId)` 는 그 Gateway 의 `agents.list`. `supports(…, connectionId, "threads")` 는 그 연결의 플러그인 capabilities.

- [ ] **Step 1: 실패하는 테스트** — `multi-gateway.test.ts`(테스트용 가짜 Gateway 서버 둘 + 가짜 플러그인 소켓 둘 — 기존 어댑터 테스트의 가짜를 쓴다):
  - `upsertGateway` 둘 → 둘 다 `connected`, 각 플러그인이 자기 토큰으로 붙음, `status().gateways` 두 줄.
  - 가짜 Gateway 1 을 내림 → 연결 1 은 재접속 루프, 연결 2 로 `send` 가 통하고 이벤트의 `connectionId` 가 2.
  - Gateway 1 토큰으로 플러그인 하나 더 hello → Gateway 1 의 앞 플러그인만 `replaced`, Gateway 2 플러그인 소켓은 끊기지 않음(Review Focus 3).
  - `upsertGateway({ …g1, enabled: false })` → 연결 1 끊김·플러그인 1 끊김·이후 그 토큰 핸드셰이크 거절, 그 연결의 열린 런에 PG5 신호. 다시 `enabled: true` → 플러그인이 다시 붙으면 런이 돈다(Review Focus 3).
  - `upsertGateway({ …g1, name: "새 이름" })` → 다시 붙지 않음(연결 객체·소켓 그대로), 열린 런 그대로(Review Focus 1).
  - `upsertGateway({ …g1, url: 다른 주소 })` → 연결 1 만 다시 붙고 `gateways/<g1>/` 의 디바이스 토큰 파일이 지워짐, 연결 2 의 열린 런은 그대로(Review Focus 1).
  - `removeGateway(g1)` → 디렉터리 삭제, 열린 런 PG5 신호, `status()` 에서 빠짐.
  - 페어링 대기는 그 연결에만(`setupDetail()` 의 g1 에만 `pairing`).
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** 기존 단일 Gateway 테스트는 `upsertGateway` 한 번으로 시작하게 바꾸고 단언은 그대로.
- [ ] **Step 3: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `feat(openclaw-adapter): manage several Gateway connections behind one adapter`.

---

### Task 3: 서버 — Gateway 모듈·부팅·env 제거

**Files:**
- Create: `apps/server/src/modules/gateways/{service,routes}.ts`, `apps/server/test/gateways.test.ts`
- Modify: `apps/server/src/config.ts`(OpenClaw·`BRIDGE_TOKEN` 변수 제거, PG1 상수 제거), `app.ts`(부팅 때 켜진 Gateway 를 `upsertGateway`, 라우트 등록), `adapters/connection.ts`(null 대체 제거), `db/schema.sqlite.ts`(`bridge_tokens.gateway_id` NOT NULL) + 생성기, `modules/setup/{routes,status,tokens}.ts`(PG6·PG7, `importEnvToken` 제거), `backup.ts`(`DATA_DIR/gateways/`), `.env.example`, `infra/local.env.example`, `scripts/bundle-smoke.mjs`, `test/helpers/{env,live-app}.ts`, `scripts/dev-fake.ts`(가짜 Gateway 하나를 DB 에 넣고 시작 — 둘은 태스크 8), 설정 상태 소비 테스트
- Modify(최소, 컴파일 유지): `apps/web/src/features/setup/*` — `SetupStatus` 새 모양에서 **첫 Gateway** 를 지금 화면에 그대로 보이게(카드 목록은 태스크 6), 브리지 토큰 API 경로만 새 경로로

**Interfaces:**
- Consumes: 태스크 2 `upsertGateway`·`removeGateway`·`BridgeTokenVerifier`.
- Produces(owner 전용, 스펙 6.2):
  - `GET /api/v1/gateways` → `GatewaySummary[]`(`{ id, name, url, enabled, tokenSet: true, ownerUserId: null, createdAt, updatedAt }`)
  - `POST /api/v1/gateways` `CreateGatewayBody { name, url, token }` → 201 `GatewaySummary`
  - `PATCH /api/v1/gateways/:id` `UpdateGatewayBody { name?, url?, token?, enabled? }` — 빈 문자열 토큰은 「바꾸지 않음」
  - `DELETE /api/v1/gateways/:id` → `DeleteGatewayResult { unboundAgents, deletedTokens }`(PG9)
  - `GET/POST /api/v1/gateways/:id/bridge-tokens`, `DELETE /api/v1/gateways/:id/bridge-tokens/:tokenId`(PG6)
  - 오류: 이름 겹침 409 `CONFLICT`, 잘못된 주소·이름 400 `VALIDATION`, 없는 id 404.
- `verifyBridgeTokenDb` 는 `{ tokenId, gatewayId }` 를 돌려준다(꺼진 Gateway 판단은 어댑터).

- [ ] **Step 1: 실패하는 테스트** — `gateways.test.ts`:
  - `.env` 에 OpenClaw 변수 없이 `createApp` 이 뜨고 `GET /api/v1/gateways` 가 `[]`, 설정 상태 `gateways: []`(Review Focus 5).
  - POST(가짜 Gateway 주소) → 응답·목록·로그 어디에도 토큰 원문 없음, 어댑터 `status().gateways` 에 연결됨. 이름 겹침 409, `http://` 주소 400.
  - PATCH 이름만 → 어댑터 `upsertGateway` 가 이름만 바뀐 값으로 불리고 연결은 그대로. 빈 토큰 PATCH → DB 토큰 그대로.
  - 브리지 토큰 발급(새 경로) → 원문 한 번·설정 조각 모양 그대로, 그 토큰으로 가짜 플러그인이 그 Gateway 에 붙음, 다른 Gateway 의 토큰 목록에는 없음.
  - DELETE → 그 Gateway 의 토큰 행 없음, 그 Gateway 에이전트의 `gateway_id` null, 응답 수가 맞음, 디바이스 디렉터리 없음.
  - 역할: admin·member 는 모든 Gateway 경로가 403(역할 매트릭스 테스트에 줄 추가).
  - 부팅: DB 에 켜진 Gateway 둘·꺼진 하나 → `upsertGateway` 셋(꺼진 것은 `enabled: false`).
  - 백업 테스트: `DATA_DIR/gateways/<id>/` 파일이 백업에 들어간다.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** env 를 넣던 테스트 도우미는 「가짜 Gateway 를 DB 에 넣는」 도우미로 바꾼다. dev:fake 는 가짜 Gateway 하나를 DB 에 넣고 지금처럼 돈다(훅 그대로).
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드 + 서버 번들 스모크**(`bundle-smoke.mjs` 는 OpenClaw env 없이 뜨는지).
- [ ] **Step 4: 커밋** — `feat(server): configure OpenClaw Gateways in the app instead of env`.

---

### Task 4: 에이전트 API·브리지 첨부 범위·프롬프트 동기화

**Files:**
- Modify: `apps/server/src/modules/agents/{routes,service}.ts`, `modules/attachments/{service,routes}.ts`, `modules/channels/{routes,service}.ts`, shared `domain/index.ts`(`Agent.gateway`·`CreateAgentBody.gatewayId`·찾기 쿼리)
- Test: `apps/server/test/agents.gateway.test.ts`(새), `apps/server/test/attachments.bridge-scope.test.ts`(새), 채널 프롬프트 테스트

**Interfaces:**
- `GET /api/v1/agents/discover?provider=openclaw&gatewayId=<id>`(admin 이상) — OpenClaw 는 `gatewayId` 필수(없으면 400), 꺼졌거나 끊긴 Gateway 는 `ADAPTER_UNAVAILABLE`.
- `POST /api/v1/agents` — OpenClaw 면 `gatewayId` 필수, 같은 Gateway 에 같은 id 면 409, 핸들 겹침 409(그대로).
- `PUT /api/v1/agents/:id/gateway { gatewayId }`(owner) — 대상 Gateway 에 같은 id 면 409. 러너 에이전트는 400.
- `Agent.gateway: { id: string; name: string } | null`(OpenClaw 에이전트만 키가 있음).
- 브리지 첨부(스펙 6.4): 브리지 토큰의 `gatewayId` 로 — 그 Gateway 의 열린 런(`runs.connection_id`)의 트리거 첨부와 그 Gateway 가 올린 첨부만 읽기, `claimBridgeAttachments` 는 그 Gateway 가 올린 것만. 업로드 행에 올린 Gateway 를 남길 열이 없으면 이 태스크에서 더한다(생성기).
- 채널 프롬프트(PG10): `syncChannelPrompt` 가 그 채널 에이전트 멤버의 Gateway 집합마다 `syncChannelConfig(…, gatewayId)`, 에이전트를 채널에 넣어 Gateway 가 새로 들어오면 그 Gateway 에 한 번.

- [ ] **Step 1: 실패하는 테스트**:
  - 두 Gateway 에 `main` 등록(핸들 `main-office`·`main-home`) 성공, 같은 Gateway 에 `main` 다시 → 409, 핸들 `main-office` 재사용 → 409.
  - `discover` 가 `gatewayId` 별로 다른 목록, `gatewayId` 없으면 400.
  - Gateway 삭제 → 에이전트 `gateway: null`, 그 에이전트 멘션 → 서버 오류 없이 `ADAPTER_UNAVAILABLE` 카드, `PUT …/gateway` 로 다른 Gateway → 「다시 실행」이 그 Gateway 로 가서 런이 돈다. 대상에 같은 id 가 있으면 409(Review Focus 4). admin 의 `PUT …/gateway` 403.
  - 첨부: Gateway 1 토큰으로 Gateway 2 런의 트리거 첨부 GET → 404(또는 기존 거절 코드), Gateway 1 런의 것은 200. Gateway 2 가 올린 첨부 id 를 Gateway 1 이 claim → 거절.
  - 프롬프트: 채널에 Gateway 1 에이전트만 → Gateway 1 에만 `config.set`. Gateway 2 에이전트를 넣으면 Gateway 2 에 한 번.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `feat(server): register and move OpenClaw agents per Gateway`, `fix(server): scope bridge attachment reads to the token's Gateway`.

---

### Task 5: 운영·상태·wire

**Files:**
- Modify: `apps/server/src/modules/ops/{health,settings,routes,store,service}.ts`, `modules/adapter/routes.ts`, `app.ts`(`watchGatewayReconnecting`·`watchConnections`·`watchGatewayVersion` 를 Gateway 별로), shared `ops/index.ts`·`wire/index.ts`, `realtime/*`
- Test: `apps/server/test/ops.gateways.test.ts`(새), 기존 운영 테스트

**Interfaces:**
- 사건 키: `gateway_down`·`plugin_down` → `gateway:<id>`, `gateway_version_changed` → `gateway:<id>`, `gateway_version_untested` → `gateway:<id>:<version>`. 사건 본문에 Gateway 이름.
- 버전: `gateways.last_version`(`workspaces.ops_json.lastGatewayVersion` 제거).
- 재연결 알림: Gateway 마다, 문구에 이름.
- `OpsStatus.gateways: Array<{ id; name; enabled; gateway: { state; version; pinned; drift }; plugin: { state } }>`(기존 단수 `gateway`·`plugin` 대신), wire `adapter.status` 는 태스크 2 의 상태 모양 그대로, `GET /api/v1/adapter/status` 도.
- Gateway 를 지우면 그 Gateway 의 열린 운영 사건을 닫는다(`resolve`).

- [ ] **Step 1: 실패하는 테스트** — Gateway 둘 중 1 만 60초 넘게 끊김 → `gateway_down` 사건 하나(키 `gateway:<g1>`), 2 는 사건 없음 · 둘의 버전이 다르면 사건이 각자 · Gateway 0개면 `OpsStatus.gateways` 가 `[]`(Review Focus 5) · 지운 Gateway 의 사건은 닫힘.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드**(웹은 컴파일만 맞춘다 — 화면은 태스크 7) **+ 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `feat(server): track Gateway health, versions and events per Gateway`.

---

### Task 6: 웹 — 연결 페이지 Gateway 카드

**Files:**
- Modify/Create: `apps/web/src/features/setup/{ConnectionPage,sections,TokenList,IssueTokenDialog}.tsx`, `GatewayCard.tsx`(새)·`GatewayForm.tsx`(새)·`DeleteGatewayConfirm.tsx`(새), `mutations.ts`·`api/queries.ts`(`qk.gateways`)
- Test: 해당 `*.test.tsx`, `connection.test.tsx`(deploy.md 와 대조하는 테스트가 있으면 태스크 10 과 맞물린다 — 문구 대조 대상이 바뀌면 그 테스트의 기준을 이 태스크에서 맞추고 보고)

**Interfaces:**
- Consumes: 태스크 3 Gateway API·`SetupStatus.gateways`, 태스크 5 상태 모양.
- 화면(스펙 7장 문구 그대로): 블록 머리 「플러그인 받기」·「Gateway 추가」, Gateway 카드(상태·페어링 복사·플러그인·이 Gateway 의 브리지 토큰·메뉴 수정/끄기·켜기/삭제), 삭제 확인(페이지 안, 「이 Gateway 의 에이전트 N개는 남고 연결이 비어 옮기기를 기다립니다 · 브리지 토큰 M개가 지워집니다」), 0개 빈 상태(「OpenClaw Gateway 를 추가하면 그 안의 에이전트를 채널에 데려올 수 있습니다」). 수정 폼의 토큰 칸 자리 표시 「바꾸려면 입력」. `.env` 를 가리키던 안내 문구(`GatewaySection` 의 `OPENCLAW_GATEWAY_URL` 힌트)는 지운다.

- [ ] **Step 1: 실패하는 테스트** — 0개 빈 상태 · 추가 폼(이름·주소·토큰 검증 문구, `http://` 거절) · 카드 둘(같은 문구가 카드마다) · 페어링 대기 카드의 복사 명령 · 토큰 발급이 그 카드의 Gateway 경로로 · 수정 폼의 빈 토큰은 요청 본문에 토큰을 싣지 않음 · 삭제 확인 문구의 수(N·M) · 끄기/켜기.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드.**
- [ ] **Step 4: 커밋** — `feat(web): manage OpenClaw Gateways on the connection page`.

---

### Task 7: 웹 — 에이전트·표시·운영 화면

**Files:**
- Modify: `apps/web/src/features/agents/{AgentsPage,DiscoverDialog,mutations}.tsx`, `features/composer/*`(멘션 후보), `features/ops/{StatusCard,copy}.ts(x)`, `app/layout/{Banners,ConnectionDots}.tsx`, `api/queries.ts`(`openclawAdapterStatus` → Gateway 목록), `realtime/handlers.ts`
- Test: 해당 `*.test.tsx`

**Interfaces:**
- 가져오기: OpenClaw 면 Gateway 고르기 → 그 Gateway 목록. Gateway 0개면 「Gateway 를 먼저 추가하세요」(owner 에게는 연결 페이지 링크). 이미 등록 숨김 기준 「같은 Gateway + 같은 id」. 핸들 칸 기본값 id, 겹침 문구 「이미 쓰이는 핸들입니다 — 다른 핸들을 입력하세요」.
- 에이전트 줄 `@main-home · 집`, 연결이 빈 줄 「Gateway 가 삭제됨 — 다른 Gateway 로 옮기거나 지우세요」 + 「Gateway 옮기기」(owner).
- 연결 점: 모두 연결됨 초록·일부 끊김 노랑·모두 끊김 빨강·없음 회색, 툴팁에 Gateway 별 상태.
- 배너: 「OpenClaw Gateway 「<이름>」에 연결되지 않아 그 Gateway 의 에이전트가 답하지 못합니다」, 둘 이상이면 「Gateway 2개」 꼴로 묶음, 「연결 설정 보기」.
- 멘션 후보: OpenClaw 에이전트 옆에 Gateway 이름.
- 운영 화면: Gateway 줄 반복, 사건에 Gateway 이름.

- [ ] **Step 1: 실패하는 테스트** — 두 Gateway 의 `main` 이 두 줄로 구분되어 보임 · 가져오기 Gateway 고르기·핸들 겹침 · 연결 점 네 상태 · 배너 하나/둘 · Gateway 0개(연결 점 회색·배너 없음·가져오기 안내 — Review Focus 5) · 옮기기 단추는 owner 에게만 · 운영 화면 Gateway 두 묶음.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드.**
- [ ] **Step 4: 커밋** — `feat(web): show agents, status and banners per Gateway`.

---

### Task 8: dev:fake 둘·통합 시나리오

**Files:**
- Modify: `apps/server/scripts/dev-fake.ts`, `apps/server/test/fakes/{fake-gateway,fake-plugin,scenario}.ts`, `test/helpers/live-app.ts`
- Create: `apps/server/test/multi-gateway.integration.test.ts`

**Interfaces:**
- 가짜 Gateway 의 `agents.list` 를 옵션으로(지금은 고정 `dev`·`fin`).
- dev:fake 시작: Gateway 「사무실」(`dev`·`fin`)·「집」(`main`·`dev`)을 DB 에 넣고, 가짜 플러그인 둘(고정 브리지 토큰 `dev-fake-bridge-token-office`·`dev-fake-bridge-token-home`), 시나리오는 Gateway·플러그인 짝마다. 셋째 가짜 Gateway 주소를 하나 열어 두고 시작 로그에 찍는다(화면에서 「Gateway 추가」로 붙여 보는 용도). 에이전트 등록은 지금처럼 시작 때(핸들 `dev`·`fin`·`main`·`dev-home`).
- 훅: `/__devfake/gateway {gatewayId, state}`, `/__devfake/plugin-token {gatewayId, token}`, `/__devfake/plugin-capabilities {gatewayId, threads}` — `gatewayId` 가 없으면 400. 머리 주석을 고친다.

- [ ] **Step 1: 실패하는 테스트** — `multi-gateway.integration.test.ts`(가짜 둘, 실제 서버):
  - 스펙 9장 통합 목록 전부: 두 `main` 각각 멘션·답·승인·런 이벤트가 맞는 에이전트로, 대기열이 서로 막지 않음 · `main-office` 의 답에 `@main-home` → 릴레이 런이 집 Gateway 로(Review Focus 2) · Gateway 삭제 → 열린 런 `ADAPTER_UNAVAILABLE`·에이전트 연결 비움 → 옮긴 뒤 「다시 실행」 · 첨부 범위 · 프롬프트 동기화 대상 · 한 Gateway 끄기/켜기 동안 다른 Gateway 런이 끝까지 감(Review Focus 3).
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** dev:fake 를 직접 띄워(포트는 브리프) 시작 로그·훅 둘을 손으로 확인하고 보고서에.
- [ ] **Step 3: 루트 검사 4종 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `test(server): run two fake Gateways in dev:fake and the integration suite`.

---

### Task 9: 브라우저 검증 (dev:fake)

워커(verify) — 태스크 8 의 dev:fake(포트는 브리프, 3100·5180·5173·3000 금지) 위에서 독립 Chromium(neo 는 사용자 인스턴스 쿠키를 덮으므로 쓰지 않는다 — `docs/guides/browser-verification.md`)으로:

1. 연결 페이지: 카드 둘, 「Gateway 추가」로 셋째 가짜 Gateway 붙이기(페어링·플러그인 없음 상태), 이름만 수정(다시 붙지 않음), 끄기·켜기, 삭제 확인 문구의 수, 0개 빈 상태(모두 지운 뒤 — 마지막에 다시 띄운다).
2. 브리지 토큰: 카드별 발급·폐기, 다른 카드 목록에 없음.
3. 에이전트: 가져오기 Gateway 고르기·핸들 겹침, `@main-office`·`@main-home` 각각 멘션·답, 둘 사이 릴레이.
4. Gateway 삭제 → 연결이 빈 에이전트 줄·옮기기(owner 만 보임 — member 로 확인)·「다시 실행」.
5. 배너·연결 점(한 Gateway 를 훅으로 내림 → 노랑·배너에 이름, 둘 다 → 빨강·「Gateway 2개」).
6. 운영 화면 Gateway 두 묶음·사건 이름.
7. 390px 에서 카드·대화상자 넘침 없음.

보고서: 항목별 통과/결함(재현 단계·스크린샷 경로), 콘솔 오류. 결함은 조율자가 수정 태스크로.

---

### Task 10: 문서·실연

**Files:**
- Modify: `docs/guides/deploy.md`(「설정 — `.env`」 표에서 OpenClaw·`BRIDGE_TOKEN` 줄 제거, 「체크리스트 — 처음 배포」의 Gateway 접속·플러그인·브리지 단계를 「연결 페이지에서 Gateway 추가」 흐름으로, 「브리지 토큰 교체」·「복원」(디바이스 디렉터리)·「로컬 검증 (이 Mac)」·「오류」), `docs/guides/user-guide.md`(연결 페이지·가져오기·옮기기·배너), `docs/project-structure.md`(서버·어댑터·웹 절, 환경 변수 장, 런타임 토폴로지), `docs/guides/live-smoke.md`(「전제」 — dev Gateway 를 연결 페이지로 붙이는 법, 새 실연 절), `.env.example` 확인, `CLAUDE.md`(dev:fake 훅·명령 줄 — 조율자가 「현재 단계」), 스펙 「구현과 맞춘 것」 장(PG1~PG10)

- [ ] **Step 1: 둘째 실물 Gateway 확인(PG8)** — 스크래치에 `openclaw@2026.9.5` CLI(`docs/guides/live-smoke.md` 「절차」), `--help` 에서 상태 디렉터리를 가르는 옵션을 찾아 다른 포트로 둘째 Gateway 를 띄워 본다. 결과를 보고서에.
- [ ] **Step 2: 실연(모델 런 0회)** — 로컬 서버(포트는 브리프)에 연결 페이지 「Gateway 추가」로 dev Gateway 를 붙여 페어링·플러그인 설치(새 브리지 토큰)·「서버와 같은 빌드입니다」·런 0회 하네스(가짜 claude CLI — `docs/guides/live-smoke.md` 「런 0회 하네스」)로 멘션·답. 둘째 Gateway(실물 또는 dev:fake 가짜)를 함께 붙여 같은 id 에이전트 둘을 각각 부른다. 모델 런이 필요하다고 판단되면 멈추고 조율자에게 묻는다(사용자 승인).
- [ ] **Step 3: 문서** — 위 파일. 화면 문구는 소스 그대로 인용, 04-citation(절 제목 인용·줄번호 없음·현재형).
- [ ] **Step 4: `pnpm fmt:check`, 커밋** — `docs: configure OpenClaw Gateways from the connection page`.

---

## Self-Review 기록

- **스펙 대조**: 0장 결정 1(이행 없음) → Global Constraints·태스크 3 · 2(소유자 자리) → 태스크 1 `owner_user_id` · 3(Gateway 별 구분) → 태스크 1·4 · 4(평문 토큰·응답에 없음) → 태스크 3 · 5(안 B) → 태스크 2 · 6(핸들 유일) → 태스크 4·7 · 7(삭제 처리) → 태스크 3(PG9)·4 · 8(첨부 범위) → 태스크 4 · 9(옮기기 owner) → 태스크 4·7 · 10(연결 점·플러그인 받기) → 태스크 6·7. 3장 → 1·3, 4장 → 1, 5장 → 2, 6.1 → 1, 6.2 → 3, 6.3·6.4 → 4, 6.5 → 5, 6.6 → 3·4·7, 7장 → 6·7, 8장 오류 표 → 2·3·4(각 테스트), 9장 → 1~9, 10장 완료 기준 1 → 3, 2 → 1·8, 3 → 2·8, 4 → 4·8, 5 → 4, 6 → 5·7, 7 → 10, 8 → 8·9·10. 11장은 범위 밖.
- **자리표시 검사**: TBD·「적절한」·「태스크 N 과 같이」 없음. 둘째 실물 Gateway 는 확인 절차(PG8)로 정했다.
- **이름 일관성**: `connectionId`·`ConnectionId`·`SendOptions`·`connectionIdOf`·`upsertGateway`·`removeGateway`·`GatewayConnectionConfig`·`BridgeTokenVerifier → { tokenId, gatewayId }`·`GatewaySummary`·`CreateGatewayBody`·`UpdateGatewayBody`·`DeleteGatewayResult { unboundAgents, deletedTokens }`·`SetupStatus.gateways`·`OpsStatus.gateways`·`Agent.gateway`·`OPENCLAW_ENV_CONNECTION_ID`(태스크 1 에서 생기고 3 에서 사라짐)를 태스크 사이에서 같은 이름으로 썼다.
- **Review Focus**: 다섯 줄 모두 소유 태스크의 Step 1 에 테스트가 있다(1 → 2·3, 2 → 1·8, 3 → 2·8, 4 → 4·8, 5 → 3·5·7).
