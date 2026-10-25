import type { AnyControlTool, ControlToolName, Message, OpsStatus, TeamRole } from "@dodok/shared";
import type { z } from "zod";
import {
  authorizeAgentArchive,
  authorizeAgentDiscover,
  authorizeAgentPatch,
  authorizeAgentRegister,
  authorizeChannelAgentPatch,
  authorizeChannelArchive,
  authorizeChannelCreate,
  authorizeChannelMemberAdd,
  authorizeChannelMemberRemove,
  authorizeChannelPatch,
  authorizeChannelUnarchive,
  authorizeOpsRead,
  authorizeRead,
} from "../../auth/policies";
import type { Db } from "../../db/client";
import { apiError } from "../../http/errors";
import { josa } from "../../util/josa";
import {
  type AgentActionContext,
  archiveAgentAndNotify,
  discoverAgents,
  patchAgentAndNotify,
  registerAgentAndNotify,
} from "../agents/actions";
import { getAgent, listAgents } from "../agents/service";
import {
  addChannelMemberAndNotify,
  archiveChannelAndNotify,
  type ChannelActionContext,
  createChannelAndNotify,
  patchChannelAndNotify,
  removeChannelMemberAndNotify,
  unarchiveChannelAndNotify,
  updateChannelAgentAndNotify,
} from "../channels/actions";
import {
  assertChannelWritable,
  type ChannelRecord,
  getChannel,
  listChannels,
  listMembers,
} from "../channels/service";
import { listConversations } from "../conversations/service";
import { getConversation } from "../conversations/store";
import { listPeople } from "../members/people";
import { getThreadRoot, listMessages, withThreadSummaries } from "../messages/service";
import { getRunInWorkspace } from "../runs/store";
import { type HandleOf, readableMentions } from "../search/readable";
import { mentionHandleOf, searchMessages } from "../search/service";
import type { Principal } from "./principal";

// 도구마다 처리기 하나(제어 MCP 스펙 「도구」 장) — 역할은 같은 REST 경로의 정책 함수(auth/policies.ts, 계획 판정 PC1)로, 실행은 REST 가
// 부르는 같은 서비스·액션 함수로 한다(결정 6). 도구마다 권한 표를 따로 두지 않는다

export type HandlerContext = {
  db: Db;
  workspaceId: string;
  channels: ChannelActionContext;
  agents: AgentActionContext;
  opsStatus(): OpsStatus;
  now(): Date;
};

type InputOf<N extends ControlToolName> = z.output<Extract<AnyControlTool, { name: N }>["input"]>;

/** 확인 카드 제목·시스템 메시지의 술어 — want 는 「…하려 합니다」(카드 제목, 채널 이름 포함), done 은 「…했습니다」(그 채널의 시스템 메시지) */
export type Wording = { want: string; done: string };

export type ControlHandler<N extends ControlToolName> = {
  /**
   * 역할 검사 — 같은 REST 경로의 정책 함수. 본문을 보는 정책에는 REST 본문 꼴로 바꾼 **원래 인자**(raw)를 넘긴다 — 파싱이 채운 기본값
   * (autoRespond:false 등)을 세면 member 가 별칭만 바꿔도 admin 이 필요해진다(REST 도 원래 본문을 넘긴다)
   */
  authorize(role: TeamRole | undefined, raw: Record<string, unknown>): void;
  /** 실행 전 상태 검사 — 없으면 NOT_FOUND, 보관한 채널의 쓰기는 CHANNEL_ARCHIVED. 확인 카드를 띄우기 전에, 허용 뒤에 한 번 더 */
  check?(ctx: HandlerContext, input: InputOf<N>): void;
  /** 바꾼 채널 — 쓰기 뒤 그 채널에 시스템 메시지를 남기고 사건 detail 에 싣는다 */
  channelId?(input: InputOf<N>): string;
  /** 바꾼 에이전트 — 사건 detail 의 targetAgentId */
  targetAgentId?(input: InputOf<N>): string;
  /** 쓰기 도구의 문구 */
  wording?(ctx: HandlerContext, input: InputOf<N>): Wording;
  /** 확인 카드 설명 — 바뀔 내용 요약(값은 앞부분만). 없으면 설명 없이 */
  summary?(ctx: HandlerContext, input: InputOf<N>): string | undefined;
  run(ctx: HandlerContext, input: InputOf<N>, principal: Principal): unknown;
};

