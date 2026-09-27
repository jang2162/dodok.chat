# Phase 4 ③ Claude 러너 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 이 저장소에서는 Orca 워커가 태스크를 맡는다(`CLAUDE.md` 「작업 방식」). 태스크 하나 = 워크트리 하나 = 브리프 하나.

**Goal:** 사람의 머신에서 도는 러너가 Claude Agent SDK 로 에이전트를 돌려 dodok 채널에 붙고, OpenClaw 에이전트와 같은 채널에서 서로 @멘션 릴레이한다.

**Architecture:** 어댑터 계약(`AgentAdapter`)을 `@dodok/shared` 로 올리고, 서버는 어댑터 하나를 쥐던 자리를 `AdapterRegistry`(에이전트의 `provider` → 어댑터)로 바꾼다. 서버 쪽 `@dodok/runner-adapter` 가 Socket.IO 네임스페이스 `/runner` 로 러너 연결을 받고, 사람 머신의 `@dodok/claude-runner` 는 런마다 SDK `query()` 하나를 돌려 스트림을 `RunEvent` 로 바꿔 올린다. 권한의 천장은 러너 로컬 설정이고, 도구 승인은 `canUseTool` → 기존 승인 카드다.

**Tech Stack:** Fastify 5 · Socket.IO 4.8(서버·클라이언트) · drizzle-orm 0.45 + better-sqlite3 · zod 4 · React 19 + TanStack Router/Query · esbuild · **새 의존성 하나 — `@anthropic-ai/claude-agent-sdk@0.3.283`(정확 핀, `packages/claude-runner` 에만)**

**Spec:** `docs/superpowers/specs/2026-09-27-claude-runner-design.md` — 결정 0장, 구성 2장, `/runner` 계약 3장, 러너 4장, 토큰·연결 페이지 5장, 승인 6장, 웹 7장, 오류 8장, 검증 9장, 완료 기준 10장. 실측 근거 `docs/adr/0007-claude-agent-sdk-spike.md`(「질문별」·「함정」·「설계에 주는 제약과 추천」). **태스크를 시작하기 전에 스펙의 해당 장과 ADR 의 해당 절을 읽는다.**

## Global Constraints

- **새 npm 의존성은 `@anthropic-ai/claude-agent-sdk@0.3.283` 하나**, `packages/claude-runner` 의 `dependencies` 에만, 정확 핀. 러너 번들은 SDK 를 품지 않는다(esbuild `external`). 서버·웹·shared·어댑터 패키지는 SDK 를 import 하지 않는다. 그 밖의 의존성(`socket.io-client`·`zod`·`esbuild`)은 저장소에 이미 있는 판본을 그대로 쓴다.
- `shared` 는 Node 전용 API 금지(어댑터 계약·가드는 순수 타입·순수 코드만).
- 외부 입력(러너 프레임·설정 파일·HTTP 본문)은 경계에서 Zod 파싱.
- **호스트 경로 원문은 어떤 텍스트에도 쓰지 않는다** — hello(작업 디렉터리는 라벨만)·도구 결과·`run.event`·승인 요약·오류 문구·로그. 작업 디렉터리 상대 경로만, 밖이면 `<작업 디렉터리 밖>`.
- 토큰: 러너 `drn_` + 32바이트 난수 base64url, DB 에는 sha256 hex 만. 원문은 발급 응답 한 번뿐 — 로그·사건·목록·wire 에 원문 없음. 러너는 토큰을 로그·오류 문구에 싣지 않는다.
- 세션 키는 shared `dodokSessionKey`·`parseDodokSessionKey` 로만(따로 조립·정규식 금지). 러너 에이전트 id 도 OpenClaw agentId 규칙(소문자).
- 승인 기한 10분(`RUNNER_APPROVAL_TTL_MS = 600_000`), 러너 동시 실행 기본 3(`maxConcurrentRuns`), 러너 재접속 백오프 1초~30초, `run.abort` 뒤 `close()` 까지 5초, `runner_down` 임계는 기존 `DISCONNECT_EVENT_MS`(60초).
- SDK 옵션 기본값(스펙 4.2): `systemPrompt: { type: "preset", preset: "claude_code", append, snapshot: false }`, `strictMcpConfig: true`, `settingSources: []`, `includePartialMessages: true`, dodok MCP `alwaysLoad: true`, env 허용 목록 + `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, 새 세션 `title`.
- 레이트리밋 숫자는 `apps/server/src/modules/ops/limits.ts` 한곳.
- 역할: 러너 토큰 발급·폐기와 러너 블록은 owner, 에이전트 등록·도구 승인 결정은 admin 이상(팀 스펙 「역할과 권한」 그대로).
- 웹 문구는 합쇼체, 서버 오류 문구를 그대로 보이지 않는다.
- **모델 런은 태스크 9 에서만, 실행 직전 사용자 승인**. 그 밖의 태스크는 모델 런 0 — 러너 테스트는 주입한 가짜 `query`, 하네스는 로컬 가짜 Messages API.
- Claude 로그인: `~/.claude` 는 읽지도 쓰지도 않는다. 자격 증명·키체인 값을 읽거나 출력하지 않는다. 러너 로그인 디렉터리는 경로만 넘긴다.
- 시크릿 규칙 `docs/guides/live-smoke.md` 「시크릿 규칙」. 5173·3000 금지(웹 5180, dev:fake 3100 대). 프로세스는 자기 PID 로만. Docker `prune` 금지.
- 커밋: `git add -A`·`git commit -a` 금지, 경로 명시. Conventional Commits + 스코프(`feat(runner): …`·`feat(runner-adapter): …`). 워커 트레일러 `Co-Authored-By: <네 실제 모델명> <noreply@anthropic.com>`.
- 생성물(drizzle SQL·meta)은 생성기(`pnpm -F @dodok/server exec drizzle-kit generate`)로.
- 끝내기 검사: 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check`, 각 exit code, 테스트 수는 자기 실행 출력에서 패키지별로(0개는 통과가 아니다). 웹을 바꿨으면 `pnpm -F @dodok/web build`, 서버를 바꿨으면 `pnpm -F @dodok/server build && pnpm -F @dodok/server bundle:smoke`.

## 계획 판정 (스펙과 맞춘 것)

조사한 코드에 맞춰 스펙을 구체화한 것. 태스크 9 가 스펙 「구현과 맞춘 것」 장으로 옮긴다.

- **P1 — `/runner` 는 Socket.IO 네임스페이스다.** 브리지(`/bridge`)가 이미 같은 `io` 서버의 네임스페이스라 같은 모양으로 둔다. 프레임은 Socket.IO 이벤트 이름 + ack, `ping`/`pong` 프레임은 두지 않는다(Socket.IO 하트비트). 첨부 HTTP 는 `RUNNER_ATTACHMENTS_PATH = "/runner/attachments"`.
- **P2 — `run.start` 에 `resume` 을 싣지 않는다.** 서버는 세션이 CLI 에 실제로 만들어졌는지 모른다(첫 런이 CLI 기동 전에 실패할 수 있다). 러너가 SDK 세션 도우미로 그 `providerSessionId` 의 전사가 있으면 `resume`, 없으면 `sessionId` 로 연다.
- **P3 — 채널 규칙 틀·턴 사실은 러너 어댑터(서버 쪽)가 만든다.** `run.start` 는 `InboundDeliver` + `providerSessionId` + `channelRulesAppend` + `turnFacts`. 문장은 shared `buildChannelRulesAppend`·`buildTurnFacts` 한곳. 러너 어댑터는 `capabilities().promptEveryRun = true` 라 오케스트레이터가 채널 프롬프트를 **매 런** 싣는다(OpenClaw 는 지금처럼 새 세션에서만).
- **P4 — Claude 세션 UUID 는 오케스트레이터가 정한다.** `capabilities().serverSessionIds = true` 인 어댑터면 오케스트레이터가 `agent_sessions.provider_session_id` 가 비었을 때 `randomUUID()` 를 쓰고 `send(input, { providerSessionId })` 로 넘긴다. 「새 대화」는 그 열을 비운다(다음 런이 새 UUID).
- **P5 — 승인 기한 타이머는 러너 어댑터가 쥔다.** 어댑터가 `ProviderApproval.expiresAt = now + 10분` 으로 정규화하고, 그때까지 결정이 없으면 러너에 `approval.resolve { decision: "deny" }` 를 보내고 `expired` 로 갱신한다. 서버의 기존 만료 감시는 그대로 돈다(둘 다 같은 시각).
- **P6 — 승인 결정 전 「Gateway 연결」 검사는 어댑터 안으로.** 지금 승인 서비스가 `adapter.status().gateway === "connected"` 를 먼저 본다. 이 검사를 OpenClaw 어댑터의 `resolveApproval` 안으로 옮기고(`ADAPTER_UNAVAILABLE` 로 던짐), 러너 어댑터는 그 에이전트의 러너가 없으면 같은 코드로 던진다. 서비스는 `AdapterError` 코드를 그대로 돌려준다.
- **P7 — `AdapterStatus` 는 `provider` 판별 유니온.** `{ provider: "openclaw", gateway, bridge }` | `{ provider: "claude", runners: { connected: number; tokens: number } }`. wire `adapter.status` 는 어댑터마다 따로 나간다. 웹의 기존 소비자(연결 점·배너)는 `openclaw` 만 본다.
- **P8 — usage 이벤트 이름은 `dodok.usage`.** 오케스트레이터는 `"openclaw.usage"` 와 `"dodok.usage"` 를 같은 경로로 받는다. `RunUsage` 에 `costKind?: "api" | "subscription_estimate"`. 운영 요약은 **제공자별로** 믿음을 가른다 — `USAGE_TRUSTED_PROVIDERS = new Set(["claude"])`, 믿는 제공자의 런만 토큰·비용을 합친다.
- **P9 — 에이전트 등록은 서버에서 목록 검사를 하지 않는다**(OpenClaw 와 같다). `POST /agents` 의 `provider` 를 `"openclaw" | "claude"` 로 열고, 웹이 `GET /agents/discover?provider=claude` 목록에서 고르게 한다.
- **P10 — `BridgeAuthGuard` 는 shared 로 옮긴다**(가져오는 것이 없는 순수 클래스). `@dodok/openclaw-adapter` 는 re-export 로 기존 import 를 유지한다.

