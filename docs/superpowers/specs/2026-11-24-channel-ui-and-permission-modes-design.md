# 채널 설정 UI 다듬기와 러너 권한 auto·bypass — 설계

날짜: 2026-11-24 · 상태: 승인(2026-11-24)

## 왜

실사용(plan.md 8장 「다음 순서 — 실사용」 ②)에서 사용자가 불편을 넷 짚었다.

1. 채널 설정에서 에이전트를 넣는 UI 가 `<select>` 하나라 불편하다 — 사람·에이전트를 가리지 않고 한 번에 초대하고 싶다.
2. 러너 에이전트 설정 패널(작성기 알약 → 「러너 에이전트 N」)의 칩이 「기본」이라고만 써서 실제로 무엇으로 도는지 모른다. 줄마다 칩 폭이 달라 열이 어긋난다.
3. 릴레이 정책의 허용 쌍이 N×(N-1) 줄 체크 목록이라 에이전트 5개면 20줄이다.
4. Claude 권한에 `auto`(모델 분류기 승인)와 yolo(`bypassPermissions`)를 고를 수 없다.

네 줄은 서로 독립이다 — 워크트리 넷으로 나눠 따로 병합한다.

## 1. 러너 권한 `auto`·`bypassPermissions`

**결정(사용자):** 러너 로컬 설정의 상한으로 열 수 있다. **기본 상한에는 들지 않는다**(기본은 지금대로 `default`). 상한을 여는 것은 그 러너를 설정하는 사람의 책임이다.

이로써 `packages/shared/src/domain/index.ts` `RUNNER_PERMISSION_MODES` 주석의 옛 결정(「bypassPermissions 는 승인 카드가 뜨지 않아 어느 스키마도 받지 않는다」)을 바꾼다. 「쓰기 도구는 승인 카드」 원칙은 상한이 이 둘을 열지 않은 러너에서만 보장된다.

- 순서: `plan < dontAsk < default < acceptEdits < auto < bypassPermissions`. 배열 끝에 둘을 붙여 기존 `permissionModeRank` 비교(러너 `ceiling.ts`, 서버 `policies.ts`·`runners/live.ts`, `runner-adapter` `resolvePermissionMode`, 웹 `permissionLock`)를 그대로 쓴다. 「기본」(null)은 지금처럼 min(default, 상한) — 상한이 열려 있어도 저절로 올라가지 않는다.
- 러너: `config.ts` 의 `maxPermissionMode` 기본값은 `default` 그대로. `setup.ts` 의 `PERMISSION_CHOICES` 에 둘을 더하되 고를 때 「승인 카드 없이 실행된다 — 책임은 설정한 사람」 경고를 한 번 보인다. 드라이버(`drivers/claude/run.ts`)는 `bypassPermissions` 일 때 SDK 가 요구하는 `allowDangerouslySkipPermissions: true` 를 함께 넘긴다. `preToolDecision` 의 switch 가 두 모드를 받게 한다.
- `auto` 는 모델이 지원할 때만 뜻이 있다(SDK `ModelInfo.supportsAutoMode`). 지원하지 않는 모델에서 골랐을 때의 동작은 빌더가 SDK 로 확인해 정한다 — 거절 카드든 SDK 의 자체 처리든 결과를 문서에 적는다.
- 웹: 작성기 권한 칩·새 에이전트 폼(`RunnerAgentForm.tsx`)에 두 선택지. 둘에는 경고색과 「승인 카드 없이 실행」 안내. 고를 권한(`canRaise`)은 `acceptEdits` 와 같은 규칙.
- **옛 러너 호환(빌더가 확인할 위험):** enum 이 넓어지면 새 값을 모르는 옛 러너는 `run.start` Zod 파싱에서 런 전체를 거절할 수 있다. 옛 러너의 상한은 이 둘을 알릴 수 없으므로, 서버가 그 러너가 알린 상한보다 높은 값을 보낼 때 옛 러너가 어떻게 실패하는지 확인하고 사용자에게 읽히는 카드가 되게 한다. 러너 패키지 판은 올린다(`docs/guides/runner-release.md`).
- 문서: plan.md 10장에 결정 한 줄, agent-guide·user-guide·live-smoke 의 권한 모드 설명.

## 2. 「기본」 실제 값과 열 정렬

