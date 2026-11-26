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
  /**
   * 그 런의 에이전트 메시지 + 이 줄 안 글을 앵커로 따라온 1명 런(`followRunIds`)의 메시지(seq 순). 하위 묶음 루트가 된 줄 안 글의
   * 하위 묶음 메시지는 들지 않는다 — 하위 묶음이 가진다
   */
  messageIds: string[];
  /** 그 런·따라온 런의 run_error, 이 줄 안 글이 막힌 relay_limit·relay_denied(seq 순) */
  systemIds: string[];
  /** 이 줄 안 글이 1명만 불러 따라온 런(런 id 순) — 그 줄의 버블·「결과로 가기」가 쓴다 */
  followRunIds: string[];
  /** 따라온 런의 에이전트·상태(`followRunIds` 와 같은 순) — 접힌 줄 머리가 진행 중·실패를 보인다 */
  followRuns: { runId: string; agentId: string; status: RunState["status"] }[];
  /** 저장소 → 글의 rootRuns → 메시지로 짐작(에이전트 글 있음 → done, run_error 만 → error) 순 */
  status: RunState["status"];
  firstSeq?: number;
};

/**
 * 루트 글 하나의 묶음 — 줄은 런 id(uuid v7 = 생성) 순. `tailSystemIds` 는 루트 글이 막힌 relay_limit·relay_denied(묶음 맨 아래).
 * `threadRootId` 는 루트 글이 채널에도 보낸 스레드 답글일 때 그 스레드 — 답은 스레드에 있어 세션 타임라인에 없다(줄은 런으로 선다).
 * `parent` 는 하위 묶음일 때 그 루트 글이 든 바깥 묶음·줄
 */
export type Bundle = {
  rootId: string;
  lanes: BundleLane[];
  tailSystemIds: string[];
  threadRootId?: string;
  parent?: BundlePlace;
};

/** 묶음 안 자리 — 그 묶음 루트와 줄(런) */
export type BundlePlace = { rootId: string; runId: string };

/** 런 저장소에서 넘기는 런 — 지난 메시지의 `runRoot` 가 없는 실시간 글(wire message.created)도 이것으로 루트를 안다 */
export type BundleRun = {
  runId: string;
  agentId: string;
  rootMessageId: string;
  triggerMessageId?: string;
  status: RunState["status"];
};

/** 묶음 루트가 될 수 있는 글 — 사람·에이전트의 최상위 보통 글 또는 채널에도 보낸 답글(서버 canRootRuns 와 같은 조건) */
const canRoot = (m: Message): boolean =>
  (m.authorType === "user" || m.authorType === "agent") &&
  m.kind === "normal" &&
  (m.threadRootId === undefined || m.alsoInChannel === true);

/** 앵커 사슬을 위로 따라갈 때의 깊이 상한 — 깨진 데이터(순환)에서도 끝나게 */
const MAX_DEPTH = 32;

type Draft = {
  runId: string;
  agentId: string;
  /** 그 런을 부른 글 — triggerMessageId, 없으면 rootMessageId */
  anchorId: string;
  triggerMessageId?: string;
  status?: RunState["status"];
  messages: Message[];
  systems: Message[];
};

/**
 * 타임라인 + 런 저장소 → 묶음(루트 id → 묶음, 모든 깊이). 줄은 저장소 런·글의 rootRuns·메시지의 runRoot 를 합쳐 세운다. 판정은 실제
 * 런으로 한다(부른 글 기준 설계 2026-11-26): 런의 앵커(`triggerMessageId`, 없으면 `rootMessageId`)가 불러온 `items` 에 있는 보통 글이고,
 * 그 글을 앵커로 한 런의 에이전트가 서로 다른 2명 이상(진행 중 런 포함)이면 그 글이 묶음 루트다. 작성자·멘션 수는 보지 않는다. 1명만
 * 부른 런은 앵커 글의 자리를 따른다 — 앵커가 메인이면 메인, 어떤 줄 안이면 그 줄 안. 줄 안 글이 묶음 루트면 하위 묶음(`parent`).
 * 같은 런이 저장소와 메시지 양쪽에 있으면 저장소 상태가 이긴다
 */