## Review Focus

1. **러너가 런 도중 끊김(노트북 덮개를 닫음)** — 러너가 그 런들의 CLI 를 멈추고, 서버는 그 런을 `ADAPTER_UNAVAILABLE` 로 닫아 채널에 「다시 실행」 카드가 뜬다. 떠 있던 승인 카드는 철회로 닫힌다. 다시 붙은 뒤 「다시 실행」은 같은 세션을 이어 간다. → 태스크 3(어댑터)·5(러너)·4(통합 시나리오).
2. **에이전트가 `post` 의 `files` 로 `../.env`·`/etc/passwd`·작업 디렉터리 밖을 가리키는 심볼릭 링크를 줌** — 올리지 않고 도구 결과로 거절 사유(상대 경로만)를 돌려주며 런은 계속된다. 어떤 문구에도 호스트 경로 원문이 없다. → 태스크 6.
3. **같은 러너 토큰으로 두 번째 러너를 띄움 / 두 러너가 같은 에이전트 id 를 알림** — 앞의 경우는 먼저 붙은 연결이 끊기고 뒤가 산다. 뒤의 경우는 뒤 러너의 그 에이전트만 「충돌」, 런은 먼저 붙은 러너로 간다. → 태스크 3.
4. **승인 카드를 10분 동안 아무도 안 누름** — 카드가 만료로 닫히고, 러너는 도구를 거절 사유와 함께 돌려받아 런이 끝까지 간다(런이 영영 매달리지 않는다). → 태스크 3(타이머)·6(러너 쪽 deny).
5. **채널 규칙을 바꾼 직후 같은 에이전트에 멘션** — 다음 런의 `run.start` 에 새 규칙만 실린다(옛 규칙 없음), 새 세션이 아니어도. → 태스크 2(매 런 프롬프트)·3(`channelRulesAppend`).

각 줄의 테스트는 해당 태스크의 단계에 들어 있다.

---

## 파일 구조

| 파일 | 태스크 | 책임 |
| --- | --- | --- |
| `packages/shared/src/adapter/{index,guard}.ts`(새) | 1 | `AgentAdapter`·`AdapterEvent`·`RunEventBody`·`AdapterCapabilities`·`AdapterError`·`ProviderApproval`·`AdapterSetupDetail`·`BridgeAuthGuard` |
| `packages/shared/src/runner/{index,prompt}.ts`(새) | 1 | `/runner` 이벤트 Zod·상수, 채널 규칙 틀·턴 사실·러너 프롬프트 문장 |
| `packages/shared/src/{domain,common,ops,setup,wire,index}.ts` | 1 | `ApprovalKind` `tool`, `ErrorCode` `PROVIDER_AUTH`, `OpsEventKind` `runner_down`, `RunUsage.costKind`, `AdapterStatus` 유니온, `SetupStatus.runners` |
| `packages/openclaw-adapter/src/*` | 1 | 계약을 shared 에서 가져오기, `revokeTokenSessions`, `resolveApproval` 의 연결 검사(P6), `supports()` |
| `apps/server/src/adapters/{types,registry}.ts`·`app.ts`·`wiring.ts`·각 모듈 | 2 | `AdapterRegistry`, 어댑터를 쥐던 자리 교체, P3·P4·P6·P8 |
| `packages/runner-adapter/`(새 패키지) | 3 | `/runner` 네임스페이스·hello·러너 목록·충돌·런 중계·승인 타이머·끊김 처리 |
| `apps/server/src/modules/runners/`(새)·`db/schema.sqlite.ts`·`drizzle/0009_*`·`modules/setup/*`·`modules/attachments/routes.ts`·`modules/ops/*`·`modules/agents/*`·`infra/Dockerfile.server`·`apps/server/test/fakes/fake-runner.ts`(새) | 4 | 러너 토큰·연결 상태·러너 tgz·첨부 HTTP·`runner_down`·등록·통합 시나리오 |
| `packages/claude-runner/`(새 패키지) — `src/{config,connection,scheduler,run,stream-map,main}.ts` | 5 | 설정·연결·동시 실행·런 실행(주입한 `query`)·스트림 대응 |
| `packages/claude-runner/src/{post-tool,files,approvals,images}.ts` | 6 | `mcp__dodok__post`·파일 경로 검사와 업로드·`canUseTool`·이미지 받기 |
| `apps/web/src/features/{setup,agents,approvals,ops}/*`·`realtime/handlers.ts`·`app/layout/*` | 7 | 러너 블록·등록 제공자·도구 승인 카드·운영 화면 |
| `apps/server/scripts/dev-fake.ts` | 8 | 가짜 러너 붙이기 |
| `packages/claude-runner/scripts/fake-messages-api.ts`(새)·문서 | 9 | 런 0회 하네스·실연·문서 |

## 순서와 병렬

| 단계 | 태스크 | 선행 |
| --- | --- | --- |
| A | 1 shared 계약·어댑터 계약 이전 | — |
| B | 2 서버 레지스트리 | 1 |
| C | 3 runner-adapter ‖ 5 claude-runner 코어 | 1 (3 은 2 와 독립이지만 병합은 2 뒤) |
| D | 4 서버 통합(토큰·연결·첨부·운영·등록·시나리오) | 2·3 |
| E | 6 러너 도구·승인·첨부 ‖ 7 웹 | 5·4(6 의 업로드 경로), 4(7) |
| F | 8 dev:fake + 브라우저 검증 | 7 |
| G | 9 런 0회 하네스 + 문서 → 실연(모델 런, 사용자 승인) | 6·8 |

---

### Task 1: shared 계약·어댑터 계약 이전

**Files:**
- Create: `packages/shared/src/adapter/index.ts`, `packages/shared/src/adapter/guard.ts`, `packages/shared/src/runner/index.ts`, `packages/shared/src/runner/prompt.ts`, `packages/shared/test/runner.test.ts`, `packages/shared/test/runner-prompt.test.ts`, `packages/shared/test/adapter-guard.test.ts`
- Modify: `packages/shared/src/index.ts`(barrel 에 `./adapter`·`./runner`), `domain/index.ts`(`ApprovalKind` 에 `"tool"`, `RunUsage.costKind`), `common.ts`(`ErrorCode` 에 `"PROVIDER_AUTH"`), `ops/index.ts`(`OpsEventKind` 에 `"runner_down"`), `setup/index.ts`(`SetupStatus.runners`), `wire/index.ts`(`AdapterStatus` 유니온)
- Modify: `packages/openclaw-adapter/src/adapter-types.ts`(shared 에서 re-export 만 남김), `bridge/guard.ts`(shared re-export), `gateway/approvals.ts`(`ProviderApproval` 을 shared 에서), `openclaw-adapter.ts`·`fake-adapter.ts`(`revokeTokenSessions`·`supports`·P6), 기존 테스트
- Move test: `packages/openclaw-adapter/test/guard*.test.ts` 가 있으면 shared 로 옮긴다(가드가 옮겨 가므로)

**Interfaces — Produces:**

