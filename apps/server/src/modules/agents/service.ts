import {
  Agent,
  type DmAccess,
  type RunnerPermissionMode,
  type RunnerProgram,
  RunnerRunAgent,
} from "@dodok/shared";
import { and, asc, eq, inArray, isNotNull, isNull, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Db, DbOrTx } from "../../db/client";
import { agents, channelMembers, gateways, runnerProjects, runnerTokens } from "../../db/schema.sqlite";
import { apiError } from "../../http/errors";
import { getGatewayRow } from "../gateways/service";
import { parseStored } from "../../http/validate";
import { assertHandleFree } from "../members/handles";
import type { Orchestrator } from "../runs/orchestrator";
import { listOpenRuns } from "../runs/store";

type AgentRow = typeof agents.$inferSelect;

/**
 * 세션 키에서 푼 id 로 에이전트를 찾는 조건 — 대소문자 무시. 코어가 키를 소문자로 접으므로 등록이 소문자로 좁혀지기 전에
 * 대문자로 저장된 행(`Dev`)도 `dev` 로 찾아야 한다.
 */
export function providerAgentIdIs(providerAgentId: string): SQL {
  return sql`lower(${agents.providerAgentId}) = ${providerAgentId.toLowerCase()}`;
}

type CreateAgentCommon = {
  workspaceId: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  basePrompt?: string;
  enabled?: boolean;
};

export type CreateOpenClawAgentInput = CreateAgentCommon & {
  provider?: "openclaw";
  providerAgentId: string;
  /**
   * 그 에이전트의 Gateway(같은 워크스페이스). REST 등록은 늘 준다(routes.ts) — 없으면 연결이 빈 에이전트(런은
   * ADAPTER_UNAVAILABLE)로, 시드·테스트가 Gateway 를 지운 뒤의 모양을 만들 때만 쓴다
   */
  gatewayId?: string;
};

/**
 * 러너 에이전트(러너 일반화 계획 판정 PR4) — 프로젝트의 러너 토큰에 묶이고 providerAgentId 는 서버가 짓는다. 모델·권한·도구는 shared
 * RunnerRunAgent 의 필드 스키마로 거른다(run.start.agent 와 같은 상한). 러너 천장(권한 상한·도구 상한·프로그램)과의 대조는 붙어
 * 있는 러너를 아는 호출자(REST) 몫이고, 런마다 러너가 다시 본다
 */
export type CreateRunnerAgentInput = CreateAgentCommon & {
  provider: "runner";
  runnerProjectId: string;
  program: RunnerProgram;
  model?: string | null;
  permissionMode?: RunnerPermissionMode;
  allowedTools?: string[] | null;
  disallowedTools?: string[];
};

export type CreateAgentInput = CreateOpenClawAgentInput | CreateRunnerAgentInput;

/** null 은 값을 지운다 */
export type AgentPatch = {
  handle?: string;
  name?: string;
  avatarUrl?: string | null;
  basePrompt?: string | null;
  enabled?: boolean;
  /** REST PATCH 만 — 제어 도구는 바꾸지 않는다(에이전트 DM 계획 판정 PD13) */
  dmAccess?: DmAccess;
};

export function rowToAgent(row: AgentRow): Agent {
  return parseStored(
    Agent,
    {
      id: row.id,
      workspaceId: row.workspaceId,
      provider: row.provider,
      providerAgentId: row.providerAgentId,
      handle: row.handle,
      name: row.name,
      avatarUrl: row.avatarUrl ?? undefined,
      basePrompt: row.basePrompt ?? undefined,
      enabled: row.enabled,
      createdAt: row.createdAt.toISOString(),
      archivedAt: row.archivedAt?.toISOString() ?? null,
      dmAccess: row.dmAccess,
      program: row.program,
    },
    "agent",
  );
}

/**
 * 런을 받을 수 있는 에이전트인가 — 켜져 있고 보관되지 않았다(계획 판정 PS2). 런을 만드는 판정 자리(라우터·상호작용·러너 묶기)가
 * 이 한 함수로 본다
 */
export function isAgentActive(agent: Pick<Agent, "enabled" | "archivedAt">): boolean {
  return agent.enabled && agent.archivedAt === null;
}

/** 살아 있는(보관하지 않은) 에이전트만 고르는 조건 — 채널 멤버·참가자·러너 묶기 조회가 함께 쓴다 */
export const agentNotArchived: SQL = isNull(agents.archivedAt);

type RunnerTokenRow = Pick<typeof runnerTokens.$inferSelect, "id" | "label" | "revokedAt">;
type GatewayNameRow = Pick<typeof gateways.$inferSelect, "id" | "name">;

