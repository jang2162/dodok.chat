# Phase 2 ① 활동 패널·승인 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 에이전트가 승인이 필요한 툴을 부르면 사용자가 카드로 허용·거절하고, 툴 실행 기록을 활동 패널에서 본다.

**Architecture:** Gateway 의 `plugin.approval.requested`/`resolved` 를 어댑터가 구독해 정규화하고(정본), 세션 구독의 `approvalReplay` 로 재접속을 복구한다. 서버는 `sessionKey`+`toolCallId` 로 런에 붙여 저장하고 wire 로 중계하며, `approval.resolve` 를 받을 때 `allowedDecisions` 를 **먼저 검증**한 뒤에만 Gateway 로 보낸다. 웹은 채널 오른쪽 패널의 두 번째 탭에 활동(런 목록·툴 타임라인)을, 메시지 흐름과 활동 탭 양쪽에 승인 카드를 그리고, 승인 요구에만 브라우저 알림을 띄운다.

**Tech Stack:** TypeScript · Node 24.21.0 · pnpm 11.16.0 · Fastify + Socket.IO(서버) · Drizzle + SQLite · React 19.3 + Vite 8.3 + TanStack Router/Query · zustand · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`
**근거 실측:** `.superpowers/sdd/2026-09-20-phase2-approval-spike/spike-report.md`(승인 실물 프레임·RPC·TTL) · `.superpowers/sdd/2026-09-20-phase2-approval-spike/interfaces.md`(이 계획이 손대는 자리의 실물 시그니처)

## Global Constraints

- **의존성**: 새 의존성은 `@streamdown/cjk` 하나뿐이고 **정확 핀**(`^`·`~` 금지), 태스크 1 에서만 설치한다. 그 밖의 태스크는 의존성을 더하지 않는다. pnpm 11 최소 배포 경과 보호에 걸리면 `pnpm-workspace.yaml` 의 `minimumReleaseAgeExclude` 에 그 버전을 더한다(기존 항목과 같은 방식).
- **OpenClaw 패키지 3종은 2026.9.4 고정**(`@openclaw/gateway-client`·`@openclaw/gateway-protocol`·`openclaw`). 버전을 올리지 않는다.
- **결정 값은 `allow-once`·`allow-always`·`deny`** 셋뿐이다. 서버는 그 승인의 `allowedDecisions` 에 없는 값을 **Gateway 로 보내지 않는다** — 보내면 Gateway 가 조용히 거절(`malformed-verdict`)로 확정한다(스파이크 4.4).
- **승인 페이로드에 `runId` 가 없다.** 상관은 `sessionKey`(`agent:<providerAgentId>:dodok:channel:<channelId>`) + `toolCallId` 로만 한다.
- **TTL 은 요청자(claude-cli)가 정하고 Gateway 가 `[1s, 600s]` 로 클램프한다. 기본 120초이고 우리가 늘릴 수단은 없다.**
- **외부 입력은 경계에서 Zod 파싱**한다(Gateway 프레임·REST 요청·wire 페이로드). shared 는 Node 전용 API 금지.
- **시크릿**: 토큰·디바이스 아이덴티티는 `data/` 와 `.env` 에만. 로그·테스트 픽스처에 토큰 값을 넣지 않는다.
- **components v1 제약**(액션 로우 버튼 ≤5 또는 셀렉트 1, 옵션 ≤25, 모달 필드 ≤5)은 shared 스키마가 강제한다 — 이번 계획은 components 를 넓히지 않는다.
- **커밋**: `git add -A`·`git commit -a` 금지. 경로를 명시해 stage 한다. Conventional Commits + 패키지 스코프(`feat(server): …`).
- **검증**: 루트에서 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check` 가 **각각 exit 0**. 테스트는 행동을 재고, 새로 넣은 분기는 「그 줄을 지우면 실패하는가」를 확인한다.
- **Node**: `node -v` 가 24.21.0 이 아니면 `export PATH="$(mise where node)/bin:$(mise where npm:pnpm)/bin:$PATH"`.

---

## 파일 구조

**shared** — 계약. `domain/index.ts`(Approval 타입군)·`events/index.ts`(APPROVAL_* 이벤트, RunSignal)·`wire/index.ts`(ApprovalResolve, 서버→클라 이벤트).

**openclaw-adapter** — Gateway 경계.
- `gateway/approvals.ts`(신설): Gateway 승인 프레임 → `ProviderApproval` 정규화, 중복 제거, `approval.resolve` 인자 만들기. 순수 함수 중심.
- `gateway/events.ts`: `map()` switch 에 승인 프레임 case 추가(정규화는 위 파일에 위임).
- `gateway/connection-manager.ts`: 세션 구독에 `includeApprovals: true`, 응답 `approvalReplay` 를 승인 이벤트로 흘리기.
- `adapter-types.ts`: `AdapterEvent` 에 `{ kind: "approval" }` 추가, `AgentAdapter.resolveApproval()` 추가.
- `gateway/frame-dump.ts`: `DUMPED_EVENTS` 에 승인 이벤트 5종 추가.

**server**
- `modules/approvals/store.ts`(신설): approvals 테이블 CRUD·조회.
- `modules/approvals/service.ts`(신설): 상관(sessionKey·toolCallId) · upsert · 런 이벤트 기록 · 버스 발행 · 해결 경로 검증.
- `modules/runs/orchestrator.ts`: 승인 이벤트 수신 배선, `awaiting_approval` 동안 타임아웃 정지, 승인 만료 감시, 런 중단 시 `cancelled`.
- `modules/runs/machine.ts`: `approval_resolved` 에 `decision` 반영.
- `realtime/{socket,events,types}.ts`: `approval.resolve` 실구현, `pendingApprovals` 채우기, 팬아웃 두 줄, `RunsFacade` 확장.
- `scripts/dev-fake.ts`·`test/fakes/*`: 승인 대본.

**web**
- `features/activity/{ActivityPanel,RunList,RunTimeline,ToolCallRow}.tsx`(신설): 활동 탭.
- `features/approvals/{approvalStore.ts,ApprovalCard.tsx,countdown.ts,notify.ts}`(신설): 승인 상태·카드·카운트다운·알림.
- `app/layout/PanelTabs.tsx`(신설) + `app/router.tsx`: 오른쪽 패널 탭 셸과 `/c/$channelId/activity` 라우트.
- `realtime/handlers.ts`: `approval.requested`/`approval.resolved` 분기.
- `features/messages/{groupRows.ts,MessageList.tsx}`: 승인 카드 행.

## 태스크 순서와 병렬

| 태스크 | 선행 | 함께 돌릴 수 있는 것 |
| --- | --- | --- |
| 0 서버 이월 넷 | — | 1 |
| 1 웹 이월 다섯 + `@streamdown/cjk` | — | 0 |
| 2 shared 계약 정정 + 프레임 덤프 | 0, 1 | — |
| 3 어댑터: 승인 수신·정규화·해결 RPC | 2 | — |
| 4 서버: 저장·상관·중계 | 3 | — |
| 5 서버: 해결 경로·상태머신·타임아웃 | 4 | — |
| 6 하네스: 가짜 Gateway 승인 + `dev:fake` 대본 + 통합 시나리오 | 5 | — |
| 7 웹: 패널 탭 + 활동 탭 | 6 | 8 |
| 8 웹: 승인 스토어·카드 | 6 | 7 |
| 9 웹: 브라우저 알림 | 8 | — |
| 10 브라우저 검증(verify 워커) | 9 | — |
| 11 문서 | 10 | — |

병렬로 돌리는 태스크끼리는 서로 다른 파일만 만든다. 같은 파일을 두 태스크가 고치면 뒤 태스크가 rebase 로 받는다.

---

### Task 0: 서버 이월 넷

**Files:**
- Modify: `packages/shared/src/wire/index.ts`(`ServerToClientEvents` 에 `channel.created` 한 줄), `apps/server/src/modules/channels/service.ts`·`routes.ts`, `apps/server/src/realtime/events.ts`, `apps/server/src/realtime/bus.ts`, `apps/server/src/http/errors.ts`(또는 `CONFLICT` 를 던지는 자리), `apps/server/src/auth/routes.ts`
- Test: `apps/server/test/rest.test.ts`(있는 파일에 추가), `apps/server/test/app.wiring.test.ts`

**Interfaces:**
- Consumes: 기존 `ServerBus`(`apps/server/src/realtime/bus.ts`), `attachWireFanout`(`realtime/events.ts:18`), `apiError(code, message, details?)`(`http/errors.ts`).
- Produces: wire `"channel.created": (p: { channel: Channel }) => void` · REST `GET /auth/me` 응답에 `workspace: { id, name }` · `CONFLICT` 응답의 `details.field`(`"handle" | "providerAgentId"`) · 시스템 메시지 조사 병기형.

- [ ] **Step 1: 실패 테스트 — `channel.created`**

`apps/server/test/rest.test.ts` 에 더한다. 기존 테스트가 쓰는 하네스(같은 파일 위쪽의 `makeApp()`·소켓 접속 헬퍼)를 그대로 쓴다.

```ts
it("채널을 만들면 구독 중인 다른 소켓에 channel.created 가 간다", async () => {
  const { app, token } = await makeApp();
  const socket = await connectWire(app, token); // 기존 헬퍼
  const seen: string[] = [];
  socket.on("channel.created", (p: { channel: { name: string } }) => seen.push(p.channel.name));
  await post(app, token, "/api/v1/channels", { name: "새 채널" });
  await vi.waitFor(() => expect(seen).toEqual(["새 채널"]));
});
```

- [ ] **Step 2: 실패 확인**

`pnpm -F @dodok/server test -- rest` → 이벤트가 오지 않아 실패.

- [ ] **Step 3: 구현**