```ts
// packages/shared/src/adapter/index.ts — 지금 adapter-types.ts 의 계약을 옮기고 일반화한다
export type AdapterProvider = "openclaw" | "claude"; // AgentProvider 의 부분집합
export type AdapterCapabilities = {
  sessionReset: boolean; agentsList: boolean; configSet: boolean;
  promptEveryRun: boolean;    // P3 — 채널 프롬프트를 매 런 싣는다
  serverSessionIds: boolean;  // P4 — 서버가 providerSessionId 를 정한다
};
export type ProviderApproval = { /* 지금 openclaw gateway/approvals.ts 의 모양 그대로 옮긴다 */ };
export type AdapterSetupDetail =
  | { provider: "openclaw"; gateway: {…지금 그대로}; bridge: {…지금 그대로} }
  | { provider: "claude"; runners: RunnerConnection[] };
export type RunnerConnection = {
  tokenId: string; label: string; runnerVersion: string; sdkVersion: string; claudeCodeVersion: string;
  bundleSha256: string | null; capabilities: string[]; connectedAt: string;
  agents: Array<{ id: string; name: string; model: string; workdirLabel: string; conflict: boolean }>;
};
export type RunEventBody = DistributiveOmit<RunEvent, "seq" | "ts">;
export type AdapterEvent = /* 지금 그대로 — status 는 AdapterStatus 유니온 */;
export interface AgentAdapter {
  readonly provider: AdapterProvider;
  connect(): Promise<void>; close(): Promise<void>;
  status(): AdapterStatus; capabilities(): AdapterCapabilities; setupDetail(): AdapterSetupDetail;
  revokeTokenSessions(tokenId: string): number;
  listAgents(): Promise<Array<{ providerAgentId: string; name?: string; hint?: string }>>;
  sessionKeyFor(providerAgentId: string, channelId: string, threadRootId?: string): string;
  supports(providerAgentId: string, capability: "threads"): boolean;
  send(input: InboundDeliver, opts?: { providerSessionId?: string }): Promise<InboundDeliverResult>;
  abort(runId: string, sessionKey: string): Promise<void>;
  resetSession(sessionKey: string): Promise<{ sessionStartedAt?: string; lifecycleRevision?: string }>;
  syncChannelConfig(channelId: string, config: ConfigSet["config"]): Promise<ConfigSetResult>;
  resolveApproval(providerApprovalId: string, kind: ApprovalKind, decision: ApprovalDecision): Promise<ProviderApproval>;
  onEvent(handler: (e: AdapterEvent) => void): () => void;
  forgetRun?(runId: string): void;
}
export class AdapterError extends Error { /* 지금 그대로 */ }
export { BridgeAuthGuard } from "./guard"; // 지금 openclaw-adapter/src/bridge/guard.ts 그대로

// wire/index.ts — P7
export const AdapterStatus = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("openclaw"), gateway: z.enum(["connected", "reconnecting", "down"]), bridge: z.enum(["connected", "down"]) }),
  z.object({ provider: z.literal("claude"), runners: z.object({ connected: z.int().min(0), tokens: z.int().min(0) }) }),
]);

// setup/index.ts
SetupStatus.extend({ runners: z.object({
  list: z.array(RunnerConnectionSchema), runnerFile: z.union([z.object({ available: z.literal(true), sha256: z.string(), bundleSha256: z.string(), bytes: z.int() }), z.object({ available: z.literal(false) })]),
}) }) // RunnerConnectionSchema 는 위 RunnerConnection 과 같은 모양의 Zod

// runner/index.ts — P1
export const RUNNER_NAMESPACE = "/runner";
export const RUNNER_ATTACHMENTS_PATH = "/runner/attachments";
export const RUNNER_PROTOCOL = 1;
export const RunnerCapability = z.enum(["threads", "interrupt", "approvals", "attachments"]);
export const RunnerAgent = z.object({ id: z.string().refine(isOpenClawAgentId), name: z.string().min(1).max(64), model: z.string().min(1).max(64), workdirLabel: z.string().min(1).max(64) });
export const RunnerHello = z.object({
  runnerProtocol: z.int(), runnerVersion: z.string(), sdkVersion: z.string(), claudeCodeVersion: z.string(),
  bundleSha256: z.string().nullable(), capabilities: z.array(z.string()), agents: z.array(RunnerAgent).max(32),
}); // capabilities 는 z.string() — 모르는 값은 서버가 버린다(스레드 스펙 R1)
export const RunnerHelloResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), serverVersion: z.string(), conflicts: z.array(z.string()) }),
  z.object({ ok: z.literal(false), code: z.enum(["PROTOCOL_MISMATCH", "UNAUTHORIZED", "RATE_LIMITED"]), message: z.string() }),
]);
export const RunnerRunStart = z.object({ deliver: InboundDeliver, providerSessionId: z.uuid(), channelRulesAppend: z.string(), turnFacts: z.string(), sessionTitle: z.string().max(120) });
export const RunnerRunAck = z.object({ runId: Id, admission: z.enum(["dispatch", "drop"]), queuedPosition: z.int().min(1).optional(), reason: z.string().optional() });
export const RunEventBodySchema = /* RunEvent 판별 유니온의 각 변형에서 seq·ts 를 뺀 판별 유니온 */;
export const RunnerRunEvent = z.object({ runId: Id, event: RunEventBodySchema });
export const RunnerRunFinal = z.object({ runId: Id, text: z.string(), stopReason: z.string(), usage: z.object({ inputTokens: z.int().optional(), outputTokens: z.int().optional() }).optional(), costUsd: z.number().min(0).optional(), costKind: z.enum(["api", "subscription_estimate"]) });
export const RunnerRunError = z.object({ runId: Id, code: ErrorCode, message: z.string().max(2000) });
export const RunnerRunAbort = z.object({ runId: Id });
export const RunnerOutboundPost = OutboundMessage; // 첨부는 artifact:// id
export const RunnerOutboundAck = z.union([z.object({ ok: z.literal(true), messageId: Id }), z.object({ ok: z.literal(false), code: ErrorCode, message: z.string() })]);
export const RunnerApprovalRequested = z.object({
  providerApprovalId: z.string().min(1).max(128), runId: Id, sessionKey: z.string(), toolCallId: z.string(),
  toolName: z.string().max(128), summary: z.string().max(400), canAllowAlways: z.boolean(),
});
export const RunnerApprovalWithdrawn = z.object({ providerApprovalId: z.string() });
export const RunnerApprovalResolve = z.object({ providerApprovalId: z.string(), decision: ApprovalDecision, reason: z.enum(["expired"]).optional() }); // 기한 deny 는 reason: "expired"
export interface RunnerClientToServerEvents {
  hello: (p: RunnerHello, ack: (r: RunnerHelloResult) => void) => void;
  "run.event": (p: RunnerRunEvent) => void;
  "run.final": (p: RunnerRunFinal) => void;
  "run.error": (p: RunnerRunError) => void;
  "outbound.post": (p: RunnerOutboundPost, ack: (r: RunnerOutboundAck) => void) => void;
  "approval.requested": (p: RunnerApprovalRequested) => void;
  "approval.withdrawn": (p: RunnerApprovalWithdrawn) => void;
}
export interface RunnerServerToClientEvents {
  "run.start": (p: RunnerRunStart, ack: (r: RunnerRunAck) => void) => void;
  "run.abort": (p: RunnerRunAbort) => void;
  "approval.resolve": (p: RunnerApprovalResolve) => void;
}

// runner/prompt.ts — 문장은 여기 한곳. ADR 0007 「질문별」 채널 규칙 틀(4.5)의 틀을 그대로 옮긴다
export function buildChannelRulesAppend(input: { channelName: string; channelPrompt?: string; promptOverride?: string; relayRules: string }): string;
export function buildTurnFacts(input: { participants: InboundContext["participants"]; thread?: boolean; relayDepth?: number }): string;
/** 러너가 사용자 메시지로 보낼 본문 — 플러그인의 packages/openclaw-plugin/src/context.ts 가 만드는 dodok 헤더·최근 대화 꼴과 같은 뜻 */
export function renderRunnerPrompt(deliver: InboundDeliver): string;
```

- [ ] **Step 1: 실패하는 테스트**
  - `runner.test.ts`: 이벤트 스키마마다 유효 예 하나 왕복, 다음은 거절 — `RunnerHello` 에이전트 id 대문자·33개, `RunnerRunStart` 의 `providerSessionId` 가 UUID 아님, `RunnerApprovalRequested.summary` 401자, `RunnerRunFinal.costUsd` 음수, `RunEventBodySchema` 에 `seq` 가 있어도 통과하되 결과에 없음(`strip`).
  - `runner-prompt.test.ts`: `buildChannelRulesAppend` 가 채널 이름·규칙·출처(「채널 관리자가 dodok 채널 설정에 쓴 규칙」)를 담은 틀을 만들고, `channelPrompt`·`promptOverride` 가 없으면 규칙 줄 없이 틀과 릴레이 규칙만, **규칙 문자열 안의 틀 닫는 표식을 이스케이프**해 틀을 조기 종료시키지 못함. `buildTurnFacts` 는 참여자 핸들·자기 표시·스레드 여부. `renderRunnerPrompt` 는 보낸 사람·채널·최근 대화·스레드 루트를 담고 호스트 경로 모양 문자열을 만들지 않음. 문장 전체를 인라인 스냅숏으로 고정.
  - `adapter-guard.test.ts`: 옮긴 가드의 기존 테스트(차단·해제·주소 상한).
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** 계약 이전은 타입 이동 + 이름 바꾸기(`revokeBridgeSessions` → `revokeTokenSessions`, `pluginSupports(cap)` → `supports(agentId, cap)` — OpenClaw 는 에이전트 인자를 무시하고 붙은 플러그인을 본다). OpenClaw 어댑터 `capabilities()` 는 `promptEveryRun: false, serverSessionIds: false`, `setupDetail()` 은 `provider: "openclaw"` 를 붙인다. **P6**: 승인 서비스의 Gateway 연결 선검사와 같은 조건을 OpenClaw `resolveApproval` 첫 줄로 옮긴다(서버 쪽 삭제는 태스크 2 — 이 태스크에서는 둘 다 있어도 동작이 같다).
- [ ] **Step 3: 서버·웹 컴파일 유지.** 서버 `adapters/types.ts` 는 shared 에서 re-export, `revokeBridgeSessions`·`pluginSupports` 호출처(연결 페이지 폐기 라우트, 오케스트레이터 `pluginLacksThreads`)와 `setupDetail()` 을 읽는 자리(`status.ts` `buildSetupStatus`, 운영 `health.ts`)는 `provider === "openclaw"` 로 좁혀 읽는다. 웹의 `AdapterStatus` 소비자(`realtime/handlers.ts`·`app/layout/ConnectionDots.tsx`·`Banners.tsx`·`features/ops/StatusCard.tsx`)는 `provider === "openclaw"` 일 때만 읽고 나머지는 무시한다. `SetupStatus.runners` 는 서버가 `{ list: [], runnerFile: { available: false } }` 로 채운다(태스크 4 가 실값).
- [ ] **Step 4: 루트 검사 4종 + 웹 빌드.** 기존 테스트 수가 줄지 않았는지 패키지별로 대조(가드 테스트는 옮겨 간 만큼 shared 로).
- [ ] **Step 5: 커밋** — `refactor(shared): 어댑터 계약을 shared 로 — revokeTokenSessions·supports·AdapterStatus 유니온`, `feat(shared): /runner 계약과 채널 규칙 틀`.

---

### Task 2: 서버 어댑터 레지스트리

**Files:**
- Create: `apps/server/src/adapters/registry.ts`, `apps/server/test/adapter-registry.test.ts`
- Modify: `apps/server/src/app.ts`(`AppDeps.adapter` → `AppDeps.adapters?: AgentAdapter[]`, 기본은 OpenClaw 하나, `App.registry`), `wiring.ts`(`sessionRecoverTargets` 는 `provider = 'openclaw'` 만), `modules/runs/orchestrator.ts`·`context.ts`, `modules/approvals/service.ts`, `modules/sessions/service.ts`, `modules/channels/{routes,service}.ts`, `modules/agents/routes.ts`, `modules/adapter/routes.ts`, `modules/setup/routes.ts`, `modules/ops/{routes,health,summary}.ts`, `realtime/events.ts`, 기존 테스트의 `adapter:` 주입

