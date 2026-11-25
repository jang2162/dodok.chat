import type { Message, RunState } from "@dodok/shared";

/**
 * 답 묶음(여러 에이전트 답 묶음 설계)의 한 줄 — 런 하나. 줄의 원천은 런이고 메시지는 그 줄의 내용이다: 첫 메시지 전의 런·메시지 없이
 * 끝난 런도 줄이 선다
 */
export type BundleLane = {
  runId: string;
  agentId: string;
  /** 릴레이면 부른 에이전트(트리거 글의 작성자) — 사람이 부른 줄은 없음 */
  fromAgentId?: string;
  /** 그 런의 에이전트 메시지(seq 순) */
  messageIds: string[];
  /** 그 런의 run_error(seq 순) */
  systemIds: string[];
  /** 저장소 → 루트 글의 rootRuns → 메시지로 짐작(에이전트 글 있음 → done, run_error 만 → error) 순 */
  status: RunState["status"];
  firstSeq?: number;
};

/**
 * 루트 글 하나의 묶음 — 줄은 런 id(uuid v7 = 생성) 순. `tailSystemIds` 는 그 체인의 relay_limit·relay_denied(묶음 맨 아래).
 * `threadRootId` 는 루트 글이 채널에도 보낸 스레드 답글일 때 그 스레드 — 답은 스레드에 있어 세션 타임라인에 없다(줄은 런으로 선다)
 */
export type Bundle = { rootId: string; lanes: BundleLane[]; tailSystemIds: string[]; threadRootId?: string };

/** 런 저장소에서 넘기는 런 — 지난 메시지의 `runRoot` 가 없는 실시간 글(wire message.created)도 이것으로 루트를 안다 */
export type BundleRun = {
  runId: string;
  agentId: string;
  rootMessageId: string;
  triggerMessageId?: string;
  status: RunState["status"];
};

/** 묶음 루트가 될 수 있는 글 — 사람의 최상위 보통 글 또는 채널에도 보낸 답글(서버 canRootRuns 와 같은 조건) */
const canRoot = (m: Message): boolean =>
  m.authorType === "user" &&
  m.kind === "normal" &&
  (m.threadRootId === undefined || m.alsoInChannel === true);

type Draft = {
  runId: string;
  agentId: string;
  rootId: string;
  triggerMessageId?: string;
  status?: RunState["status"];
  messages: Message[];
  systems: Message[];
};

/**
 * 타임라인 + 런 저장소 → 묶음(루트 id → 묶음). 줄은 저장소 런·루트 글의 rootRuns·메시지의 runRoot 를 합쳐 세운다. 판정은 실제 런으로 한다(설계 「정한 것」, 사용자 결정): 루트가 불러온 `items` 에 있는 사람
 * 최상위 글이고, `rootMessageId` 가 그 글인 런의 에이전트가 서로 다른 2명 이상(진행 중 런 포함). 멘션 수는 보지 않는다.
 * 같은 런이 저장소와 메시지 양쪽에 있으면 저장소 상태가 이긴다
 */
