# Phase 1 ② 웹 MVP 설계

- 날짜: 2026-09-19 · 상태: **구현 완료**(계획 `2026-09-19-web-mvp.md` 태스크 0~14, 2026-09-20) — 구현과 다르게 확정된 곳은 각 절에 「구현과 맞춘 것(2026-09-20)」으로 적었다(5.2·5.5·6.5·8장·9.2)
- 선행: Phase 1 ① 서버 코어(`2026-09-15-server-core-design.md`, main 26ce3bc) + 실연 잔여 정리(워커 `sv-residual`)
- 근거 문서: 계획서 2.1(기능 요구)·5.5(스트리밍)·7장(스택)·8장 Phase 1, 계약 스펙 `2026-09-14-shared-contracts-design.md` 5장(런)·7장(wire), 구성 가이드 2.5, `docs/guides/live-smoke.md`, `docs/guides/browser-verification.md`

## 0. 결정 요약

| 항목 | 결정 | 출처 |
| --- | --- | --- |
| 범위 | 계획서 Phase 1 그대로 — 로그인, 채널 목록·생성, 메시지 목록·전송, @멘션 작성기, 마크다운 렌더, 스트리밍 버블, 중지, 에이전트 등록·채널 추가, 채널 프롬프트·릴레이 정책 편집, 「새 대화」 | 사용자 2026-09-19 |
| 순서 | 서버 실연 잔여 4건을 웹 착수 전에 정리(`sv-residual`) | 사용자 |
| 데이터 흐름 | **A** — 서버 상태는 TanStack Query 캐시가 진실, wire 이벤트가 캐시를 패치. 스트리밍 런만 Zustand 런 스토어 | 사용자 |
| 디자인 | 메신저 관습(3단 레이아웃) + 절제된 커스텀(중립 회색 + 강조색 1, 에이전트 표식) | 사용자 |
| 검증 | 워커가 Playwright 로 스크린샷·콘솔·WebSocket 프레임 확인. E2E 테스트 파일은 남기지 않는다 | 사용자 |
| wire 인증 | 브라우저는 세션 토큰을 보관하지 않는다 — 서버가 wire 핸드셰이크에서 같은 출처 쿠키를 받는다(9.1) | 조율자, 1~3절 승인 |
| components | Phase 1 은 `actions` 블록의 **버튼만** 렌더(「이어가기」가 릴레이 흐름의 일부). 셀렉트·모달·미디어는 자리표시 | 1~3절 승인 |
| 개발 모드 | 가짜 에이전트 모드 `dev:fake`(9.2) — 모델 런 없이 웹 전체를 돌린다 | 4~6절 승인 |

## 1. 범위

**포함**: 2장~8장의 화면·동작, 9장의 서버 선행 작업 두 개, 10장의 검증.

**제외(Phase 2 이후)**: components 렌더러의 셀렉트·모달·미디어·파일, 활동 패널(런 타임라인·툴 카드), 승인 카드(`approval.*`), 이미지 첨부·업로드, PWA 설치·오프라인 캐시·푸시, 스레드, 검색, 메시지 수정·삭제, 다중 사용자(초대·권한), 모바일 전용 레이아웃(좁은 화면에서 사이드바가 시트로 접히는 것까지만 한다).

## 2. 구조

### 2.1 패키지

`apps/web`, 이름 `@dodok/web`, `private: true`, `type: module`. 의존성은 전부 **정확 핀**(계획서 작성 때 npm 최신 안정판으로 고정, `^`·`~` 금지). pnpm 11 최소 배포 경과 보호에 걸리면 `pnpm-workspace.yaml` `minimumReleaseAgeExclude` 에 그 버전을 더한다(서버 코어와 같은 방식).

| 용도 | 패키지 |
| --- | --- |
| 빌드 | `vite`, `@vitejs/plugin-react`, `typescript`(루트와 같은 5.9.3) |
| UI | `react`·`react-dom` 19, `tailwindcss` 4(`@tailwindcss/vite`), shadcn/ui(복사-소유 — Radix 프리미티브 의존), `lucide-react`, `sonner`(토스트) |
| 라우팅·서버 상태 | `@tanstack/react-router`(코드 기반 라우트 — 파일 라우팅 생성기 없음), `@tanstack/react-query` |
| 클라이언트 상태 | `zustand`(런 스토어만) |
| 실시간 | `socket.io-client` 4.8.3(서버와 같은 버전) |
| 렌더 | `streamdown` (코드 하이라이트는 별도 `@streamdown/code` 플러그인 — 넣지 않았다, 5.2) |
| 작성기 | `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-mention`, `@tiptap/suggestion` |
| 목록 | `@tanstack/react-virtual` |
| 계약 | `@dodok/shared`(workspace) — 타입·Zod·`MENTION_TOKEN_RE`·`WIRE_PROTOCOL` |
| 테스트 | `vitest`(루트와 같은 4.1.11), `@testing-library/react`, `@testing-library/user-event`, `jsdom` |