**Interfaces:**
- Consumes: 태스크 1 `AgentAdapter`·`AdapterCapabilities`·`AdapterStatus` 유니온.
- Produces:

```ts
// adapters/registry.ts
export interface AdapterRegistry {
  all(): readonly AgentAdapter[];
  forProvider(p: AdapterProvider): AgentAdapter | undefined;
  /** 에이전트 행의 provider 로 — 없으면 AdapterError("ADAPTER_UNAVAILABLE") */
  forAgent(agent: { provider: string }): AgentAdapter;
  /** all() 의 이벤트를 한 핸들러로 — 이벤트에 어느 어댑터에서 왔는지 붙인다 */
  onEvent(handler: (e: AdapterEvent, from: AgentAdapter) => void): () => void;
}
export function createAdapterRegistry(adapters: AgentAdapter[]): AdapterRegistry; // 같은 provider 둘이면 throw
```

- 바꿀 자리(탐색 결과 — 지금 어댑터를 받는 곳 전부): `createServices`·`createOrchestrator`·`createApprovalsService`·`ensureSession`·`resetAgentSession`·`ChannelRouteContext`·`AgentRouteContext`·`AdapterRouteContext`·`SetupRouteContext`·운영 routes·`watchConnections`·`watchGatewayVersion`·`watchGatewayReconnecting`·`createApp` 안의 `setupStatus()`·`onEvent(kind:"setup")`. 원칙: **런·세션·승인·리셋은 에이전트 → `forAgent`**, **OpenClaw 전용 감시(Gateway 버전·재연결·페어링)는 `forProvider("openclaw")`**, 상태·이벤트 구독은 `all()`.
- 오케스트레이터(P3·P4·P8):
  - `ensureSession` 이 돌려준 `needsPromptContext` 를 `adapter.capabilities().promptEveryRun` 이면 늘 `true` 로 본다.
  - `capabilities().serverSessionIds` 면 `ensureProviderSessionId(db, session.id)`(새 함수, `sessions/service.ts` — 비었으면 `randomUUID()` 를 쓰고 돌려준다)를 `send(inbound, { providerSessionId })` 로.
  - `pluginLacksThreads()` → `!adapter.supports(agent.providerAgentId, "threads")`(OpenClaw 는 붙은 플러그인이 있을 때만 false 가 의미 있으므로 기존 조건 유지).
  - usage: `"openclaw.usage"` 와 `"dodok.usage"` 둘 다 `recordUsage`.
  - wire `adapter.status` 는 어댑터마다 자기 상태로.
- 리셋: `resetAgentSession` 은 어댑터 `resetSession` 뒤 `serverSessionIds` 면 `agent_sessions.provider_session_id` 를 NULL 로.
- 승인(P6): 서비스의 `status().gateway === "connected"` 선검사를 지우고 `forAgent(에이전트)` 의 `resolveApproval` 이 던지는 `AdapterError` 코드를 그대로 돌려준다. `findAgentId(…, provider, …)` 는 **승인을 낸 어댑터의 provider** 로(`registry.onEvent` 의 `from.provider`).
- 운영 요약(P8): `USAGE_TRUSTED` 상수를 `USAGE_TRUSTED_PROVIDERS: ReadonlySet<string> = new Set(["claude"])` 로 바꾸고, `runs` 를 `agents` 와 조인해 믿는 제공자의 런만 토큰·비용을 합친다. `OpsRunsSummary.usageTrusted: boolean` 은 `usageTrustedProviders: string[]` 로(웹 `RunsTable` 은 목록이 비었으면 지금처럼 「측정 불가」 — 웹 표시는 태스크 7).
- `AdapterRouteContext`(`GET /api/v1/adapter/status`)는 `{ statuses: AdapterStatus[], capabilities: Record<provider, AdapterCapabilities> }` 로. 웹 `api/queries.ts` 의 `qk.adapter` 소비자는 `openclaw` 항목을 고른다.

- [ ] **Step 1: 실패하는 테스트** — `adapter-registry.test.ts`: `FakeAdapter` 를 provider 둘로 흉내(두 번째는 `provider: "claude"` 인 최소 가짜 — `FakeAdapter` 에 `provider` 생성자 옵션을 더한다)해 `createApp({ adapters: [openclawFake, claudeFake] })`:
  - `provider: "claude"` 에이전트를 멘션하면 `claudeFake.send` 만 불리고 `opts.providerSessionId` 가 UUID, 같은 세션의 두 번째 런은 **같은 UUID**, 「새 대화」 뒤 런은 **다른 UUID**.
  - `claudeFake` 는 `promptEveryRun: true` — 채널 프롬프트가 있는 채널에서 **두 번째 런에도** `context.channelPrompt` 가 실림. 채널 프롬프트를 바꾼 뒤 런에는 **새 값만**(Review Focus 5). OpenClaw 가짜 쪽은 지금처럼 새 세션에서만.
  - 한 채널에 OpenClaw 에이전트 `dev` 와 Claude 에이전트 `coder` — `dev` 의 답에 `@coder` 가 있으면 릴레이 런이 `claudeFake` 로, 그 답의 `@dev` 는 `openclawFake` 로(릴레이 깊이·한도는 지금 규칙 그대로).
  - 승인: `claudeFake` 가 낸 `approval` 이벤트가 claude 에이전트로 이어지고, `resolveApproval` 이 `AdapterError("ADAPTER_UNAVAILABLE")` 를 던지면 wire ack 가 `ADAPTER_UNAVAILABLE`·승인은 pending 그대로.
  - `"dodok.usage"` CUSTOM 이벤트가 `runs.usage` 에 들어가고, 운영 요약은 claude 런의 비용만 합치고 `usageTrustedProviders` 가 `["claude"]`.
  - 어댑터가 없는 provider(`codex`) 에이전트 멘션 → `ADAPTER_UNAVAILABLE` run_error 카드.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.** OpenClaw 하나만 등록된 기존 테스트는 **전부 그대로 초록**(동작 변화 없음). `createApp` 의 `deps.adapter` 를 쓰던 테스트는 `adapters: [fake]` 로 바꾼다.
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드 + 서버 번들 스모크.**
- [ ] **Step 4: 커밋** — `refactor(server): AdapterRegistry — 에이전트의 provider 로 어댑터를 고른다`, `feat(server): 서버가 정하는 세션 id·매 런 채널 프롬프트·제공자별 usage 믿음`.

---

### Task 3: `@dodok/runner-adapter`

**Files:**
- Create: `packages/runner-adapter/{package.json,tsconfig.json,vitest.config.ts}`, `src/index.ts`, `src/runner-adapter.ts`, `src/connections.ts`, `src/approvals.ts`, `test/runner-adapter.test.ts`, `test/helpers/fake-runner-client.ts`
- `package.json` 은 `packages/openclaw-adapter/package.json` 을 본떠(private, `type: module`, `main: ./src/index.ts`) 의존성 `@dodok/shared`·`socket.io`·`zod`(저장소 판본), devDependency `socket.io-client`·`vitest`·`@types/node`. `pnpm-workspace.yaml` 이 `packages/*` 를 잡는지 확인.

**Interfaces:**
- Consumes: 태스크 1 계약 전부(`AgentAdapter`·`BridgeAuthGuard`·runner 이벤트 Zod·`buildChannelRulesAppend`·`buildTurnFacts`).
- Produces:

```ts
export type RunnerTokenVerifier = (presented: unknown) => { tokenId: string; label: string } | null;
export type RunnerAdapterOptions = {
  io: Server;                         // 서버의 Socket.IO — io.of(RUNNER_NAMESPACE)
  verifyToken: RunnerTokenVerifier;
  clientAddress: (socket: Socket) => string;
  authGuard: BridgeAuthGuard; onBlocked: (address: string) => void; now: () => number;
  serverVersion: string;
  logger: AdapterLogger;
  /** run.start 에 실을 채널 이름·새 세션 제목 */
  channelName: (channelId: string) => string | undefined;
  /** outbound.post 를 서버가 받아 메시지를 만든다 — 오케스트레이터의 onCanonical 과 같은 자리 */
  onOutbound: (m: OutboundMessage) => Promise<{ messageId: string }>;
  tokenCount: () => number;           // AdapterStatus.runners.tokens
  approvalTtlMs?: number;             // 기본 RUNNER_APPROVAL_TTL_MS
};
export function createRunnerAdapter(opts: RunnerAdapterOptions): AgentAdapter & { provider: "claude" };
export const RUNNER_APPROVAL_TTL_MS = 600_000;
```