/** 확인 카드 설명에 싣는 값의 길이 — 프롬프트는 앞 300자(스펙 「확인 카드」 장) */
const SUMMARY_VALUE_MAX = 300;

function clip(text: string, max = SUMMARY_VALUE_MAX): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}

function without(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !keys.includes(key)));
}

function channelOf(ctx: HandlerContext, channelId: string): ChannelRecord {
  const channel = getChannel(ctx.db, channelId, ctx.workspaceId);
  if (!channel) throw apiError("NOT_FOUND", "channel not found");
  return channel;
}

function agentHandle(ctx: HandlerContext, agentId: string): string {
  const agent = getAgent(ctx.db, agentId, ctx.workspaceId);
  if (!agent) throw apiError("NOT_FOUND", "agent not found");
  return agent.handle;
}

/** 채널 쓰기 — 없으면 NOT_FOUND, 보관했으면 CHANNEL_ARCHIVED(REST 쓰기 경로와 같은 함수) */
function writable(ctx: HandlerContext, channelId: string): void {
  assertChannelWritable(ctx.db, channelId, ctx.workspaceId);
}

const name = (ctx: HandlerContext, channelId: string) => `#${channelOf(ctx, channelId).name}`;

/** 목적격 조사 — 「을(를)」처럼 병기하지 않는다(util/josa.ts) */
const eul = (word: string) => josa(word, "을", "를");

/** 에이전트가 읽는 메시지 한 줄 — 멘션은 @핸들, 작성자도 핸들로 */
function readable(handleOf: HandleOf, message: Message) {
  const author =
    message.authorType === "user" || message.authorType === "agent"
      ? `@${(message.authorId && handleOf(message.authorType === "user" ? "u" : "a", message.authorId)) ?? "알 수 없음"}`
      : message.authorType;
  return {
    id: message.id,
    seq: message.seq,
    author,
    authorType: message.authorType,
    text: readableMentions(message.bodyMd, handleOf),
    ...(message.attachments.length === 0 ? {} : { attachments: message.attachments.map((a) => a.name) }),
    ...(message.threadRootId === undefined ? {} : { threadRootId: message.threadRootId }),
    ...(message.threadSummary === undefined ? {} : { replyCount: message.threadSummary.count }),
    createdAt: message.createdAt,
  };
}

function relayPolicyText(policy: {
  maxRelayTurns: number;
  allowPairs: "all" | Array<{ from: string; to: string }>;
}) {
  const pairs =
    policy.allowPairs === "all"
      ? "모든 쌍"
      : policy.allowPairs.map((p) => `${p.from}→${p.to}`).join(", ") || "없음";
  return `릴레이 최대 ${policy.maxRelayTurns}번 · 허용 쌍: ${clip(pairs)}`;
}

type Handlers = { [N in ControlToolName]: ControlHandler<N> };