- **모델:** 러너가 `supportedModels()` 의 `value: "default"` 줄에서 `resolvedModel` 을 같은 목록의 표시 이름으로 풀어 `resolvedLabel`(`RunnerModelOption` 의 선택 필드)로 싣는다. 풀 줄이 없으면 `resolvedModel` 글자, 그것도 없으면 키 없음. `description` 은 쓰지 않는다(구현 때 확인 — CLI 2.1.283 의 글에 가격이 섞여 칩에 맞지 않는다). 웹은 「기본」 칩을 `기본 · <표시 이름>` 으로 보인다. 옛 러너(필드 없음)는 「기본」 그대로.
- **노력치(내 판단):** SDK 가 모델의 기본 노력치를 알리지 않는다. 고정표는 판이 바뀌면 틀린 값을 보이므로 두지 않고 `기본 · 모델 기본` 으로 쓴다. 빌더가 SDK 에서 실제 값을 얻을 길을 찾으면 그것을 쓴다.
- **권한:** 「기본」은 `기본 · <min(default, 상한)의 이름>` — 서버가 아는 값이다.
- **정렬:** `AgentPills` 패널(팝오버·시트)의 줄을 하나의 CSS grid(핸들 · 모델 · 노력 · 권한 · 컨텍스트)로 묶어 열을 맞춘다. 칩 하나가 길면 그 열이 넓어지고 줄임표는 열 최대폭에서.

## 3. 릴레이 정책 — 격자(사용자가 A 를 골랐다)

- `RelayPolicySection` 의 `PairList` 를 표로 바꾼다: 행 = 보내는 쪽, 열 = 받는 쪽, 대각선은 비활성. 칸마다 체크박스(접근 이름 「@a → @b」 유지).
- 행 머리·열 머리 단추로 그 행/열 전체 켜기·끄기(전부 켜져 있으면 끈다).
- 넓이가 넘치면 표만 가로 스크롤, 머리 열은 고정. 저장 형식(`allowPairs`)·검증(`relayPolicyForm.ts`)은 그대로.

## 4. 채널 통합 초대

- 채널은 모든 사람이 보고 사람은 쓰거나 멘션되면 저절로 참여한다(user-guide 「채널 참여」). 사람을 넣는 API 는 있고 화면에만 없다.
- 「멤버」 칸 맨 위의 `AddAgentForm`(`<select>`)을 「초대」 단추로 바꾼다. 대화상자에서 사람과 에이전트를 한 검색칸으로 찾고(핸들·이름) 여럿을 골라 한 번에 넣는다. 결과 목록에는 종류 표시(사람/에이전트, 에이전트는 Gateway 꼬리·꺼짐). 이미 멤버인 것·보관한 에이전트·비활성 사람은 뺀다.
- 칸 아래는 사람 멤버와 에이전트 멤버를 함께 보인다(에이전트 행은 지금의 `AgentMemberRow` 그대로). 사람 행 빼기와 그 권한은 서버 정책(`policies.ts`)을 따른다.
- 사람 넣기·빼기 권한이 화면에서 처음 쓰이므로, 빌더는 팀 스펙 「역할과 권한」 표와 서버 정책이 맞는지 확인하고 user-guide 의 「스펙 표의 「채널에 사람 넣기·빼기」는 API 에만 있고 화면에는 없다」 문장을 고친다.
- 세션 초대(`InviteAgentDialog`, 세션 하나에만 부르기)는 이 일의 범위가 아니다.

## 범위 밖

- 대화별 노력치·모델의 고정표, 사람의 채널 「참여」 단추, 세션 초대 대화상자 손질.

## 빌더에게 남긴 것

- `auto` 를 지원하지 않는 모델에서의 동작, 옛 러너가 넓어진 enum 을 받을 때의 실패 꼴.
  - **확인함(A 줄, 2026-11-24)** — `auto` 미지원 모델: CLI 가 거절하지 않고 말없이 `default` 로 내린다(init `auto` → `system/status` `permissionMode: "default"`, 쓰기 도구는 승인 카드). 런 0회 하네스 — SDK 0.3.283 내장 CLI 2.1.283 + `haiku`(→ `claude-haiku-4-5-20251001`, `supportsAutoMode` 없음). 거절 카드는 두지 않았다 — 더 묻는 쪽이라 안전해서, 남은 것(칩이 `auto` 그대로)은 plan.md 8장 「이월」. 절차는 `docs/guides/live-smoke.md` 11절 「권한 auto·bypassPermissions 재기」.
  - **확인함** — 옛 러너(0.10.0): `permissionMode: "auto"` 가 실린 `run.start` 를 dispatch 로 받고 `run.error VALIDATION`(「run.start 형식이 틀렸습니다 — agent.permissionMode」)으로 닫는다. CLI 는 뜨지 않고, 서버 카드는 「@x 실행이 실패했습니다: VALIDATION」(사유 없음). 그래서 어댑터 `send` 가 `acceptEdits` 위 모드를 hello 상한 위면 보내지 않고 `RUNNER_CEILING(permissionMode)` 로 닫는다 — 옛 러너는 이 둘을 상한으로 알릴 수 없으니 언제나 이 길이다.
- 초대 대화상자의 세부 꼴(검색 결과 정렬, 다중 추가 중 일부 실패 표시).
- 격자 머리 단추의 정확한 모양.