- 동작(스펙 3·4.5·5·6·8장):
  - **핸드셰이크**: `namespace.use` — 가드 차단이면 토큰을 보지 않고 거절, `socket.handshake.auth.token` 을 `verifyToken`, 실패는 `authGuard.fail`(브리지 `bridge/server.ts` 의 `namespace.use` 와 같은 순서). 붙은 뒤 `hello` 를 10초 안에 받지 못하면 끊는다. `hello` 를 `RunnerHello` 로 파싱, `runnerProtocol !== RUNNER_PROTOCOL` → `{ ok:false, code:"PROTOCOL_MISMATCH" }` 후 끊기. 모르는 capability 는 버림.
  - **같은 토큰의 두 번째 연결**은 먼저 붙은 소켓을 끊고 뒤를 남긴다(Review Focus 3).
  - **에이전트 id 충돌**: 이미 다른 러너가 알린 id 는 뒤 러너 쪽에서 `conflict: true`, `hello.ok.conflicts` 에 싣고 warn 로그. 먼저 러너가 끊기면 충돌이던 러너의 그 에이전트가 이어받는다(끊긴 순간 재배정).
  - `listAgents()` → 충돌 아닌 에이전트, `hint` 에 러너 라벨·작업 디렉터리 라벨·모델.
  - `send(input, { providerSessionId })` → 그 에이전트를 가진 러너가 없으면 `AdapterError("ADAPTER_UNAVAILABLE")`. 있으면 `run.start`(ack 제한시간 15초, 넘으면 `ADAPTER_UNAVAILABLE`) — `channelRulesAppend = buildChannelRulesAppend(...)`, `turnFacts = buildTurnFacts(...)`, `sessionTitle = "<채널 이름> · <에이전트 이름>"`. ack 의 `queuedPosition` 이 있으면 `run_event RUN_QUEUED { position }`.
  - `run.event` → `run_event`(Zod 실패는 버리고 warn), `run.final` → `canonical` 없이 `run_signal`(종료) + 최종 답 — **최종 답이 메시지가 되는 모양은 OpenClaw 의 `canonical` 과 같게**: `onOutbound` 와 같은 경로로 최종 텍스트를 채널 메시지로 만들고 `run_signal` 을 낸다. 비용은 `run_event CUSTOM { name: "dodok.usage", value: RunUsage }`(P8).
  - `run.error` → `RUN_ERROR` 이벤트(코드 그대로).
  - `abort(runId)` → `run.abort`.
  - `resetSession()` → `{}`(러너에 할 일 없음 — UUID 는 서버가 비운다). `syncChannelConfig()` → `{ applied: "live" }`. `capabilities()` → `{ sessionReset: true, agentsList: true, configSet: true, promptEveryRun: true, serverSessionIds: true }`.
  - `supports(agentId, "threads")` → 그 에이전트를 가진 러너의 hello 에 `threads`.
  - **승인(P5)**: `approval.requested` → `ProviderApproval { kind: "tool", title: toolName, detail: summary, severity: "warn", allowedDecisions: canAllowAlways ? ["allow-once","allow-always","deny"] : ["allow-once","deny"], status: "pending", createdAt: now, expiresAt: now + ttl }` 을 `approval` 이벤트로. `approval.withdrawn` → 같은 id 를 `status: "expired", reason` 철회로. `resolveApproval()` → 러너가 없으면 `ADAPTER_UNAVAILABLE`(P6), 있으면 `approval.resolve` 를 보내고 `resolved` 스냅숏. 기한 타이머가 먼저 오면 `approval.resolve { decision: "deny", reason: "expired" }` + `expired` 이벤트, 뒤늦은 `resolveApproval` 은 `EXPIRED`.
  - **러너 끊김**: 그 러너에 떠 있던 런마다 `RUN_ERROR { code: "ADAPTER_UNAVAILABLE" }`, 떠 있던 승인마다 철회 이벤트, 타이머 정리, `status` 이벤트.
  - `revokeTokenSessions(tokenId)` → 그 토큰 소켓을 끊고 끊은 수.
  - `status()` → `{ provider: "claude", runners: { connected, tokens: tokenCount() } }`, 러너가 붙거나 끊길 때마다 `status` 와 `setup` 이벤트.
  - 로그에 토큰 원문·작업 디렉터리 경로 없음(러너는 경로를 안 보내지만 로그 필드도 라벨만).

- [ ] **Step 1: 실패하는 테스트** — `test/helpers/fake-runner-client.ts`(socket.io-client 로 `/runner` 에 붙어 hello·이벤트를 보내는 도우미)와 실제 `http.Server` + `Server` 로:
  - 틀린 토큰 → 연결 거절, 가드 한도 뒤에는 옳은 토큰도 거절. 프로토콜 2 → `PROTOCOL_MISMATCH` 후 끊김. hello 없이 10초(가짜 시계) → 끊김.
  - 같은 토큰 두 번째 연결 → 첫 소켓 끊김, `status().runners.connected === 1`. 두 러너가 `coder` 를 알림 → 뒤 러너 `conflicts: ["coder"]`, `send` 는 앞 러너로. 앞 러너가 끊기면 다음 `send` 는 뒤 러너로(Review Focus 3).
  - `send` → 러너가 받은 `run.start` 의 `channelRulesAppend` 에 채널 프롬프트, `providerSessionId` 가 넘긴 값, `queuedPosition: 2` ack → `RUN_QUEUED { position: 2 }` 이벤트. 러너 없음 → `ADAPTER_UNAVAILABLE`.
  - `run.event` 텍스트 델타·도구 이벤트가 `run_event` 로, 스키마 밖 이벤트는 버려짐. `run.final { costUsd: 0.12, costKind: "subscription_estimate" }` → 최종 메시지 + `dodok.usage` CUSTOM + 종료 신호.
  - 승인: 요청 → `approval` pending, `resolveApproval("allow-always")` → 러너가 `approval.resolve` 를 받음. 가짜 시계로 10분 → 러너가 `deny` 를 받고 `expired` 이벤트, 뒤늦은 `resolveApproval` 은 `EXPIRED`(Review Focus 4). `approval.withdrawn` → 철회 이벤트.
  - **런 도중 러너 끊김** → 그 런 `RUN_ERROR ADAPTER_UNAVAILABLE`, pending 승인 철회, 뒤 `resolveApproval` 은 `ADAPTER_UNAVAILABLE`(Review Focus 1).
  - `revokeTokenSessions` → 끊고 1 을 돌려줌.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종**(새 패키지가 turbo `test`·`typecheck` 에 잡혔는지 실행 개수로 확인).
- [ ] **Step 4: 커밋** — `feat(runner-adapter): /runner 네임스페이스와 러너 어댑터`.

---

### Task 4: 서버 통합 — 러너 토큰·연결 페이지·첨부·운영·등록

**Files:**
- Modify: `apps/server/src/db/schema.sqlite.ts`(`runner_tokens` — `bridge_tokens` 와 같은 열: `id`, `workspace_id`, `label`, `hash` 유일, `prefix`, `created_at`, `last_used_at`, `revoked_at`), 생성기로 `apps/server/drizzle/0009_*`
- Create: `apps/server/src/modules/runners/{tokens,routes,runner-file}.ts`, `apps/server/test/fakes/fake-runner.ts`, `apps/server/test/runners.routes.test.ts`, `apps/server/test/integration/runner.scenarios.test.ts`
- Modify: `apps/server/src/app.ts`(러너 어댑터 생성·레지스트리 등록·`verifyRunnerToken`·가드 공유), `config.ts`(`DODOK_RUNNER_DIR`), `modules/setup/{routes,status}.ts`(`SetupStatus.runners`), `modules/attachments/routes.ts`(`RUNNER_ATTACHMENTS_PATH` GET·POST, 러너 토큰), `modules/ops/health.ts`(`runner_down`), `modules/ops/service.ts`(`resolve` 의 kind 에 `runner_down`), `modules/agents/{routes,service}.ts`(P9), `packages/claude-runner/package.json` 의 `pack:runner` 를 부르는 `infra/Dockerfile.server` 단계(`/app/runner`, `DODOK_RUNNER_DIR`)

**Interfaces:**
- Consumes: 태스크 2 `AdapterRegistry`, 태스크 3 `createRunnerAdapter`·`RunnerTokenVerifier`.
- Produces:

```ts
// modules/runners/tokens.ts — modules/setup/tokens.ts 의 브리지 토큰 함수와 같은 모양, 접두사 drn_
export function issueRunnerToken(db: Db, workspaceId: string, label: string, now?: Date): { token: string; record: RunnerTokenRecord };
export function verifyRunnerTokenDb(db: Db, presented: unknown, now?: Date): { tokenId: string; label: string } | null;
export function listRunnerTokens(db: Db, workspaceId: string, connectedTokenIds: ReadonlySet<string>): RunnerTokenRecord[];
export function revokeRunnerToken(db: Db, workspaceId: string, id: string, now?: Date): boolean;
export function activeRunnerTokenCount(db: Db, workspaceId: string): number;
// routes (owner): GET/POST /api/v1/setup/runner-tokens, DELETE /api/v1/setup/runner-tokens/:id, GET /api/v1/setup/runner.tgz
// POST 응답 201 { token, record, runnerConfig: { serverUrl, tokenFile: "~/.dodok-runner/token" } }, cache-control: no-store
// runner-file.ts — modules/setup/plugin-file.ts 의 readPluginFile 과 같은 모양(tgz 안 package/dist/main.js 의 번들 해시)
```

- 러너 tgz: `packages/claude-runner` 의 `pack:runner`(태스크 5 가 만든다 — 이 태스크가 먼저 병합되면 `DODOK_RUNNER_DIR` 에 파일이 없어 `runnerFile.available: false`, 라우트 404 `RUNNER_FILE_MISSING` 이 정상). Dockerfile 은 플러그인 단계를 본떠 `runner` 단계를 더하고 `/app/runner` 로 복사, 번들 스모크가 러너 파일 없음도 통과하는지 확인.
- 첨부 HTTP: 기존 `requireBridge(verify, guard)` 를 `requireToken(verify, guard)` 로 일반화해 브리지·러너 두 경로가 함께 쓴다(가드는 한 인스턴스). 러너 POST 는 기존 제한(20 MiB·매직 바이트·디스크 여유 507) 그대로.
- 운영: `watchConnections` 에 러너 쪽 — `status.provider === "claude"` 에서 **토큰별**로 「마지막 연결이 있었던 토큰이 끊긴 채 60초」면 `runner_down`(key = 토큰 id), 다시 붙으면 `resolve`. 폐기된 토큰은 사건을 남기지 않는다.
- 등록(P9): `CreateAgentBody.provider` = `z.enum(["openclaw","claude"]).default("openclaw")`, `CreateAgentInput.provider` 도. `GET /api/v1/agents/discover?provider=openclaw|claude`(기본 openclaw) → `registry.forProvider(p)?.listAgents()`.
- 연결 페이지 폐기: `DELETE runner-tokens/:id` → `revokeRunnerToken` → `registry.forProvider("claude")?.revokeTokenSessions(id)` → `changed()`.