`packages/shared/src/wire/index.ts` 의 `ServerToClientEvents` 에 한 줄(기존 `"channel.updated"` 바로 위):

```ts
  "channel.created": (p: { channel: Channel }) => void; // 워크스페이스 룸
```

`apps/server/src/realtime/bus.ts` 의 이벤트 맵에 같은 이름을 더하고, `realtime/events.ts` 의 `offs` 배열에 한 줄을 더한다. 채널 생성은 채널 룸에 아무도 없으므로 **사용자 룸**으로 보낸다(기존 `adapter.status` 가 쓰는 패턴과 같다):

```ts
    on("channel.created", (p) => io.to(workspaceRoom(p.workspaceId)).emit("channel.created", { channel: p.channel })),
```

워크스페이스 룸이 없으면 `socket.ts` 의 접속 시 `socket.join(workspaceRoom(user.workspaceId))` 한 줄을 더한다(`userRoom` 과 같은 자리).

`modules/channels/service.ts` 의 채널 생성 함수가 성공 뒤 `bus.emit("channel.created", { workspaceId, channel })` 하도록 한다.

- [ ] **Step 4: 통과 확인 후 나머지 셋**

(a) **조사 병기형** — 시스템 메시지를 만드는 자리를 찾는다(`rg "이\(가\)|가 자동 응답|을 켭니다" apps/server/src`). 받침에 따라 고르는 작은 도우미를 서버에도 둔다(웹의 `apps/web/src/lib/josa.ts` 와 같은 규칙, 복사하지 말고 서버 쪽에 `apps/server/src/util/josa.ts` 로 새로 — shared 로 올리지 않는다. 웹은 브라우저 번들, 서버는 노드라 쓰임새가 다르고 규칙이 10줄이다):

```ts
/** 받침이 있으면 with, 없으면 without (한글 음절만 본다 — 영문 핸들은 without) */
export function josa(word: string, withFinal: string, without: string): string {
  const last = word.at(-1) ?? "";
  const code = last.charCodeAt(0);
  const hangul = code >= 0xac00 && code <= 0xd7a3;
  return hangul && (code - 0xac00) % 28 !== 0 ? withFinal : without;
}
```

테스트 2개(받침 있는 말·없는 말·영문 핸들).

(b) **`CONFLICT` 의 `details.field`** — 에이전트 생성·수정에서 핸들 충돌과 `providerAgentId` 충돌을 가른다. `apiError("CONFLICT", "…", { field: "handle" })` 형태로 넘기고, 응답 봉투에 `details` 가 실리는지 확인한다(`http/errors.ts`). 테스트 2개(각 충돌에서 `details.field` 값).

(c) **`GET /auth/me` 에 워크스페이스 이름** — 응답에 `workspace: { id, name }` 을 더한다. 테스트 1개. (웹은 태스크 1 에서 쓴다.)

- [ ] **Step 5: 검증·커밋**

루트 네 명령 exit 0.

```bash
git add packages/shared/src/wire/index.ts apps/server/src/modules/channels apps/server/src/realtime \
  apps/server/src/http/errors.ts apps/server/src/auth/routes.ts apps/server/src/util/josa.ts apps/server/test
git commit -m "feat(server): channel.created 이벤트·조사 병기형·CONFLICT details.field·me 워크스페이스 이름"
```

---

### Task 1: 웹 이월 다섯 + `@streamdown/cjk`

**Files:**
- Modify: `apps/web/src/features/messages/MessageList.tsx`, `apps/web/src/realtime/handlers.ts`, `apps/web/vite.config.ts`, `apps/web/src/features/messages/MessageBody.tsx`, `apps/web/package.json`, `pnpm-lock.yaml`, `apps/web/src/app/layout/Sidebar.tsx`(워크스페이스 이름), `tsconfig` 또는 `turbo.json`(wire-cli typecheck)
- Split: `apps/web/src/features/agents/agents.test.tsx`(558줄) → 목록/등록 두 파일, `apps/web/src/features/settings/members.test.tsx`(527줄) → 멤버/자동응답 두 파일
- Test: 위 파일들의 테스트 + `apps/web/src/realtime/handlers.connection.test.ts`

**Interfaces:**
- Consumes: 태스크 0 의 wire `channel.created` 와 `me.workspace`(**태스크 0 이 먼저 병합되지 않았으면 그 두 항목만 빼고 나머지를 한다** — 조율자가 rebase 때 합친다).
- Produces: 없음(내부 개선).

- [ ] **Step 1: 스크롤 보정 — 실패 테스트**

뷰포트가 줄면 끝에 다시 붙지 않는 문제(계획서 8장). `apps/web/src/features/messages/MessageList.test.tsx` 에:

```ts
it("끝에 붙어 있을 때 뷰포트가 줄면 다시 끝으로 맞춘다", async () => {
  const { scroller, setViewportHeight } = renderListAtEnd(); // 기존 stubScrollLayout 헬퍼 위에 한 줄짜리 래퍼
  expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight);
  setViewportHeight(scroller.clientHeight - 44); // 배너가 생긴 만큼
  await vi.waitFor(() => expect(scroller.scrollTop).toBe(scroller.scrollHeight - scroller.clientHeight));
});
```

- [ ] **Step 2: 구현** — 스크롤러에 `ResizeObserver` 를 걸고, 붙어 있는 동안(`stuck`)에만 다시 겨눈다. 태스크 13 수정 라운드가 만든 「사용자 입력이 오면 멈춘다」 규칙을 그대로 따른다(`MessageList.tsx` 의 기존 `stuck` 판정 재사용).

- [ ] **Step 3: 재연결 백오프**

`apps/web/src/realtime/handlers.ts` 의 고정 `WIRE_RETRY_MS`(2초)를 지수 백오프로. 상한 30초, 지터 ±20%, `connect` 가 오면 초기화.

```ts
/** 서버가 끊은 소켓·미들웨어 거절 뒤 직접 재연결 — 2s 에서 시작해 30s 까지 두 배씩(지터 ±20%) */
export const WIRE_RETRY_BASE_MS = 2_000;
export const WIRE_RETRY_MAX_MS = 30_000;
export function nextRetryDelay(attempt: number, random = Math.random): number {
  const base = Math.min(WIRE_RETRY_BASE_MS * 2 ** attempt, WIRE_RETRY_MAX_MS);
  return Math.round(base * (0.8 + 0.4 * random()));
}
```

테스트 3개: `nextRetryDelay(0|1|5, () => 0.5)` 값, 상한, `connect` 뒤 시도 횟수 초기화(가짜 타이머, 테스트 끝에 원복).

- [ ] **Step 4: 나머지 셋**

(a) `apps/web/vite.config.ts` 의 `build.rolldownOptions.output.advancedChunks` → `codeSplitting` 으로 옮기고 `pnpm -F @dodok/web build` 에서 **`advancedChunks` 폐기 경고**가 사라지는지 확인한다. 첫 화면 번들 크기를 보고서에 적는다(지금 0.47MB).
    ⚠ **「경고 0」이 되지는 않는다.** 청크 크기 경고(>500kB)가 하나 남는다 — `markdown` 청크. `chunkSizeWarningLimit` 은 기본값 500 그대로 둔다(태스크 1 리뷰 판정): 전역 임계값을 올리면 다른 청크의 경고까지 가린다.

(b) `@streamdown/cjk` 를 **정확 핀**으로 설치하고 `MessageBody.tsx` 의 `REMARK` 배열에 더한다(`defaultRemarkPlugins` 뒤, `remarkSoftBreaks` 앞). 렌더 테스트 2개: `**"인용"**은` 이 굵게, `**중요**합니다` 가 그대로 굵게(회귀).

(c) 큰 테스트 파일 둘을 describe 단위로 나눈다(목·헬퍼도 같이 옮긴다). 테스트 수는 그대로여야 한다.

(d) 태스크 0 이 병합됐으면: `channel.created` 를 `handlers.ts` 에서 받아 `["channels"]` 캐시에 덧붙이고(중복 id 는 무시), 사이드바 제목을 `me.workspace.name` 으로 바꾼다. 테스트 2개.

(e) `wire-cli` 를 루트 typecheck 에 넣는다(`rg "wire-cli" -l` 로 자리 확인 — `package.json` 스크립트·`tsconfig` 참조 관계를 보고 가장 작은 변경으로).

- [ ] **Step 5: 검증·커밋**

루트 네 명령 exit 0 + `pnpm -F @dodok/web build` 에서 `advancedChunks` 폐기 경고 0.
**남는 경고는 청크 크기 하나**다 — 2026-09-21 실측 `dist/assets/markdown-*.js` **511.87 kB**(gzip 156.97 kB), 500 kB 임계값을 넘는 유일한 청크. 의도한 잔여물이다.

```bash
git add apps/web/src apps/web/vite.config.ts apps/web/package.json pnpm-lock.yaml pnpm-workspace.yaml
git commit -m "fix(web): 뷰포트 축소 시 끝 붙임·재연결 백오프·코드 분할 옵션·CJK 강조·테스트 분할"
```

---

### Task 2: shared 계약 정정 + 프레임 덤프 화이트리스트

**Files:**
- Modify: `packages/shared/src/domain/index.ts:198-215`, `packages/shared/src/events/index.ts:62-72`, `packages/shared/src/wire/index.ts:44-49`, `packages/openclaw-adapter/src/gateway/frame-dump.ts`
- Modify(컴파일 따라가기): `apps/server/src/realtime/socket.ts:159-166`(스텁이 새 타입으로 파싱만 하게), 그 밖에 타입 오류가 나는 곳
- Test: `packages/shared/test/domain.test.ts`·`events.test.ts`·`wire.test.ts`(기존 파일 관습을 따라 추가)

**Interfaces:**
- Consumes: 없음.
- Produces (뒤 태스크 전부가 쓴다):