/**
 * 에이전트 행 + 묶인 연결 요약(REST 응답의 Agent.runner·Agent.gateway). 러너 토큰 행이 없으면 runner 없이. OpenClaw 에이전트는
 * gateway 키가 늘 있다 — Gateway 가 지워졌으면 null
 */
function toApiAgent(
  row: AgentRow,
  token: RunnerTokenRow | null | undefined,
  gateway: GatewayNameRow | null | undefined,
): Agent {
  const agent = rowToAgent(row);
  return {
    ...agent,
    ...(token
      ? { runner: { tokenId: token.id, label: token.label, revoked: token.revokedAt !== null } }
      : {}),
    ...(row.provider === "openclaw"
      ? { gateway: gateway ? { id: gateway.id, name: gateway.name } : null }
      : {}),
  };
}

const runnerTokenColumns = {
  id: runnerTokens.id,
  label: runnerTokens.label,
  revokedAt: runnerTokens.revokedAt,
};

const gatewayNameColumns = { id: gateways.id, name: gateways.name };

/** REST 응답용 — 행 하나에 묶인 러너 토큰·Gateway 를 붙인다 */
export function apiAgent(db: DbOrTx, row: AgentRow): Agent {
  const token =
    row.runnerTokenId === null
      ? undefined
      : db.select(runnerTokenColumns).from(runnerTokens).where(eq(runnerTokens.id, row.runnerTokenId)).get();
  const gateway =
    row.gatewayId === null
      ? undefined
      : db.select(gatewayNameColumns).from(gateways).where(eq(gateways.id, row.gatewayId)).get();
  return toApiAgent(row, token, gateway);
}

/**
 * 같은 Gateway 에 그 id(대소문자 무시 — 유일 인덱스는 대소문자를 가린다)의 다른 OpenClaw 에이전트가 있으면 409. Gateway 가 빈
 * 에이전트끼리는 겹쳐도 된다 — 어느 연결의 것도 아니라 가를 대조가 없고, Gateway 를 지우면 같은 id 둘이 함께 비는 것이 자연스럽다
 * (서버는 런·정본·승인을 「연결 id + 세션 키」로 가른다 — adapters/connection.ts)
 */
function assertFreeOnGateway(
  tx: DbOrTx,
  input: { workspaceId: string; gatewayId: string; providerAgentId: string; exceptAgentId?: string },
): void {
  const taken = tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, input.workspaceId),
        eq(agents.provider, "openclaw"),
        eq(agents.gatewayId, input.gatewayId),
        providerAgentIdIs(input.providerAgentId),
        input.exceptAgentId === undefined ? undefined : ne(agents.id, input.exceptAgentId),
      ),
    )
    .get();
  if (taken) {
    throw apiError("CONFLICT", `providerAgentId ${input.providerAgentId} 는 그 Gateway 에 이미 등록돼 있다`, {
      field: "providerAgentId",
    });
  }
}

/** 같은 워크스페이스의 Gateway 여야 한다 — 아니면 400(없는 id 와 남의 것을 가르지 않는다) */
function assertWorkspaceGateway(tx: DbOrTx, workspaceId: string, gatewayId: string): GatewayNameRow {
  const row = getGatewayRow(tx, workspaceId, gatewayId);
  if (!row) throw apiError("VALIDATION", "gateway not found", { field: "gatewayId" });
  return row;
}

/**
 * 같은 자리(OpenClaw 는 같은 Gateway·id, 러너는 같은 id)의 보관한 에이전트 — 다시 가져오면 새로 만들지 않고 되살린다(스펙 「에이전트
 * 보관」 절의 API). 대소문자는 유일 규칙과 같이 무시한다
 */
export function findArchivedAgent(
  db: DbOrTx,
  input: { workspaceId: string; provider: string; providerAgentId: string; gatewayId: string | null },
): string | undefined {
  return db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.workspaceId, input.workspaceId),
        eq(agents.provider, input.provider),
        input.provider === "openclaw"
          ? input.gatewayId === null
            ? isNull(agents.gatewayId)
            : eq(agents.gatewayId, input.gatewayId)
          : undefined,
        providerAgentIdIs(input.providerAgentId),
        sql`${agents.archivedAt} IS NOT NULL`,
      ),
    )
    .get()?.id;
}

function assertNotArchived(
  tx: DbOrTx,
  input: { workspaceId: string; provider: string; providerAgentId: string; gatewayId: string | null },
): void {
  const archived = findArchivedAgent(tx, input);
  if (archived !== undefined) {
    throw apiError("AGENT_ARCHIVED", "삭제된 에이전트입니다", { agentId: archived });
  }
}