- [ ] **Step 1: 실패하는 테스트**
  - `runners.routes.test.ts`: owner 발급 201(원문 `drn_` 한 번, 목록에는 prefix 만), admin·member 403, 폐기 → 그 토큰 소켓 끊김·`SetupStatus.runners.list` 에서 빠짐, 러너 파일 없음 → `runner.tgz` 404·`runnerFile.available: false`, 러너 첨부 GET·POST 가 러너 토큰으로 통과하고 브리지 토큰·틀린 토큰은 401, 같은 가드라 러너 경로 실패도 브리지 차단에 합산.
  - `fake-runner.ts`: socket.io-client 로 `/runner` 에 붙어 hello(에이전트 `coder`)를 보내고, `run.start` 를 받으면 대본대로 델타 → `run.final`, 옵션으로 `approval.requested`·`outbound.post`·끊기. (dev:fake 도 쓴다 — 태스크 8.)
  - `runner.scenarios.test.ts`(실제 앱 + 가짜 Gateway·플러그인 + 가짜 러너, 모델 런 0):
    1. `claude` 에이전트 등록(`discover?provider=claude` 에 `coder`) → 멘션 → 스트리밍 → 최종 답 메시지, 활동 탭 런에 도구 타임라인.
    2. 스레드 안 멘션 → `run.start.deliver.sessionKey` 가 스레드 하위 키.
    3. 승인 허용·항상 허용·거절·만료(10분 가짜 시계) — 카드 상태와 러너가 받은 결정.
    4. **런 도중 러너 끊김** → `ADAPTER_UNAVAILABLE` run_error 카드, 「다시 실행」 → 다시 붙은 러너가 **같은 `providerSessionId`** 로 `run.start` 를 받음(Review Focus 1).
    5. 토큰 폐기 → 즉시 끊김, 다음 멘션은 run_error 카드.
    6. 두 러너가 `coder` 를 알림 → 연결 페이지 상태에 충돌 표시.
    7. **OpenClaw 에이전트 `dev` 와 Claude 에이전트 `coder` 가 한 채널에서 서로 @멘션 릴레이** — `dev` 의 답 `@coder …` → 러너 런 → `coder` 의 답 `@dev …` → 플러그인 런, 릴레이 깊이 한도에서 멈춤.
    8. `outbound.post`(카드) → 채널에 카드 메시지, ack 의 `messageId` 가 그 메시지.
    9. 러너 60초 끊김 → `runner_down` 사건, 다시 붙으면 해소.
    10. 운영 요약에 러너 런 비용이 합쳐짐.
- [ ] **Step 2: 마이그레이션** — 스키마를 고치고 생성기를 돌린다. 기존 DB(0008 상태)에 적용해 기존 행이 그대로인지 `test/db.test.ts` 에 한 사례.
- [ ] **Step 3: 실패 확인 → 구현 → 통과.**
- [ ] **Step 4: 루트 검사 4종 + 서버 번들 스모크.** Docker 이미지는 로컬 Compose 로 빌드만 확인(`docker compose --env-file infra/local.env -f infra/compose.yml -f infra/compose.local.yml build app`) — 자기가 만든 이미지만 이름으로 지운다.
- [ ] **Step 5: 커밋** — `feat(server): runner_tokens 와 연결 페이지 러너 API`, `feat(server): 러너 어댑터 연결 — 첨부·runner_down·claude 에이전트 등록`, `test(server): 러너 통합 시나리오`.

---

### Task 5: `@dodok/claude-runner` 코어

**Files:**
- Create: `packages/claude-runner/{package.json,tsconfig.json,vitest.config.ts,build.mjs}`, `src/main.ts`(bin `dodok-runner`), `src/config.ts`, `src/connection.ts`, `src/scheduler.ts`, `src/run.ts`, `src/stream-map.ts`, `src/sdk.ts`(SDK 를 import 하는 유일한 파일 — `query` 와 세션 도우미를 주입 가능한 모양으로 내보냄), `test/{config,stream-map,run,scheduler,connection}.test.ts`, `test/helpers/fake-query.ts`
- `package.json`: `dependencies` 에 `@anthropic-ai/claude-agent-sdk: "0.3.283"`(정확), `@dodok/shared`(번들에 들어감), `socket.io-client`·`zod`(저장소 판본). 스크립트 `build`(esbuild — SDK `external`, `@dodok/shared` 는 번들), `pack:runner`(빌드 → `dist/` 에 tgz, 번들 해시를 hello 의 `bundleSha256` 상수로 굽는 방식은 `packages/openclaw-plugin` 의 `build.mjs`·`bundle-hash.ts` 를 본뜬다), `test`, `typecheck`. SDK 설치에 postinstall 이 있으면 `pnpm-workspace.yaml` 의 허용 목록 정책을 따른다(허용하지 않는다 — 번들 CLI 는 SDK 패키지 안 파일로 충분한지 설치 뒤 확인하고 보고).

**Interfaces:**
- Consumes: 태스크 1 runner 계약·`renderRunnerPrompt`.
- Produces:

```ts
// config.ts
export const RunnerConfig = z.object({
  serverUrl: z.url(), tokenFile: z.string().optional(), claudeConfigDir: z.string(),
  maxConcurrentRuns: z.int().min(1).max(16).default(3),
  agents: z.array(z.object({
    id: z.string().refine(isOpenClawAgentId), name: z.string().min(1).max(64), workdir: z.string(), workdirLabel: z.string().max(64).optional(),
    model: z.string().min(1).max(64), permissionMode: z.enum(["default", "acceptEdits", "plan", "dontAsk"]).default("default"),
    allowedTools: z.array(z.string()).default([]), disallowedTools: z.array(z.string()).default([]),
  })).min(1).max(32),
});
/** ~ 를 풀고, workdir 존재 확인, 토큰을 tokenFile 또는 env DODOK_RUNNER_TOKEN 에서. 오류는 사람이 읽는 한 줄(키 경로 + 까닭), 토큰 값은 싣지 않는다 */
export function loadRunnerConfig(path: string, env: NodeJS.ProcessEnv, fs: FsLike): { config: ResolvedRunnerConfig; token: string; warnings: string[] };

// sdk.ts — 테스트는 이것을 가짜로 바꾼다
export type SdkPort = {
  query: (args: { prompt: AsyncIterable<SdkUserMessage>; options: SdkOptions }) => SdkQuery; // SdkQuery: AsyncIterable<SdkMessage> & { interrupt(): Promise<void>; close(): void }
  sessionExists: (sessionId: string, cwd: string) => Promise<boolean>; // P2 — SDK 세션 도우미
  accountKind: () => Promise<"api" | "subscription">; // costKind — initialize 결과의 계정 종류
};

// stream-map.ts — ADR 0007 대응표. 상태를 가진 변환기(텍스트 메시지 시작 여부·도구 시작 시각)
export function createStreamMapper(now: () => number): {
  map(m: SdkMessage): Array<{ event?: RunEventBody; final?: RunnerRunFinalBody; error?: { code: ErrorCode; message: string } }>;
};

// run.ts
export function buildQueryOptions(agent: ResolvedAgent, start: RunnerRunStart, deps: { claudeConfigDir: string; baseEnv: NodeJS.ProcessEnv; mcpServer: unknown; canUseTool?: CanUseTool; resume: boolean }): SdkOptions;
export const ENV_ALLOWLIST: readonly string[]; // PATH HOME LANG LC_ALL TERM TMPDIR SHELL USER
export function runOnce(start: RunnerRunStart, ctx: RunContext): Promise<void>; // 이벤트·final·error 를 ctx.emit 으로

// scheduler.ts
export function createScheduler(max: number): { submit(runId: string, sessionId: string, job: () => Promise<void>): { queuedPosition?: number } | { busy: true }; abort(runId: string): void; abortAll(): void; };
```

- 동작(스펙 4장·ADR 0007):
  - `buildQueryOptions` 는 Global Constraints 의 SDK 옵션 기본값을 그대로. `resume` 이면 `resume: providerSessionId`, 아니면 `sessionId: providerSessionId` + `title: start.sessionTitle`. `env` 는 `ENV_ALLOWLIST` 의 값만 + `CLAUDE_CONFIG_DIR` + `CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1"`. 러너 시작 때 `process.env.CLAUDE_CONFIG_DIR` 도 같은 값으로.
  - `hooks.UserPromptSubmit` → `{ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: start.turnFacts } }`.
  - 프롬프트는 `renderRunnerPrompt(start.deliver)` 를 담은 사용자 메시지 하나(이미지 블록은 태스크 6).
  - **런의 끝**: 그 프롬프트 턴의 `result` — `resume` 직후 `num_turns: 0` 결과는 건너뛴다, 마지막 `result` 뒤 반복자가 던지면 무시, `result` 전에 던지면 `run.error`(메시지에 인증 실패 표지면 `PROVIDER_AUTH`, 그 밖은 `INTERNAL`).
  - 비용: `sessionExists` 가 참이면 런 전에 알던 누적값이 없으므로 **첫 `result` 의 `total_cost_usd` − 이 세션의 직전 누적값**을 쓰기 위해 러너가 세션별 마지막 누적값을 메모리에 둔다. 러너 재시작 뒤 첫 런은 누적값을 모르므로 `costUsd` 를 싣지 않는다(토큰 수는 싣는다).
  - 스케줄러: 동시 `max`, 넘치면 대기열과 `queuedPosition`, 같은 세션 id 가 돌고 있으면 `{ busy: true }` → `run.error CONFLICT`. `run.abort` → `interrupt()`, 5초 안에 끝나지 않으면 `close()`.
  - 연결: socket.io-client 로 `serverUrl` + `RUNNER_NAMESPACE`, `auth: { token }`, 붙으면 `hello`(에이전트 목록은 `workdirLabel` 만), `hello.ok:false` 면 사유를 출력하고 종료 코드 2. **끊기면 `abortAll()`**(Review Focus 1), 1초~30초 지수 백오프 재접속(socket.io-client 옵션).
  - `run.start` 의 `deliver.agentId` 가 설정 파일에 없으면 `run.error { code: "NOT_FOUND" }`(스펙 8장).
  - `main.ts`: `dodok-runner --config <경로>`(기본 `~/.dodok-runner/config.json`), 시작 줄에 러너·SDK·CLI 판본과 에이전트 라벨, SIGINT 에 `abortAll()` 뒤 종료.