```ts
// domain
export const ApprovalKind = z.enum(["exec", "plugin", "system-agent"]);
export const ApprovalStatus = z.enum(["pending", "allowed", "denied", "expired", "cancelled"]);
export const ApprovalDecision = z.enum(["allow-once", "allow-always", "deny"]);
export const ApprovalReason = z.enum([
  "user", "timeout", "malformed-verdict", "no-route", "run-aborted", "gateway-restart", "storage-corrupt",
]);
export const ApprovalSeverity = z.enum(["info", "warning", "critical"]);
export const Approval = z.object({
  id: Id,
  providerApprovalId: z.string().min(1).max(200),
  kind: ApprovalKind,
  channelId: Id,
  agentId: Id,
  runId: Id.optional(),
  toolCallId: z.string().max(200).optional(),
  toolName: z.string().max(100).optional(),
  pluginId: z.string().max(100).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(512).optional(),
  detail: z.string().max(16_384).optional(),
  severity: ApprovalSeverity,
  allowedDecisions: z.array(ApprovalDecision).min(1).max(3),
  urlPath: z.string().max(500).optional(),
  status: ApprovalStatus,
  decision: ApprovalDecision.optional(),
  reason: ApprovalReason.optional(),
  decidedBy: Id.optional(),
  decidedAt: IsoDateTime.optional(),
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime,
});
// events
ev("APPROVAL_REQUESTED", {
  approvalId: Id, kind: ApprovalKind, title: z.string().max(200), severity: ApprovalSeverity,
  allowedDecisions: z.array(ApprovalDecision).min(1), toolCallId: z.string().max(200).optional(),
  expiresAt: IsoDateTime,
}),
ev("APPROVAL_RESOLVED", {
  approvalId: Id, decision: ApprovalDecision, reason: ApprovalReason, decidedBy: Id.optional(),
}),
// RunSignal
| { kind: "approval_requested" }
| { kind: "approval_resolved"; decision: ApprovalDecision }
// wire
export const ApprovalResolve = z.object({ approvalId: Id, decision: ApprovalDecision });
```

- [ ] **Step 1: 실패 테스트**

`packages/shared/test/` 의 기존 파일 관습대로(파서 통과·거부를 재는 방식) 다음을 더한다.

```ts
it("Approval 은 실물 승인 프레임에서 뽑은 값을 받는다", () => {
  const parsed = Approval.parse({
    id: uid(1), providerApprovalId: "plugin:533fe246-fa79-4f86-bcd0-3c08b549cb20", kind: "plugin",
    channelId: uid(2), agentId: uid(3), toolCallId: "toolu_018ohZoiNMZwidAe7fWsWSam", toolName: "Write",
    pluginId: "claude-cli", title: "claude-cli native tool: Write", description: '{"file_path":"/tmp/a.txt"}',
    severity: "warning", allowedDecisions: ["allow-once", "deny"], status: "pending",
    expiresAt: "2026-09-20T10:00:00.000Z", createdAt: "2026-09-20T09:58:00.000Z",
  });
  expect(parsed.runId).toBeUndefined(); // 승인에는 runId 가 없다
});

it("승인 결정은 Gateway 값 셋뿐이다", () => {
  expect(ApprovalDecision.safeParse("approve").success).toBe(false);
  expect(ApprovalDecision.options).toEqual(["allow-once", "allow-always", "deny"]);
});

it("APPROVAL_RESOLVED 는 decision 과 reason 을 함께 싣는다", () => {
  const e = RunEvent.parse({
    type: "APPROVAL_RESOLVED", runId: uid(4), seq: 7, ts: "2026-09-20T10:00:00.000Z",
    approvalId: uid(1), decision: "deny", reason: "timeout",
  });
  expect(e.type === "APPROVAL_RESOLVED" && e.reason).toBe("timeout");
});
```

- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/shared test`. `approve` 가 아직 통과하고 `reason` 이 거부되어 실패한다.

- [ ] **Step 3: 구현** — 위 Produces 블록 그대로 바꾼다. `ApprovalStatus` 의 옛 값(`approved`)을 쓰는 자리가 있으면 새 값으로 고친다(`rg '"approved"' apps packages`).

- [ ] **Step 4: 프레임 덤프 화이트리스트**

`packages/openclaw-adapter/src/gateway/frame-dump.ts` 의 `DUMPED_EVENTS` 에 다섯을 더한다. 지금은 승인이 덤프에 하나도 남지 않아 진단이 불가능하다(스파이크 8.5).

```ts
const DUMPED_EVENTS = new Set([
  "chat", "agent", "session.message",
  "session.approval", "plugin.approval.requested", "plugin.approval.resolved",
  "exec.approval.requested", "exec.approval.resolved",
]);
```

테스트 1개: 덤프 대상 판정 함수가 `plugin.approval.requested` 에 참을 준다.

- [ ] **Step 5: 컴파일 따라가기**

`pnpm typecheck` 를 돌려 깨진 자리를 고친다. `socket.ts:159-166` 의 스텁은 **그대로 `ADAPTER_UNAVAILABLE` 을 던지되** 새 `ApprovalResolve` 로 파싱만 하게 둔다(실구현은 태스크 5). 웹에서 `Approval` 을 쓰는 자리가 있으면 타입만 맞춘다.

- [ ] **Step 6: 검증·커밋**

```bash
git add packages/shared/src packages/shared/test packages/openclaw-adapter/src/gateway/frame-dump.ts \
  packages/openclaw-adapter/test apps/server/src/realtime/socket.ts
git commit -m "feat(shared): 승인 계약을 Gateway 실물에 맞춤(결정 값·상태·필드)·프레임 덤프에 승인 추가"
```

---

### Task 3: 어댑터 — 승인 수신·정규화·해결 RPC

**Files:**
- Create: `packages/openclaw-adapter/src/gateway/approvals.ts`, `packages/openclaw-adapter/test/approvals.test.ts`
- Modify: `packages/openclaw-adapter/src/gateway/events.ts:236-247`(map switch), `packages/openclaw-adapter/src/gateway/connection-manager.ts:182`(세션 구독), `packages/openclaw-adapter/src/adapter-types.ts:30-52`, `packages/openclaw-adapter/src/openclaw-adapter.ts`(어댑터 본체 — `resolveApproval` 구현), `packages/openclaw-adapter/src/fake-adapter.ts`
- Test: 위 새 파일 + `packages/openclaw-adapter/test/` 의 기존 매퍼 테스트

**Interfaces:**
- Consumes: 태스크 2 의 `Approval`·`ApprovalKind`·`ApprovalDecision`·`ApprovalReason`·`ApprovalSeverity`.
- Produces:

```ts
// gateway/approvals.ts
export type ProviderApproval = {
  providerApprovalId: string; kind: ApprovalKind; sessionKey: string; providerAgentId: string;
  toolCallId?: string; toolName?: string; pluginId?: string;
  title: string; description?: string; detail?: string; severity: ApprovalSeverity;
  allowedDecisions: ApprovalDecision[]; urlPath?: string;
  status: "pending" | "allowed" | "denied" | "expired" | "cancelled";
  decision?: ApprovalDecision; reason?: ApprovalReason;
  createdAt: string; expiresAt: string; resolvedAt?: string;
};
/** Gateway 승인 프레임(plugin/exec/system-agent · requested/resolved · session.approval) → 정규화. 모르는 모양이면 undefined */
export function parseApprovalFrame(event: string, payload: unknown): ProviderApproval | undefined;
/** approvalReplay.approvals 배열 → ProviderApproval[] (재접속 복구) */
export function parseApprovalReplay(payload: unknown): ProviderApproval[];
/** approval.resolve 인자 */
export function resolveParams(a: Pick<ProviderApproval, "providerApprovalId" | "kind">, decision: ApprovalDecision): {
  id: string; kind: ApprovalKind; decision: ApprovalDecision;
};

// adapter-types.ts
export type AdapterEvent =
  | { kind: "run_event"; runId: string; event: RunEventBody }
  | { kind: "run_signal"; runId: string; signal: RunSignal; snapshotText?: string }
  | { kind: "canonical"; message: OutboundMessage }
  | { kind: "status"; status: AdapterStatus; capabilities: AdapterCapabilities }
  | { kind: "approval"; approval: ProviderApproval };   // 새로

export interface AgentAdapter {
  // …기존 그대로…
  /** ok:false 는 throw AdapterError. 돌아온 terminal 스냅샷을 정규화해 준다 */
  resolveApproval(providerApprovalId: string, kind: ApprovalKind, decision: ApprovalDecision): Promise<ProviderApproval>;
}
```

- [ ] **Step 1: 실패 테스트 — 정규화(스파이크 실물 프레임 그대로)**

`packages/openclaw-adapter/test/approvals.test.ts`:

```ts
const REQUESTED = {
  approvalKind: "plugin",
  id: "plugin:533fe246-fa79-4f86-bcd0-3c08b549cb20",
  request: {
    pluginId: "claude-cli", title: "claude-cli native tool: Write",
    description: '{"file_path":"/tmp/a.txt","content":"hello\\n"}',
    scope: null, detail: '{"file_path":"/tmp/a.txt","content":"hello\\n"}',
    severity: "warning", toolName: "Write", toolCallId: "toolu_018ohZoiNMZwidAe7fWsWSam",
    allowedDecisions: ["allow-once", "deny"], agentId: "dev",
    sessionKey: "agent:dev:dodok:channel:01a0be37-edfd-75fd-9f36-aa98f621803d",
    runId: null, turnSourceChannel: null,
  },
  createdAtMs: 1789897787988,
  expiresAtMs: 1789897907988,
};