export function createAgent(db: Db, input: CreateAgentInput): Agent {
  if (input.provider === "runner") return createRunnerAgent(db, input);
  return db.transaction((tx) => {
    const gatewayId = input.gatewayId ?? null;
    // 보관한 에이전트는 핸들도 쥐고 있다 — 같은 자리면 핸들 409 보다 되살리기 안내가 먼저다
    if (gatewayId !== null) {
      assertNotArchived(tx, {
        workspaceId: input.workspaceId,
        provider: "openclaw",
        providerAgentId: input.providerAgentId,
        gatewayId,
      });
    }
    assertHandleFree(tx, input.workspaceId, input.handle);
    if (gatewayId !== null) {
      assertWorkspaceGateway(tx, input.workspaceId, gatewayId);
      assertFreeOnGateway(tx, {
        workspaceId: input.workspaceId,
        gatewayId,
        providerAgentId: input.providerAgentId,
      });
    }
    const row = tx
      .insert(agents)
      .values({
        ...commonValues(input),
        provider: "openclaw",
        providerAgentId: input.providerAgentId,
        gatewayId,
      })
      .returning()
      .get();
    return apiAgent(tx, row);
  });
}

function commonValues(input: CreateAgentCommon) {
  return {
    id: uuidv7(),
    workspaceId: input.workspaceId,
    handle: input.handle,
    name: input.name,
    avatarUrl: input.avatarUrl ?? null,
    basePrompt: input.basePrompt ?? null,
    enabled: input.enabled ?? true,
    createdAt: new Date(),
  };
}

const RunnerAgentFields = RunnerRunAgent.pick({
  model: true,
  permissionMode: true,
  allowedTools: true,
  disallowedTools: true,
});

/** 러너 에이전트의 서버 쪽 id — `r-` + 소문자 hex 10. 세션 키 규칙(OpenClaw agentId) 안이고 사람이 고르지 않는다 */
const RUNNER_AGENT_ID_TRIES = 8;
function newRunnerAgentId(tx: DbOrTx, workspaceId: string): string {
  for (let i = 0; i < RUNNER_AGENT_ID_TRIES; i += 1) {
    const id = `r-${randomBytes(5).toString("hex")}`;
    const taken = tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.workspaceId, workspaceId), eq(agents.provider, "runner"), providerAgentIdIs(id)))
      .get();
    if (!taken) return id;
  }
  throw apiError("INTERNAL", "could not pick a runner agent id");
}

function createRunnerAgent(db: Db, input: CreateRunnerAgentInput): Agent {
  const fields = RunnerAgentFields.safeParse({
    model: input.model ?? null,
    permissionMode: input.permissionMode ?? "default",
    allowedTools: input.allowedTools ?? null,
    disallowedTools: input.disallowedTools ?? [],
  });
  if (!fields.success) {
    const field = String(fields.error.issues[0]?.path[0] ?? "agent");
    throw apiError("VALIDATION", `invalid runner agent field: ${field}`, { field });
  }
  return db.transaction((tx) => {
    const project = tx
      .select({ runnerTokenId: runnerProjects.runnerTokenId, archivedAt: runnerProjects.archivedAt })
      .from(runnerProjects)
      .where(
        and(eq(runnerProjects.id, input.runnerProjectId), eq(runnerProjects.workspaceId, input.workspaceId)),
      )
      .get();
    if (!project) throw apiError("VALIDATION", "runner project not found", { field: "runnerProjectId" });
    // 보관한 프로젝트로는 새 에이전트를 만들지 않는다 — 이미 있는 에이전트는 남고 런도 돈다(스펙 8장)
    if (project.archivedAt !== null)
      throw apiError("VALIDATION", "runner project is archived", { field: "runnerProjectId" });
    assertHandleFree(tx, input.workspaceId, input.handle);
    const row = tx
      .insert(agents)
      .values({
        ...commonValues(input),
        provider: "runner",
        providerAgentId: newRunnerAgentId(tx, input.workspaceId),
        program: input.program,
        runnerTokenId: project.runnerTokenId,
        runnerProjectId: input.runnerProjectId,
        model: fields.data.model,
        permissionMode: fields.data.permissionMode,
        allowedToolsJson: fields.data.allowedTools,
        disallowedToolsJson: fields.data.disallowedTools,
      })
      .returning()
      .get();
    return apiAgent(tx, row);
  });
}

