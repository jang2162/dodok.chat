import { z } from "zod";
import { Id } from "../common";
import { RunnerEffort, RunnerPermissionMode } from "../domain";

// 러너 에이전트의 세션 설정(세션 설정 스펙 5장) — 대화 × 러너 에이전트마다 모델·effort·권한 모드. null 은 「기본」이다:
// 모델·effort 는 프로그램 기본, 권한은 실행 때 min(default, 그 러너의 상한)

const SettingModel = z.string().min(1).max(128);

/** 에이전트의 「새 세션 시작값」 — 설정 행이 없는 대화가 이 값으로 돈다(S10) */
export const SessionDefaults = z.object({
  model: SettingModel.nullable(),
  effort: RunnerEffort.nullable(),
  permissionMode: RunnerPermissionMode.nullable(),
});
export type SessionDefaults = z.infer<typeof SessionDefaults>;

/** GET /conversations/:id/agent-settings 의 한 줄. contextPercent 는 그 세션에서 그 에이전트의 마지막 실행 — 없으면 null */
export const ConversationAgentSettings = SessionDefaults.extend({
  agentId: Id,
  contextPercent: z.int().min(0).max(100).nullable(),
});
export type ConversationAgentSettings = z.infer<typeof ConversationAgentSettings>;

const PATCH_FIELDS = {
  model: SettingModel.nullable().optional(),
  effort: RunnerEffort.nullable().optional(),
  permissionMode: RunnerPermissionMode.nullable().optional(),
};
const hasField = (v: Record<string, unknown>) => Object.keys(PATCH_FIELDS).some((k) => v[k] !== undefined);
const NEEDS_FIELD = { message: "model·effort·permissionMode 가운데 하나는 있어야 한다" };

/** PATCH /conversations/:id/agent-settings/:agentId — 보낸 필드만 바꾼다. null 은 「기본」으로 되돌린다 */
export const AgentSettingsPatch = z.object(PATCH_FIELDS).refine(hasField, NEEDS_FIELD);
export type AgentSettingsPatch = z.infer<typeof AgentSettingsPatch>;

/** 새 세션의 첫 글과 함께 오는 에이전트 하나의 설정(S11) */
export const AgentSettingsEntry = z.object({ agentId: Id, ...PATCH_FIELDS }).refine(hasField, NEEDS_FIELD);
export type AgentSettingsEntry = z.infer<typeof AgentSettingsEntry>;