스크립트: `dev`(vite), `build`(tsc -b && vite build), `test`(vitest run), `typecheck`(tsc). 루트 turbo 파이프라인에 그대로 합류한다. `shared` 는 Node 전용 API 가 없으므로 번들에 들어간다(불변 규칙).

### 2.2 폴더

```
apps/web/src/
├─ main.tsx                  QueryClient·Router·WireProvider·Toaster
├─ app/                      router.tsx(라우트 트리·가드), layout/(AppShell·Sidebar·ChannelHeader·RightPanel)
├─ api/                      http.ts(fetch 래퍼·ApiError), queries.ts(쿼리 키·useQuery 훅), mutations.ts
├─ realtime/                 wire.ts(소켓 생성·연결 상태), subscriptions.ts(채널 구독 관리자), handlers.ts(서버 이벤트 → 캐시·스토어)
├─ features/
│  ├─ auth/                  LoginPage, useSession
│  ├─ channels/              ChannelList, CreateChannelDialog
│  ├─ messages/              timeline.ts(병합 순수 함수), MessageList(가상), MessageItem, SystemCard, ActionButtons, MentionChip
│  ├─ runs/                  runStore.ts, StreamingBubble
│  ├─ composer/              Composer(Tiptap), mentionSuggestion, serialize.ts, slashCommands.ts
│  ├─ agents/                AgentsPage, DiscoverDialog, AgentForm
│  └─ settings/              ChannelSettingsPanel, MembersSection, PromptSection, RelayPolicySection
├─ ui/                       shadcn 컴포넌트(복사본)
└─ theme/                    tokens.css, agentColor.ts
```

한 파일에 책임 하나. `timeline.ts`·`runStore.ts`·`serialize.ts`·`agentColor.ts` 는 React 없이 테스트한다.

위 트리는 설계 시점의 계획이다 — **실물 트리·파일명은 구성 가이드 2.5**(2026-09-20 갱신)에 있다.

### 2.3 라우트

| 경로 | 화면 | 가드 |
| --- | --- | --- |
| `/login` | 로컬 토큰 입력 | 이미 로그인이면 `/` |
| `/` | 첫 채널로 이동, 채널이 없으면 빈 상태(「채널 만들기」) | 로그인 |
| `/c/$channelId` | 채널 | 로그인 |
| `/c/$channelId/settings` | 채널 + 오른쪽 설정 패널 | 로그인 |
| `/agents` | 에이전트 관리 | 로그인 |

로그인 가드는 `GET /api/v1/auth/me` 쿼리 결과로 판정한다(401 → `/login?next=<원래 경로>`).

### 2.4 레이아웃

- **왼쪽 사이드바**(약 260px): 워크스페이스 이름, 채널 목록(선택 강조), 「채널 만들기」, 「에이전트」 링크, 하단 연결 상태 점 두 개(Gateway·플러그인, 7장).
- **가운데**: 채널 헤더(이름·주제·참여 에이전트 아바타 묶음·설정 버튼) → 메시지 목록 → 작성 중 표시 → 작성기.
- **오른쪽 패널**: `/c/$channelId/settings` 에서만 열린다(약 360px). Phase 2 의 활동 패널이 같은 자리를 쓴다.
- 폭이 768px 미만이면 사이드바는 시트로 접히고 오른쪽 패널은 전체 화면 시트가 된다.

### 2.5 개발 서버·출처

Vite(5173)가 `/api` 와 `/socket.io`(ws 포함)를 서버(`PORT`, 기본 3000)로 프록시한다. 브라우저에게 웹과 API 는 **같은 출처**다 — 서버 REST 에 CORS 가 없어도 되고, 세션 쿠키(`dodok.session`, httpOnly·SameSite=Lax)가 그대로 붙는다. 서버 `.env` 의 `APP_ORIGIN=http://localhost:5173`. 배포(Phase 3)는 Caddy 가 같은 구조로 정적 파일과 프록시를 맡는다.

## 3. 인증

1. `/login` 에서 로컬 토큰을 넣으면 `POST /api/v1/auth/local { token }` → 서버가 httpOnly 쿠키를 굽는다. 응답 본문의 `sessionToken` 은 **쓰지도 보관하지도 않는다**.
2. 성공하면 `auth/me` 캐시를 무효화하고 `next` 로 이동한다. 실패 코드: 401 → 「토큰이 맞지 않습니다」, 429 → 「잠시 뒤 다시 시도하세요(1분 5회)」.
3. wire 는 쿠키로 인증한다(9.1). 소켓은 로그인 확인 뒤에만 연결한다.
4. 로그아웃: `POST /api/v1/auth/logout` → 소켓 끊기 → Query 캐시·런 스토어 비우기 → `/login`.
5. REST 401 이나 wire `connect_error { code: "UNAUTHORIZED" }` 는 같은 처리(4번)로 로그인 화면에 보낸다.

## 4. 데이터 계층

### 4.1 Query 캐시

