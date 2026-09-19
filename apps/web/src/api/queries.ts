import type { Agent, AdapterStatus, Channel, ChannelMember, User } from "@dodok/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./http";

export type MeResponse = { user: User; workspaceId: string };
export type AdapterCapabilities = { sessionReset: boolean; agentsList: boolean; configSet: boolean };
export type AdapterStatusResponse = AdapterStatus & { capabilities: AdapterCapabilities };

export const qk = {
  me: ["me"] as const,
  channels: ["channels"] as const,
  channel: (id: string) => ["channel", id] as const,
  members: (id: string) => ["members", id] as const,
  agents: ["agents"] as const,
  discover: ["agents", "discover"] as const,
  adapter: ["adapter"] as const,
  timeline: (id: string) => ["timeline", id] as const,
};

export const meQuery = queryOptions({
  queryKey: qk.me,
  queryFn: () => api<MeResponse>("GET", "/auth/me"),
  staleTime: Infinity,
});
export const useMe = () => useQuery(meQuery);
export const useChannels = () =>
  useQuery({
    queryKey: qk.channels,
    queryFn: async () => (await api<{ channels: Channel[] }>("GET", "/channels")).channels,
  });
/**
 * 조회 오류는 채널 화면(ChannelPage)이 화면 안에 그린다(없는 채널 등) — 전역 토스트를 끈다(`silent`).
 * meta 는 같은 키의 관찰자 중 마지막 것이 이기므로 `["channel", id]` 는 이 훅으로만 부른다.
 * 채널 목록에 있으면 그 값을 자리값으로 먼저 보인다(채널을 옮길 때 빈 화면 없이) — 캐시에는 넣지 않는다
 */
export const useChannel = (id: string) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: qk.channel(id),
    queryFn: async () => (await api<{ channel: Channel }>("GET", `/channels/${id}`)).channel,
    placeholderData: () => qc.getQueryData<Channel[]>(qk.channels)?.find((c) => c.id === id),
    meta: { silent: true },
  });
};
export const useMembers = (channelId: string) =>
  useQuery({
    queryKey: qk.members(channelId),
    queryFn: async () =>
      (await api<{ members: ChannelMember[] }>("GET", `/channels/${channelId}/members`)).members,
  });
export const useAgents = () =>
  useQuery({
    queryKey: qk.agents,
    queryFn: async () => (await api<{ agents: Agent[] }>("GET", "/agents")).agents,
  });
export const useAdapterStatus = () =>
  useQuery({ queryKey: qk.adapter, queryFn: () => api<AdapterStatusResponse>("GET", "/adapter/status") });
