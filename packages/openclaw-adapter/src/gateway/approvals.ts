/**
 * Gateway 승인 프레임 → `ProviderApproval` 정규화 — 설계 4.1, 승인 스파이크 3·4·5장. 순수 함수만, 네트워크 없음.
 *
 * 같은 승인이 두 경로로 온다: 정본은 전역 `plugin|exec|openclaw.approval.requested/resolved`(`request` 블록, `toolCallId` 있음),
 * 보조는 세션 구독의 `session.approval`(`presentation` 블록, `toolCallId` 없음) + 재접속 때의 `approvalReplay`.
 * 두 모양을 하나로 모으고, 만료의 비대칭(plugin 은 `deny`+`resolvedBy:null`, session 은 `expired`)도 여기서 흡수한다.
 *
 * 경계 원칙 둘:
 * - **우리 세션만** 정규화한다. `plugin.approval.*` 는 전역이라 다른 채널 플러그인·TUI 승인도 온다.
 * - **상한 초과는 fail-open** — 계약 상한을 넘는 문자열은 승인을 버리지 않고 잘라서 통과시킨다(끝에 `…`).
 *   승인이 통째로 사라지면 사용자는 카드도 못 보고 TTL 이 끝난 뒤 만료만 본다.
 */
import {
  ApprovalDecision,
  ApprovalKind,
  ApprovalReason,
  ApprovalSeverity,
  ApprovalStatus,
} from "@dodok/shared";
import { z } from "zod";

/** 런 상관(서버 태스크 4) 전의 승인. `channelId`·`providerAgentId` 는 `sessionKey` 에서 푼 값이다. */
export type ProviderApproval = {
  providerApprovalId: string;
  kind: ApprovalKind;
  sessionKey: string;
  providerAgentId: string;
  channelId: string;
  toolCallId?: string;
  toolName?: string;
  pluginId?: string;
  title: string;
  description?: string;
  detail?: string;
  severity: ApprovalSeverity;
  allowedDecisions: ApprovalDecision[];
  urlPath?: string;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  reason?: ApprovalReason;
  /** `*.approval.resolved` 에는 오지 않는다(스파이크 3.4) — 그때는 이미 저장한 행의 값을 지킨다. */
  createdAt?: string;
  expiresAt?: string;
  resolvedAt?: string;
};

// 계약(shared `Approval`)의 문자열 상한 = Gateway 상한. 보여 주는 값은 넘으면 자르고, 상관 키(`toolCallId`)는 자르지 않는다.
const MAX = {
  title: 200,
  description: 512,
  detail: 16_384,
  toolName: 100,
  pluginId: 100,
  urlPath: 500,
  toolCallId: 200,
};

const SESSION_KEY_RE =
  /^agent:([^:]+):dodok:channel:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const APPROVAL_EVENTS: ReadonlySet<string> = new Set([
  "plugin.approval.requested",
  "plugin.approval.resolved",
  "exec.approval.requested",
  "exec.approval.resolved",
  "openclaw.approval.requested",
  "openclaw.approval.resolved",
  "session.approval",
]);

/** 이 이벤트가 승인 프레임인가. 어댑터가 「승인인데 못 읽었다」와 「승인이 아니다」를 가르는 데 쓴다. */
export function isApprovalEvent(event: string): boolean {
  return APPROVAL_EVENTS.has(event);
}

/** 우리 세션 키(`agent:<providerAgentId>:dodok:channel:<uuid>`)만 받는다. 접미사가 붙으면 우리 것이 아니다(계획 #19). */
export function parseSessionKey(
  sessionKey: string | undefined,
): { providerAgentId: string; channelId: string } | undefined {
  const match = sessionKey ? SESSION_KEY_RE.exec(sessionKey) : null;
  const providerAgentId = match?.[1];
  const channelId = match?.[2];
  if (!providerAgentId || !channelId) return undefined;
  return { providerAgentId, channelId: channelId.toLowerCase() };
}

// 외부 입력 — 읽는 필드만 좁게, 값 검증은 정규화에서 한다(모르는 값 하나가 승인을 통째로 버리지 않게).
/** `request`(정본 경로)와 `presentation`(세션 경로)이 겹치는 모양. exec 종류는 `commandText` 쪽이다(스파이크 10.1, 미관측). */
const Details = z.looseObject({
  kind: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  detail: z.string().optional(),
  severity: z.string().optional(),
  pluginId: z.string().optional(),
  toolName: z.string().optional(),
  toolCallId: z.string().optional(),
  agentId: z.string().optional(),
  sessionKey: z.string().optional(),
  allowedDecisions: z.array(z.unknown()).optional(),
  commandText: z.string().optional(),
  commandPreview: z.string().optional(),
});

