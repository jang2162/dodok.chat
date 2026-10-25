import type { Channel, ChannelMember, RelayPolicy, SessionPolicy } from "@dodok/shared";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/**
 * 채널 설정 패널의 뮤테이션. 성공하면 응답으로 캐시를 직접 고친다(다시 불러오지 않는다).
 * 서버는 같은 변경을 wire(`channel.updated`·`channel.member.changed`)로도 보내고, 그것이 응답보다 먼저 올 수 있다.
 * 그래서 응답은 보낸 필드·그 멤버 한 줄만 고친다 — 늦게 온 응답이 그 사이 wire 로 온 다른 변경을 옛 값으로 덮지 않게
 */

/** `null` 은 지운다. relayPolicy 는 통째로 바뀐다(빠진 필드는 서버 기본값) */
export type ChannelPatch = {
  name?: string;
  topic?: string | null;
  prompt?: string | null;
  relayPolicy?: RelayPolicy;
  /** 누가 새 세션을 만드나(admin 이상 — 채널 세션 계획 판정 PS8) */
  sessionPolicy?: SessionPolicy;
};
/** `promptOverride: null` 은 지운다 */
export type MemberPatch = { promptOverride?: string | null; autoRespond?: boolean };

/** current 에서 keys 만 fresh 값으로(fresh 에 없으면 — 지운 필드 — 뺀다). current 가 없으면 fresh */
function withPatched<T extends object>(current: T | undefined, fresh: T, keys: readonly string[]): T {
  if (current === undefined) return fresh;
  const next = { ...current } as Record<string, unknown>;
  for (const key of keys) {
    const value = (fresh as Record<string, unknown>)[key];
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

export function usePatchChannel(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: ChannelPatch) =>
      (await api<{ channel: Channel }>("PATCH", `/channels/${channelId}`, patch)).channel,
    onSuccess: (channel, patch) => {
      const keys = Object.keys(patch);
      qc.setQueryData<Channel>(qk.channel(channelId), (prev) => withPatched(prev, channel, keys));
      qc.setQueryData<Channel[]>(qk.channels, (list) =>
        list?.map((c) => (c.id === channelId ? withPatched(c, channel, keys) : c)),
      );
    },
  });
}

/** 목록을 아직 불러오지 않았으면 건드리지 않는다(부분 목록을 만들지 않게 — 조회가 채운다) */
function updateMembers(qc: QueryClient, channelId: string, fn: (prev: ChannelMember[]) => ChannelMember[]) {
  qc.setQueryData<ChannelMember[]>(qk.members(channelId), (prev) => prev && fn(prev));
}

/** 변수는 에이전트 id. 그 사이 wire 로 먼저 들어와 있으면 바꿔 끼우기만 */
export function useAddMember(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) =>
      (
        await api<{ member: ChannelMember }>("POST", `/channels/${channelId}/members`, {
          memberType: "agent",
          memberId: agentId,
        })
      ).member,
    onSuccess: (member) =>
      updateMembers(qc, channelId, (prev) =>
        prev.some((m) => m.id === member.id)
          ? prev.map((m) => (m.id === member.id ? member : m))
          : [...prev, member],
      ),
  });
}

/**
 * memberId 는 에이전트 id(서버 경로 `…/members/:memberId`). 그 멤버의 보낸 필드만 고친다 —
 * 그 사이 wire 로 빠졌으면 되살리지 않는다
 */
export function usePatchMember(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ memberId, patch }: { memberId: string; patch: MemberPatch }) =>
      (await api<{ member: ChannelMember }>("PATCH", `/channels/${channelId}/members/${memberId}`, patch))
        .member,
    onSuccess: (member, { patch }) => {
      const keys = Object.keys(patch);
      updateMembers(qc, channelId, (prev) =>
        prev.map((m) => (m.id === member.id ? withPatched(m, member, keys) : m)),
      );
    },
  });
}

/**
 * 변수는 에이전트 id. 응답은 뺀 뒤의 목록 전체지만 그 사이 wire 로 더 새 목록이 와 있을 수 있어,
 * 지금 캐시에서 그 멤버만 뺀다(캐시가 없을 때만 응답 목록을 넣는다)
 */
export function useRemoveMember(channelId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (agentId: string) =>
      (await api<{ members: ChannelMember[] }>("DELETE", `/channels/${channelId}/members/${agentId}`))
        .members,
    onSuccess: (members, agentId) =>
      qc.setQueryData<ChannelMember[]>(
        qk.members(channelId),
        (prev) => prev?.filter((m) => !(m.memberType === "agent" && m.memberId === agentId)) ?? members,
      ),
  });
}