- [ ] **Step 1: 실패하는 테스트** — `fake-query.ts` 는 대본(SDK 메시지 배열)을 흘리는 `SdkPort`:
  - `config.test.ts`: 틀린 JSON·없는 workdir·대문자 id·토큰 없음 → 키 경로가 든 한 줄, 토큰 값·workdir 원문이 문구에 없음(workdir 는 존재 확인 실패 때도 라벨로), `tokenFile` 권한 0644 → 경고.
  - `stream-map.test.ts`: ADR 0007 대응표 전 항목(텍스트 시작·델타·끝, 도구 시작·인자·끝·결과 `ok`·`durationMs`, `result success` → final, `error_during_execution` → `RUN_ABORTED`(interrupt 로 끝난 턴) 또는 `RUN_ERROR`, `thinking`·`system/thinking_tokens`·`tool_progress` 버림).
  - `run.test.ts`: `buildQueryOptions` 가 `snapshot:false`·`strictMcpConfig`·`settingSources: []`·`alwaysLoad` MCP·`title`(새 세션만)·`resume` 분기(P2)를 싣고, **`env` 에 허용 목록 밖 값(`ANTHROPIC_API_KEY`·`DODOK_RUNNER_TOKEN`·`AWS_SECRET_ACCESS_KEY` 를 `baseEnv` 에 넣어 둠)이 없음**. `num_turns: 0` 결과 먼저 → 건너뜀. 마지막 `result` 뒤 throw → 오류 아님. `result` 전 throw(인증 표지) → `PROVIDER_AUTH`. 세션 누적 비용 차이.
  - `scheduler.test.ts`: 상한 3 에 넷째 → `queuedPosition: 1`, 하나 끝나면 시작, 같은 세션 겹침 → busy, `abortAll` 이 도는 것과 대기열 모두 멈춤.
  - `connection.test.ts`: 태스크 3 의 러너 어댑터(실제 `Server`)에 붙어 hello → `run.start` → 가짜 query 대본 → 서버가 `run.event`·`run.final` 을 받음. `PROTOCOL_MISMATCH` → 종료 코드 2. **서버 쪽에서 소켓을 끊으면 도는 런의 `interrupt` 가 불림**(Review Focus 1). 설정에 없는 `agentId` 의 `run.start` → `run.error NOT_FOUND`.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 빌드 확인** — `pnpm -F @dodok/claude-runner build && pnpm -F @dodok/claude-runner pack:runner`, tgz 안에 SDK 파일이 **없음**(`tar -tzf … | grep -c claude-agent-sdk` 가 0), `package.json` 의 `dependencies` 에 SDK 정확 판본.
- [ ] **Step 4: 루트 검사 4종.**
- [ ] **Step 5: 커밋** — `feat(runner): 설정·연결·스케줄러·런 실행·스트림 대응`.

---

### Task 6: 러너 도구·승인·첨부

**Files:**
- Create: `packages/claude-runner/src/{post-tool,files,approvals,images,attachments-http}.ts`, `test/{post-tool,files,approvals,images}.test.ts`
- Modify: `packages/claude-runner/src/run.ts`(MCP 서버·`canUseTool`·이미지 블록 연결), `connection.ts`(`outbound.post`·`approval.*`)

**Interfaces:**
- Consumes: 태스크 5 `SdkPort`·`runOnce`·연결, 태스크 1 `ComponentsV1`·`RunnerApprovalRequested`·`RUNNER_ATTACHMENTS_PATH`, 태스크 4 러너 첨부 HTTP.
- Produces:

```ts
// files.ts — 작업 디렉터리 안 상대 경로만
export type FileCheck = { ok: true; abs: string; rel: string; bytes: number } | { ok: false; rel: string; reason: "outside_workdir" | "not_found" | "not_a_file" | "too_large" };
export function checkPostFiles(workdir: string, paths: string[], fs: FsLike): { checks: FileCheck[]; tooMany: boolean }; // 10개 초과면 tooMany
// 거절 사유 문구는 rel(작업 디렉터리 상대, 밖이면 "<작업 디렉터리 밖>")만 담는다

// post-tool.ts
export const POST_TOOL_NAME = "post"; // 모델에게는 mcp__dodok__post
export function createDodokMcpServer(deps: { sdk: SdkPort; post: (input: PostInput) => Promise<{ messageId: string } | { error: string }> }): unknown; // createSdkMcpServer({ name: "dodok", alwaysLoad: true, tools: [tool(POST_TOOL_NAME, 설명, PostInputSchema, handler)] })
export const PostInputSchema = z.object({ text: z.string().max(4000).optional(), components: ComponentsV1.optional(), files: z.array(z.string()).max(10).optional() }).refine((v) => v.text || v.components || v.files?.length, "text·components·files 중 하나는 있어야 합니다");

// approvals.ts
export function createCanUseTool(deps: { runId: string; sessionKey: string; workdir: string; emit: (p: RunnerApprovalRequested) => void; withdraw: (id: string) => void; waitDecision: (id: string, signal: AbortSignal) => Promise<ApprovalDecision> }): CanUseTool;
export function summarizeToolInput(toolName: string, input: unknown, workdir: string): string; // Bash → 명령, 파일 도구 → 상대 경로, 그 밖 → JSON 앞 200자. 호스트 경로 → 상대 또는 "<작업 디렉터리 밖>"

// images.ts — deliver.message.attachments 중 이미지를 러너 첨부 HTTP 로 받아 base64 이미지 블록으로
export function loadImageBlocks(deliver: InboundDeliver, http: AttachmentsHttp): Promise<SdkImageBlock[]>;
```

- 동작(스펙 4.4·6장):
  - `post` 핸들러: `checkPostFiles` → 통과한 파일을 `POST RUNNER_ATTACHMENTS_PATH`(러너 토큰)로 올려 `artifact://<id>` → `outbound.post`(ack `messageId`) → 도구 결과 「보냈습니다(메시지 id)」. 거절 파일이 하나라도 있으면 **아무것도 올리지 않고** 거절 사유 목록을 도구 결과로(런은 계속). `allowedTools` 에 늘 `mcp__dodok__post`.
  - `canUseTool`: `approval.requested`(id 는 `toolUseID`), 결정 `allow-once` → `{ behavior: "allow", updatedInput: input }`, `allow-always` → 제안의 `destination` 을 `"session"` 으로 바꿔 `updatedPermissions`, `deny` → `{ behavior: "deny", message: "사람이 거절했습니다" }`, 기한 deny(`reason: "expired"` — 태스크 1 스키마, 태스크 3 어댑터가 싣는다) → `"승인 시간이 지났습니다"`. SDK `signal` 이 끊기면 `approval.withdrawn`.
  - 이미지: 5 MiB·10장 한도 안(서버가 이미 막은 값), 받기 실패는 그 이미지만 빼고 프롬프트 끝에 「첨부 이미지 N장을 불러오지 못했습니다」 한 줄.

- [ ] **Step 1: 실패하는 테스트**
  - `files.test.ts`(임시 디렉터리): `a.txt` 통과, `../x`·`/etc/passwd`·작업 디렉터리 밖을 가리키는 심볼릭 링크·안쪽 디렉터리 이름 → 거절, 20 MiB + 1 → `too_large`, 11개 → `tooMany`, **거절 문구 어디에도 임시 디렉터리 절대 경로가 없음**(Review Focus 2).
  - `post-tool.test.ts`: 거절 파일이 섞이면 업로드 0회·`outbound.post` 0회·도구 결과에 사유, 모두 통과면 업로드 → `artifact://` 가 `outbound.post` 에, components 가 `ComponentsV1` 위반이면 SDK 검증 전에 거절(스키마 공유 확인).
  - `approvals.test.ts`: 네 결정 각각의 `PermissionResult` 모양, `allow-always` 의 `destination: "session"`, `reason: "expired"` deny 문구, `signal` abort → withdrawn, `summarizeToolInput` 이 `cat /Users/…/repo/secret` 을 작업 디렉터리 상대로·밖은 가림.
  - `images.test.ts`: 두 장 중 한 장 404 → 블록 하나 + 안내 줄.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종.**
- [ ] **Step 4: 커밋** — `feat(runner): dodok post 도구·파일 경로 검사·도구 승인·이미지`.

---

### Task 7: 웹 — 러너 블록·등록 제공자·도구 승인 카드·운영 화면

**Files:**
- Create: `apps/web/src/features/setup/{RunnerSection,IssueRunnerTokenDialog,RunnerTokenList}.tsx`, 테스트
- Modify: `apps/web/src/features/setup/{ConnectionPage,mutations,queries}.ts(x)`, `features/agents/{AgentsPage,DiscoverDialog,ManualAgentForm,mutations}.tsx`, `features/approvals/ApprovalCard.tsx`, `features/ops/{StatusCard,RunsTable}.tsx`, `realtime/handlers.ts`, `api/queries.ts`