/** 전역 승인 프레임(`*.approval.requested`·`*.approval.resolved`). */
const GlobalFrame = z.looseObject({
  approvalKind: z.string().optional(),
  id: z.string().min(1),
  request: Details.optional(),
  status: z.string().optional(),
  decision: z.string().optional(),
  reason: z.string().optional(),
  resolvedBy: z.string().nullish(),
  createdAtMs: z.number().optional(),
  expiresAtMs: z.number().optional(),
  resolvedAtMs: z.number().optional(),
  ts: z.number().optional(),
});

/** `session.approval`·`approvalReplay.approvals[]`·`approval.resolve` 응답이 함께 쓰는 승인 스냅샷. */
const Snapshot = z.looseObject({
  id: z.string().min(1),
  status: z.string().optional(),
  presentation: Details.optional(),
  urlPath: z.string().optional(),
  createdAtMs: z.number().optional(),
  expiresAtMs: z.number().optional(),
  resolvedAtMs: z.number().optional(),
  reason: z.string().optional(),
  decision: z.string().optional(),
  sourceSessionKey: z.string().optional(),
  source: z.looseObject({ agentId: z.string().optional(), sessionKey: z.string().optional() }).optional(),
});

const SessionApprovalFrame = z.looseObject({
  sessionKey: z.string().optional(),
  sourceSessionKey: z.string().optional(),
  phase: z.string().optional(),
  approval: Snapshot,
});

const ReplayResult = z.looseObject({
  approvalReplay: z
    .looseObject({ sessionKey: z.string().optional(), approvals: z.array(z.unknown()) })
    .optional(),
});

const ResolveResult = z.looseObject({ applied: z.boolean().optional(), approval: Snapshot });

type Normalizable = {
  event?: string;
  id: string;
  kindHint?: string;
  details: z.infer<typeof Details> | undefined;
  sessionKey: string | undefined;
  status?: string;
  decision?: string;
  reason?: string;
  resolvedBy?: string | null;
  urlPath?: string;
  createdAtMs?: number;
  expiresAtMs?: number;
  resolvedAtMs?: number;
  /** 이벤트 이름으로 알 수 없을 때(스냅샷 경로) 해결 여부를 정하는 값. */
  resolvedPhase?: boolean;
  fallbackKind?: ApprovalKind;
};

/**
 * 승인 프레임 하나를 정규화한다. 승인 이벤트가 아니거나, 우리 세션이 아니거나, 승인으로 읽을 수 없으면 undefined.
 */
export function parseApprovalFrame(event: string, payload: unknown): ProviderApproval | undefined {
  if (!isApprovalEvent(event)) return undefined;
  if (event === "session.approval") {
    const parsed = SessionApprovalFrame.safeParse(payload);
    if (!parsed.success) return undefined;
    const { approval, phase } = parsed.data;
    return normalizeSnapshot(approval, {
      sessionKey: approval.sourceSessionKey ?? parsed.data.sourceSessionKey ?? parsed.data.sessionKey,
      resolvedPhase: phase === "terminal",
    });
  }
  const parsed = GlobalFrame.safeParse(payload);
  if (!parsed.success) return undefined;
  const p = parsed.data;
  return normalize({
    event,
    id: p.id,
    kindHint: p.approvalKind,
    details: p.request,
    sessionKey: p.request?.sessionKey,
    ...(p.status === undefined ? {} : { status: p.status }),
    ...(p.decision === undefined ? {} : { decision: p.decision }),
    ...(p.reason === undefined ? {} : { reason: p.reason }),
    ...(p.resolvedBy === undefined ? {} : { resolvedBy: p.resolvedBy }),
    ...opt("createdAtMs", p.createdAtMs),
    ...opt("expiresAtMs", p.expiresAtMs),
    // 해결 프레임의 시각은 `ts` 로 온다(스파이크 3.4)
    ...opt("resolvedAtMs", p.resolvedAtMs ?? p.ts),
  });
}

/**
 * `sessions.messages.subscribe({ includeApprovals: true })` 응답의 `approvalReplay.approvals` 를 정규화한다.
 * 미해결 승인만 담긴다(스파이크 5.3). 우리 세션이 아닌 항목·못 읽는 항목은 조용히 버린다.
 */
