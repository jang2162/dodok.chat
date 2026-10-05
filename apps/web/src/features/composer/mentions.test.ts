import { Agent, ChannelMember, type Person, User } from "@dodok/shared";
import { expect, it } from "vitest";
import { type MentionCandidate, matchMentions, mentionCandidates } from "./mentions";
import { uid } from "../../../test/fixtures";

const W = uid(900);
const TS = "2026-09-19T00:00:00.000Z";
const agent = (n: number, handle: string, over: Partial<Agent> = {}): Agent =>
  Agent.parse({
    id: uid(n),
    workspaceId: W,
    provider: "openclaw",
    providerAgentId: handle,
    handle,
    name: handle.toUpperCase(),
    enabled: true,
    createdAt: TS,
    archivedAt: null,
    ...over,
  });
const member = (memberType: "user" | "agent", memberId: string, aliases: string[] = []): ChannelMember =>
  ChannelMember.parse({
    id: uid(Number.parseInt(memberId.slice(-4), 10) + 500),
    channelId: uid(1),
    memberType,
    memberId,
    aliases,
    joinedAt: TS,
  });
const ME = {
  user: User.parse({
    id: uid(10),
    workspaceId: W,
    handle: "owner",
    displayName: "장병현",
    authProvider: "local",
    createdAt: TS,
  }),
  workspaceId: W,
};

const DEV = agent(21, "dev", { name: "개발봇" });
const FIN = agent(22, "fin", { name: "Finance", enabled: false });
const OTHER = agent(23, "ops");

it("채널 에이전트 멤버(멤버 순) 다음 사람(owner) — 멤버 아닌 에이전트·모르는 에이전트는 빠진다", () => {
  const list = mentionCandidates(
    [
      member("user", ME.user.id),
      member("agent", FIN.id),
      member("agent", DEV.id, ["dv"]),
      member("agent", uid(99)),
    ],
    [DEV, FIN, OTHER],
    ME,
  );
  expect(list).toEqual<MentionCandidate[]>([
    { id: `a:${FIN.id}`, label: "fin", name: "Finance", kind: "agent", aliases: [], enabled: false },
    { id: `a:${DEV.id}`, label: "dev", name: "개발봇", kind: "agent", aliases: ["dv"], enabled: true },
    { id: `u:${ME.user.id}`, label: "owner", name: "장병현", kind: "user", aliases: [], enabled: true },
  ]);
});

it("아직 불러오지 않은 목록은 빈 것으로 본다", () => {
  expect(mentionCandidates(undefined, undefined, undefined)).toEqual([]);
  expect(mentionCandidates(undefined, [DEV], ME).map((c) => c.label)).toEqual(["owner"]);
});

it("검색: 핸들·이름·별칭 앞부분(대소문자 무시), 빈 검색어는 전부", () => {
  const all = mentionCandidates(
    [member("agent", DEV.id, ["coder"]), member("agent", FIN.id)],
    [DEV, FIN],
    ME,
  );
  const labels = (q: string) => matchMentions(all, q).map((c) => c.label);
  expect(labels("")).toEqual(["dev", "fin", "owner"]);
  expect(labels("D")).toEqual(["dev"]);
  expect(labels("개발")).toEqual(["dev"]);
  expect(labels("cod")).toEqual(["dev"]);
  expect(labels("fi")).toEqual(["fin"]);
  expect(labels("장")).toEqual(["owner"]);
  expect(labels("ev")).toEqual([]);
});

it("사람 목록이 있으면 사람 후보는 그 목록의 멤버 전원(가입 순) — 나간 멤버(role 없음)는 빠진다(팀 스펙 5장)", () => {
  const people: Person[] = [
    { id: ME.user.id, handle: "owner", displayName: "장병현", role: "owner" },
    { id: uid(30), handle: "mina", displayName: "미나", role: "member" },
    { id: uid(31), handle: "left-x", displayName: "지훈", leftHandle: "jihoon" },
    { id: uid(32), handle: "sora", displayName: "소라", role: "admin", avatarUrl: "/a.png" },
  ];
  const list = mentionCandidates([member("agent", DEV.id)], [DEV], ME, people);
  expect(list.map((c) => c.id)).toEqual([`a:${DEV.id}`, `u:${ME.user.id}`, `u:${uid(30)}`, `u:${uid(32)}`]);
  expect(list[2]).toEqual<MentionCandidate>({
    id: `u:${uid(30)}`,
    label: "mina",
    name: "미나",
    kind: "user",
    aliases: [],
    enabled: true,
  });
});

it("OpenClaw 에이전트 후보는 Gateway 이름을 함께 싣는다 — 연결이 비었거나 러너 에이전트면 싣지 않는다", () => {
  const office = agent(31, "main-office", { gateway: { id: uid(41), name: "사무실" } });
  const orphan = agent(32, "main-home", { gateway: null });
  const runner = agent(33, "coder", { provider: "claude" });
  const list = mentionCandidates(
    [member("agent", office.id), member("agent", orphan.id), member("agent", runner.id)],
    [office, orphan, runner],
    ME,
  );
  expect(list.slice(0, 3).map((c) => c.gateway)).toEqual(["사무실", undefined, undefined]);
});