export function computeBundles(items: readonly Message[], runs: readonly BundleRun[]): Map<string, Bundle> {
  const byId = new Map(items.map((m) => [m.id, m]));
  const drafts = new Map<string, Draft>();
  const draftOf = (runId: string, agentId: string, anchorId: string, triggerMessageId?: string): Draft => {
    let d = drafts.get(runId);
    if (!d) {
      d = { runId, agentId, anchorId, messages: [], systems: [] };
      if (triggerMessageId !== undefined) d.triggerMessageId = triggerMessageId;
      drafts.set(runId, d);
    }
    return d;
  };
  const storeRuns = new Map(runs.map((r) => [r.runId, r]));
  for (const r of runs)
    draftOf(r.runId, r.agentId, r.triggerMessageId ?? r.rootMessageId, r.triggerMessageId).status = r.status;
  // 글의 rootRuns(서버가 새로 불러올 때 그 글이 부른 런을 싣는다) — 메시지 없이 중지·실패한 런도 줄이 선다. 저장소에 있는 런은 저장소가 이긴다
  for (const m of items) {
    if (!m.rootRuns || !canRoot(m)) continue;
    for (const r of m.rootRuns) {
      if (storeRuns.has(r.runId)) continue;
      draftOf(r.runId, r.agentId, r.triggerMessageId ?? m.id, r.triggerMessageId).status = r.status;
    }
  }
  /** 메시지 id → 그 메시지를 낸 런(에이전트 글·run_error) */
  const runOfMessage = new Map<string, Draft>();
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
    const trigger = known ? known.triggerMessageId : root?.triggerMessageId;
    const d = draftOf(runId, agentId, trigger ?? rootId, trigger);
    if (m.authorType === "agent") d.messages.push(m);
    else d.systems.push(m);
    runOfMessage.set(m.id, d);
  }

  // 앵커별 런 — 서로 다른 에이전트 2명 이상이면 묶음 루트 후보
  const byAnchor = new Map<string, Draft[]>();
  for (const d of drafts.values()) {
    const anchor = byId.get(d.anchorId);
    if (!anchor || !canRoot(anchor)) continue;
    const list = byAnchor.get(d.anchorId);
    if (list) list.push(d);
    else byAnchor.set(d.anchorId, [d]);
  }
  const roots = new Set<string>();
  for (const [id, list] of byAnchor) if (new Set(list.map((d) => d.agentId)).size >= 2) roots.add(id);

  /** 런의 자리 — 앵커가 묶음 루트면 그 묶음의 자기 줄, 아니면 앵커 글의 자리. undefined 는 메인 */
  const placeOfRun = (d: Draft, seen: Set<string>): BundlePlace | undefined =>
    roots.has(d.anchorId) ? { rootId: d.anchorId, runId: d.runId } : placeOfMessage(d.anchorId, seen);
  /** 글의 자리 — 런이 낸 글이면 그 런의 자리, 사람 글·불러오지 않은 글이면 메인. 순환·깊이 상한이면 메인 */
  function placeOfMessage(id: string, seen: Set<string>): BundlePlace | undefined {
    if (seen.has(id) || seen.size >= MAX_DEPTH) return undefined;
    seen.add(id);
    const d = runOfMessage.get(id);
    return d ? placeOfRun(d, seen) : undefined;
  }
  // 바깥 묶음 사슬이 자기에게 돌아오는 루트(깨진 데이터)는 루트에서 뺀다 — 빼면 다른 루트의 자리가 바뀌므로 바뀌지 않을 때까지
  for (let changed = true; changed;) {
    changed = false;
    for (const r of roots) {
      const visited = new Set<string>();
      for (let cur = r, i = 0; i <= MAX_DEPTH; i++) {
        const p = placeOfMessage(cur, new Set());
        if (!p) break;
        if (p.rootId === r || i === MAX_DEPTH) {
          roots.delete(r);
          changed = true;
          break;
        }
        if (visited.has(p.rootId)) break;
        visited.add(p.rootId);
        cur = p.rootId;
      }
    }
  }

  const bundles = new Map<string, Bundle>();
  if (roots.size === 0) return bundles;
  const statusOf = (d: Draft): RunState["status"] => d.status ?? (d.messages.length > 0 ? "done" : "error");
  type LaneDraft = { lane: BundleLane; messages: Message[]; systems: Message[] };
  const lanesByRun = new Map<string, LaneDraft>();
  for (const rootId of roots) {
    const list = [...(byAnchor.get(rootId) ?? [])].sort((a, b) => (a.runId < b.runId ? -1 : 1));
    const lanes = list.map((d): BundleLane => {
      const trigger = d.triggerMessageId === undefined ? undefined : byId.get(d.triggerMessageId);
      const lane: BundleLane = {
        runId: d.runId,
        agentId: d.agentId,
        messageIds: [],
        systemIds: [],
        followRunIds: [],
        followRuns: [],
        status: statusOf(d),
      };
      if (trigger?.authorType === "agent" && trigger.authorId !== undefined)
        lane.fromAgentId = trigger.authorId;
      lanesByRun.set(d.runId, { lane, messages: [...d.messages], systems: [...d.systems] });
      return lane;
    });
    const threadRootId = byId.get(rootId)?.threadRootId;
    const bundle: Bundle = { rootId, lanes, tailSystemIds: [], ...(threadRootId ? { threadRootId } : {}) };
    const parent = placeOfMessage(rootId, new Set());
    if (parent) bundle.parent = parent;
    bundles.set(rootId, bundle);
  }
  // 1명만 부른 런 — 앵커 글이 든 줄에 따라 들어간다(메인이면 그대로 메인)
  const follows = [...drafts.values()]
    .filter((d) => !roots.has(d.anchorId))
    .sort((a, b) => (a.runId < b.runId ? -1 : 1));
  for (const d of follows) {
    const p = placeOfRun(d, new Set());
    const target = p && lanesByRun.get(p.runId);
    if (!target) continue;
    target.lane.followRunIds.push(d.runId);
    target.lane.followRuns.push({ runId: d.runId, agentId: d.agentId, status: statusOf(d) });
    target.messages.push(...d.messages);
    target.systems.push(...d.systems);
  }
  // relay_limit·relay_denied — 막힌 멘션을 쓴 글(sourceRunId 런의 글)의 자리: 그 글이 묶음 루트면 그 묶음 맨 아래, 줄 안이면 그 줄
  for (const m of items) {
    const rel = m.kind === "system" ? m.systemMeta?.relay : undefined;
    if (!rel || (m.systemMeta?.kind !== "relay_limit" && m.systemMeta?.kind !== "relay_denied")) continue;
    const source = drafts.get(rel.sourceRunId);
    if (!source) continue;
    const asRoot = source.messages.find((s) => bundles.has(s.id));
    if (asRoot) {
      bundles.get(asRoot.id)?.tailSystemIds.push(m.id);
      continue;
    }
    const p = placeOfRun(source, new Set());
    if (p) lanesByRun.get(p.runId)?.systems.push(m);
  }
  const bySeq = (a: Message, b: Message) => a.seq - b.seq;
  for (const { lane, messages, systems } of lanesByRun.values()) {
    messages.sort(bySeq);
    systems.sort(bySeq);
    lane.messageIds = messages.map((m) => m.id);
    lane.systemIds = systems.map((m) => m.id);
    const seqs = [...messages, ...systems].map((m) => m.seq);
    if (seqs.length > 0) lane.firstSeq = Math.min(...seqs);
  }
  return bundles;
}

