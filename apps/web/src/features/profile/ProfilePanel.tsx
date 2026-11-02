import { useParams } from "@tanstack/react-router";
import { AgentProfile } from "./AgentProfile";
import { PersonProfile } from "./PersonProfile";
import { NotFound } from "./ProfileParts";

/** 오른쪽 패널의 「프로필」 탭 내용(프로필 스펙 3.1) — 경로 `p/$kind/$id`, kind 는 u(사람)·a(에이전트) */
export function ProfilePanel() {
  const { kind, id } = useParams({ strict: false }) as { kind?: string; id?: string };
  if (!id) return <NotFound />;
  if (kind === "u") return <PersonProfile key={id} userId={id} />;
  if (kind === "a") return <AgentProfile key={id} agentId={id} />;
  return <NotFound />;
}
