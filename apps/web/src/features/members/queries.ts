import type { Invite, MemberRow } from "@dodok/shared";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/http";
import { qk } from "@/api/queries";

/** 멤버 표(`GET /members`, admin 이상 — 팀 스펙 4장). 권한이 있는 화면만 부른다 */
export const useTeamMembers = () =>
  useQuery({
    queryKey: qk.teamMembers,
    queryFn: async () => (await api<{ members: MemberRow[] }>("GET", "/members")).members,
  });

/** 대기 중인(유효한) 초대 — 원문 없이 앞 8자(`prefix`)만 */
export const useInvites = () =>
  useQuery({
    queryKey: qk.invites,
    queryFn: async () => (await api<{ invites: Invite[] }>("GET", "/invites")).invites,
  });