export function computeBundles(items: readonly Message[], runs: readonly BundleRun[]): Map<string, Bundle> {
  const byId = new Map(items.map((m) => [m.id, m]));
  const drafts = new Map<string, Draft>();
  const draftOf = (runId: string, agentId: string, rootId: string, triggerMessageId?: string): Draft => {
    let d = drafts.get(runId);
    if (!d) {
      d = { runId, agentId, rootId, messages: [], systems: [] };
      if (triggerMessageId !== undefined) d.triggerMessageId = triggerMessageId;
      drafts.set(runId, d);
    }
    return d;
  };
  const storeRuns = new Map(runs.map((r) => [r.runId, r]));
  for (const r of runs) draftOf(r.runId, r.agentId, r.rootMessageId, r.triggerMessageId).status = r.status;
  // 루트 글의 rootRuns(서버가 새로 불러올 때 싣는다) — 메시지 없이 중지·실패한 런도 줄이 선다. 저장소에 있는 런은 저장소가 이긴다
  for (const m of items) {
    if (!m.rootRuns || !canRoot(m)) continue;
    for (const r of m.rootRuns) {
      if (storeRuns.has(r.runId)) continue;
      draftOf(r.runId, r.agentId, m.id, r.triggerMessageId).status = r.status;
    }
  }
  for (const m of items) {
    const runId =
      m.authorType === "agent"
        ? m.runId
        : m.kind === "system" && m.systemMeta?.kind === "run_error"
          ? m.systemMeta.runId
          : undefined;
    if (runId === undefined) continue;
    const known = storeRuns.get(runId);
    const root = m.runRoot?.runId === runId ? m.runRoot : undefined;
    const rootId = known?.rootMessageId ?? root?.rootMessageId;
    const agentId = known?.agentId ?? root?.agentId ?? (m.authorType === "agent" ? m.authorId : undefined);
    if (rootId === undefined || agentId === undefined) continue;
    const d = draftOf(runId, agentId, rootId, known?.triggerMessageId ?? root?.triggerMessageId);
    if (m.authorType === "agent") d.messages.push(m);
    else d.systems.push(m);
  }

  const byRoot = new Map<string, Draft[]>();
  for (const d of drafts.values()) {
    const root = byId.get(d.rootId);
    if (!root || !canRoot(root)) continue;
    const list = byRoot.get(d.rootId);
    if (list) list.push(d);
    else byRoot.set(d.rootId, [d]);
  }

  const bundles = new Map<string, Bundle>();
  for (const [rootId, list] of byRoot) {
    if (new Set(list.map((d) => d.agentId)).size < 2) continue;
    list.sort((a, b) => (a.runId < b.runId ? -1 : 1));
    const lanes = list.map((d): BundleLane => {
      const bySeq = (a: Message, b: Message) => a.seq - b.seq;
      d.messages.sort(bySeq);
      d.systems.sort(bySeq);
      const trigger = d.triggerMessageId === undefined ? undefined : byId.get(d.triggerMessageId);
      const seqs = [...d.messages, ...d.systems].map((m) => m.seq);
      const lane: BundleLane = {
        runId: d.runId,
        agentId: d.agentId,
        messageIds: d.messages.map((m) => m.id),
        systemIds: d.systems.map((m) => m.id),
        status: d.status ?? (d.messages.length > 0 ? "done" : "error"),
      };
      if (trigger?.authorType === "agent" && trigger.authorId !== undefined)
        lane.fromAgentId = trigger.authorId;
      if (seqs.length > 0) lane.firstSeq = Math.min(...seqs);
      return lane;
    });
    const threadRootId = byId.get(rootId)?.threadRootId;
    bundles.set(rootId, { rootId, lanes, tailSystemIds: [], ...(threadRootId ? { threadRootId } : {}) });
  }
  if (bundles.size === 0) return bundles;
  for (const m of items) {
    const rel = m.kind === "system" ? m.systemMeta?.relay : undefined;
    if (!rel || (m.systemMeta?.kind !== "relay_limit" && m.systemMeta?.kind !== "relay_denied")) continue;
    bundles.get(rel.rootMessageId)?.tailSystemIds.push(m.id);
  }
  return bundles;
}

/** 메시지 id·런 id → 그 묶음의 rootId (groupRows·이동이 쓴다). 루트 글 자신은 넣지 않는다 */
export function bundleIndex(bundles: ReadonlyMap<string, Bundle>): {
  byMessage: Map<string, string>;
  byRun: Map<string, string>;
} {
  const byMessage = new Map<string, string>();
  const byRun = new Map<string, string>();
  for (const b of bundles.values()) {
    for (const lane of b.lanes) {
      byRun.set(lane.runId, b.rootId);
      for (const id of lane.messageIds) byMessage.set(id, b.rootId);
      for (const id of lane.systemIds) byMessage.set(id, b.rootId);
    }
    for (const id of b.tailSystemIds) byMessage.set(id, b.rootId);
  }
  return { byMessage, byRun };
}

/** 메시지 id → 그 메시지가 든 줄의 런 id(묶음 안 이동이 그 줄을 펼친다). 꼬리 시스템 글은 줄이 없다 */
export function laneOfMessage(bundle: Bundle, messageId: string): string | undefined {
  return bundle.lanes.find((l) => l.messageIds.includes(messageId) || l.systemIds.includes(messageId))?.runId;
}

/** 접힌 줄의 미리보기 — 마크다운 표시를 걷은 첫 줄(빈 줄은 건너뛴다). 멘션 토큰은 @핸들로. `lines` 면 그만큼의 줄을 줄바꿈으로 잇는다(링크한 메시지 카드) */
export function previewOf(
  bodyMd: string,
  mention: (kind: "a" | "u", id: string) => string | undefined,
  lines = 1,
): string {
  return bodyMd
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(0, lines)
    .map((line) =>
      line
        .replace(/<@([au]):([0-9a-f-]+)>/gi, (_, kind: "a" | "u", id: string) => `@${mention(kind, id) ?? "?"}`)
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
        .replace(/[*_`~]/g, "")
        .trim(),
    )
    .join("\n");
}