| 키 | 출처 | wire 로 패치 |
| --- | --- | --- |
| `["me"]` | `GET /auth/me` | — |
| `["channels"]` | `GET /channels` | `channel.updated`(항목 교체) |
| `["channel", id]` | `GET /channels/:id` | `channel.updated` |
| `["members", channelId]` | `GET /channels/:id/members` | `channel.member.changed`(통째 교체) |
| `["agents"]` | `GET /agents` | — (변경은 이 화면의 mutation 응답으로) |
| `["agents", "discover"]` | `GET /agents/discover` | — (다이얼로그를 열 때만, `staleTime 0`) |
| `["adapter"]` | `GET /adapter/status` | `adapter.status` |
| `["timeline", channelId]` | 4.3 | `message.created`·`message.updated` |

mutation 은 응답 본문으로 해당 캐시를 직접 갱신한다(다시 불러오지 않는다). 작성자 표시(이름·아바타·에이전트 여부)는 `["agents"]` 와 `["me"]` 로 푼다 — MVP 사용자는 owner 한 명이다.

### 4.2 wire 연결

- `io({ path: "/socket.io", transports: ["websocket"], withCredentials: true, auth: { protocol: WIRE_PROTOCOL } })` — 토큰은 싣지 않는다(9.1).
- 연결 상태 `connecting | connected | reconnecting | offline` 을 작은 Zustand 슬라이스(또는 `useSyncExternalStore`)로 노출한다. socket.io 기본 자동 재연결을 쓴다.
- `connect_error.data.code`: `UNAUTHORIZED` → 3.5, `PROTOCOL_MISMATCH` → 재연결을 멈추고 「앱을 새로고침하세요」 배너, 그 밖 → 재연결 계속.
- **재연결되면** 구독 관리자가 구독 중인 채널을 각자의 `lastSeq` 로 다시 `channel.subscribe` 한다(4.3 규칙 4).

### 4.3 채널 타임라인(`timeline.ts`)

캐시 값: `{ items: TimelineItem[], hasOlder: boolean, lastSeq: number }`. `TimelineItem = Message & { local?: { state: "sending" | "failed" } }`. 병합 규칙은 **순수 함수**로 두고 단위 테스트한다.

1. **입장**: `channel.subscribe { channelId }`(lastSeq 없음) → 서버는 최근 200개와 `hasMore`(더 옛것이 있다)를 준다 → `items = messages`, `hasOlder = hasMore`, `activeRuns` 는 런 스토어로(4.5).
2. **과거**: 목록 맨 위에 닿으면 `GET /channels/:id/messages?beforeSeq=<가장 옛 seq>&limit=50` → 앞에 붙이고 `hasOlder` 갱신.
3. **새 메시지**: `message.created`·`message.updated` → `upsert(items, message)` — id 가 같으면 교체, `clientMsgId` 가 같은 로컬 항목이 있으면 그 자리를 교체, 아니면 seq 순서 자리에 넣는다. `lastSeq = max(확정 seq)`.
4. **빈틈**: 받은 `message.created.seq > lastSeq + 1` 이거나 재연결 뒤면 `channel.subscribe { channelId, lastSeq }` → 서버는 `lastSeq` 이후를 오래된 순으로 최대 200개와 `hasMore`(더 새것이 있다)를 준다 → 병합. `hasMore` 면 `GET …/messages?afterSeq=` 로 이어 받되 5쪽(1,000개)을 넘으면 타임라인을 버리고 1번부터 다시 한다.
5. **나갈 때**: 다른 채널로 이동하면 `channel.unsubscribe`. 캐시는 남겨 되돌아올 때 즉시 보여 주고, 다시 구독할 때 4번(lastSeq)으로 맞춘다.
6. 로컬 항목(보내는 중·실패)은 항상 확정 메시지보다 뒤(목록 끝)에 둔다.

### 4.4 전송

1. 작성기가 `bodyMd`(토큰 본문, 5.1)를 만들면 `clientMsgId = crypto.randomUUID()` 로 로컬 항목(`sending`)을 넣는다.
2. `message.send { channelId, clientMsgId, bodyMd }` — ack `{ message }` 면 3번 규칙으로 확정(같은 메시지가 `message.created` 로도 오지만 id·clientMsgId 로 한 번만 남는다).
3. ack 오류·10초 무응답이면 `failed` — 항목에 「다시 보내기」(같은 clientMsgId 로 재전송, 서버 멱등)와 「삭제」(로컬만).
4. 연결이 `offline`·`reconnecting` 이면 작성기는 입력은 받되 전송 버튼을 막고 「연결되면 보낼 수 있습니다」를 보인다(오프라인 큐는 Phase 2 PWA).

### 4.5 런 스토어(`runStore.ts`, Zustand)

런마다 `{ state: RunState, text: string, lastEventSeq: number }`, 채널별 진행 중 런 id 목록.