it("plugin.approval.requested 를 정규화한다", () => {
  const a = parseApprovalFrame("plugin.approval.requested", REQUESTED);
  expect(a).toMatchObject({
    providerApprovalId: "plugin:533fe246-fa79-4f86-bcd0-3c08b549cb20",
    kind: "plugin", status: "pending", severity: "warning", toolName: "Write",
    toolCallId: "toolu_018ohZoiNMZwidAe7fWsWSam", providerAgentId: "dev",
    allowedDecisions: ["allow-once", "deny"],
    expiresAt: new Date(1789897907988).toISOString(),
  });
});

it("해결 프레임은 결정과 이유를 싣는다", () => {
  const a = parseApprovalFrame("plugin.approval.resolved", {
    ...REQUESTED, status: "allowed", decision: "allow-once", reason: "user",
    resolvedAtMs: 1789897790009,
  });
  expect(a).toMatchObject({ status: "allowed", decision: "allow-once", reason: "user" });
});

it("만료는 deny + timeout 으로 정규화한다", () => {
  const a = parseApprovalFrame("plugin.approval.resolved", {
    ...REQUESTED, status: "expired", decision: "deny", reason: "timeout", resolvedAtMs: 1789898083646,
  });
  expect(a).toMatchObject({ status: "expired", decision: "deny", reason: "timeout" });
});

it("모르는 모양·다른 이벤트는 undefined", () => {
  expect(parseApprovalFrame("chat", {})).toBeUndefined();
  expect(parseApprovalFrame("plugin.approval.requested", { id: 1 })).toBeUndefined();
});
```

- [ ] **Step 2: 실패 확인** — `pnpm -F @dodok/openclaw-adapter test -- approvals` → 모듈이 없어 실패.

- [ ] **Step 3: 구현**

`gateway/approvals.ts` 는 Zod 로 경계 파싱한다(모르는 필드는 버린다). 요지:

```ts
const Request = z.object({
  pluginId: z.string().optional(), title: z.string().min(1), description: z.string().optional(),
  detail: z.string().optional(), severity: z.enum(["info", "warning", "critical"]).default("warning"),
  toolName: z.string().optional(), toolCallId: z.string().optional(),
  allowedDecisions: z.array(ApprovalDecision).min(1), agentId: z.string().min(1), sessionKey: z.string().min(1),
});
const Frame = z.object({
  approvalKind: ApprovalKind.default("plugin"),
  id: z.string().min(1),
  request: Request,
  status: z.enum(["pending", "allowed", "denied", "expired", "cancelled"]).optional(),
  decision: ApprovalDecision.optional(),
  reason: ApprovalReason.optional(),
  createdAtMs: z.number(),
  expiresAtMs: z.number(),
  resolvedAtMs: z.number().optional(),
});
const APPROVAL_EVENTS = new Set([
  "plugin.approval.requested", "plugin.approval.resolved",
  "exec.approval.requested", "exec.approval.resolved",
  "openclaw.approval.requested", "openclaw.approval.resolved",
]);
```

- 이벤트 이름이 `…requested` 면 `status: "pending"`, `…resolved` 면 프레임의 `status` 를 쓰되 없으면 `decision` 으로 추론한다(`deny` → `denied`).
- `session.approval` 은 `phase: "pending"|"terminal"` 과 `presentation` 모양이 달라 **`toolCallId` 가 없다**(스파이크 3.3). 이 경로는 `parseApprovalReplay` 와 같은 축약 모양으로 파싱하고, `toolCallId` 없이도 동작하게 한다.
- 시각은 밀리초 → ISO 문자열.

`gateway/events.ts` 의 `map()` switch 에 case 를 더한다. 승인은 런 이벤트가 아니므로 **여기서는 `AdapterEvent` 를 만들지 않고** 매퍼 바깥(어댑터 본체)이 쓰도록 `parseApprovalFrame` 을 노출만 한다. 더 간단한 길이 보이면 그렇게 하고 보고서에 적는다.

`connection-manager.ts:182` 의 세션 구독에 `includeApprovals: true` 를 더하고, 응답의 `approvalReplay` 를 `parseApprovalReplay` 로 흘린다.

`openclaw-adapter.ts` 는 승인 프레임을 받으면 `{ kind: "approval", approval }` 을 발행하고, **같은 `providerApprovalId` + `status` 조합은 한 번만** 발행한다(두 경로로 오므로 — 스파이크 3.1). `resolveApproval` 은 `ConnectionManager.request("approval.resolve", resolveParams(...))` 를 부르고 응답의 terminal 스냅샷을 정규화해 돌려준다.

`fake-adapter.ts` 에 `emitApproval(a: ProviderApproval)` 과 `resolveApproval` 스텁(기록만)을 더해 서버 테스트가 쓸 수 있게 한다.

- [ ] **Step 4: 중복 제거·구독 테스트**

```ts
it("같은 승인이 두 경로로 와도 한 번만 발행한다", async () => {
  const { adapter, gateway, events } = await connectedAdapter(); // 기존 테스트 헬퍼
  gateway.emit("plugin.approval.requested", REQUESTED);
  gateway.emit("session.approval", sessionApprovalPending(REQUESTED));
  expect(events.filter((e) => e.kind === "approval")).toHaveLength(1);
});

it("세션 구독에 includeApprovals 를 넣고 replay 를 흘린다", async () => {
  const { gateway, events } = await connectedAdapter();
  expect(gateway.calls("sessions.messages.subscribe")[0]).toMatchObject({ includeApprovals: true });
  // 구독 응답에 approvalReplay 가 있으면 approval 이벤트가 나온다
  expect(events.filter((e) => e.kind === "approval")).toHaveLength(1);
});
```

- [ ] **Step 5: 검증·커밋**

```bash
git add packages/openclaw-adapter/src packages/openclaw-adapter/test
git commit -m "feat(adapter): Gateway 승인 이벤트 구독·정규화·approval.resolve, 재접속 되감기"
```

---

### Task 4: 서버 — 승인 저장·상관·중계

**Files:**
- Create: `apps/server/src/modules/approvals/store.ts`, `apps/server/src/modules/approvals/service.ts`, `apps/server/test/approvals.test.ts`
- Create: `apps/server/drizzle/0002_*.sql`(마이그레이션 — `pnpm -F @dodok/server drizzle-kit generate` 로 생성한 파일명을 그대로 쓴다)
- Modify: `apps/server/src/db/schema.sqlite.ts:235-253`(approvals 테이블), `apps/server/src/modules/runs/orchestrator.ts:779-797`(AdapterEvent switch), `apps/server/src/realtime/bus.ts`, `apps/server/src/realtime/events.ts`, `apps/server/src/realtime/socket.ts:92-97`(pendingApprovals), `apps/server/src/wiring.ts`
- Test: `apps/server/test/approvals.test.ts`, 기존 `apps/server/test/app.wiring.test.ts`

**Interfaces:**
- Consumes: `ProviderApproval`·`AdapterEvent{kind:"approval"}`(태스크 3), `Approval`(태스크 2), `findOpenRunBySession`(`modules/runs/store.ts`), `appendRunEvent`.
- Produces:

```ts
// modules/approvals/store.ts
export function upsertApproval(db: DbOrTx, input: ApprovalRowInput): { approval: Approval; changed: boolean };
export function getApprovalByProviderId(db: DbOrTx, providerApprovalId: string): Approval | undefined;
export function getApproval(db: DbOrTx, id: string): Approval | undefined;
export function listPendingApprovals(db: DbOrTx, channelId: string, now: Date): Approval[];
export function listRunApprovals(db: DbOrTx, runId: string): Approval[];
export function markApproval(db: DbOrTx, id: string, patch: {
  status: ApprovalStatus; decision?: ApprovalDecision; reason?: ApprovalReason; decidedBy?: string; decidedAt: Date;
}): Approval;
export function listPendingApprovalsByRun(db: DbOrTx, runId: string): Approval[];

// modules/approvals/service.ts
export type ApprovalsService = {
  /** 어댑터 승인 이벤트 1건을 반영한다. 새 사실이면 wire·런 이벤트까지 낸다 */
  ingest(a: ProviderApproval): void;
  /** 런이 끝났을 때 남은 승인을 닫는다 */
  cancelForRun(runId: string, reason: ApprovalReason): void;
  pendingForChannel(channelId: string): Approval[];
};
export function createApprovalsService(deps: {
  db: Db; bus: ServerBus; logger: AdapterLogger; now?: () => Date;
  onSignal(runId: string, signal: RunSignal): void;   // orchestrator.api.signal
  appendEvent(runId: string, event: RunEventBody): void; // orchestrator.api.applyRunEvent
}): ApprovalsService;
```

- [ ] **Step 1: 스키마·마이그레이션**

`schema.sqlite.ts` 의 `approvals` 를 계약(태스크 2)에 맞춘다. `runId` 는 **nullable** 로 내리고 새 컬럼을 더한다.

```ts
export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    providerApprovalId: text("provider_approval_id").notNull(),
    kind: text("kind").notNull(),
    channelId: text("channel_id").notNull().references(() => channels.id),
    agentId: text("agent_id").notNull().references(() => agents.id),
    runId: text("run_id").references(() => runs.id),       // 없을 수 있다
    toolCallId: text("tool_call_id"),
    toolName: text("tool_name"),
    pluginId: text("plugin_id"),
    title: text("title").notNull(),
    description: text("description"),
    detail: text("detail"),
    severity: text("severity").notNull(),
    allowedDecisions: json<string[]>("allowed_decisions_json").notNull(),
    urlPath: text("url_path"),
    status: text("status").notNull(),
    decision: text("decision"),
    reason: text("reason"),
    decidedBy: text("decided_by"),
    decidedAt: ts("decided_at"),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("approvals_provider").on(t.providerApprovalId),
    index("approvals_channel_status").on(t.channelId, t.status),
    index("approvals_run").on(t.runId),
  ],
);
```

마이그레이션은 drizzle-kit 으로 생성한다. 기존 `approvals` 행은 개발 DB 에만 있으므로 테이블 재생성으로 족하다 — 생성된 SQL 을 읽고 그 점을 보고서에 적는다.

- [ ] **Step 2: 실패 테스트 — 상관과 중계**

`apps/server/test/approvals.test.ts`(기존 통합 테스트 하네스 사용 — `apps/server/test/` 의 가짜 Gateway·가짜 플러그인 헬퍼):

```ts
it("승인 요구를 런에 붙여 저장하고 wire 로 중계한다", async () => {
  const h = await startHarness();                    // 서버 + 가짜 어댑터
  const run = await h.startRun({ text: "@dev 파일 써줘" });
  h.adapter.emitApproval(approvalFixture({ sessionKey: run.sessionKey, toolCallId: "toolu_1" }));

  const approval = await vi.waitFor(() => h.wire.last("approval.requested").approval);
  expect(approval).toMatchObject({ runId: run.id, channelId: h.channel.id, status: "pending", toolName: "Write" });
  expect(h.db.runEvents(run.id).map((e) => e.type)).toContain("APPROVAL_REQUESTED");
  expect(h.db.run(run.id).status).toBe("awaiting_approval");
});