/** 묶음의 가장 바깥 묶음 rootId — parent 를 따라 올라간다(computeBundles 가 순환을 걷어 낸다, 그래도 상한) */
function outermost(bundles: ReadonlyMap<string, Bundle>, b: Bundle): string {
  let cur = b;
  for (let i = 0; i < MAX_DEPTH && cur.parent; i++) {
    const up = bundles.get(cur.parent.rootId);
    if (!up) break;
    cur = up;
  }
  return cur.rootId;
}

/**
 * 메시지 id·런 id → 그 묶음의 **가장 바깥** rootId (groupRows 가 메인에서 뺄 것·이동이 쓴다). 메인에 있는 루트 글 자신은 넣지 않는다 —
 * 하위 묶음의 루트 글은 바깥 줄 안에 있어 든다
 */
export function bundleIndex(bundles: ReadonlyMap<string, Bundle>): {
  byMessage: Map<string, string>;
  byRun: Map<string, string>;
} {
  const byMessage = new Map<string, string>();
  const byRun = new Map<string, string>();
  for (const b of bundles.values()) {
    const top = outermost(bundles, b);
    for (const lane of b.lanes) {
      byRun.set(lane.runId, top);
      for (const id of lane.followRunIds) byRun.set(id, top);
      for (const id of lane.messageIds) byMessage.set(id, top);
      for (const id of lane.systemIds) byMessage.set(id, top);
    }
    for (const id of b.tailSystemIds) byMessage.set(id, top);
  }
  return { byMessage, byRun };
}