| 입력 | 처리 |
| --- | --- |
| subscribe ack `activeRuns` | 상태를 넣고, `streaming`·`tool`·`finalizing` 인 런은 `run.events.replay { runId, afterSeq: 0 }` 로 텍스트를 다시 쌓는다 |
| `run.state` | 상태 교체. `resync: true` 면 `run.events.replay { afterSeq: lastEventSeq }` |
| `run.event` `TEXT_MESSAGE_CONTENT` | `event.seq > lastEventSeq` 일 때만 `text += delta`(재생과 실시간이 겹쳐도 한 번) |
| `run.event` 그 밖 | `lastEventSeq` 만 올린다(툴·스냅샷 표시는 Phase 2) |
| 종료 상태(`done`·`error`·`aborted`) | 4.6 규칙으로 버블을 정리한 뒤 항목 삭제 |

### 4.6 스트리밍 버블

진행 중 런마다 타임라인 끝(로컬 항목 앞)에 버블 하나. 에이전트 아바타·이름·색(7.2), 본문은 런 텍스트를 5.2 렌더러로.

| 런 상태 | 버블 |
| --- | --- |
| `queued` | 「대기 중」 점 애니메이션 · 중지 버튼 |
| `streaming` | 누적 텍스트 + 커서 · 중지 버튼 |
| `tool` | 누적 텍스트 + 「도구 사용 중」 · 중지 버튼 |
| `awaiting_approval` | 「승인 대기 — Phase 2 에서 지원」 · 중지 버튼 |
| `finalizing` | 누적 텍스트, 중지 버튼 숨김 |
| `done` | 타임라인에 같은 `runId` 의 에이전트 메시지가 있으면 버블을 곧바로 내린다. 없으면 그 메시지가 올 때까지(최대 5초) 유지하고, 그래도 없으면 내린다(빈 답) |
| `error` | 「실행 실패: <code>」 한 줄, 3초 뒤 내림(서버가 run_error 시스템 메시지를 따로 보낸다) |
| `aborted` | 「중지됨」 한 줄, 3초 뒤 내림 |

중지 버튼 → `run.abort { runId }`. ack 오류는 토스트. 누른 뒤 상태가 바뀔 때까지 버튼은 「중지 중」으로 잠근다.

### 4.7 작성 중 표시

작성기 입력이 바뀌면 3초에 한 번 `typing { channelId }`. 받은 `typing` 은 채널별로 (actorType, actorId) → 만료 5초 맵에 넣고, 작성기 위에 「@dev 작성 중…」(여럿이면 「@dev, @fin 작성 중…」)을 보인다. 자기 자신 것은 숨긴다.

## 5. 작성기와 렌더

### 5.1 작성기(Tiptap)

- 확장: StarterKit(굵게·기울임·코드·코드 블록·목록만 — 제목·표·이미지 끔), Mention, placeholder.
- `@` 를 치면 후보 목록: 채널의 에이전트 멤버(핸들·이름·「AI」 배지, `enabled` 가 false 면 흐리게 + 「꺼짐」)와 사람(MVP 는 owner). 별칭(`aliases`)으로도 찾는다.
- 전송 직렬화(`serialize.ts`): 문서를 마크다운으로 바꾸고 멘션 노드를 `<@a:<agentId>>` / `<@u:<userId>>` 로 쓴다 — shared `MENTION_TOKEN_RE` 가 받는 형식. 결과를 `bodyMd` 로 보낸다(서버가 다시 검증·파싱한다).
- 키: Enter 전송, Shift+Enter 줄바꿈, IME 조합 중 Enter 는 전송하지 않는다(한글 입력), ↑ 는 후보 목록이 열려 있을 때만 목록 이동.
- 슬래시 커맨드(문서 맨 앞에서만): `/stop` → 이 채널의 진행 중 런 전부 `run.abort`(없으면 「진행 중인 실행이 없습니다」), `/new @에이전트` → 6.4 「새 대화」와 같은 확인 대화상자. 둘 다 메시지로 보내지 않는다.
- 붙여넣기: 텍스트만. 이미지는 무시하고 「이미지는 Phase 2 에서 지원」 토스트.

### 5.2 렌더

- 본문은 Streamdown(원시 HTML 끔). 렌더 전에 멘션 토큰을 자리표시로 바꾸고, 렌더된 트리에서 그 자리에 `MentionChip`(@핸들, 에이전트면 에이전트 색 점)을 끼운다. 모르는 id 는 「@알 수 없음」.
- 스트리밍 버블도 같은 렌더러를 쓴다(Streamdown 이 미완성 마크다운을 처리한다).
- 링크는 새 탭(`rel="noopener noreferrer"`).
- **마크다운 이미지는 불러오지 않는다** — 「이미지: <alt 또는 주소>」 새 탭 링크로 바꾼다(외부 주소를 자동으로 받으면 추적 픽셀이 된다). 이미지·첨부 표시는 Phase 2.
- 문단 안 단일 개행은 줄바꿈(`<br>`)으로 보인다 — 메신저 관습(작성기 Shift+Enter·에이전트 답). 코드 블록·인라인 코드는 그대로.