it("런이 없으면 채널 수준 승인으로 저장한다", async () => {
  const h = await startHarness();
  h.adapter.emitApproval(approvalFixture({ sessionKey: h.sessionKeyOf("dev"), toolCallId: "toolu_2" }));
  const approval = await vi.waitFor(() => h.wire.last("approval.requested").approval);
  expect(approval.runId).toBeUndefined();
  expect(approval.channelId).toBe(h.channel.id);
});

it("같은 승인이 두 번 오면 한 번만 중계한다", async () => {
  const h = await startHarness();
  const a = approvalFixture({ sessionKey: h.sessionKeyOf("dev") });
  h.adapter.emitApproval(a);
  h.adapter.emitApproval(a);
  await vi.waitFor(() => expect(h.wire.all("approval.requested")).toHaveLength(1));
});

it("우리 세션 키가 아니면 무시한다", async () => {
  const h = await startHarness();
  h.adapter.emitApproval(approvalFixture({ sessionKey: "agent:dev:discord:channel:x" }));
  await h.settle();
  expect(h.wire.all("approval.requested")).toHaveLength(0);
});

it("구독 응답이 미해결 승인을 돌려준다", async () => {
  const h = await startHarness();
  h.adapter.emitApproval(approvalFixture({ sessionKey: h.sessionKeyOf("dev") }));
  await vi.waitFor(() => h.wire.all("approval.requested").length === 1);
  const res = await h.wire.subscribe(h.channel.id);
  expect(res.pendingApprovals).toHaveLength(1);
});
```

- [ ] **Step 3: 실패 확인** — `pnpm -F @dodok/server test -- approvals`.

- [ ] **Step 4: 구현**

`service.ts` 의 `ingest` 순서:

1. `sessionKey` 파싱 — `agent:<providerAgentId>:dodok:channel:<channelId>`. 모양이 다르면 `logger.warn({ sessionKey }, "approval for unknown session")` 하고 끝낸다(**토큰·본문은 찍지 않는다**).
2. 채널·에이전트를 찾는다(없으면 같은 warn).
3. `findOpenRunBySession(db, sessionKey)` 로 런을 찾는다(없으면 `runId` 없이).
4. `upsertApproval` — `providerApprovalId` 가 있으면 갱신, 없으면 새로. **이미 종료 상태인 행에 `pending` 이 늦게 오면 무시**하고 `changed: false`.
5. `changed` 일 때만: 런이 있으면 `appendEvent(runId, { type: "APPROVAL_REQUESTED", … })` 또는 `APPROVAL_RESOLVED`, 런 신호(`onSignal(runId, { kind: "approval_requested" })` / `{ kind: "approval_resolved", decision }`), 그리고 `bus.emit("approval.requested"|"approval.resolved", { channelId, approval })`.

`bus.ts`·`events.ts` 에 두 이벤트를 더한다(채널 룸으로):

```ts
    on("approval.requested", (p) => io.to(channelRoom(p.channelId)).emit("approval.requested", { approval: p.approval })),
    on("approval.resolved", (p) => io.to(channelRoom(p.channelId)).emit("approval.resolved", { approval: p.approval })),
```

`orchestrator.ts:779-797` 의 switch 에 case 하나:

```ts
      case "approval":
        approvals.ingest(e.approval);
        return;
```

`socket.ts:92-97` 의 하드코딩을 실제 조회로 바꾼다: `pendingApprovals: ctx.runs?.pendingApprovals(channel.id) ?? []`. `RunsFacade`(`realtime/types.ts`)에 `pendingApprovals(channelId: string): Approval[]` 를 더하고 `wiring.ts` 에서 서비스를 잇는다.

- [ ] **Step 5: 검증·커밋**

```bash
git add apps/server/src/modules/approvals apps/server/src/db/schema.sqlite.ts apps/server/drizzle \
  apps/server/src/modules/runs/orchestrator.ts apps/server/src/realtime apps/server/src/wiring.ts apps/server/test
git commit -m "feat(server): 승인 저장·런 상관(sessionKey+toolCallId)·wire 중계·미해결 승인 조회"
```

---

### Task 5: 서버 — 해결 경로·상태머신·타임아웃

**Files:**
- Modify: `apps/server/src/realtime/socket.ts:159-166`, `apps/server/src/realtime/types.ts`, `apps/server/src/modules/approvals/service.ts`, `apps/server/src/modules/runs/machine.ts:26-73`, `apps/server/src/modules/runs/orchestrator.ts`(타이머), `apps/server/src/wiring.ts`
- Test: `apps/server/test/approvals.test.ts`(이어서), `apps/server/test/machine.test.ts`(있으면 그 파일)

**Interfaces:**
- Consumes: 태스크 4 의 `ApprovalsService`·store, 태스크 3 의 `adapter.resolveApproval`.
- Produces: `RunsFacade.resolveApproval(input: { approvalId: string; decision: ApprovalDecision; userId: string }): Promise<void>` · `ApprovalsService.resolve(...)`(같은 인자, 검증 포함).

- [ ] **Step 1: 실패 테스트 — 검증 표**

```ts
it.each([
  ["다른 워크스페이스 사용자", "FORBIDDEN"],
  ["없는 승인", "NOT_FOUND"],
  ["이미 확정된 승인", "CONFLICT"],
  ["만료된 승인", "CONFLICT"],
  ["allowedDecisions 밖 결정", "VALIDATION"],
])("%s 는 %s 이고 Gateway 로 보내지 않는다", async (caseName, code) => {
  const h = await startHarness();
  const { approvalId, resolve } = await h.pendingApproval();   // 헬퍼가 상황별로 준비
  await expect(resolve(caseName)).rejects.toMatchObject({ code });
  expect(h.adapter.resolveCalls).toHaveLength(0);
});

it("허용하면 Gateway 로 보내고 런이 이어진다", async () => {
  const h = await startHarness();
  const { approvalId, run } = await h.pendingApproval();
  await h.wire.emit("approval.resolve", { approvalId, decision: "allow-once" });
  expect(h.adapter.resolveCalls[0]).toMatchObject({ decision: "allow-once" });
  await vi.waitFor(() => expect(h.db.approval(approvalId).status).toBe("allowed"));
  expect(h.db.run(run.id).status).toBe("tool");     // 대기 전 상태로 복귀
});

it("거절해도 런은 죽지 않는다", async () => {
  const h = await startHarness();
  const { approvalId, run } = await h.pendingApproval();
  await h.wire.emit("approval.resolve", { approvalId, decision: "deny" });
  await vi.waitFor(() => expect(h.db.approval(approvalId).status).toBe("denied"));
  expect(h.db.run(run.id).status).toBe("tool");
});

it("승인 대기 동안에는 런 무응답 타임아웃이 돌지 않는다", async () => {
  vi.useFakeTimers();
  const h = await startHarness();
  const { run } = await h.pendingApproval();
  await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1_000);
  expect(h.db.run(run.id).status).toBe("awaiting_approval");   // error 가 아니다
});

it("승인이 만료 시각을 넘기면 승인을 만료로 닫고 런 시계를 다시 켠다", async () => {
  vi.useFakeTimers();
  const h = await startHarness();
  const { approvalId, run } = await h.pendingApproval({ ttlMs: 20_000 });
  await vi.advanceTimersByTimeAsync(25_000);                    // Gateway 가 조용한 경우
  expect(h.db.approval(approvalId).status).toBe("expired");
  await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS + 1_000);
  expect(h.db.run(run.id).status).toBe("error");
});

it("런을 중지하면 남은 승인을 cancelled 로 닫는다", async () => {
  const h = await startHarness();
  const { approvalId, run } = await h.pendingApproval();
  await h.wire.emit("run.abort", { runId: run.id });
  await vi.waitFor(() => expect(h.db.approval(approvalId)).toMatchObject({ status: "cancelled", reason: "run-aborted" }));
});
```

- [ ] **Step 2: 실패 확인** — 지금은 `approval.resolve` 가 늘 `ADAPTER_UNAVAILABLE` 이라 전부 실패한다.

- [ ] **Step 3: 구현 — 해결 경로**

`socket.ts` 의 스텁을 `run.abort` 와 같은 모양으로 바꾼다:

```ts
    socket.on("approval.resolve", async (raw: unknown, ack: unknown) => {
      const res = await settle(ctx.logger, "approval.resolve", async () => {
        const { approvalId, decision } = parsePayload(ApprovalResolve, raw);
        await runs().resolveApproval({ approvalId, decision, userId });
        return null;
      });
      reply(ack, res);
    });