/**
 * OpenClaw 에이전트를 다른 Gateway 로 옮긴다(멀티 Gateway 스펙 「에이전트 API」 절, owner). 대상에 같은 id 가 있으면 409, 러너 에이전트는 400.
 * 도는 런은 맡은 연결(runs.connection_id)에서 끝까지 가고, 아직 보내지 않은 런은 디스패치 때 닫힌다(runs/orchestrator.ts dispatch).
 * previousGatewayId 는 채널 프롬프트 동기화가 새로 들어온 Gateway 를 가를 때 쓴다
 */
export function moveAgentGateway(
  db: Db,
  input: { workspaceId: string; agentId: string; gatewayId: string },
): { agent: Agent; previousGatewayId: string | null } {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, input.agentId), eq(agents.workspaceId, input.workspaceId)))
      .get();
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    if (current.provider !== "openclaw")
      throw apiError("VALIDATION", "only OpenClaw agents belong to a gateway", { field: "gatewayId" });
    assertWorkspaceGateway(tx, input.workspaceId, input.gatewayId);
    if (current.gatewayId === input.gatewayId)
      return { agent: apiAgent(tx, current), previousGatewayId: current.gatewayId };
    assertFreeOnGateway(tx, {
      workspaceId: input.workspaceId,
      gatewayId: input.gatewayId,
      providerAgentId: current.providerAgentId,
      exceptAgentId: current.id,
    });
    const row = tx
      .update(agents)
      .set({ gatewayId: input.gatewayId })
      .where(eq(agents.id, current.id))
      .returning()
      .get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return { agent: apiAgent(tx, row), previousGatewayId: current.gatewayId };
  });
}

export function updateAgent(db: Db, id: string, patch: AgentPatch): Agent {
  return db.transaction((tx) => {
    const current = tx.select().from(agents).where(eq(agents.id, id)).get();
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    if (patch.handle !== undefined && patch.handle !== current.handle) {
      assertHandleFree(tx, current.workspaceId, patch.handle);
    }
    const set: Partial<AgentRow> = {};
    if (patch.handle !== undefined) set.handle = patch.handle;
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.avatarUrl !== undefined) set.avatarUrl = patch.avatarUrl;
    if (patch.basePrompt !== undefined) {
      set.basePrompt = patch.basePrompt;
      // 지시가 실제로 바뀔 때만 — 러너 세션이 이 값으로 새로 열린다(계획 판정 PR2). 빈 지시는 없는 것과 같다
      if ((patch.basePrompt ?? null) !== (current.basePrompt ?? null))
        set.instructionsRevision = current.instructionsRevision + 1;
    }
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.dmAccess !== undefined) set.dmAccess = patch.dmAccess;
    if (Object.keys(set).length === 0) return apiAgent(tx, current);
    const row = tx.update(agents).set(set).where(eq(agents.id, id)).returning().get();
    if (!row) throw apiError("NOT_FOUND", "agent not found");
    return apiAgent(tx, row);
  });
}

export type ArchiveDeps = {
  /** 사람 「중지」와 같은 길(run.abort) — 진행 런은 어댑터에 중단을 보내고, 대기 런은 보내지 않고 닫는다. 걸린 승인은 cancelled 로 닫힌다 */
  orchestrator: Pick<Orchestrator, "abort">;
};

/**
 * 보관(스펙 「에이전트 보관」 절) — archived_at 을 쓰고 그 에이전트의 열린 런을 멈춘다. 이미 보관했으면 그대로(멱등), 행·핸들·채널
 * 참여·세션은 남는다. 새 런은 런 관문이 막는다(ops/budget.ts) — 쓰기가 끝난 뒤 들어온 멘션은 런을 만들지 않고, 쓰기 전에 만든 런은
 * 아래 훑기가 닫는다. 대기 런을 보내지 않는 것은 두 겹이다 — 훑기는 대기 런(뒤)부터 거꾸로 닫아 진행 런이 끝난 뒤 pump 가 꺼낼 런을
 * 남기지 않고, 그래도 꺼낸 런은 디스패치 가드(runs/orchestrator.ts dispatch)가 보관을 보고 보내지 않은 채 닫는다
 */
export async function archiveAgent(
  db: Db,
  deps: ArchiveDeps,
  id: string,
  workspaceId: string,
): Promise<Agent> {
  const row = db
    .update(agents)
    .set({ archivedAt: new Date() })
    .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId), isNull(agents.archivedAt)))
    .returning()
    .get();
  const current =
    row ??
    db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
      .get();
  if (!current) throw apiError("NOT_FOUND", "agent not found");
  const open = listOpenRuns(db).filter((run) => run.agentId === id);
  for (const run of open.reverse()) await deps.orchestrator.abort(run.id);
  return apiAgent(db, current);
}