export function parseApprovalReplay(response: unknown): ProviderApproval[] {
  const parsed = ReplayResult.safeParse(response);
  const entries = parsed.success ? parsed.data.approvalReplay?.approvals : undefined;
  if (!entries) return [];
  const fallbackSessionKey = parsed.success ? parsed.data.approvalReplay?.sessionKey : undefined;
  const out: ProviderApproval[] = [];
  for (const entry of entries) {
    const snapshot = Snapshot.safeParse(entry);
    if (!snapshot.success) continue;
    const approval = normalizeSnapshot(snapshot.data, {
      sessionKey: snapshot.data.sourceSessionKey ?? fallbackSessionKey,
    });
    if (approval) out.push(approval);
  }
  return out;
}

/**
 * 같은 승인의 두 모양을 하나로 모은다 — 어느 쪽도 버리지 않는다(p2-t6 실측 C).
 *
 * 실물은 같은 승인을 두 프레임으로 준다: `plugin.approval.requested` 에는 `toolCallId` 가 있고 `urlPath` 가 없으며,
 * `session.approval` 에는 `urlPath` 가 있고 `toolCallId` 가 없다. 먼저 온 쪽만 남기면 어느 순서든 한쪽 값을 잃는다.
 *
 * 규칙 셋:
 * - **표시 값은 빈 자리만 채운다** — 먼저 온 값은 덮지 않는다(같은 사실을 두 번 읽은 것이지 바뀐 것이 아니다).
 * - **결말(`status`)은 먼저 확정된 쪽이 이긴다** — 서버 저장과 같은 규칙(설계 4.4).
 *   늦게 온 되감기 `pending` 이 이미 닫힌 승인을 되살리지 않는다.
 * - **같은 결말을 말하는 짝은 빈 `decision`·`reason` 을 채운다** — 확정도 짝으로 온다(3.4·5.2):
 *   만료는 `session.approval(terminal)` 에 `status:"expired"`·`reason:"timeout"` 만 있고 `decision` 이 없으며,
 *   `plugin.approval.resolved` 에만 `deny` 가 실린다. 세션 쪽이 먼저 오면 그 자리가 영영 비어
 *   같은 만료가 경로에 따라 다른 모양으로 남는다(p2-t6 리뷰 F2). **다른 결말**을 말하는 프레임은 채우지 않는다.
 */
export function mergeApproval(previous: ProviderApproval, next: ProviderApproval): ProviderApproval {
  // 결말을 쥔 쪽 — 둘 다 pending 이면 값이 같으므로 previous 로 본다
  const outcome = previous.status !== "pending" ? previous : next.status !== "pending" ? next : previous;
  // 같은 결말을 말하는 나머지 한쪽 — 빈 `decision`·`reason` 을 채울 수 있는 짝이다
  const peer = outcome === previous ? next : previous;
  const samePeer = peer.status === outcome.status ? peer : undefined;
  return {
    // 승인이 사는 동안 바뀌지 않는 값 — 먼저 읽은 것을 지킨다
    providerApprovalId: previous.providerApprovalId,
    kind: previous.kind,
    sessionKey: previous.sessionKey,
    providerAgentId: previous.providerAgentId,
    channelId: previous.channelId,
    title: previous.title,
    severity: previous.severity,
    allowedDecisions: previous.allowedDecisions,
    // 한쪽에만 있는 표시 값 — 빈 자리만 채운다
    ...opt("toolCallId", previous.toolCallId ?? next.toolCallId),
    ...opt("toolName", previous.toolName ?? next.toolName),
    ...opt("pluginId", previous.pluginId ?? next.pluginId),
    ...opt("description", previous.description ?? next.description),
    ...opt("detail", previous.detail ?? next.detail),
    ...opt("urlPath", previous.urlPath ?? next.urlPath),
    ...opt("createdAt", previous.createdAt ?? next.createdAt),
    ...opt("expiresAt", previous.expiresAt ?? next.expiresAt),
    // 결말은 먼저 확정된 쪽 그대로 — 빈 자리는 같은 결말을 말하는 짝만 채운다(섞이지 않는다)
    status: outcome.status,
    ...opt("decision", outcome.decision ?? samePeer?.decision),
    ...opt("reason", outcome.reason ?? samePeer?.reason),
    ...opt("resolvedAt", outcome.resolvedAt ?? previous.resolvedAt ?? next.resolvedAt),
  };
}

/** 두 승인이 같은 사실인가 — 「새로 채운 필드도 없고 상태도 그대로」면 다시 낼 것이 없다. */
export function sameApproval(a: ProviderApproval, b: ProviderApproval): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof ProviderApproval)[]);
  for (const key of keys) {
    const left = a[key];
    const right = b[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      if (JSON.stringify(left) !== JSON.stringify(right)) return false;
    } else if (left !== right) return false;
  }
  return true;
}