```

`service.resolve` 는 스펙 4.4 표 순서대로 검사하고, 통과할 때만 `adapter.resolveApproval` 을 부른다. Gateway 응답의 terminal 스냅샷으로 `markApproval` 하고 `bus.emit("approval.resolved", …)`. Gateway 가 같은 사실을 이벤트로도 주므로 `ingest` 와 **id + status 로 중복 제거**한다(먼저 온 쪽이 이긴다 — `upsert` 가 `changed:false` 를 주면 조용히 끝낸다).

- [ ] **Step 4: 구현 — 상태머신·타이머**

`machine.ts` 의 `approval_resolved` 는 **대기 전 상태로 돌아간다**. 지금은 무조건 `streaming` 이라 툴 진행 중이었으면 상태가 뒤로 간다. 런 행에 `statusBeforeApproval` 을 두지 말고(스키마를 늘리지 않는다), 신호에 실어 보낸다:

```ts
    case "approval_resolved":
      if (st !== "awaiting_approval") return IGNORED;
      return go(s.resumeTo ?? "streaming");
```

`RunSignal` 의 `approval_resolved` 를 `{ kind: "approval_resolved"; decision: ApprovalDecision; resumeTo?: "streaming" | "tool" }` 로 넓히고(태스크 2 계약을 이 태스크에서 한 줄 더 고친다 — 뒤 태스크가 쓰기 전이라 안전), 서비스가 승인 요청 때의 런 상태를 기억했다가 넘긴다(메모리 맵, 서버 재기동 시에는 `tool` 로 가정).

`orchestrator.ts` 의 타이머 재무장(`rearmTimers`)에서 `awaiting_approval` 이면 무응답 타임아웃을 걸지 않고, 대신 그 런의 미해결 승인 중 가장 이른 `expiresAt` + 5초에 감시 타이머를 건다. 그때까지 아무 해결도 오지 않으면 `service` 가 승인을 `expired`(`reason: "timeout"`)로 닫고 런 신호를 보낸다 — 그러면 보통 타이머가 다시 켜진다.

런 종료(`abort`·`error`·`done`) 때 `cancelForRun(runId, "run-aborted")`.

- [ ] **Step 5: 검증·커밋**

```bash
git add apps/server/src/realtime apps/server/src/modules/approvals apps/server/src/modules/runs \
  packages/shared/src/events/index.ts apps/server/test
git commit -m "feat(server): 승인 해결 경로 검증·대기 중 타임아웃 정지·만료 감시·런 중단 시 취소"
```

---

### Task 6: 하네스 — 가짜 Gateway 승인 · `dev:fake` 대본 · 통합 시나리오

**Files:**
- Modify: `apps/server/test/fakes/fake-gateway.ts`(`FAKE_GATEWAY_EVENTS`), `apps/server/test/fakes/scenario.ts`(`ScenarioScript`), `apps/server/scripts/dev-fake.ts:55-75`(`fakeAgentScript`)
- Test: `apps/server/test/integration.test.ts`(기존 시나리오 파일에 시나리오 9 추가)

**Interfaces:**
- Consumes: 태스크 3~5 전부.
- Produces: `ScenarioScript.approval?: { title: string; toolName: string; allowedDecisions: ApprovalDecision[]; ttlMs: number; onDecision: "continue" | "toolError" }` · `dev:fake` 키워드 **「승인」**.

- [ ] **Step 1: 실패 테스트 — 통합 시나리오 9**

기존 시나리오 파일의 관습대로(사람 메시지 → 가짜 Gateway 대본 → 단언) 세 가지를 더한다.

```ts
it("시나리오 9a: 승인을 허용하면 런이 이어지고 정본이 온다", async () => {
  const h = await startIntegration();
  h.gateway.script({ approval: { title: "Write", toolName: "Write", allowedDecisions: ["allow-once", "deny"], ttlMs: 20_000, onDecision: "continue" } });
  await h.send("@dev 파일 써줘");
  const approval = await vi.waitFor(() => h.wire.last("approval.requested").approval);
  await h.wire.emit("approval.resolve", { approvalId: approval.id, decision: "allow-once" });
  await vi.waitFor(() => expect(h.db.run(approval.runId!).status).toBe("done"));
  expect(h.messages().at(-1)?.authorType).toBe("agent");
});

it("시나리오 9b: 거절하면 툴 오류로 이어지고 런은 끝난다", async () => { /* onDecision: "toolError" */ });

it("시나리오 9c: 아무도 응답하지 않으면 만료되고 런 시계가 다시 켜진다", async () => { /* ttlMs 짧게, 가짜 타이머 */ });
```

- [ ] **Step 2: 실패 확인** — 하네스가 승인 프레임을 만들 줄 몰라 실패.

- [ ] **Step 3: 구현 — 하네스**

`fake-gateway.ts` 가 대본의 `approval` 을 보면 툴 시작 뒤 `plugin.approval.requested` 프레임을 실물 모양(스파이크 3.2)으로 보내고, `approval.resolve` RPC 를 받으면 `plugin.approval.resolved` 를 보낸 뒤 대본대로 이어간다(`continue` 면 델타 계속, `toolError` 면 툴 결과를 오류로). TTL 이 지나면 `resolved(status:"expired", decision:"deny", reason:"timeout")`.

`dev-fake.ts` 의 `fakeAgentScript` 에 키워드 한 줄:

```ts
    ...(text.includes("승인")
      ? { approval: { title: "claude-cli native tool: Write", toolName: "Write", allowedDecisions: ["allow-once", "deny"] as const, ttlMs: 20_000, onDecision: "continue" as const } }
      : {}),
```

TTL 20초는 브라우저 검증이 만료까지 볼 수 있게 한 값이다(실물은 120초).

- [ ] **Step 4: 검증·커밋**

```bash
git add apps/server/test apps/server/scripts/dev-fake.ts
git commit -m "test(server): 가짜 Gateway 승인 프레임·dev:fake 「승인」 대본·통합 시나리오 9"
```

---

### Task 7: 웹 — 오른쪽 패널 탭 + 활동 탭

**Files:**
- Create: `apps/web/src/app/layout/PanelTabs.tsx`, `apps/web/src/features/activity/{ActivityPanel,RunList,RunTimeline,ToolCallRow}.tsx`, `apps/web/src/features/activity/timeline.ts`(순수 변환) + `timeline.test.ts`, `apps/web/src/features/activity/activity.test.tsx`
- Modify: `apps/web/src/app/router.tsx:70-103`(라우트 추가), `apps/web/src/features/settings/ChannelSettingsPanel.tsx`(탭 셸 사용), `apps/web/src/api/queries.ts`(런·이벤트 쿼리)
- Test: 위 테스트 파일들 + 기존 `apps/web/test/shellApi.tsx` 확장(런·이벤트 기본 응답)

**Interfaces:**
- Consumes: `useRunStore`·`selectChannelRuns`(`features/runs/runStore.ts`), `qk`·`api`(`api/queries.ts`·`api/http.ts`), `useIsNarrow`·`OpenSidebarButton`(태스크 6 웹 MVP 산출물).
- Produces:

```ts
// api/queries.ts
qk.channelRuns = (channelId: string) => ["channels", channelId, "runs"] as const;
qk.runEvents   = (runId: string)     => ["runs", runId, "events"] as const;
export function useChannelRuns(channelId: string): UseQueryResult<RunState[]>;
export function useRunEvents(runId: string | undefined): UseQueryResult<RunEvent[]>;

// features/activity/timeline.ts
export type ActivityRow =
  | { kind: "tool"; key: string; toolCallId: string; name: string; args?: string; result?: string; ok?: boolean; durationMs?: number; state: "running" | "done" }
  | { kind: "step"; key: string; name: string; state: "started" | "finished" }
  | { kind: "subagent"; key: string; label?: string; state: "started" | "finished" | "error"; message?: string }
  | { kind: "approval"; key: string; approvalId: string; title: string; decision?: string; reason?: string }
  | { kind: "error"; key: string; message: string };
/** 런 이벤트(오름차순)를 화면 행으로 접는다. 텍스트 델타는 버린다 */
export function toActivityRows(events: readonly RunEvent[]): ActivityRow[];

// PanelTabs
export function PanelTabs({ channelId, active }: { channelId: string; active: "settings" | "activity" }): ReactElement;
```

- [ ] **Step 1: 순수 변환 테스트**

```ts
it("툴 호출은 시작·인자·결과·끝을 한 행으로 접는다", () => {
  const rows = toActivityRows([
    runEvent({ type: "TOOL_CALL_START", seq: 1, toolCallId: "t1", toolCallName: "Read" }),
    runEvent({ type: "TOOL_CALL_ARGS", seq: 2, toolCallId: "t1", delta: '{"path":' }),
    runEvent({ type: "TOOL_CALL_ARGS", seq: 3, toolCallId: "t1", delta: '"README.md"}' }),
    runEvent({ type: "TOOL_CALL_RESULT", seq: 4, toolCallId: "t1", content: "ok", ok: true, durationMs: 12 }),
    runEvent({ type: "TOOL_CALL_END", seq: 5, toolCallId: "t1" }),
  ]);
  expect(rows).toEqual([
    { kind: "tool", key: "tool:t1", toolCallId: "t1", name: "Read", args: '{"path":"README.md"}',
      result: "ok", ok: true, durationMs: 12, state: "done" },
  ]);
});

