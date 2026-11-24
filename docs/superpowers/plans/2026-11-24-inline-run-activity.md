# 응답 안의 활동(추론·도구) 구현 계획

> **For agentic workers:** 두 줄(E·F)이다. 워커는 브리프가 가리킨 한 줄만 한다. 단계는 `- [ ]`.

**Goal:** 에이전트 런의 추론·도구 줄을 스트리밍 버블 안에서 실시간으로 보이고, 답이 오면 접힌 요약 줄로 남겨 응답마다 펼쳐 보게 한다.

**Architecture:** 추론은 새 런 이벤트(`REASONING_MESSAGE_*`)로 Claude 러너·OpenClaw 두 경로에서 모아 기존 `run_events` 길(코얼레싱·저장·wire 팬아웃)로 흘린다. 웹은 런 이벤트를 받아 버블과 확정 메시지(`Message.runId`)에 같은 「활동」 블록을 그린다 — 도구 줄은 활동 탭의 `toActivityRows`·`ToolCallRow` 를 다시 쓴다.

**Tech Stack:** Zod(shared), Fastify·Socket.IO(server), Claude Agent SDK 0.3.283(claude-runner), OpenClaw 2026.9.4(openclaw-adapter), React·zustand·TanStack Query(web), vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-inline-run-activity-design.md`

**순서:** E(데이터) → 병합 → F(웹). F 는 E 가 정한 이벤트 이름·모양을 쓴다.

## Global Constraints

- 이벤트 이름(스펙 「데이터」): `REASONING_MESSAGE_START { messageId }`, `REASONING_MESSAGE_CONTENT { messageId, delta: string.min(1) }`, `REASONING_MESSAGE_END { messageId }` — 기존 `ev()` 꼴, 공통 `runId`·`seq`·`ts` 는 base 그대로.
- 런 하나의 추론 저장 상한 20,000자(스펙 — 내 판단으로 적힌 값). 넘으면 그 뒤 델타는 저장·팬아웃하지 않고, 상한에 닿은 순간 `CUSTOM { name: "reasoning_truncated" }` 하나를 남긴다.
- 보이는 사람: 지금 런 이벤트를 보는 사람과 같다(`GET /api/v1/runs/:id/events` 의 기존 접근 검사). 새 권한 없음.
- 활동 탭은 바꾸지 않는다(추론 줄을 활동 탭 타임라인에 넣을지는 F 의 판단 — 넣으면 같은 컴포넌트).
- 러너 판: 이 일에서 러너가 바뀌므로 `packages/claude-runner/package.json` 을 0.12.0 으로(배포는 하지 않는다 — 코디네이터가 한다).
- 모델 런 금지 — 러너는 런 0회 하네스(가짜 Messages API)로만. OpenClaw 은 기존 스파이크·시험 픽스처로.
- 커밋 경로 명시, Conventional Commits(`feat(shared)`·`feat(runner)`·`feat(adapter)`·`feat(server)`·`feat(web)`).
- 검증: 바꾼 패키지 `pnpm -F <패키지> test`(실행 수 보고), `pnpm typecheck`·`pnpm lint`·`pnpm fmt:check`. `pnpm test` 와 typecheck 동시 금지.

## Review Focus

- **새 러너(0.12.0)가 옛 서버에 붙음** — 옛 runner-adapter 가 모르는 이벤트 타입을 받았을 때 그 이벤트만 버리고 런은 이어져야 한다(런 전체가 실패하면 안 된다). → E2 시험 또는 보고에 진단.
- **thinking 이 비거나 요약만 오는 모델** — START/END 만 오면 「생각 중…」 한 줄, 빈 델타로 계약 위반(`delta.min(1)`)을 내지 않는다. → E2.
- **추론 20,000자 초과** — 저장·팬아웃이 멈추고 표시 하나, 답 텍스트 델타는 계속 흐른다. → E3.
- **답이 바로 오는 런(추론·도구 없음)** — 버블과 메시지에 요약 줄이 없다. 지금 모양과 같다. → F1.
- **오래된 메시지 펼침에 이벤트가 없음(보존 정리·옛 런)** — 「활동 기록이 없습니다.」, 오류 토스트 없음. → F2.

---

## E. 데이터 — 추론 이벤트를 모아 저장

### Task E1: shared 이벤트

**Files:**
- Modify: `packages/shared/src/events/index.ts`
- Test: `packages/shared/test/events.test.ts`(없으면 그 패키지의 이벤트 시험 파일 이름을 보고에 적고 거기에)

- [ ] 시험: 세 이벤트가 파싱되고, `REASONING_MESSAGE_CONTENT` 의 빈 `delta` 는 거절.
- [ ] 구현 → 통과 → 커밋.

### Task E2: Claude 러너·OpenClaw 매핑

**Files:**
- Modify: `packages/claude-runner/src/drivers/claude/stream-map.ts`(`mapStream` 의 `content_block_start` type `thinking`·`content_block_delta` `thinking_delta`·`content_block_stop`), `packages/claude-runner/src/sink.ts`(새 타입 통과), `packages/claude-runner/package.json`(0.12.0)
- Modify: `packages/runner-adapter/src/runner-adapter.ts`(러너가 보내도 되는 이벤트 목록 — 254줄 근처 — 에 세 타입)
- Modify: `packages/openclaw-adapter/src/gateway/events.ts`(`mapAgent` 의 `stream === "thinking"`)
- Test: `packages/claude-runner/test/stream-map.test.ts`, `packages/claude-runner/test/sink.test.ts`, `packages/runner-adapter/test/runner-adapter.test.ts`, `packages/openclaw-adapter/test/` 안의 `events` 매퍼 시험 파일(이름을 보고에)
- 확인만: `packages/claude-runner/src/drivers/claude/run.ts`(thinking 표시 옵션 — SDK `thinkingDisplay`·`maxThinkingTokens` 를 지금 어떻게 넘기는지. 추론이 `omitted` 로 꺼져 있으면 `summarized` 로 켜는 것이 맞는지 보고하고, 켤 때는 바꾸기 전에 코디네이터에게 묻는다)

- [ ] 시험(stream-map): thinking 블록 start → `REASONING_MESSAGE_START { messageId: <블록 인덱스로 만든 id> }`, `thinking_delta` 두 번 → 델타 둘, stop → END. 빈 `thinking` 델타는 내지 않는다. `parent_tool_use_id` 가 있는 메시지(서브에이전트)는 지금처럼 버린다. `signature_delta` 는 버린다.
- [ ] 시험(runner-adapter): 세 타입을 받아 `emitEvent` 로 넘긴다. 목록 밖 타입은 지금처럼 경고하고 그 이벤트만 버린다 — 런은 이어진다(Review Focus 1: 옛 서버 쪽 동작을 지금 코드로 확인해 보고).
- [ ] 시험(OpenClaw): `stream: "thinking"` 프레임을 세 이벤트로. 프레임 모양(델타인지 누적 스냅숏인지)은 `docs/superpowers/` 의 Gateway 스파이크 문서·기존 픽스처로 확인하고, 스냅숏이면 앞 글과의 차이만 델타로 낸다. 확인 근거를 보고에.
- [ ] 구현 → 통과 → 런 0회 하네스로 thinking 블록이 든 가짜 응답을 흘려 서버 `run_events` 에 세 이벤트가 남는지 본다 → 커밋.

### Task E3: 오케스트레이터 코얼레싱·상한

**Files:**
- Modify: `apps/server/src/modules/runs/orchestrator.ts`(`Coalescable` 에 `REASONING_MESSAGE_CONTENT`, 키는 `messageId`; 런별 추론 글자 수 세기·20,000자 상한)
- Test: `apps/server/test/runs.orchestrator.test.ts`, `apps/server/test/wire.runs.test.ts`, `apps/server/test/orchestrator.runner.test.ts`

- [ ] 시험: 추론 델타 여럿이 텍스트 델타와 같은 규칙으로 합쳐져 저장·팬아웃된다. 텍스트와 추론 델타가 섞여 와도 서로의 버퍼를 끊지 않고 순서가 보존된다.
- [ ] 시험: 추론 누적이 20,000자를 넘으면 넘는 부분은 잘려 저장되고 `CUSTOM { name: "reasoning_truncated" }` 가 한 번, 뒤 추론 델타는 저장·팬아웃 없음, 답 텍스트 델타는 계속.
- [ ] 시험: `GET /api/v1/runs/:id/events` 가 추론 이벤트를 돌려준다(기존 접근 검사 그대로).
- [ ] dev:fake: `apps/server/scripts/dev-fake.ts` 의 대본이 도구를 쓰는 런에서 추론 이벤트도 낸다(F 의 화면 확인용 — 어느 키워드인지 보고에). `apps/server/test/dev-fake.test.ts` 에 한 줄.
- [ ] 구현 → 통과 → 커밋.

---

## F. 웹 — 버블과 메시지 안의 활동 (E 병합 뒤)

### Task F1: 활동 모델과 블록 컴포넌트

**Files:**
- Modify: `apps/web/src/features/activity/timeline.ts`(행 종류에 `ReasoningRow { kind: "reasoning"; key; text; state: "running" | "done"; truncated?: boolean }`, `TIMELINE_TYPES` 에 세 타입·`CUSTOM reasoning_truncated` 처리, 요약 함수 `summarizeActivity(rows): { reasoning: boolean; tools: number; durationMs?: number }`)
- Create: `apps/web/src/features/activity/InlineActivity.tsx`(`InlineActivity({ rows, live, defaultOpen, onToggle? })` — 요약 줄 단추 + 펼친 줄들, 도구 줄은 `ToolCallRow` 재사용)
- Test: `apps/web/src/features/activity/timeline.test.ts`, `apps/web/src/features/activity/InlineActivity.test.tsx`(새)

- [ ] 시험(timeline): START·CONTENT×2·END → `ReasoningRow` 하나(text 합침, state done), 도구와 섞이면 시간 순. 잘림 표시면 `truncated`.
- [ ] 시험(InlineActivity): 요약 줄 글은 `활동 · 추론 · 도구 4 · 12초` 꼴(추론 없으면 「추론」 빠짐, 시간 모르면 빠짐). 행이 없으면 아무것도 그리지 않는다. 접힌 상태는 `aria-expanded=false`, 펼치면 추론 전체(흐린 글, 마크다운 해석 없음)와 도구 줄. 잘림이면 「추론이 길어 일부만 남겼습니다」.
- [ ] 구현 → 통과 → 커밋.

### Task F2: 버블·메시지에 붙이기

**Files:**
- Modify: `apps/web/src/features/runs/runStore.ts`(`RunView` 에 활동 행 — 또는 `useLiveRunEvents` 를 버블에서 재사용, 둘 중 하나를 고른 이유를 보고), `apps/web/src/features/runs/StreamingBubble.tsx`, `apps/web/src/features/messages/MessageItem.tsx`(에이전트 메시지에 `runId` 가 있으면 `InlineActivity`)
- Create(필요하면): `apps/web/src/features/activity/useRunActivity.ts`(`useRunActivity(runId, { enabled })` — 런 스토어에 있으면 그것, 없으면 펼칠 때 `GET /runs/:id/events`)
- Test: `apps/web/src/features/runs/StreamingBubble.test.tsx`, `apps/web/src/features/runs/runStore.test.ts`, `apps/web/src/features/messages/MessageList.test.tsx`, `apps/web/src/features/activity/useLiveRunEvents.test.tsx`
- Docs: `docs/manual/user-guide.md`(「활동 탭」 절 앞에 「응답 안의 활동」)

- [ ] 시험(버블): 도구 이벤트가 오면 버블에 펼친 활동 블록, 진행 중 도구 줄에 진행 표시. 첫 텍스트 델타가 오면 접힌다. 사람이 그 전에 접었다 펼쳤으면 그대로 둔다. 추론·도구 없는 런은 블록 없음.
- [ ] 시험(메시지): `runId` 있는 에이전트 메시지는 요약 줄 「활동」만(미리 받지 않음 — 네트워크 호출 0). 펼치면 `GET /api/v1/runs/<id>/events` 한 번, 받은 뒤 요약 줄에 수. 빈 응답이면 「활동 기록이 없습니다.」, 실패면 그 자리에 「활동을 불러오지 못했습니다」+「다시 시도」(전역 토스트 없음). 그 탭에서 막 끝난 런(런 스토어에 이벤트 있음)은 호출 없이 수가 바로 보인다.
- [ ] 시험: 스레드 패널의 에이전트 답글에도 같다.
- [ ] 구현 → 통과 → 화면 확인(dev:fake 대본으로 도구 쓰는 런 — `docs/guides/browser-verification.md`, 워크트리 전용 포트, 넓은·좁은 화면 스크린숏) → user-guide → 커밋.