**구현과 맞춘 것(2026-09-20)**: 코드 하이라이트(shiki)는 **Phase 2** 로 미뤘다 — Streamdown 2.6 은 하이라이트를 `@streamdown/code` 플러그인으로 분리했고 이 MVP 의 의존성 목록에 없다(의존성은 태스크 2 에서만 넣는다).
MVP 코드 블록은 틀·복사 버튼까지다. 한국어 강조(`**"인용"**은` 처럼 CJK·구두점이 붙은 강조)와 CJK 구두점 경계도 같은 이유로 Phase 2 의 `@streamdown/cjk` 후보다 — 작성기에서는 굵게 보이는데 보낸 뒤 평문이라 WYSIWYG 이 어긋난다(계획서 8장 「이월」).

### 5.3 메시지 종류

| 종류 | 모양 |
| --- | --- |
| 사람·에이전트(`kind: normal`) | 아바타·이름·시간·본문. 에이전트는 이름 옆 「AI」 배지 + 아바타 테두리 에이전트 색. 같은 작성자의 5분 안 연속 메시지는 머리(아바타·이름)를 생략 |
| 시스템(`kind: system`) | 가운데 정렬 얇은 카드. `systemMeta.kind` 별 아이콘·색: `relay_limit`(주의), `relay_denied`(주의), `run_error`(오류), `info`(정보) |
| components 가 있는 메시지 | 5.4 |
| 로컬 항목 | 본문을 흐리게, `sending` 은 작은 스피너, `failed` 는 「다시 보내기 · 삭제」 |

### 5.4 components — 버튼만

- `components.blocks` 중 `actions` 블록의 `button` 아이템만 버튼으로 그린다(`style` → shadcn variant, 링크 버튼은 새 탭). 그 밖의 블록·아이템은 「이 메시지의 입력 요소는 Phase 2 에서 지원합니다」 한 줄.
- 누르면 `component.interact { messageId, componentId, blockId?, itemId, values: {} }`. 성공하면 서버의 `message.updated`(소비 상태)로 버튼이 바뀐다. 오류 코드별 토스트: `EXPIRED` 「만료된 버튼입니다」, `CONSUMED` 「이미 처리된 버튼입니다」, `FORBIDDEN` 「이 버튼을 누를 권한이 없습니다」, `VALIDATION` 「처리할 수 없는 요청입니다」.
- `componentState.consumed` 에 든 아이템과 `expiresAt` 이 지난 메시지의 버튼은 비활성으로 그린다.

### 5.5 메시지 목록

TanStack Virtual 로 가변 높이 가상 목록. 맨 아래에 붙어 있을 때(하단에서 80px 이내)만 새 항목에 자동 스크롤하고, 아니면 「새 메시지 N개 ↓」 칩을 띄운다. 과거를 앞에 붙일 때 스크롤 위치를 유지한다. 날짜가 바뀌는 자리에 날짜 구분선.

**구현과 맞춘 것(2026-09-20)**: 위 규칙에 셋을 더한다.

- **내가 보낸 메시지는 항상 끝으로 간다** — 위를 보고 있었어도 보내는 순간 끝에 붙는다(메신저 관습). 그래서 「새 메시지」 칩은 **남이 보낸 것만 센다**(내 사용자 메시지는 세지 않는다).
- **채널을 열면 최신이 보인다** — 첫 진입은 총 높이가 잦아들 때까지 프레임마다 끝에 다시 붙인다(행이 추정 높이로 먼저 잡혔다가 재어지면서 한 번 겨눈 것이 풀린다). 사용자가 휠·터치·키·포인터로 스크롤을 잡으면 그 자리에서 멈춘다 — 스스로 올린 사람을 끌어내리지 않는다.
- 끝에 붙은 채 마지막 행의 정체(key)가 바뀌는 교체(스트리밍 버블 → 확정 메시지, 보내는 중 → 확정)에서도 끝을 다시 겨눈다.

## 6. 설정 화면

### 6.1 에이전트 관리(`/agents`)

- 목록: 핸들·이름·OpenClaw id(`providerAgentId`)·사용 여부 토글·기본 프롬프트 편집(`PATCH /agents/:id`).
- 「Gateway 에서 가져오기」: `GET /agents/discover`(응답 `{ agents: [{ providerAgentId, name? }] }`) 중 아직 등록되지 않은 것(같은 `providerAgentId` 가 없는 것)을 체크 목록으로 → 항목마다 핸들·이름을 확인해 `POST /agents`. 핸들 기본값은 OpenClaw id 를 핸들 규칙(`^[a-z0-9_-]{2,32}$`)에 맞게 정리한 것(소문자화, 그 밖 글자는 `-`, 32자 자르기). discover 가 503(`ADAPTER_UNAVAILABLE` — Gateway 끊김)·403(`FORBIDDEN` — `agents.list` 권한 없음)이면 「직접 입력」 폼(OpenClaw id·핸들·이름)으로 안내.
- 핸들 중복 409 는 폼 안 오류.

### 6.2 채널 만들기

사이드바 「채널 만들기」 → 이름(필수)·주제 → `POST /channels` → `["channels"]` 에 넣고 `/c/<id>/settings` 로 이동(곧바로 에이전트를 넣을 수 있게).

### 6.3 채널 설정 패널