export const HANDLERS: Handlers = {
  // ── 읽기 ────────────────────────────────────────────────────
  list_channels: {
    authorize: (role) => authorizeRead(role),
    run: (ctx, input) => ({
      channels: listChannels(ctx.db, ctx.workspaceId, { archived: input.archived === true }),
    }),
  },
  get_channel: {
    authorize: (role) => authorizeRead(role),
    run: (ctx, input) => {
      const channel = channelOf(ctx, input.channelId);
      const handleOf = mentionHandleOf(ctx.db, ctx.workspaceId);
      const members = listMembers(ctx.db, channel.id).map((m) => ({
        ...m,
        handle: handleOf(m.memberType === "agent" ? "a" : "u", m.memberId),
      }));
      return { channel, members };
    },
  },
  list_agents: {
    authorize: (role) => authorizeRead(role),
    run: (ctx) => ({ agents: listAgents(ctx.db, ctx.workspaceId) }),
  },
  list_people: {
    authorize: (role) => authorizeRead(role),
    run: (ctx) => ({ people: listPeople(ctx.db, ctx.workspaceId) }),
  },
  search_messages: {
    authorize: (role) => authorizeRead(role),
    // 검색 결과의 가시 범위는 지금 사람과 무관하다(워크스페이스의 모든 채널) — 시킨 사람이 없는 런도 같은 범위다
    run: (ctx, input, principal) =>
      searchMessages(ctx.db, ctx.workspaceId, principal.userId ?? "", input, ctx.now()),
  },
  list_conversations: {
    authorize: (role) => authorizeRead(role),
    // REST GET /channels/:id/conversations 와 같은 함수·같은 쪽 — read_messages 의 conversationId 를 얻는 길이다
    run: (ctx, input) =>
      listConversations(ctx.db, channelOf(ctx, input.channelId).id, {
        status: input.status,
        ...(input.q === undefined ? {} : { q: input.q }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      }),
  },
  read_messages: {
    authorize: (role) => authorizeRead(role),
    // 한 세션 안만 읽는다 — 채널 경로로 읽으면 세션이 섞인다(웹 REST /conversations/:id/messages 와 같은 규칙).
    // 읽기 범위는 채널 단위 그대로다: 채널 안 에이전트도 같은 채널의 다른 세션을 읽을 수 있다(채널 세션 스펙 「wire·REST」 장 —
    // 막는 것은 세션 밖으로 보내기뿐이다)
    run: (ctx, input) => {
      const conversation = getConversation(ctx.db, input.conversationId, ctx.workspaceId);
      if (!conversation) throw apiError("NOT_FOUND", "conversation not found");
      if (input.threadRootId !== undefined) {
        const root = getThreadRoot(ctx.db, conversation.channelId, input.threadRootId);
        if (!root || root.conversationId !== conversation.id) throw apiError("NOT_FOUND", "thread not found");
      }
      const page = listMessages(ctx.db, conversation.channelId, {
        conversationId: conversation.id,
        limit: input.limit,
        ...(input.beforeSeq === undefined ? {} : { beforeSeq: input.beforeSeq }),
        ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
        ...(input.around === undefined ? {} : { aroundSeq: input.around }),
        ...(input.threadRootId === undefined ? {} : { scope: { threadRootId: input.threadRootId } }),
      });
      const handleOf = mentionHandleOf(ctx.db, ctx.workspaceId);
      const messages =
        input.threadRootId === undefined ? withThreadSummaries(ctx.db, page.messages) : page.messages;
      return {
        messages: messages.map((m) => readable(handleOf, m)),
        hasMore: page.hasMore,
        ...(page.hasMoreAfter === undefined ? {} : { hasMoreAfter: page.hasMoreAfter }),
      };
    },
  },
  get_run: {
    authorize: (role) => authorizeRead(role),
    run: (ctx, input) => {
      const run = getRunInWorkspace(ctx.db, input.runId, ctx.workspaceId);
      if (!run) throw apiError("NOT_FOUND", "run not found");
      return { run };
    },
  },
  ops_status: {
    authorize: (role) => authorizeOpsRead(role),
    run: (ctx) => ctx.opsStatus(),
  },
  discover_agents: {
    authorize: (role) => authorizeAgentDiscover(role),
    run: (ctx, input) => discoverAgents(ctx.agents, input, ctx.workspaceId),
  },

  // ── 채널 ────────────────────────────────────────────────────
  create_channel: {
    authorize: (role, raw) => authorizeChannelCreate(role, raw),
    wording: (_ctx, input) => ({
      want: `채널 #${input.name} ${eul(input.name)} 만들려 합니다`,
      done: `채널 #${input.name} ${eul(input.name)} 만들었습니다`,
    }),
    summary: (_ctx, input) =>
      [
        input.topic === undefined ? undefined : `주제: ${clip(input.topic)}`,
        input.prompt === undefined ? undefined : `채널 프롬프트: ${clip(input.prompt)}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n") || undefined,
    run: (ctx, input, principal) => {
      if (principal.userId === null) throw apiError("FORBIDDEN", "사람이 시킨 런에서만 바꿀 수 있습니다");
      return { channel: createChannelAndNotify(ctx.channels, input, ctx.workspaceId, principal.userId) };
    },
  },
  update_channel: {
    authorize: (role, raw) => authorizeChannelPatch(role, without(raw, "channelId")),
    check: (ctx, input) => writable(ctx, input.channelId),
    channelId: (input) => input.channelId,
    wording: (ctx, input) => ({
      want: `${name(ctx, input.channelId)} 의 이름·주제를 바꾸려 합니다`,
      done: "채널 이름·주제를 바꿨습니다",
    }),
    summary: (_ctx, input) =>
      [
        input.name === undefined ? undefined : `이름: ${input.name}`,
        input.topic === undefined
          ? undefined
          : `주제: ${input.topic === null ? "(지움)" : clip(input.topic)}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n") || undefined,
    run: (ctx, input) => {
      const { channelId, ...patch } = input;
      return { channel: patchChannelAndNotify(ctx.channels, channelId, patch) };
    },
  },
  set_channel_prompt: {
    authorize: (role, raw) => authorizeChannelPatch(role, without(raw, "channelId")),
    check: (ctx, input) => writable(ctx, input.channelId),
    channelId: (input) => input.channelId,
    wording: (ctx, input) =>
      input.prompt === null
        ? {
            want: `${name(ctx, input.channelId)} 의 채널 프롬프트를 지우려 합니다`,
            done: "채널 프롬프트를 지웠습니다",
          }
        : {
            want: `${name(ctx, input.channelId)} 의 채널 프롬프트를 바꾸려 합니다`,
            done: "채널 프롬프트를 바꿨습니다",
          },
    summary: (_ctx, input) => (input.prompt === null ? undefined : `새 채널 프롬프트: ${clip(input.prompt)}`),
    run: (ctx, input) => ({
      channel: patchChannelAndNotify(ctx.channels, input.channelId, { prompt: input.prompt }),
    }),
  },
  add_channel_agent: {
    authorize: (role, raw) =>
      authorizeChannelMemberAdd(role, {
        memberType: "agent",
        memberId: raw.agentId,
        ...without(raw, "channelId", "agentId"),
      }),
    check: (ctx, input) => {
      writable(ctx, input.channelId);
      agentHandle(ctx, input.agentId);
    },
    channelId: (input) => input.channelId,
    targetAgentId: (input) => input.agentId,
    wording: (ctx, input) => {
      const handle = agentHandle(ctx, input.agentId);
      return {
        want: `${name(ctx, input.channelId)} 에 @${handle} ${eul(handle)} 넣으려 합니다`,
        done: `@${handle} ${eul(handle)} 채널에 넣었습니다`,
      };
    },
    summary: (_ctx, input) =>
      [
        input.autoRespond === true ? "자동 응답: 켬" : undefined,
        input.promptOverride === undefined ? undefined : `채널별 프롬프트: ${clip(input.promptOverride)}`,
        input.aliases.length === 0 ? undefined : `별칭: ${input.aliases.join(", ")}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n") || undefined,
    run: (ctx, input) => {
      const { channelId, agentId, ...rest } = input;
      return {
        member: addChannelMemberAndNotify(ctx.channels, channelId, {
          memberType: "agent",
          memberId: agentId,
          ...rest,
        }),
      };
    },
  },
  remove_channel_agent: {
    authorize: (role) => authorizeChannelMemberRemove(role),
    // 사람 id 를 주면 사람 멤버가 빠진다(removeMember 는 종류를 보지 않는다) — 에이전트인지 먼저 본다
    check: (ctx, input) => {
      writable(ctx, input.channelId);
      agentHandle(ctx, input.agentId);
    },
    channelId: (input) => input.channelId,
    targetAgentId: (input) => input.agentId,
    wording: (ctx, input) => {
      const handle = agentHandle(ctx, input.agentId);
      return {
        want: `${name(ctx, input.channelId)} 에서 @${handle} ${eul(handle)} 빼려 합니다`,
        done: `@${handle} ${eul(handle)} 채널에서 뺐습니다`,
      };
    },
    run: (ctx, input) => ({
      members: removeChannelMemberAndNotify(ctx.channels, input.channelId, input.agentId),
    }),
  },
  update_channel_agent: {
    authorize: (role, raw) => authorizeChannelAgentPatch(role, without(raw, "channelId", "agentId")),
    check: (ctx, input) => {
      writable(ctx, input.channelId);
      agentHandle(ctx, input.agentId);
    },
    channelId: (input) => input.channelId,
    targetAgentId: (input) => input.agentId,
    wording: (ctx, input) => {
      const handle = agentHandle(ctx, input.agentId);
      return {
        want: `${name(ctx, input.channelId)} 에서 @${handle} 의 채널 설정을 바꾸려 합니다`,
        done: `@${handle} 의 채널 설정을 바꿨습니다`,
      };
    },
    summary: (_ctx, input) =>
      [
        input.autoRespond === undefined ? undefined : `자동 응답: ${input.autoRespond ? "켬" : "끔"}`,
        input.promptOverride === undefined
          ? undefined
          : `채널별 프롬프트: ${input.promptOverride === null ? "(지움)" : clip(input.promptOverride)}`,
        input.aliases === undefined ? undefined : `별칭: ${input.aliases.join(", ") || "(없음)"}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n") || undefined,
    run: (ctx, input) => {
      const { channelId, agentId, ...patch } = input;
      return { member: updateChannelAgentAndNotify(ctx.channels, channelId, agentId, patch) };
    },
  },
  set_relay_policy: {
    authorize: (role, raw) => authorizeChannelPatch(role, without(raw, "channelId")),
    check: (ctx, input) => writable(ctx, input.channelId),
    channelId: (input) => input.channelId,
    wording: (ctx, input) => ({
      want: `${name(ctx, input.channelId)} 의 릴레이 정책을 바꾸려 합니다`,
      done: "릴레이 정책을 바꿨습니다",
    }),
    summary: (_ctx, input) => relayPolicyText(input.relayPolicy),
    // 일일 한도는 그대로 둔다 — REST PATCH 의 relayPolicy 는 통째로 바꾸므로 지금 값과 합쳐 넘긴다
    run: (ctx, input) => {
      const current = channelOf(ctx, input.channelId).relayPolicy;
      return {
        channel: patchChannelAndNotify(ctx.channels, input.channelId, {
          relayPolicy: { ...current, ...input.relayPolicy },
        }),
      };
    },
  },
  set_channel_run_limit: {
    authorize: (role, raw) =>
      authorizeChannelPatch(role, { relayPolicy: { dailyRunLimit: raw.dailyRunLimit } }),
    check: (ctx, input) => writable(ctx, input.channelId),
    channelId: (input) => input.channelId,
    wording: (ctx, input) => ({
      want: `${name(ctx, input.channelId)} 의 일일 런 한도를 바꾸려 합니다`,
      done: "채널 일일 런 한도를 바꿨습니다",
    }),
    summary: (_ctx, input) =>
      input.dailyRunLimit === null
        ? "일일 런 한도: 없음(워크스페이스 한도만)"
        : `일일 런 한도: ${input.dailyRunLimit}`,
    run: (ctx, input) => {
      const { dailyRunLimit: _old, ...rest } = channelOf(ctx, input.channelId).relayPolicy;
      return {
        channel: patchChannelAndNotify(ctx.channels, input.channelId, {
          relayPolicy: input.dailyRunLimit === null ? rest : { ...rest, dailyRunLimit: input.dailyRunLimit },
        }),
      };
    },
  },
  archive_channel: {
    authorize: (role) => authorizeChannelArchive(role),
    // 보관 해제 말고는 보관한 채널의 쓰기를 모두 미리 거절한다 — 이미 보관한 채널을 다시 보관하는 카드도 띄우지 않는다
    check: (ctx, input) => writable(ctx, input.channelId),
    channelId: (input) => input.channelId,
    wording: (ctx, input) => {
      const channel = name(ctx, input.channelId);
      return { want: `${channel} ${eul(channel)} 보관하려 합니다`, done: "채널을 보관했습니다" };
    },
    run: async (ctx, input) => ({
      channel: await archiveChannelAndNotify(ctx.channels, input.channelId, ctx.workspaceId),
    }),
  },
  unarchive_channel: {
    authorize: (role) => authorizeChannelUnarchive(role),
    check: (ctx, input) => void channelOf(ctx, input.channelId),
    channelId: (input) => input.channelId,
    wording: (ctx, input) => ({
      want: `${name(ctx, input.channelId)} 의 보관을 풀려 합니다`,
      done: "채널 보관을 풀었습니다",
    }),
    run: (ctx, input) => ({
      channel: unarchiveChannelAndNotify(ctx.channels, input.channelId, ctx.workspaceId),
    }),
  },

  // ── 에이전트 ─────────────────────────────────────────────────
  register_agent: {
    authorize: (role) => authorizeAgentRegister(role),
    wording: (_ctx, input) => ({
      want: `에이전트 @${input.handle} ${eul(input.handle)} 등록하려 합니다`,
      done: `에이전트 @${input.handle} ${eul(input.handle)} 등록했습니다`,
    }),
    summary: (_ctx, input) => `${input.provider} · ${input.providerAgentId} · 이름 ${input.name}`,
    run: (ctx, input) => ({ agent: registerAgentAndNotify(ctx.agents, input, ctx.workspaceId) }),
  },
  update_agent: {
    authorize: (role) => authorizeAgentPatch(role),
    check: (ctx, input) => void agentHandle(ctx, input.agentId),
    targetAgentId: (input) => input.agentId,
    wording: (ctx, input) => {
      const handle = agentHandle(ctx, input.agentId);
      return {
        want: `에이전트 @${handle} 의 설정을 바꾸려 합니다`,
        done: `에이전트 @${handle} 의 설정을 바꿨습니다`,
      };
    },
    summary: (_ctx, input) =>
      [
        input.handle === undefined ? undefined : `핸들: @${input.handle}`,
        input.name === undefined ? undefined : `이름: ${input.name}`,
        input.avatarUrl === undefined ? undefined : `아바타: ${input.avatarUrl ?? "(지움)"}`,
        input.basePrompt === undefined
          ? undefined
          : `기본 프롬프트: ${input.basePrompt === null ? "(지움)" : clip(input.basePrompt)}`,
      ]
        .filter((line) => line !== undefined)
        .join("\n") || undefined,
    run: (ctx, input) => {
      const { agentId, ...patch } = input;
      return { agent: patchAgentAndNotify(ctx.agents, agentId, patch, ctx.workspaceId) };
    },
  },
  set_agent_enabled: {
    authorize: (role) => authorizeAgentPatch(role),
    check: (ctx, input) => void agentHandle(ctx, input.agentId),
    targetAgentId: (input) => input.agentId,
    wording: (ctx, input) => {
      const handle = agentHandle(ctx, input.agentId);
      return input.enabled
        ? {
            want: `에이전트 @${handle} ${eul(handle)} 켜려 합니다`,
            done: `에이전트 @${handle} ${eul(handle)} 켰습니다`,
          }
        : {
            want: `에이전트 @${handle} ${eul(handle)} 끄려 합니다`,
            done: `에이전트 @${handle} ${eul(handle)} 껐습니다`,
          };
    },
    run: (ctx, input) => ({
      agent: patchAgentAndNotify(ctx.agents, input.agentId, { enabled: input.enabled }, ctx.workspaceId),
    }),
  },
  archive_agent: {
    authorize: (role) => authorizeAgentArchive(role),
    check: (ctx, input) => void agentHandle(ctx, input.agentId),
    targetAgentId: (input) => input.agentId,
    wording: (ctx, input) => {
      const handle = agentHandle(ctx, input.agentId);
      return {
        want: `에이전트 @${handle} ${eul(handle)} 삭제하려 합니다`,
        done: `에이전트 @${handle} ${eul(handle)} 삭제했습니다`,
      };
    },
    run: async (ctx, input) => ({
      agent: await archiveAgentAndNotify(ctx.agents, input.agentId, ctx.workspaceId),
    }),
  },
};

/** 입력 타입을 지운 처리기 — 서비스는 그 도구의 Zod 스키마로 파싱한 값만 넘긴다 */
export type AnyHandler = {
  authorize(role: TeamRole | undefined, raw: Record<string, unknown>): void;
  check?(ctx: HandlerContext, input: unknown): void;
  channelId?(input: unknown): string;
  targetAgentId?(input: unknown): string;
  wording?(ctx: HandlerContext, input: unknown): Wording;
  summary?(ctx: HandlerContext, input: unknown): string | undefined;
  run(ctx: HandlerContext, input: unknown, principal: Principal): unknown;
};

/** 이름으로 처리기를 고른다 — 이름은 CONTROL_TOOLS 에서 찾은 것이라 늘 있다 */
export function handlerFor(tool: AnyControlTool): AnyHandler {
  return HANDLERS[tool.name] as unknown as AnyHandler;
}