it("끝나지 않은 툴은 running", () => { /* START 만 */ });
it("텍스트 델타는 행이 되지 않는다", () => { /* TEXT_DELTA 만 넣으면 [] */ });
it("승인·단계·서브에이전트·오류는 순서대로 행이 된다", () => { /* 섞어서 넣고 kind 순서 단언 */ });
```

- [ ] **Step 2: 실패 확인 → 구현** — `toActivityRows` 는 `toolCallId` 로 맵을 만들고 순서를 보존한다(첫 등장 자리에 행을 둔다).

- [ ] **Step 3: 탭 셸과 라우트**

`router.tsx` 에 라우트 하나를 더한다(설정 라우트와 같은 부모·같은 모양):

```ts
export const channelActivityRoute = createRoute({
  getParentRoute: () => channelRoute,
  path: "activity",
  component: lazyPage(() => import("@/features/activity/ActivityPanel"), "ActivityPanel"),
});
// routeTree: channelRoute.addChildren([channelSettingsRoute, channelActivityRoute])
```

`PanelTabs` 는 두 탭 링크(`aria-current="page"`)와 닫기 버튼을 그린다. `ChannelSettingsPanel` 과 `ActivityPanel` 은 같은 바깥 틀(넓은 화면 360px 패널 / 좁은 화면 전체 화면 시트, `data-testid` 유지)을 공유한다 — 지금 `ChannelSettingsPanel` 에 있는 틀을 `PanelTabs` 로 올리고 두 패널이 내용만 넣는다.

- [ ] **Step 4: 화면 테스트**

```ts
it("활동 탭은 런 목록을 보이고 고르면 타임라인을 그린다", async () => {
  stubServer({ runs: [runState({ id: RUN, status: "done" })], events: [/* 위 툴 5개 */] });
  renderRoute(`/c/${CH}/activity`);
  await screen.findByRole("link", { name: "설정" });                   // 탭 둘
  await userEvent.click(await screen.findByRole("button", { name: /@dev/ }));
  expect(await screen.findByText("Read")).toBeInTheDocument();
  expect(screen.queryByText('{"path":"README.md"}')).not.toBeInTheDocument();  // 인자는 접힘
  await userEvent.click(screen.getByRole("button", { name: "인자 보기" }));
  expect(screen.getByText('{"path":"README.md"}')).toBeInTheDocument();
});

it("잘린 결과에는 잘림 표시가 붙는다", async () => { /* content 에 "…[+120 chars hidden]…" */ });
it("진행 중 런은 새 이벤트가 오면 끝에 붙는다", async () => { /* wire run.event 를 밀어 넣고 마지막 행이 보이는지 */ });
it("설정 탭으로 가도 같은 틀(패널·시트)이 유지된다", async () => { /* 좁은 화면 stubMedia 로 시트 확인 */ });
```

- [ ] **Step 5: 검증·커밋**

```bash
git add apps/web/src/features/activity apps/web/src/app/layout/PanelTabs.tsx apps/web/src/app/router.tsx \
  apps/web/src/features/settings/ChannelSettingsPanel.tsx apps/web/src/api/queries.ts apps/web/test/shellApi.tsx
git commit -m "feat(web): 오른쪽 패널 탭·활동 탭(런 목록·툴 타임라인)"
```

---

### Task 8: 웹 — 승인 스토어·카드

**Files:**
- Create: `apps/web/src/features/approvals/{approvalStore.ts,ApprovalCard.tsx,countdown.ts}` + `approvalStore.test.ts`·`ApprovalCard.test.tsx`
- Modify: `apps/web/src/realtime/handlers.ts:76-100`(분기 둘), `apps/web/src/realtime/subscriptions.ts`(구독 ack 의 `pendingApprovals`), `apps/web/src/features/messages/groupRows.ts`·`MessageList.tsx`(승인 행), `apps/web/test/fixtures.ts`(승인 픽스처)
- Test: 위 + 기존 `features/messages/MessageList.test.tsx`

**Interfaces:**
- Consumes: 태스크 2 `Approval`·`ApprovalDecision`, 태스크 4·5 의 wire 이벤트·ack, `emitAck`·`WireAckError`(`realtime/wire.ts`).
- Produces:

```ts
// features/approvals/approvalStore.ts
export type ApprovalView = { approval: Approval; sending?: ApprovalDecision };
export const useApprovalStore: UseBoundStore<{
  byChannel: Record<string, Record<string, ApprovalView>>;   // channelId → approvalId → view
  apply(approval: Approval): void;
  applyMany(approvals: readonly Approval[]): void;
  setSending(approvalId: string, decision?: ApprovalDecision): void;
  reset(): void;
}>;
export function selectChannelApprovals(channelId: string): (s: …) => ApprovalView[];   // useShallow 와 함께
export function selectPendingApproval(channelId: string, runId?: string): (s: …) => ApprovalView | undefined;

// features/approvals/countdown.ts
/** 남은 밀리초 → 「1분 58초」·「12초」·「만료됨」 */
export function remainingLabel(expiresAt: string, now: number): string;

// features/approvals/ApprovalCard.tsx
export function ApprovalCard({ approvalId, channelId }: { approvalId: string; channelId: string }): ReactElement | null;
```

- [ ] **Step 1: 스토어·카운트다운 테스트**

```ts
it("나중에 온 사실이 이긴다 — 확정 뒤 pending 은 무시", () => {
  const s = useApprovalStore.getState();
  s.apply(approvalFixture({ id: A, status: "pending" }));
  s.apply(approvalFixture({ id: A, status: "allowed", decision: "allow-once", reason: "user" }));
  s.apply(approvalFixture({ id: A, status: "pending" }));
  expect(useApprovalStore.getState().byChannel[CH]![A]!.approval.status).toBe("allowed");
});

it.each([
  [118_000, "1분 58초"],
  [12_000, "12초"],
  [0, "만료됨"],
  [-5_000, "만료됨"],
])("남은 시간 %i ms → %s", (ms, label) => {
  expect(remainingLabel(new Date(NOW + ms).toISOString(), NOW)).toBe(label);
});
```

- [ ] **Step 2: 카드 테스트**

```ts
it("allowedDecisions 에 있는 버튼만 그리고 카운트다운을 보인다", async () => {
  renderCard(approvalFixture({ allowedDecisions: ["allow-once", "deny"], expiresAt: iso(NOW + 120_000) }));
  expect(screen.getByRole("button", { name: "이번만 허용" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "거절" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "항상 허용" })).not.toBeInTheDocument();
  expect(screen.getByText("2분 0초 남음")).toBeInTheDocument();
});

it("누르면 approval.resolve 를 보내고 잠근다", async () => {
  const { socket } = renderCard(approvalFixture({}));
  await userEvent.click(screen.getByRole("button", { name: "이번만 허용" }));
  expect(socket.sentOf("approval.resolve")[0]).toMatchObject({ decision: "allow-once" });
  expect(screen.getByRole("button", { name: "이번만 허용" })).toBeDisabled();
});

it("CONFLICT 면 문구를 토스트하고 잠금을 푼다", async () => { /* ack 오류 */ });
it("확정되면 결과 한 줄로 바뀐다", async () => { /* status allowed → 「허용됨」, 버튼 없음 */ });
it("만료되면 만료됨으로 바뀐다", async () => { /* 시계를 넘겨 */ });
it("인자는 접혀 있고 펼칠 수 있다", async () => { /* description */ });
```

- [ ] **Step 3: 구현**

`handlers.ts` 에 분기 둘:

```ts
    "approval.requested": ({ approval }) => useApprovalStore.getState().apply(approval),
    "approval.resolved": ({ approval }) => useApprovalStore.getState().apply(approval),
```

구독 ack 처리(`subscriptions.ts`)에서 `pendingApprovals` 를 `applyMany` 로 넣는다. 로그아웃·세션 정리 때 `reset()`(기존 `registerSessionReset` 자리).

`groupRows.ts` 에 승인 행을 더한다 — `Row` 유니온에 `{ kind: "approval"; key: string; approvalId: string }`. 순서는 승인 `createdAt` 기준으로 확정 메시지 사이에 끼우고, 미해결 승인은 **맨 아래 버블 앞**에 둔다. `MessageList.tsx` 는 그 행을 `<ApprovalCard/>` 로 그린다. 기존 행 memo 비교에 승인 뷰를 더한다.

활동 탭(태스크 7)의 맨 위에도 같은 카드를 쓴다 — `ActivityPanel` 이 `selectPendingApproval` 로 하나를 골라 그린다.

- [ ] **Step 4: 목록 테스트**

```ts
it("미해결 승인은 메시지 흐름 맨 아래에 카드로 뜬다", async () => { /* MessageList + 스토어 */ });
it("확정된 승인 카드는 사라지지 않고 결과로 남는다", async () => { /* 기록 */ });
```

- [ ] **Step 5: 검증·커밋**

```bash
git add apps/web/src/features/approvals apps/web/src/realtime apps/web/src/features/messages apps/web/test/fixtures.ts
git commit -m "feat(web): 승인 스토어·카드(메시지 흐름·활동 탭)·카운트다운·해결"
```

---

### Task 9: 웹 — 브라우저 알림

**Files:**
- Create: `apps/web/src/features/approvals/notify.ts` + `notify.test.ts`, `apps/web/src/app/layout/NotifyToggle.tsx`
- Modify: `apps/web/src/realtime/handlers.ts`(승인 요구에서 호출), `apps/web/src/app/layout/Sidebar.tsx`(토글 자리)
- Test: 위 테스트 + `apps/web/test/domStubs.ts`(Notification 스텁)

**Interfaces:**
- Consumes: 태스크 8 의 스토어·핸들러.
- Produces:

```ts
// features/approvals/notify.ts
export type NotifyPermission = "unsupported" | "default" | "granted" | "denied";
export function notifyPermission(): NotifyPermission;
export async function requestNotifyPermission(): Promise<NotifyPermission>;
/** 승인 요구 알림. 같은 채널을 보고 있고 탭이 보이면 띄우지 않는다. 띄웠으면 true */
export function notifyApproval(a: Approval, ctx: { visible: boolean; currentChannelId?: string; onClick(): void }): boolean;
```

- [ ] **Step 1: 실패 테스트**

```ts
it("권한이 granted 이고 다른 채널을 보고 있으면 띄운다", () => {
  const made = stubNotification("granted");
  expect(notifyApproval(approvalFixture({ channelId: CH, toolName: "Write" }),
    { visible: true, currentChannelId: CH2, onClick: noop })).toBe(true);
  expect(made[0]?.title).toBe("승인 필요 — @dev 가 Write 를 실행하려 합니다");
});