- **기본**: 이름·주제(`PATCH /channels/:id`).
- **채널 프롬프트**: 여러 줄 입력(최대 20,000자, 남은 글자 수). 저장하면 「다음 턴부터 반영됩니다. 이미 진행 중인 대화에 온전히 반영하려면 에이전트별 「새 대화」를 누르세요」 안내(ADR 0003 결론).
- **릴레이 정책**: 턴 상한(0~32 숫자), 일일 런 상한(비우면 없음), 허용 쌍 — 「모든 에이전트끼리 허용」 토글, 끄면 채널 에이전트 from→to 체크 목록(최대 64쌍, 자기 자신 제외).
- 저장은 섹션별 버튼. 서버 응답의 채널로 캐시를 바꾼다.

### 6.4 멤버

- 에이전트 추가: 등록됐고 아직 멤버가 아닌 에이전트 선택 → `POST /channels/:id/members { memberType: "agent", memberId }`. 등록된 에이전트가 없으면 `/agents` 로 안내.
- 에이전트 행: 이름·핸들·자동 응답 토글·채널 오버라이드 프롬프트(펼침 편집, `PATCH …/members/:memberId`)·「새 대화」·제거(`DELETE`, 확인 대화상자).
- 자동 응답은 채널당 하나다. 서버는 둘 이상을 막지 않고 경고 로그만 남기며 라우터는 가장 먼저 합류한 하나만 쓴다 — 그래서 **웹이 하나를 보장한다**: 다른 에이전트가 켜져 있으면 확인(「@fin 의 자동 응답을 끄고 @dev 를 켭니다」) 뒤 그쪽을 먼저 끄고(`PATCH autoRespond: false`) 이쪽을 켠다.
- **「새 대화」**: 확인 대화상자(「@dev 와의 대화 기록을 새로 시작합니다. 진행 중인 실행은 중지됩니다」) → `POST /channels/:id/agents/:agentId/reset`. 200 이면 서버가 info 시스템 메시지를 보낸다. 409 `ADAPTER_CAPABILITY_MISSING` → 「Gateway 권한(operator.admin)이 없어 새 대화를 시작할 수 없습니다」, 503 → 「Gateway 에 연결되지 않았습니다」.

### 6.5 연결 상태

- 사이드바 하단 점 두 개: Gateway(`connected` 초록 · `reconnecting` 노랑 · `down` 빨강), 플러그인(`connected` · `down`). 마우스를 올리면 설명.
- Gateway 나 플러그인이 끊기면 메시지 영역 위 배너: 「OpenClaw 에 연결되지 않아 에이전트가 답하지 못합니다. 메시지는 저장됩니다.」
- wire 자체가 끊기면(4.2) 가장 위 얇은 배너 「서버에 다시 연결하는 중…」. 연결 문제 배너 둘은 동시에 보일 수 있다.

**구현과 맞춘 것(2026-09-20)**: wire 상태에 `rejected` 를 더한다 — wire 가 `UNAUTHORIZED` 인데 REST 세션은 살아 있는 경우(8장)다. 재연결을 멈추고 배너
「실시간 연결이 거부되었습니다 — 주소(localhost:5173)를 확인하세요」를 띄운다. 또한 **Gateway·플러그인 점과 어댑터 배너는 wire 가 `connected` 일 때만 값을 믿는다** —
끊기면 `adapter.status` 가 더는 오지 않아 마지막 값이 남으므로, 점은 회색 「알 수 없음」으로 두고 어댑터 배너는 띄우지 않는다(사정은 끊김 배너가 이미 알린다). 틀린 초록보다 「상태 모름」이 낫다.

## 7. 디자인

### 7.1 관습

Slack·Discord 의 3단 구성과 밀도를 따른다: 사이드바 약 260px, 메시지 행 좌우 여백 16px, 아바타 36px, 본문 15px/행간 1.5, 코드 13px. 라이트·다크는 `prefers-color-scheme` 를 따르고 수동 전환은 두지 않는다(Phase 3).

### 7.2 커스텀(절제)

- 토큰(`theme/tokens.css`): shadcn CSS 변수 위에 중립 회색 램프 + **강조색 하나**(링크·선택·주요 버튼). 배경은 흰색/거의 검정이 아니라 한 단계 누그러진 회색.
- **에이전트 표식**: 이름 옆 작은 「AI」 배지(외곽선), 아바타 테두리 2px 에 에이전트 색. 에이전트 색은 `agentColor(handle)` — 핸들 해시로 8색 팔레트 중 하나(라이트·다크 각각 대비 확인). 사람은 테두리 없음.
- 스트리밍 버블: 에이전트 색 왼쪽 막대 + 상태 문구(4.6). 애니메이션은 커서 깜빡임과 대기 점 셋뿐이고 `prefers-reduced-motion` 이면 끈다.
- 시스템 카드: 배경 없는 얇은 테두리, 아이콘 + 한 줄.
- 글꼴: 시스템 한글 스택(`-apple-system, "Apple SD Gothic Neo", "Pretendard Variable", "Noto Sans KR", sans-serif`), 코드는 시스템 모노. 웹폰트는 번들하지 않는다.
- 테마 태스크 워커는 frontend-design 스킬을 참고해 위 제약 안에서 팔레트·간격을 정하고 스크린샷을 남긴다.

