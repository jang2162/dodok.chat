import {
  type Agent,
  type AgentSettingsPatch,
  type ConversationAgentSettings,
  roleAtLeast,
  type SessionDefaults,
} from "@dodok/shared";
import { useState } from "react";
import { ApiRequestError } from "@/api/http";
import { useAgents, useCachedMe, useMembers, useRole } from "@/api/queries";
import { useConnectionList } from "@/features/connections/queries";
import { agentOwnerOf } from "@/features/connections/useConnectionTree";
import {
  useAgentCeilings,
  useAgentSettings,
  usePatchAgentSettings,
} from "@/features/conversations/agentSettings";
import { useSessionInvitedAgents } from "@/features/conversations/invitedAgents";
import { NEW_CONVERSATION } from "@/features/messages/timeline";
import { Button } from "@/ui/button";
import { AgentSettingsPopover, DEFAULT_LABEL, RAISE_LOCKED } from "./AgentSettingsPopover";

/** 줄이 이보다 많으면 「러너 에이전트 N」 한 줄로 접는다(세션 설정 스펙 S3) */
export const FOLD_OVER = 3;
const SAVE_FAILED = "저장하지 못했습니다";
const CEILING_REFUSED = "러너 상한 위의 권한 모드입니다";

/** 새 세션 창에서 바꾼 값(에이전트 id → 바꾼 칸) — 첫 글과 함께 간다(S11) */
export type PendingAgentSettings = Readonly<Record<string, AgentSettingsPatch>>;

const NO_DEFAULTS: SessionDefaults = { model: null, effort: null, permissionMode: null };

/** 줄 하나의 글 — 「기본」은 「기본」, 컨텍스트가 없으면 「—」 */
export function settingsSummary(row: Omit<ConversationAgentSettings, "agentId">): string {
  return [
    row.model ?? `모델 ${DEFAULT_LABEL}`,
    `effort ${row.effort ?? DEFAULT_LABEL}`,
    row.permissionMode ?? `권한 ${DEFAULT_LABEL}`,
    `컨텍스트 ${row.contextPercent === null ? "—" : `${row.contextPercent}%`}`,
  ].join(" · ");
}

function errorText(e: unknown): string {
  if (e instanceof ApiRequestError) {
    if (e.code === "FORBIDDEN") return RAISE_LOCKED;
    if (e.code === "VALIDATION") return CEILING_REFUSED;
  }
  return SAVE_FAILED;
}

/**
 * 작성기 바로 위 상태 줄(세션 설정 스펙 S3·5.4) — 그 대화에 든 러너 에이전트(S13)마다 한 줄: 모델·effort·권한·컨텍스트 % 와 「변경」.
 * 대화가 있으면 서버 값(`GET …/agent-settings`, 스레드면 컨텍스트 % 만 그 스레드의 것 — S9), 새 세션 창이면 에이전트 시작값에 화면에서
 * 바꾼 값(`pending`)을 얹는다 — 저장하지 않고 첫 글이 싣는다(S11). 러너 에이전트가 없으면(OpenClaw 만) 그리지 않는다
 */