**Interfaces:**
- Consumes: 태스크 1 `SetupStatus.runners`·`AdapterStatus` 유니온·`ApprovalKind` `tool`, 태스크 2 `GET /adapter/status` 새 모양·`usageTrustedProviders`, 태스크 4 러너 토큰 API·`discover?provider`.
- 화면(스펙 5·7장):
  - **연결 페이지 러너 블록**(owner): 토큰 목록(라벨·prefix·마지막 사용·연결 여부)·발급(라벨 입력 → 원문과 설정 조각 한 번, 브리지 발급 대화상자 재사용)·폐기(확인), 러너별 카드(라벨·연결·러너/SDK/CLI 판본·같은 빌드 여부·붙은 시각·에이전트 목록 — 충돌은 「다른 러너와 id 가 겹쳐 배정되지 않습니다」), 설치 안내(tgz 받기 → `CLAUDE_CONFIG_DIR=~/.dodok-runner/claude claude` 로 전용 로그인 → 설정 파일 예시 → `dodok-runner`), **드러나는 것 둘**(스펙 5장 문장 그대로의 뜻을 합쇼체로).
  - **에이전트 등록**: 제공자 고르기(OpenClaw · Claude 러너). Claude 러너면 `discover?provider=claude` 목록(러너 라벨·작업 디렉터리 라벨·모델 힌트), 러너가 없으면 「연결된 러너가 없습니다 — 연결 페이지에서 러너를 붙이세요」(owner 에게만 링크).
  - **도구 승인 카드** `kind: "tool"`: 제목에 도구 이름, 요약은 코드 글꼴(`<code>`), 결정 버튼은 `allowedDecisions` 그대로.
  - **운영 화면**: 연결 줄 — OpenClaw(Gateway·플러그인)와 러너(붙은 수 / 토큰 수). 런 표 — `usageTrustedProviders` 에 든 제공자의 에이전트 행은 비용·토큰, 구독 환산이면 「환산값」 꼬리표, 그 밖은 지금처럼 「측정 불가」.
  - 연결 점·배너는 OpenClaw 상태만(태스크 1 에서 좁힌 그대로).
- [ ] **Step 1: 실패하는 테스트** — 러너 블록: owner 에게만 보임, 발급 뒤 원문이 대화상자에만 한 번(닫으면 목록에 prefix 만), 폐기 확인, 러너 0대·충돌 표시. 등록: 제공자 전환 시 목록이 바뀜, 러너 없음 안내. 승인 카드 `tool`: 요약이 `<code>`, `allow-always` 가 없는 요청은 버튼 둘. 운영: claude 행 비용·「환산값」, openclaw 행 「측정 불가」.
- [ ] **Step 2: 실패 확인 → 구현 → 통과.**
- [ ] **Step 3: 루트 검사 4종 + 웹 빌드.**
- [ ] **Step 4: 커밋** — `feat(web): 연결 페이지 러너 블록·Claude 러너 에이전트 등록`, `feat(web): 도구 승인 카드와 제공자별 운영 화면`.

---

### Task 8: dev:fake 가짜 러너 + 브라우저 검증

**Files:**
- Modify: `apps/server/scripts/dev-fake.ts`(태스크 4 `fake-runner.ts` 를 붙인다 — 고정 러너 토큰 `dev-fake-runner-token` 행을 시작 때 넣고, 에이전트 `coder` 를 등록해 둔다), 대본에 도구 승인·`post` 카드를 부르는 단어 하나씩, 훅 `POST /__devfake/runner {connected: boolean}`(가짜 러너 끊기·붙이기)
- Modify: `CLAUDE.md` 「명령」 의 dev:fake 줄은 조율자가 고친다(워커는 보고에 넣을 문장을 적는다)

- [ ] **Step 1: 가짜 러너 붙이기 + 훅**, `pnpm -F @dodok/server dev:fake` 로 뜨는지(포트 3100 대, 웹 5180).
- [ ] **Step 2: 브라우저 검증**(워커, `docs/guides/browser-verification.md` — neo 에 Playwright, 네가 연 탭은 네가 닫는다): 연결 페이지 러너 블록(발급·원문 한 번·폐기로 끊김), 에이전트 등록(Claude 러너 목록), `@coder` 멘션 → 스트리밍·최종 답, 도구 승인 카드(허용·거절, member 계정에는 결정 버튼 없음), `post` 카드, 러너 끊기 훅 → run_error 카드 → 붙이기 → 「다시 실행」, 운영 화면 러너 줄·비용, 390px 에서 러너 블록·승인 카드 요약 넘침 없음, OpenClaw 에이전트 `dev` 와 `coder` 가 한 채널에서 릴레이. 항목마다 통과/결함, 결함은 재현 절차.
- [ ] **Step 3: 커밋** — `feat(server): dev:fake 가짜 러너`, 보고서에 브라우저 결과표.

---

### Task 9: 런 0회 하네스 + 문서 → 실연

**Files:**
- Create: `packages/claude-runner/scripts/fake-messages-api.ts`(로컬 가짜 Messages API — 스트리밍 SSE 로 대본 응답, 받은 요청 본문을 파일로 남김. ADR 0007 「다시 재는 법」의 방식)
- Modify: `docs/guides/live-smoke.md`(「런 0회 하네스」 옆에 새 절 「Claude 러너 런 0회 하네스」, 뒤에 「Claude 러너(Phase 4 ③) 실연」 절), `docs/guides/deploy.md`(러너 설치 절 — 전용 로그인·설정 파일·토큰·드러나는 것 둘·업데이트는 tgz 를 다시 받는다), `docs/guides/agent-guide.md`(Claude 러너 절 — `mcp__dodok__post`, 글 답은 최종 답으로, 파일은 작업 디렉터리 상대 경로), `docs/adr/0007-claude-agent-sdk-spike.md`(구현이 고른 것 반영, 「확인 못 한 것」 갱신), 스펙 「구현과 맞춘 것」 장(계획 판정 P1~P10 + 구현 중 판정)
- 조율자가 고칠 것(워커는 문장을 보고에): `docs/plan.md` 8장(이월), `docs/project-structure.md`(새 패키지 둘), `README.md` 문서 지도, `CLAUDE.md` 「구조」·「명령」·「현재 단계」

- [ ] **Step 1: 하네스** — 실제 서버(`PORT` 3100 대) + 실제 러너(`pnpm -F @dodok/claude-runner` 빌드본) + 번들 CLI 에 `ANTHROPIC_BASE_URL`(가짜 API)·가짜 API 키·스크래치 `CLAUDE_CONFIG_DIR` — 모델 런 0. 합격 기준: 요청 본문의 시스템 프롬프트에 틀을 입힌 채널 규칙이 **한 벌만**, 규칙을 바꾼 뒤 런에 새 규칙만, `UserPromptSubmit` 훅 문맥 자리, `mcp__dodok__post` 가 지연 목록에 없음(`alwaysLoad`), 가짜 API 가 `tool_use`(쓰기 Bash)를 내면 `canUseTool` → 승인 카드 → 허용 → 도구 결과, 중지 → `RUN_ABORTED`, 러너를 죽이면 run_error 카드. 항목마다 수치·근거.
- [ ] **Step 2: 문서** — 위 Files 의 문서. live-smoke 새 절에 넣을 문장: 「Claude 러너 어댑터는 번들 CLI 에 `ANTHROPIC_BASE_URL`(로컬 가짜 Messages API)·가짜 API 키·스크래치 `CLAUDE_CONFIG_DIR` 을 주어 모델 없이 실제 요청 본문과 권한·도구·interrupt 흐름을 두드린다(ADR 0007 「다시 재는 법」).」
- [ ] **Step 3: 커밋** — `test(runner): 런 0회 하네스`, `docs: Claude 러너 설치·에이전트 가이드·하네스 절`.
- [ ] **Step 4: 실연(모델 런 — 실행 직전 사용자 승인, 3회 이내 예정)** — 러너 전용 로그인(`CLAUDE_CONFIG_DIR=~/.dodok-runner/claude`)으로 로컬 서버 + dev Gateway(OpenClaw 에이전트 `dev`) + 러너(에이전트 `coder`, 작업 디렉터리는 스크래치 git 저장소): ① 멘션 → 스트리밍·최종 답·운영 화면 비용 ② 채널 규칙을 바꾼 뒤 `resume` 한 세션이 새 규칙을 따르는가(ADR 0007 「확인 못 한 것」) ③ 쓰기 도구 승인 카드 허용 + `post` 로 카드·파일, `dev` ↔ `coder` 릴레이. 결과는 live-smoke 실연 절에, 런별 비용 포함. 스파이크 세션 전사는 끝나면 지운다.

---

## Self-Review 기록

- **스펙 대조**: 0장 결정 1~6 → 태스크 3·5·6(러너·권한 천장)·1(틀)·5(전용 로그인 경로만). 1장 「한다」 목록 → 태스크 1~9 에 하나씩. 2장 구성(계약 이전·레지스트리·세션·등록) → 1·2·4. 3장 계약 → 1(스키마)·3(서버 쪽)·5(러너 쪽), `ping`/`pong` 과 `resume` 은 P1·P2 로 바꿈. 4장 → 5·6. 5장 → 4·7. 6장 → 3·6·7. 7장 → 7. 8장 오류 표 → 3(끊김·폐기·없는 러너)·5(설정·프로토콜·인증)·6(경로), `NOT_FOUND`(알리지 않은 에이전트 id 의 `run.start`)는 태스크 5. 9장 → 각 태스크 테스트·8·9. 10장 완료 기준 1~8 → 태스크 4 시나리오 1·3·4·5·7·8·10, 9 실연 ②.
- **이름 일관성**: `revokeTokenSessions`·`supports`·`promptEveryRun`·`serverSessionIds`·`RUNNER_APPROVAL_TTL_MS`·`RUNNER_ATTACHMENTS_PATH`·`USAGE_TRUSTED_PROVIDERS`·`usageTrustedProviders`·`"dodok.usage"` 를 태스크 1·2·3·4·7 에서 같은 이름으로 썼다.