### 7.3 접근성

키보드만으로 채널 이동·전송·버튼·대화상자 조작이 된다(Radix 기본). 아이콘 버튼에 `aria-label`. 새 메시지 알림은 `aria-live="polite"` 영역에 요약만.

## 8. 오류 처리

| 원인 | 화면 |
| --- | --- |
| REST 401 · wire `UNAUTHORIZED` | 3.5 → 로그인 |
| REST 401 (Query 밖 직접 호출 — 과거 페이지·빈틈 이어 받기) | 토스트 없이 로그인으로. 오류는 부른 쪽이 화면에서 처리한다 |
| wire `UNAUTHORIZED` 인데 REST 세션은 살아 있음 | 재연결을 멈추고 `rejected` 배너(6.5) — Origin ≠ `APP_ORIGIN`·오설정에서 로그인↔앱 무한 이동을 막는다 |
| REST 그 밖 오류(`{ code, message }`) | 토스트(서버 message). 폼 입력 오류(`VALIDATION`·`CONFLICT`)는 폼 안 |
| REST 네트워크 실패 | Query 기본 재시도 2회 후 토스트 「서버에 연결할 수 없습니다」 |
| wire 끊김 | 상단 배너(6.5), 재연결 뒤 구독 복구(4.3-4)되면 내림. 어댑터 배너·연결 점은 이 동안 「상태 모름」(6.5) |
| wire `PROTOCOL_MISMATCH` | 재연결 중단, 「앱을 새로고침하세요」 배너 + 새로고침 버튼 |
| 전송 ack 실패 | 해당 로컬 항목 `failed`(4.4) |
| `run.abort`·`component.interact` ack 실패 | 토스트(5.4 코드표) |
| `system.notice` | 수준별 토스트(info 4초 · warn 6초 · error 유지) |
| 런 `error`·`aborted` | 버블(4.6). 시스템 메시지는 서버가 따로 |
| 렌더 예외 | 메시지 단위 에러 경계 — 그 메시지만 「표시할 수 없는 메시지」, 앱은 계속 |

## 9. 서버 선행 작업

### 9.1 wire 쿠키 인증

- `attachWire` 인증 미들웨어: `handshake.auth.token` 이 없으면 핸드셰이크 쿠키 헤더에서 `dodok.session` 을 읽어 `verifySessionToken` 에 넣는다. 토큰이 있으면 지금처럼 토큰을 쓴다(wire-cli·테스트 호환).
- **쿠키 경로는 핸드셰이크 `Origin` 이 `APP_ORIGIN` 과 같을 때만** 받는다 — 다른 출처 페이지가 사용자의 쿠키로 소켓을 여는 것(CSWSH)을 막는다. 다르면 `UNAUTHORIZED`.
- 테스트: 쿠키만으로 연결 성공 · Origin 불일치 거부 · 토큰 우선 · 잘못된 쿠키 거부.

### 9.2 가짜 에이전트 개발 모드(`dev:fake`)

- `pnpm -F @dodok/server dev:fake` — 서버 코어 태스크 13 의 가짜 Gateway·가짜 플러그인·시나리오를 개발 스크립트로 묶는다. 순서: 가짜 Gateway 기동 → 서버 `createApp`(실제 `OpenClawAdapter`, `OPENCLAW_TARGET=dev` 를 가짜 Gateway 로) → listen → 가짜 플러그인 접속 → 로그 한 줄.
  **구현과 맞춘 것(2026-09-20)**: `.env` 를 아예 읽지 않고 토큰·비밀을 **개발 전용 고정값**으로 둔다 — 로그인 토큰은 `dev-fake-local-token` 이고 시크릿이 아니므로 **로그에 값을 찍는다**.
  워커가 `.env` 를 읽지 않고도 로그인해 검증할 수 있게 한 결정이다(계획 Self-Review).
- DB 는 `data/dev-fake.sqlite`(시작할 때마다 새로 — 옵션 `--keep` 이면 유지). 에이전트 `dev`·`fin` 을 Gateway `agents.list` 에 싣는다(등록은 웹의 「Gateway 에서 가져오기」로 — 그 흐름도 검증 대상).
- 대본: 받은 글을 요약해 되받는 답을 3~6개 델타로 나눠 150ms 간격으로 흘린다. 본문에 「@<다른 에이전트>」 를 넣어 보내면 답에도 그 멘션을 싣어 릴레이가 일어나게 한다. 「느리게」가 들어 있으면 델타 간격 1.5s(중지 버튼 검증용). 「실패」가 들어 있으면 `chatError`, 「드롭」이면 `drop: "bot-loop-protection"`. 「도구」면 가짜 툴 이벤트 1개.
- 하네스 파일은 `apps/server/test/fakes/` 에 그대로 두고 스크립트가 가져다 쓴다(테스트와 개발 모드가 같은 가짜를 쓴다). 스크립트 자리는 `apps/server/scripts/dev-fake.ts`.
- 운영 코드(`src/`)는 바꾸지 않는다.