/** 프로젝트가 없는 러너 에이전트(0031 이 보관)를 되살리려 할 때 — 화면 문구와 같다 */
export const RUNNER_AGENT_WITHOUT_PROJECT = "프로젝트가 없어 되살릴 수 없습니다 — 새로 만드세요";

/**
 * 되살리기 — archived_at 을 비운다. 살아 있으면 그대로. 핸들은 보관 중에도 이 에이전트 몫이라 겹칠 수 없다.
 * 자동 응답은 채널당 하나다 — 보관 중에는 멤버 응답이 이 에이전트를 걸러 웹이 다른 에이전트를 켤 때 이 행을 끌 수 없으므로, 같은
 * 채널에 살아 있는 다른 에이전트의 자동 응답이 켜져 있으면 되살린 쪽을 끈다. 끈 채널은 호출자가 channel.member.changed 로 알린다
 */
export function restoreAgent(
  db: Db,
  id: string,
  workspaceId: string,
): { agent: Agent; autoRespondOffChannelIds: string[] } {
  return db.transaction((tx) => {
    const archived = tx
      .select({ provider: agents.provider, runnerProjectId: agents.runnerProjectId })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId), isNotNull(agents.archivedAt)))
      .get();
    // 「보관되지 않은 러너 에이전트는 프로젝트가 있다」(계획 판정 PR4) — 0031 이 보관한 옛 러너 에이전트는 되살리지 않는다
    if (archived?.provider === "runner" && archived.runnerProjectId === null)
      throw apiError("VALIDATION", RUNNER_AGENT_WITHOUT_PROJECT, { field: "runnerProjectId" });
    const row = tx
      .update(agents)
      .set({ archivedAt: null })
      .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId), isNotNull(agents.archivedAt)))
      .returning()
      .get();
    const current =
      row ??
      tx
        .select()
        .from(agents)
        .where(and(eq(agents.id, id), eq(agents.workspaceId, workspaceId)))
        .get();
    if (!current) throw apiError("NOT_FOUND", "agent not found");
    const autoRespondOffChannelIds = row === undefined ? [] : clearContestedAutoRespond(tx, id);
    return { agent: apiAgent(tx, current), autoRespondOffChannelIds };
  });
}

/** 그 에이전트가 자동 응답을 켠 채널 가운데 살아 있는 다른 에이전트도 켠 채널에서 그 에이전트의 자동 응답을 끄고 채널 id 를 돌려준다 */
function clearContestedAutoRespond(tx: DbOrTx, agentId: string): string[] {
  const other = alias(channelMembers, "other");
  const contested = tx
    .selectDistinct({ channelId: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(
      other,
      and(
        eq(other.channelId, channelMembers.channelId),
        eq(other.memberType, "agent"),
        ne(other.memberId, agentId),
        eq(other.autoRespond, true),
      ),
    )
    .innerJoin(agents, and(eq(agents.id, other.memberId), agentNotArchived))
    .where(
      and(
        eq(channelMembers.memberType, "agent"),
        eq(channelMembers.memberId, agentId),
        eq(channelMembers.autoRespond, true),
      ),
    )
    .all()
    .map((r) => r.channelId);
  if (contested.length === 0) return [];
  tx.update(channelMembers)
    .set({ autoRespond: false })
    .where(
      and(
        eq(channelMembers.memberType, "agent"),
        eq(channelMembers.memberId, agentId),
        inArray(channelMembers.channelId, contested),
      ),
    )
    .run();
  return contested;
}

/** REST 목록 — 묶인 러너 토큰(라벨·폐기 여부)과 Gateway(이름)를 붙인다. 보관한 에이전트도 싣는다(archivedAt 으로 가른다) */
export function listAgents(db: DbOrTx, workspaceId: string): Agent[] {
  return db
    .select({ agent: agents, token: runnerTokenColumns, gateway: gatewayNameColumns })
    .from(agents)
    .leftJoin(runnerTokens, eq(runnerTokens.id, agents.runnerTokenId))
    .leftJoin(gateways, eq(gateways.id, agents.gatewayId))
    .where(eq(agents.workspaceId, workspaceId))
    .orderBy(asc(agents.createdAt), asc(agents.id))
    .all()
    .map(({ agent, token, gateway }) => toApiAgent(agent, token, gateway));
}

/** workspaceId 를 주면 그 워크스페이스 것만 찾는다(REST 는 항상 준다). */
export function getAgent(db: DbOrTx, id: string, workspaceId?: string): Agent | undefined {
  const row = db
    .select()
    .from(agents)
    .where(
      and(eq(agents.id, id), workspaceId === undefined ? undefined : eq(agents.workspaceId, workspaceId)),
    )
    .get();
  return row ? rowToAgent(row) : undefined;
}
