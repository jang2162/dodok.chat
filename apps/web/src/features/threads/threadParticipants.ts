import type { RunStatus, ThreadSummary } from "@dodok/shared";
import { useMemo } from "react";
import { runStatusLabel } from "@/features/activity/timeline";
import { selectScopeRuns, TERMINAL, useRunStore } from "@/features/runs/runStore";

/** 스레드 칩의 얼굴 하나 — active 는 그 스레드에서 끝나지 않은 런이 있는 에이전트의 런 상태 */
export type ThreadFace = { kind: "user" | "agent"; id: string; active?: RunStatus };
export type ThreadActiveRun = { agentId: string; status: RunStatus };

/**
 * 칩에 그릴 참여자 — 요약의 participants(옛 서버면 agentIds 를 에이전트로). 진행 중 에이전트는 표시하고, 목록에 없으면
 * (아직 답글 전) 앞에 더한다. 같은 얼굴은 한 번
 */
export function threadFaces(
  summary: ThreadSummary | undefined,
  active: readonly ThreadActiveRun[],
): ThreadFace[] {
  const base: ThreadFace[] =
    summary?.participants ?? (summary?.agentIds ?? []).map((id) => ({ kind: "agent" as const, id }));
  const statusOf = new Map<string, RunStatus>();
  for (const r of active) if (!statusOf.has(r.agentId)) statusOf.set(r.agentId, r.status);
  const listed = new Set(base.filter((f) => f.kind === "agent").map((f) => f.id));
  const added: ThreadFace[] = [...statusOf]
    .filter(([id]) => !listed.has(id))
    .map(([id, status]) => ({ kind: "agent", id, active: status }));
  const seen = new Set<string>();
  const out: ThreadFace[] = [];
  for (const f of [...added, ...base]) {
    const key = `${f.kind}:${f.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const status = f.kind === "agent" ? statusOf.get(f.id) : undefined;
    out.push(status === undefined ? { kind: f.kind, id: f.id } : { kind: f.kind, id: f.id, active: status });
  }
  return out;
}

/** 칩 옆 문구 — 「@dev 응답 중…」, 둘 이상이면 「@dev 외 1명 응답 중…」(상태는 첫 에이전트의 것) */
export function activeLabel(handles: readonly string[], status: RunStatus): string {
  const [first] = handles;
  const who = handles.length > 1 ? `@${first} 외 ${handles.length - 1}명` : `@${first}`;
  return `${who} ${runStatusLabel(status)}…`;
}

/**
 * 그 스레드(세션의 rootId)에서 끝나지 않은 런의 에이전트 — 런 생성 순, 같은 에이전트는 한 번. 저장소에서는 「에이전트:상태」 문자열
 * 하나로 고른다 — 텍스트 델타마다 칩이 다시 그려지지 않게(런 뷰는 델타마다 참조가 바뀐다)
 */
export function useThreadActiveRuns(
  channelId: string,
  conversationId: string,
  rootId: string,
): ThreadActiveRun[] {
  const key = useRunStore((s) => {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const v of selectScopeRuns(channelId, conversationId, rootId)(s)) {
      if (TERMINAL.has(v.state.status) || seen.has(v.state.agentId)) continue;
      seen.add(v.state.agentId);
      parts.push(`${v.state.agentId}:${v.state.status}`);
    }
    return parts.join("|");
  });
  return useMemo(
    () =>
      key === ""
        ? []
        : key.split("|").map((part) => {
            const [agentId = "", status] = part.split(":");
            return { agentId, status: status as RunStatus };
          }),
    [key],
  );
}