export function AgentSettingsBar({
  channelId,
  conversationId,
  threadRootId,
  pending,
  onPendingChange,
}: {
  channelId: string;
  conversationId: string;
  threadRootId?: string;
  pending?: PendingAgentSettings;
  onPendingChange?: (agentId: string, patch: AgentSettingsPatch) => void;
}) {
  const isNew = conversationId === NEW_CONVERSATION && threadRootId === undefined;
  const members = useMembers(channelId);
  const agents = useAgents();
  const [expanded, setExpanded] = useState(false);
  const memberRunners = (members.data ?? []).flatMap((m) => {
    if (m.memberType !== "agent") return [];
    const agent = agents.data?.find((a) => a.id === m.memberId);
    return agent && agent.provider === "runner" && agent.archivedAt === null ? [agent] : [];
  });
  // 그 세션에 초대한 러너 에이전트도 한 줄(세션 에이전트 초대 스펙 5.2·5.4) — 새 세션 창에는 초대가 없다
  const invitedRunners = useSessionInvitedAgents(conversationId, { enabled: !isNew }).filter(
    (agent) => agent.provider === "runner" && !memberRunners.some((m) => m.id === agent.id),
  );
  const invitedIds = new Set(invitedRunners.map((a) => a.id));
  const runnerAgents = [...memberRunners, ...invitedRunners];
  // 러너 에이전트가 없는 대화(OpenClaw 만·사람끼리)는 묻지 않는다
  const settings = useAgentSettings(conversationId, threadRootId, { enabled: runnerAgents.length > 0 });
  // 대화가 없는 새 세션 창은 상한을 채널 단위로 받는다 — 대화가 있으면 줄에 실려 온다
  const ceilings = useAgentCeilings(channelId, { enabled: isNew && runnerAgents.length > 0 });
  if (runnerAgents.length === 0) return null;

  const rowOf = (agent: Agent): ConversationAgentSettings => {
    const saved = settings.data?.find((s) => s.agentId === agent.id);
    if (!isNew && saved) return saved;
    const base = agent.sessionDefaults ?? NO_DEFAULTS;
    const ceiling = ceilings.data?.find((c) => c.agentId === agent.id)?.ceiling ?? null;
    return {
      agentId: agent.id,
      ...base,
      ...(isNew ? pending?.[agent.id] : {}),
      contextPercent: null,
      ceiling,
    };
  };

  const folded = runnerAgents.length > FOLD_OVER && !expanded;
  return (
    <div
      className="mb-1 flex flex-col gap-0.5 px-1 text-xs text-muted-foreground"
      data-testid="agent-settings-bar"
    >
      {folded ? (
        <div className="flex items-center gap-2">
          <span>러너 에이전트 {runnerAgents.length}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            aria-expanded={false}
            onClick={() => setExpanded(true)}
          >
            펼치기
          </Button>
        </div>
      ) : (
        <>
          {runnerAgents.map((agent) => (
            <SettingsLine
              key={agent.id}
              agent={agent}
              invited={invitedIds.has(agent.id)}
              row={rowOf(agent)}
              conversationId={conversationId}
              isNew={isNew}
              {...(onPendingChange ? { onPendingChange } : {})}
            />
          ))}
          {runnerAgents.length > FOLD_OVER && (
            <div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                aria-expanded
                onClick={() => setExpanded(false)}
              >
                접기
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SettingsLine({
  agent,
  invited,
  row,
  conversationId,
  isNew,
  onPendingChange,
}: {
  agent: Agent;
  /** 이 세션에만 초대한 에이전트 — 핸들 옆 「초대됨」 */
  invited: boolean;
  row: ConversationAgentSettings;
  conversationId: string;
  isNew: boolean;
  onPendingChange?: (agentId: string, patch: AgentSettingsPatch) => void;
}) {
  const role = useRole();
  const meId = useCachedMe()?.user.id ?? null;
  const connections = useConnectionList();
  const patch = usePatchAgentSettings(conversationId);
  const [error, setError] = useState<string>();
  const owner = agentOwnerOf(agent, connections.data);
  const canRaise = roleAtLeast(role, "admin") || (meId !== null && owner === meId);
  // 상한은 서버가 싣는다(누구에게나) — 남의 러너는 `GET /runners` 에 없어 member 화면이 모른다(리뷰 건 1)
  const ceiling = row.ceiling ?? undefined;

  async function save(change: AgentSettingsPatch): Promise<boolean> {
    setError(undefined);
    if (isNew) {
      onPendingChange?.(agent.id, change);
      return true;
    }
    try {
      await patch.mutateAsync({ agentId: agent.id, patch: change });
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2">
      <span className="font-medium text-foreground">@{agent.handle}</span>
      {invited && <span className="rounded-sm bg-muted px-1 text-[10px]">초대됨</span>}
      <span className="min-w-0 break-words">{settingsSummary(row)}</span>
      <AgentSettingsPopover
        handle={agent.handle}
        value={{ model: row.model, effort: row.effort, permissionMode: row.permissionMode }}
        canRaise={canRaise}
        ceiling={ceiling}
        saving={patch.isPending}
        error={error}
        onSave={save}
      />
    </div>
  );
}