## 10. 테스트와 검증

### 10.1 단위(Vitest, jsdom)

- `timeline.ts`: 입장·과거 페이지·upsert·낙관적 교체·빈틈 감지·재구독 병합·5쪽 초과 리셋.
- `runStore.ts`: activeRuns 초기화·재생과 실시간 델타 중복 제거(`lastEventSeq`)·resync·종료 정리.
- `serialize.ts`: 멘션 노드 → 토큰, 코드 블록 안 `@` 는 멘션이 아님, IME 조합 Enter.
- 렌더: 멘션 칩·시스템 카드·버튼 비활성(consumed·만료)·로컬 항목 상태.
- 라우트 가드(401 → `/login?next=`), 설정 폼(릴레이 정책 검증, 409 표시).
- wire 핸들러는 가짜 소켓(이벤트 이미터)으로 캐시·스토어 반영을 잰다.

### 10.2 워커 브라우저 검증(`dev:fake` 위, Playwright)

도구 순서는 `docs/guides/browser-verification.md` — neo 가 붙으면 neo 에 Playwright 를 얹고, 아니면 플러그인 Playwright 가 자체 브라우저를 띄운다. 시나리오마다 스크린샷, 콘솔 오류 0, 필요한 곳은 WebSocket 프레임 확인. 워커가 연 탭·브라우저는 워커가 닫는다.

1. 로그인(틀린 토큰 → 오류, 맞는 토큰 → `/`) · 새로고침 뒤에도 로그인 유지(쿠키 → wire 연결).
2. 에이전트 「Gateway 에서 가져오기」로 dev·fin 등록.
3. 채널 만들기 → 설정 패널에서 dev·fin 추가 → 프롬프트 저장.
4. `@dev 안녕` → 대기 → 스트리밍 버블(델타 누적) → 확정 메시지 교체(버블 하나, 메시지 하나).
5. `@dev @fin 에게 전해줘` → dev 답에 fin 멘션 → fin 버블·답(릴레이) → 턴 상한 1 로 낮춰 다시 → 「이어가기」 카드 → 누르면 fin 런, 버튼 소비 상태.
6. `@dev 느리게` → 중지 → 「중지됨」, `/stop` 도 같은 결과.
7. 「새 대화」 → info 시스템 메시지.
8. `@dev 실패` → 버블 「실행 실패」 → run_error 시스템 카드.
9. 서버 재시작(`dev:fake --keep`) 동안 배너 → 복구 → 재시작 중 생긴 메시지 없음 확인, 끊긴 사이 다른 탭에서 보낸 메시지가 빈틈 복구로 들어오는지.
10. 좁은 화면(390px) 스크린샷 — 사이드바 시트.

### 10.3 실물 확인(선택)

마지막 태스크에서 실제 로컬 dev Gateway 로 4·5·6 을 한 번 — **모델 런 3회 이하**. `docs/guides/live-smoke.md` 절차(웹 절 추가)를 따른다.

**구현과 맞춘 것(2026-09-20)**: 문서 태스크(14)에서 **떼어 뒤로 미뤘다** — 모델 사용량은 사용자 판단이다. 아직 하지 않았고, 절차·볼 것은 `docs/guides/live-smoke.md` **7절**에 적어 두었다.

## 11. 완료 기준

- 10.1 통과, 루트 `pnpm test && pnpm typecheck && pnpm lint && pnpm fmt:check` 통과(웹 포함).
- 10.2 시나리오 1~10 스크린샷·확인 기록(보고서) — 리뷰어가 대조한다.
- 계획서 8장 Phase 1 의 웹 항목(마크다운 렌더, 스트리밍 버블·중지, 에이전트 등록 UI·채널에 추가·프롬프트 편집)에 완료 표시, 「완료 기준(사람 1 + 에이전트 2 가 멘션으로 3턴 이상 협업)」을 `dev:fake` 시나리오 5 와 실물 확인(10.3)으로 확인했다고 적는다.
- 구성 가이드 2.5(파일 실물)·CLAUDE.md 명령(`pnpm -F @dodok/web dev`, `pnpm -F @dodok/server dev:fake`)·현재 단계 갱신.

## 12. 열린 문제·후속

1. 다중 사용자: 멘션 후보·작성자 표시에 사용자 목록 REST 가 필요하다(지금은 owner 한 명) — 팀 단계에서 `GET /users`.
2. 오프라인 전송 큐·최근 채널 캐시는 PWA(Phase 2).
3. `wire-cli` 는 루트 typecheck 밖이다(sc-t15 걱정 7) — 웹이 wire 계약을 타입으로 쓰므로 계약이 바뀌면 웹 typecheck 가 먼저 깨진다. wire-cli 는 그대로 둔다.
4. usage·툴 이벤트 표시는 활동 패널(Phase 2) — `sv-residual` 의 usage 조사 결과를 그때 반영한다.