/** `approval.resolve` 인자(스파이크 4.1). `kind` 는 wire 에 없으므로 저장된 행에서 받는다. */
export function resolveParams(
  approval: Pick<ProviderApproval, "providerApprovalId" | "kind">,
  decision: ApprovalDecision,
): { id: string; kind: ApprovalKind; decision: ApprovalDecision } {
  return { id: approval.providerApprovalId, kind: approval.kind, decision };
}

/**
 * `approval.resolve` 응답(`{ applied, approval }`)의 terminal 스냅샷을 같은 정규화로 돌려준다.
 * `applied:false`(이미 확정된 승인)도 스냅샷은 그대로 온다 — 오류가 아니다(스파이크 4.4).
 */
export function parseResolveResult(response: unknown, kind: ApprovalKind): ProviderApproval | undefined {
  const parsed = ResolveResult.safeParse(response);
  if (!parsed.success) return undefined;
  const { approval } = parsed.data;
  return normalizeSnapshot(approval, {
    sessionKey: approval.source?.sessionKey ?? approval.sourceSessionKey,
    resolvedPhase: true,
    fallbackKind: kind,
  });
}

function normalizeSnapshot(
  snapshot: z.infer<typeof Snapshot>,
  o: { sessionKey: string | undefined; resolvedPhase?: boolean; fallbackKind?: ApprovalKind },
): ProviderApproval | undefined {
  return normalize({
    id: snapshot.id,
    details: snapshot.presentation,
    sessionKey: o.sessionKey,
    ...(snapshot.status === undefined ? {} : { status: snapshot.status }),
    ...(snapshot.decision === undefined ? {} : { decision: snapshot.decision }),
    ...(snapshot.reason === undefined ? {} : { reason: snapshot.reason }),
    ...(snapshot.urlPath === undefined ? {} : { urlPath: snapshot.urlPath }),
    ...(snapshot.createdAtMs === undefined ? {} : { createdAtMs: snapshot.createdAtMs }),
    ...(snapshot.expiresAtMs === undefined ? {} : { expiresAtMs: snapshot.expiresAtMs }),
    ...(snapshot.resolvedAtMs === undefined ? {} : { resolvedAtMs: snapshot.resolvedAtMs }),
    ...(o.resolvedPhase === undefined ? {} : { resolvedPhase: o.resolvedPhase }),
    ...(o.fallbackKind === undefined ? {} : { fallbackKind: o.fallbackKind }),
  });
}

function normalize(input: Normalizable): ProviderApproval | undefined {
  const session = parseSessionKey(input.sessionKey);
  if (!session || input.sessionKey === undefined) return undefined;

  const allowedDecisions = normalizeDecisions(input.details?.allowedDecisions);
  // 버튼을 지어내면 사용자가 「허용」을 눌러도 Gateway 가 malformed-verdict 로 거절한다(스파이크 4.4) — 차라리 버린다.
  if (allowedDecisions.length === 0) return undefined;

  const kind = deriveKind(input);
  const { status, decision, reason } = deriveOutcome(input);
  if (!status) return undefined;

  const details = input.details;
  const toolName = clamp(nonEmpty(details?.toolName), MAX.toolName);
  const description = clamp(
    nonEmpty(details?.description) ?? nonEmpty(details?.commandText) ?? nonEmpty(details?.commandPreview),
    MAX.description,
  );

  return {
    providerApprovalId: input.id,
    kind,
    sessionKey: input.sessionKey,
    providerAgentId: session.providerAgentId,
    channelId: session.channelId,
    // 상관 키라 자르면 안 된다(자른 id 는 어느 툴 호출과도 안 맞는다) — 상한을 넘으면 없는 셈 치고 채널 수준 승인이 된다
    ...opt("toolCallId", keyWithin(nonEmpty(details?.toolCallId), MAX.toolCallId)),
    ...opt("toolName", toolName),
    ...opt("pluginId", clamp(nonEmpty(details?.pluginId), MAX.pluginId)),
    title: clamp(nonEmpty(details?.title), MAX.title) ?? fallbackTitle(kind, toolName),
    ...opt("description", description),
    ...opt("detail", clamp(nonEmpty(details?.detail), MAX.detail)),
    severity: ApprovalSeverity.safeParse(details?.severity).data ?? "warning",
    allowedDecisions,
    ...opt("urlPath", clamp(nonEmpty(input.urlPath), MAX.urlPath)),
    status,
    ...opt("decision", decision),
    ...opt("reason", reason),
    ...opt("createdAt", msToIso(input.createdAtMs)),
    ...opt("expiresAt", msToIso(input.expiresAtMs)),
    ...opt("resolvedAt", msToIso(input.resolvedAtMs)),
  };
}

