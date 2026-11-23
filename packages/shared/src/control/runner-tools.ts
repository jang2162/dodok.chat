import { z } from "zod";
import { Id } from "../common";
import { RunnerBotDefinition, SessionDefaults } from "../domain";
import { CreateRunnerProjectAgentBody } from "./rest-bodies";
import {
  ArchiveRunnerProjectBody,
  CreateRunnerProjectBody,
  CreateWorktreeBody,
  RenameRunnerProjectBody,
} from "./runner-bodies";
import type { ControlTool } from "./tools";

// 「이 러너 설정 제어」 도구(러너 봇 2부 스펙 T7~T10·T14·T16) — 내장 도구 runnerControl 을 켠 봇의 런에만 러너가 dodok MCP 에 싣고,
// 서버는 러너 경로(`/runner` control.call)에서만 받는다(`/mcp`·브리지는 모르는 도구). 대상 러너는 인자로 받지 않는다 — 서버가 그 런의
// 연결(러너 토큰)에서 정한다. 입력은 같은 REST 본문 스키마에서 꺼내되 권한을 올리는 필드(mcpServers·mcpAutoAllow·builtinTools·
// sessionDefaults.permissionMode)는 뺀다(T14 — 그 넷은 사람이 웹에서만). 역할 요구·확인 카드는 CONTROL_TOOLS 와 같은 규칙이다

/** 러너 머신의 로컬 설정은 못 바꾼다는 것(T10) — 「루트를 더해 줘」 같은 요청에 봇이 사람에게 안내하게 */
export const RUNNER_CONTROL_LOCAL_NOTICE =
  "These tools only change what the dodok app knows about this bot's own runner. They cannot change the runner machine's local config file (allowed roots, programs, permission ceiling, app MCP policy, remote update) — when asked for that, tell the person to edit config.json on the runner machine and restart the runner.";

function tool<const N extends string, I extends z.ZodObject>(
  t: { name: N; input: I } & Omit<ControlTool<I>, "name" | "input">,
): Omit<ControlTool<I>, "name"> & { name: N } {
  // CONTROL_TOOLS 와 같은 까닭 — 모르는 키를 버리면 모델이 「바꿨다」고 믿는다
  return { ...t, input: t.input.strict() as I };
}

const ProjectRef = z.object({ projectId: Id });

/** 봇 정의 네 칸만 — 도구·내장 도구는 사람이 웹에서만(T14). strict — 실으면 거절한다 */
export const RunnerControlBotDefinition = RunnerBotDefinition.omit({
  mcpServers: true,
  mcpAutoAllow: true,
  builtinTools: true,
}).strict();

/** 새 세션 시작값 — 권한 모드는 뺀다(T14). strict — permissionMode 를 실으면 거절한다 */
export const RunnerControlSessionDefaults = SessionDefaults.omit({ permissionMode: true }).partial().strict();

export const RUNNER_CONTROL_TOOLS = [
  tool({
    name: "runner_status",
    access: "read",
    description:
      "Show this bot's runner: label, connected, runner version and the latest published version, roots, programs with their ceilings, capabilities, and any pending update. " +
      RUNNER_CONTROL_LOCAL_NOTICE,
    input: z.object({}),
  }),
  tool({
    name: "list_runner_projects",
    access: "read",
    description:
      "List this runner's projects (id, root, relative path, label, agent count, worktree branch). archived: true lists archived projects too.",
    input: z.object({ archived: z.boolean().optional() }),
  }),
  tool({
    name: "create_runner_project",
    access: "write",
    description:
      "Add a project on this runner: a folder inside one of its roots (rootId from runner_status, relPath relative to the root, empty for the root itself). The runner checks the folder first. " +
      RUNNER_CONTROL_LOCAL_NOTICE,
    input: CreateRunnerProjectBody,
  }),
  tool({
    name: "update_runner_project",
    access: "write",
    description: "Rename one of this runner's projects.",
    input: ProjectRef.extend(RenameRunnerProjectBody.shape),
  }),
  tool({
    name: "archive_runner_project",
    access: "write",
    description:
      "Archive one of this runner's projects. A worktree project's folder is removed by the runner unless keepFolder is true; existing agents keep running.",
    input: ProjectRef.extend(ArchiveRunnerProjectBody.shape),
  }),
  tool({
    name: "add_runner_worktree",
    access: "write",
    description:
      "Create a git worktree under one of this runner's git projects (label required; branch defaults to dodok/<slug>, location defaults to <project>/.worktrees/<slug>).",
    input: ProjectRef.extend(CreateWorktreeBody.shape),
  }),
  tool({
    name: "list_runner_agents",
    access: "read",
    description:
      "List the runner agents and bots on this runner (id, handle, name, program, project or bot, enabled, archived, session defaults).",
    input: z.object({}),
  }),
  tool({
    name: "create_runner_agent",
    access: "write",
    description:
      "Create an agent on this runner: in a project (runnerProjectId, optional basePrompt instructions) or as a bot (bot: purpose, watches, does, reports). Tools, built-in tools and permission mode are set by a person in the dodok web app, not here.",
    input: CreateRunnerProjectAgentBody.pick({
      handle: true,
      name: true,
      avatarUrl: true,
      program: true,
      enabled: true,
      basePrompt: true,
    })
      .extend({
        runnerProjectId: Id.optional(),
        bot: RunnerControlBotDefinition.optional(),
      })
      .refine((b) => (b.runnerProjectId === undefined) !== (b.bot === undefined), {
        message: "give exactly one of runnerProjectId or bot",
      })
      .refine((b) => b.bot === undefined || b.basePrompt === undefined, {
        message: "a bot uses its definition instead of basePrompt",
      }),
  }),
  tool({
    name: "set_agent_session_defaults",
    access: "write",
    description:
      "Change the new-session defaults (model, effort; null means the program default) of another agent or bot on this runner. Permission mode is set by a person in the dodok web app. You cannot change yourself.",
    input: z.object({ agentId: Id, sessionDefaults: RunnerControlSessionDefaults }),
  }),
  tool({
    name: "request_runner_update",
    access: "write",
    description:
      "Update this runner to the latest published version. The runner refuses to update while any run is going, so the update is scheduled: dodok sends it when all of this runner's runs have finished (including this one).",
    input: z.object({}),
  }),
] as const;

export type AnyRunnerControlTool = (typeof RUNNER_CONTROL_TOOLS)[number];
export type RunnerControlToolName = AnyRunnerControlTool["name"];

/** 이름으로 찾는다 — 모르는 이름이면 undefined */
export function findRunnerControlTool<N extends RunnerControlToolName>(
  name: N,
): Extract<AnyRunnerControlTool, { name: N }>;
export function findRunnerControlTool(name: string): AnyRunnerControlTool | undefined;
export function findRunnerControlTool(name: string): AnyRunnerControlTool | undefined {
  return RUNNER_CONTROL_TOOLS.find((t) => t.name === name);
}

/** request_runner_update 의 결과 글(T16) */
export const RUNNER_UPDATE_SCHEDULED_MESSAGE = "예약됨 — 이 러너의 런이 모두 끝나면 업데이트합니다";
