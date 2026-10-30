# 결함 1 고침의 실물 확인 — 2026-09-23 결과 (c2-t16, 모델 런 0회)

> 결함 1(모델 런 안의 `message` 툴이 「bridge is not running」) 고침을 런 0회 하네스로 확인한 실연(c2-t16, ADR 0004)의 기록 — 계획 `docs/superpowers/plans/2026-09-21-components-v1.md` 검증 결함 수정, 스펙 `docs/superpowers/specs/2026-09-21-components-v1-design.md`. 그 시점 기록이라 고치지 않는다 — 지금 절차는 `docs/guides/live-smoke.md` 를 본다. 본문의 절 번호(「3절」·「11.4」 등)는 옮기기 전 live-smoke 의 번호다 — 그 판은 `git show 823d159:docs/guides/live-smoke.md` 로 연다.


11.3 하네스로 ADR 0004 6절 합격 기준을 `oc 2026.9.5 (f396007)` 실물 Gateway 위에서 돌렸다. **모델 런 0회**(가짜 claude CLI, `costUsd: 0`), Gateway 에이전트 런 2회.

**판정: 고쳐졌다. 6/6 통과. dodok 코드 결함 0.**

| 항목 | 값 |
| --- | --- |
| Gateway | `OpenClaw 2026.9.5 (f396007)` — 저장소 핀(2026.9.4)과 다르다(앱 자동 업데이트, 8장 이월) |
| 번들 sha | 설치 전 `9520de1f…`(고치기 전 코드) → 설치 후 `0b53c75b…`(고친 코드). **둘이 다른 것을 확인하고 쟀다** |
| 채널 | 하네스 전용 새 채널(11.1 주의대로 — 가짜 claude 세션 id 가 채널 세션에 박힌다) |

| # | 합격 기준 | 결과 |
| --- | --- | --- |
| 1 | `tools/call message` | `sent to dodok channel <CH> (<messageId>)` · `isError:false` — 전에는 `dodok: account "default" bridge is not running` |
| 2 | 카드가 **런에 묶이는가** | `message.created … runId=<그 런> replyTo=<그 사람 메시지>` — 값이 정확히 일치. REST 로도 재확인. **`correlations` 도 세대를 넘었다**(반쪽 아님) |
| 3 | `components` 온전성 | 셀렉트(`actions`)·모달(필드 4종)이 보낸 그대로 저장·렌더 |
| 4 | `ask_user` | `ask_user prompt delivery failed \| INTERNAL: HttpError: agent not found` — 「bridge is not running」이 아니다. **첫 층이 닫혔다는 증거**(뒷 두 층은 8장 이월) |
| 5 | 버전 로그 | `"gateway connected"` `gatewayVersion="2026.9.5"` `gatewayBuildId="2026.9.5-release-f39600759bec-…"` · `"bridge plugin hello"` `gatewayVersion="2026.9.5"`. ⚠ 같은 줄의 `pluginBuiltWithSdk="2026.9.4"` 는 빌드 상수다(Gateway 버전 아님) |
| 6 | probe — 세대 확인 | `module-eval evals=1 instance=26vo7d` / `evals=2 instance=exfwnw`(같은 pid) · `start-account instance=26vo7d` · **`handle-action instance=exfwnw found=true`** — 전역 레지스트리가 세대를 넘는 것이 눈으로 보인다 |

웹(5180): 카드 2장이 목록에 그려지고, 활동 탭에 런 2건이 모두 `완료`, 모달 「세부 정보」의 필드 4개가 그대로 열렸다. 콘솔 예외 유무는 재지 않았다.

**절차 노트**: 9.5 Gateway 가 떠 있는 채로 `plugins install --force` 하면 `device token scope mismatch` 로 실패하고 **파일도 안 바뀐다** — 3절 (b) 의 경고대로 Gateway 를 먼저 내리고, 설치 뒤 sha 를 반드시 확인한다.