/** `approvalKind` → `presentation.kind` → 이벤트 이름 접두사 → id 접두사 → plugin(승인을 버리지 않는다). */
function deriveKind(input: Normalizable): ApprovalKind {
  const explicit =
    ApprovalKind.safeParse(input.kindHint).data ?? ApprovalKind.safeParse(input.details?.kind).data;
  if (explicit) return explicit;
  const prefix = input.event?.split(".")[0];
  if (prefix === "plugin" || prefix === "exec") return prefix;
  if (prefix === "openclaw") return "system-agent";
  const idPrefix = input.id.includes(":") ? input.id.slice(0, input.id.indexOf(":")) : undefined;
  return ApprovalKind.safeParse(idPrefix).data ?? input.fallbackKind ?? "plugin";
}

/**
 * 상태·결정·이유. `…requested` 는 무조건 pending 이고, 해결 경로는 프레임의 `status` 를 쓰되 없으면 `decision` 으로 추론한다.
 * 만료의 비대칭을 여기서 흡수한다 — plugin 경로는 `deny` + `resolvedBy:null` 로만 오고 session 경로는 `expired` 다(5.2).
 */
function deriveOutcome(input: Normalizable): {
  status?: ApprovalStatus;
  decision?: ApprovalDecision;
  reason?: ApprovalReason;
} {
  const requested = input.event?.endsWith(".requested") === true;
  if (requested) return { status: "pending" };

  const decision = ApprovalDecision.safeParse(input.decision).data;
  const explicitStatus = ApprovalStatus.safeParse(input.status).data;
  const resolved =
    input.event?.endsWith(".resolved") === true ||
    input.resolvedPhase === true ||
    input.resolvedAtMs !== undefined ||
    decision !== undefined ||
    explicitStatus !== undefined;
  if (!resolved) return { status: "pending" };

  // 만료는 plugin 경로에서 상태 없이 deny 로만 온다. 해결한 클라이언트가 없다(resolvedBy:null)는 것이 유일한 단서다.
  const expired = decision === "deny" && input.resolvedBy === null;
  const status =
    explicitStatus ??
    (expired ? "expired" : decision === "deny" ? "denied" : decision ? "allowed" : undefined);
  if (!status) return {}; // 해결 프레임인데 상태도 결정도 못 읽었다 — 아무것도 알 수 없다
  if (status === "pending") return { status };

  const reason = ApprovalReason.safeParse(input.reason).data ?? (status === "expired" ? "timeout" : "user");
  return { status, ...opt("decision", decision), reason };
}

/** 모르는 값은 버리고 중복은 합친다. 계약 상한(3)은 값이 셋뿐이라 자연히 지켜진다. */
function normalizeDecisions(raw: unknown[] | undefined): ApprovalDecision[] {
  const out: ApprovalDecision[] = [];
  for (const value of raw ?? []) {
    const decision = ApprovalDecision.safeParse(value).data;
    if (decision && !out.includes(decision)) out.push(decision);
  }
  return out;
}

/** 제목이 비었을 때 — 카드가 뜨는 것이 빈 제목으로 버려지는 것보다 낫다(exec·system-agent 는 모양을 못 봤다, 10.1). */
function fallbackTitle(kind: ApprovalKind, toolName: string | undefined): string {
  return toolName ? `툴 승인: ${toolName}` : `승인 요청 (${kind})`;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** 상한을 넘으면 버린다 — 자르면 안 되는 상관 키에 쓴다. */
function keyWithin(value: string | undefined, max: number): string | undefined {
  return value !== undefined && value.length > max ? undefined : value;
}

/** 상한을 넘으면 자르고 끝에 `…` 를 붙인다(잘렸다는 표시). 서로게이트 쌍은 쪼개지 않는다. */
function clamp(value: string | undefined, max: number): string | undefined {
  if (value === undefined || value.length <= max) return value;
  let cut = max - 1;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // 상위 서로게이트로 끝나면 한 자리 더 버린다
  return `${value.slice(0, cut)}…`;
}

/** Date 범위 밖(±8.64e15ms)이면 toISOString 이 던지므로 undefined. */
function msToIso(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** 선택 필드는 `exactOptionalPropertyTypes` 때문에 키 자체를 빼야 한다. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