/** 그 글의 묶음과 그 아래 하위 묶음들만 — 스레드 패널이 루트 글 하나의 묶음을 그린다. 그 글이 묶음 루트가 아니면 빈 맵 */
export function bundlesUnder(bundles: ReadonlyMap<string, Bundle>, rootId: string): Map<string, Bundle> {
  const out = new Map<string, Bundle>();
  if (!bundles.has(rootId)) return out;
  for (const b of bundles.values()) {
    let cur: Bundle | undefined = b;
    for (let i = 0; i <= MAX_DEPTH && cur; i++) {
      if (cur.rootId === rootId) {
        out.set(b.rootId, b);
        break;
      }
      cur = cur.parent ? bundles.get(cur.parent.rootId) : undefined;
    }
  }
  return out;
}

/**
 * 메시지 id → 바깥부터 그 메시지가 든 줄까지의 자리(펼칠 차례). 묶음에 없으면 빈 배열. 꼬리 시스템 글은 줄이 없어 그 묶음에 이르는
 * 바깥 경로까지만(꼬리 판정은 쓰는 쪽이 tailSystemIds 로)
 */
export function bundlePath(bundles: ReadonlyMap<string, Bundle>, messageId: string): BundlePlace[] {
  let here: { bundle: Bundle; runId?: string } | undefined;
  for (const b of bundles.values()) {
    const runId = laneOfMessage(b, messageId);
    if (runId !== undefined) here = { bundle: b, runId };
    else if (b.tailSystemIds.includes(messageId)) here = { bundle: b };
    if (here) break;
  }
  if (!here) return [];
  const path: BundlePlace[] =
    here.runId === undefined ? [] : [{ rootId: here.bundle.rootId, runId: here.runId }];
  let cur: Bundle | undefined = here.bundle;
  for (let i = 0; i < MAX_DEPTH && cur?.parent; i++) {
    path.unshift(cur.parent);
    cur = bundles.get(cur.parent.rootId);
  }
  return path;
}

/** 메시지 id → 그 묶음에서 그 메시지가 든 줄의 런 id(따라온 런의 메시지 포함 — 묶음 안 이동이 그 줄을 펼친다). 꼬리 시스템 글은 줄이 없다 */
export function laneOfMessage(bundle: Bundle, messageId: string): string | undefined {
  return bundle.lanes.find((l) => l.messageIds.includes(messageId) || l.systemIds.includes(messageId))?.runId;
}

/** 접힌 줄의 미리보기 — 마크다운 표시를 걷은 첫 줄(빈 줄은 건너뛴다). 멘션 토큰은 @핸들로. `lines` 면 그만큼의 줄을 줄바꿈으로 잇는다(링크한 메시지 카드) */
export function previewOf(
  bodyMd: string,
  mention: (kind: "a" | "u", id: string) => string | undefined,
  lines = 1,
): string {
  return (
    bodyMd
      .split("\n")
      // 빈 줄·가로줄(`---`·`***`·`___`)은 미리보기에 뜻이 없다
      .filter((l) => l.trim() !== "" && !/^\s*([-*_])(\s*\1){2,}\s*$/.test(l))
      .slice(0, lines)
      .map((line) =>
        line
          .replace(
            /<@([au]):([0-9a-f-]+)>/gi,
            (_, kind: "a" | "u", id: string) => `@${mention(kind, id) ?? "?"}`,
          )
          .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
          .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/, "")
          .replace(/[*_`~]/g, "")
          .trim(),
      )
      .join("\n")
  );
}
