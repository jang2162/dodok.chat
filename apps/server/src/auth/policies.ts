import { roleAtLeast, type SessionPolicy, type TeamRole } from "@dodok/shared";
import { apiError } from "../http/errors";

// 역할 정책 — 제어 도구에 대응하는 REST 경로마다 하나. REST 라우트(requirePolicy·핸들러)와 제어 서비스가 같은 함수를 불러
// 둘의 판정이 갈라지지 않는다(제어 MCP 계획 판정 PC1). 매트릭스의 정본은 팀 스펙 「역할과 권한」 절 표다.
// 순수 함수라 역할은 부르는 쪽이 그때 읽어 넘긴다 — undefined(멤버 아님·비활성)면 어떤 정책도 통과하지 않는다.
// 도구 쪽의 「확인 카드가 필요한가」(shared CONTROL_TOOLS 의 access)는 여기서 정하지 않는다(계획 판정 PC5)

/** POST /channels·PATCH /channels/:id 에서 member 가 줄 수 있는 필드. 목록 밖 필드가 하나라도 있으면 admin — 새 필드는 기본이 admin 이다 */
export const MEMBER_EDITABLE_CHANNEL_FIELDS: ReadonlySet<string> = new Set(["name", "topic"]);

/**
 * 채널의 에이전트 멤버(POST /channels/:id/members 의 에이전트·PATCH …/members/:memberId)에서 member 가 줄 수 있는 필드.
 * promptOverride·autoRespond 는 에이전트 동작·비용 설정이라 admin
 */
export const MEMBER_EDITABLE_AGENT_MEMBER_FIELDS: ReadonlySet<string> = new Set([
  "memberType",
  "memberId",
  "aliases",
]);

/** 본문 키 중 allowed 밖이 하나라도 있는가 — 파싱이 버린 모르는 키도 센다(부분 적용 없이 통째로 막으려고) */
export function hasFieldOutside(body: unknown, allowed: ReadonlySet<string>): boolean {
  if (typeof body !== "object" || body === null) return false;
  return Object.keys(body).some((key) => !allowed.has(key));
}

/** min 에 못 미치면 403 FORBIDDEN. 문구는 REST 의 requireRole 과 같다 */
export function requireAtLeast(role: TeamRole | undefined, min: TeamRole): void {
  if (!roleAtLeast(role, min))
    throw apiError("FORBIDDEN", min === "owner" ? "owner 만 쓸 수 있다" : `${min} 이상만 쓸 수 있다`);
}

/** 본문에 allowed 밖 필드가 있으면 admin 이상 — 없으면 멤버면 된다 */
function requireFields(role: TeamRole | undefined, body: unknown, allowed: ReadonlySet<string>): void {
  requireAtLeast(role, hasFieldOutside(body, allowed) ? "admin" : "member");
}

// ── 읽기 ────────────────────────────────────────────────────

/**
 * 워크스페이스 멤버면 누구나 — GET /channels·/channels/:id·/channels/:id/members·/agents·/people·/search·
 * /runs/:id·/channels/:id/conversations·/conversations/:id/messages·/conversations/:id/threads/:rootId/messages
 */
export function authorizeRead(role: TeamRole | undefined): void {
  requireAtLeast(role, "member");
}

/** GET /ops/status(admin 이상) */
export function authorizeOpsRead(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

// ── 채널 ────────────────────────────────────────────────────

/** POST /channels — name·topic 만이면 누구나, 프롬프트·릴레이 정책·공개 범위를 실으면 admin 이상 */
export function authorizeChannelCreate(role: TeamRole | undefined, body: unknown): void {
  requireFields(role, body, MEMBER_EDITABLE_CHANNEL_FIELDS);
}

/** PATCH /channels/:id — 이름·주제는 누구나, 그 밖(프롬프트·릴레이 정책·일일 한도·공개 범위)이 섞이면 통째로 admin 이상 */
export function authorizeChannelPatch(role: TeamRole | undefined, body: unknown): void {
  requireFields(role, body, MEMBER_EDITABLE_CHANNEL_FIELDS);
}

/** POST /channels/:id/members — 에이전트면 promptOverride·autoRespond 를 실을 때 admin 이상, 사람 멤버는 누구나 */
export function authorizeChannelMemberAdd(role: TeamRole | undefined, body: unknown): void {
  const agent =
    typeof body === "object" && body !== null && (body as { memberType?: unknown }).memberType === "agent";
  if (agent) requireFields(role, body, MEMBER_EDITABLE_AGENT_MEMBER_FIELDS);
  else requireAtLeast(role, "member");
}

/** PATCH /channels/:id/members/:memberId — aliases 는 누구나, promptOverride·autoRespond 가 섞이면 통째로 admin 이상 */
export function authorizeChannelAgentPatch(role: TeamRole | undefined, body: unknown): void {
  requireFields(role, body, MEMBER_EDITABLE_AGENT_MEMBER_FIELDS);
}

/** DELETE /channels/:id/members/:memberId — 누구나 */
export function authorizeChannelMemberRemove(role: TeamRole | undefined): void {
  requireAtLeast(role, "member");
}

/** POST /channels/:id/archive(admin 이상) */
export function authorizeChannelArchive(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

/** POST /channels/:id/unarchive(admin 이상) */
export function authorizeChannelUnarchive(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

// ── 세션(채널 세션 스펙 「권한」 장) ──────────────────────────────────

/** 새 세션(wire message.send 의 newConversation) — 정책 members 면 누구나, managers 면 그 채널의 세션 관리자와 admin 이상 */
export function authorizeConversationCreate(
  role: TeamRole | undefined,
  policy: SessionPolicy,
  isManager: boolean,
): void {
  requireAtLeast(role, "member");
  if (policy.create === "members" || isManager || roleAtLeast(role, "admin")) return;
  throw apiError("FORBIDDEN", "이 채널은 세션 관리자만 새 세션을 만들 수 있다");
}

/** PATCH /conversations/:id — 제목·닫기·다시 열기. 만든 사람(자기 세션), 세션 관리자, admin 이상 */
export function authorizeConversationManage(
  role: TeamRole | undefined,
  actor: { isCreator: boolean; isManager: boolean },
): void {
  requireAtLeast(role, "member");
  if (actor.isCreator || actor.isManager || roleAtLeast(role, "admin")) return;
  throw apiError("FORBIDDEN", "만든 사람·세션 관리자·admin 이상만 이 세션을 바꿀 수 있다");
}

/** PUT·DELETE /channels/:id/session-managers/:userId(admin 이상). 세션 정책은 PATCH /channels/:id 의 필드 가르기가 본다(admin) */
export function authorizeSessionManagers(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

// ── 에이전트 ─────────────────────────────────────────────────

/** GET /agents/discover(admin 이상) */
export function authorizeAgentDiscover(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

/** POST /agents(admin 이상) */
export function authorizeAgentRegister(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

/** PATCH /agents/:id(admin 이상) — 핸들·이름·아바타·기본 프롬프트·켜기/끄기 */
export function authorizeAgentPatch(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}

/** DELETE /agents/:id — 보관(admin 이상) */
export function authorizeAgentArchive(role: TeamRole | undefined): void {
  requireAtLeast(role, "admin");
}