it("같은 채널을 보고 있고 탭이 보이면 띄우지 않는다", () => { /* false, Notification 0개 */ });
it("탭이 숨겨져 있으면 같은 채널이어도 띄운다", () => { /* visible: false */ });
it("권한이 default·denied·미지원이면 띄우지 않고 던지지 않는다", () => { /* 세 경우 */ });
it("알림을 누르면 콜백이 불린다", () => { /* onclick 호출 */ });
```

- [ ] **Step 2: 구현** — `Notification` 이 없으면 `"unsupported"`. 권한 요청은 `NotifyToggle` 이 눌릴 때만. `denied` 면 토글을 숨긴다. 알림 `tag` 는 `approvalId` 로 둬 같은 승인이 두 번 뜨지 않게 한다.

- [ ] **Step 3: 배선** — `handlers.ts` 의 `approval.requested` 분기에서 `status === "pending"` 일 때만 부른다. 클릭하면 `router.navigate({ to: "/c/$channelId/activity", params })`.

- [ ] **Step 4: 토글 테스트**

```ts
it("알림 켜기를 누르면 권한을 요청하고 켜지면 버튼이 사라진다", async () => { /* stubNotification("default") */ });
it("거부하면 다시 묻지 않는다", async () => { /* denied 면 버튼 없음 */ });
```

- [ ] **Step 5: 검증·커밋**

```bash
git add apps/web/src/features/approvals apps/web/src/app/layout apps/web/src/realtime/handlers.ts apps/web/test/domStubs.ts
git commit -m "feat(web): 승인 요구 브라우저 알림·알림 켜기 토글"
```

---

### Task 10: 브라우저 검증 (verify 워커 — 코드 변경 없음)

**Files:**
- Create: `.superpowers/sdd/2026-09-20-activity-approvals/t10-report.md`, `…/screens/t10-*.png`(둘 다 git-ignored)

**Interfaces:**
- Consumes: `PORT=3000 pnpm -F @dodok/server dev:fake`(로그인 토큰 `dev-fake-local-token`, 키워드 「승인」·「도구」·「느리게」·「실패」·「드롭」), `pnpm -F @dodok/web dev`(5173), 브라우저는 **http://localhost:5173**.
- Produces: 시나리오 표·결함 목록(조율자가 수정 라운드로 넘긴다).

- [ ] **Step 1: 준비** — 새 DB(`--keep` 없이). 도구 순서는 `docs/guides/browser-verification.md`. 서버를 끌 때는 `lsof -ti:3000 -sTCP:LISTEN`.

- [ ] **Step 2: 시나리오**

1. 활동 탭: 「@dev 도구」 → 툴 행이 실시간으로 생기고 상태가 done 으로 바뀐다. 인자·결과 펼치기. 런 목록에서 옛 런을 골라도 그린다.
2. 승인 허용: 「@dev 승인」 → 카드가 **메시지 흐름과 활동 탭 양쪽**에 뜬다 → 카운트다운이 줄어든다 → 「이번만 허용」 → 런이 이어지고 정본 메시지가 온다. 카드는 「허용됨」으로 남는다.
3. 승인 거절: 같은 흐름에서 「거절」 → 런이 툴 오류로 끝나고 카드가 「거절됨」.
4. 만료: 카드를 20초 두고 기다린다 → 「만료됨」, 버튼 비활성.
5. 재접속 복구: 승인 대기 중 서버를 끄고(`--keep` 으로 다시 켜기) → 재접속 뒤 카드가 그대로 있다(구독 ack 의 `pendingApprovals`).
6. 알림: 「알림 켜기」 → 다른 채널로 이동 → 「@dev 승인」 → 알림이 뜨고 누르면 그 채널 활동 탭으로 간다. 같은 채널을 보고 있을 때는 뜨지 않는다.
7. 390px: 패널 탭이 전체 화면 시트로, 카드 버튼이 넘치지 않는다.
8. 회귀: 메시지 보내기·스트리밍 버블·중지·채널 만들기·에이전트 등록이 그대로 된다.
9. 콘솔: 앱 JS 예외 0, `ResizeObserver` 오류 0, favicon 404 0(로그인 전 401 2건은 알려진 것).

- [ ] **Step 3: 보고** — 시나리오 표(통과·실패·스크린샷·콘솔 수), 결함 목록(심각도·재현·짐작 가는 파일), 걱정. 코드는 고치지 않는다. 결함이 있으면 조율자가 수정 라운드를 돌리고 이 태스크를 다시 돈다.

---

### Task 11: 문서

**Files:**
- Modify: `docs/project-structure.md`(2.3 어댑터 승인 경로·2.5 웹 새 폴더), `CLAUDE.md`(현재 단계), `docs/plan.md`(8장 Phase 2 진행·「이월」에서 정리된 줄 제거), `docs/guides/live-smoke.md`(승인 확인 절), `docs/superpowers/specs/2026-09-20-activity-approvals-design.md`(구현과 달라진 곳)
- Test: 없음(문서). 루트 네 명령은 돌린다.

- [ ] **Step 1: 문서 갱신**

- `project-structure.md`: 어댑터의 승인 파일(`gateway/approvals.ts`)과 서버 `modules/approvals/`, 웹 `features/activity`·`features/approvals` 를 실물 트리에 반영한다.
- `CLAUDE.md` 「현재 단계」: 「Phase 2 ① 활동 패널·승인 완료(날짜) — 다음: ② components v1 완성」.
- `docs/plan.md`: 8장 Phase 2 의 「활동 패널·승인 카드」 줄에 완료 표시, 「이월」에서 이번에 정리한 줄(서버 넷·웹 넷·wire-cli)을 지운다. 남은 줄은 그대로 둔다.
- `live-smoke.md`: 승인을 실물에서 보려면 에이전트 권한을 「물어보기」로 바꿔야 한다는 절차(스파이크 2.1 의 먹히는 설정)와 되돌리기를 적는다.
- 스펙 문서 끝에 「구현과 맞춘 것」 단락 — 계획과 달라진 결정이 있으면 한 줄씩.

- [ ] **Step 2: 검증·커밋**

```bash
git add docs/project-structure.md CLAUDE.md docs/plan.md docs/guides/live-smoke.md docs/superpowers/specs/2026-09-20-activity-approvals-design.md
git commit -m "docs: Phase 2 ① 활동 패널·승인 — 구성 가이드·현재 단계·계획서·실연 절"
```

---

## Self-Review

**1. 스펙 대응**

| 스펙 절 | 태스크 |
| --- | --- |
| 0장 결정 1~9 | 1(8번 CJK)·2(계약)·3(1·2번 구독·상관)·5(3·4번 검증·타임아웃)·7(7번 탭)·8(5번 카드 두 자리)·9(6번 알림)·범위 밖 9번은 태스크 없음(의도) |
| 1장 범위 | 태스크 0~11 전체 |
| 2장 구조 | 파일 구조 절 |
| 3장 계약 정정 | 태스크 2(+태스크 5 에서 `RunSignal.resumeTo` 한 줄) |
| 4.1 구독 | 태스크 3 |
| 4.2 상관·저장 | 태스크 4 |
| 4.3 상태머신·타임아웃 | 태스크 5 |
| 4.4 해결 경로 | 태스크 5 |
| 4.5 진단(프레임 덤프) | 태스크 2 |
| 5.1~5.2 패널·타임라인 | 태스크 7 |
| 5.3 승인 카드 | 태스크 8 |
| 5.4 알림 | 태스크 9 |
| 5.5 상태 | 태스크 8 |
| 6장 오류 처리 | 태스크 5(서버 코드)·8(카드 문구)·7(패널 조회 실패) |
| 7장 검증 | 태스크 6(통합·dev:fake)·10(브라우저) |
| 8장 이월 | 태스크 0·1 |
| 9장 완료 기준 | 태스크 6·10 |

**2. 자리표시 점검** — 「TBD」·「적절히」·코드 없는 구현 단계는 없다. 태스크 0 (a)~(c) 와 태스크 1 (a)~(e) 는 자리를 `rg` 로 찾게 했다 — 실물 파일명이 이 계획 작성 시점에 확인되지 않은 것들이라 의도한 것이고, 각 항목마다 테스트 개수를 못 박았다.

**3. 타입 일관성** — `ProviderApproval`(태스크 3) → `Approval`(태스크 2) 로의 변환은 태스크 4 `service.ingest` 한 곳에서만 한다. `ApprovalDecision` 값은 세 태스크(2·5·8)에서 같은 문자열을 쓴다. `RunSignal.approval_resolved` 는 태스크 2 에서 `decision` 을, 태스크 5 에서 `resumeTo` 를 더한다 — 태스크 5 의 Step 4 에 그 사실을 적었다. `qk.channelRuns`·`qk.runEvents`(태스크 7)는 기존 `qk` 관습(배열 `as const`)을 따른다.

**4. 이 계획이 남기는 위험**

- 승인 실물은 스파이크에서 **plugin 종류 하나만** 봤다. `exec`·`system-agent` 는 같은 모양이라고 보고 만든다(태스크 3 의 파서가 셋을 함께 받는다). 실물이 다르면 태스크 3 파서만 고치면 된다.
- `allow-always` 는 실물에서 허용 목록에 나온 적이 없다(claude-cli `ask: "always"` 는 `["allow-once","deny"]`). 카드는 목록대로만 그리므로 위험은 표시뿐이다.
- 서버 재기동 중 승인 대기: 메모리에 둔 `resumeTo` 가 사라져 `tool` 로 가정한다(태스크 5). 잘못 가정해도 다음 신호가 상태를 맞춘다.
