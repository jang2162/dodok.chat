import type { Agent, AdapterStatus, Channel, ChannelMember, User } from "@dodok/shared";
import { queryOptions, useQuery } from "@tanstack/react-query";
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
export const useChannel = (id: string) =>
  useQuery({
    queryKey: qk.channel(id),
    queryFn: async () => (await api<{ channel: Channel }>("GET", `/channels/${id}`)).channel,
  });
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
