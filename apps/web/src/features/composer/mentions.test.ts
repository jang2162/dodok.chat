import { Agent, ChannelMember, type Person, User } from "@dodok/shared";
import { expect, it } from "vitest";
import {
  type MentionCandidate,
  matchMentions,
  mentionCandidates,
  mentionContent,
  mentionIdsIn,
} from "./mentions";
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

it("비활성 멤버는 사람 후보에서 빠진다 — 역할이 남아 있어도(채널 보관·멤버 비활성화 스펙 「기록과 목록」 절)", () => {
  const people: Person[] = [
    {
      id: ME.user.id,
      handle: "owner",
      displayName: "장병현",
      role: "owner",
      deactivatedAt: null,
      statusMessage: null,
    },
    {
      id: uid(30),
      handle: "mina",
      displayName: "미나",
      role: "member",
      deactivatedAt: "2026-10-06T00:00:00.000Z",
      statusMessage: null,
    },
  ];
  const list = mentionCandidates([], [], ME, people);
  expect(list.map((c) => c.label)).toEqual(["owner"]);
});

it("사람 목록이 있으면 사람 후보는 그 목록의 멤버 전원(가입 순) — role 없는 사람은 빠진다(팀 스펙 5장)", () => {
  const people: Person[] = [
    {
      id: ME.user.id,
      handle: "owner",
      displayName: "장병현",
      role: "owner",
      deactivatedAt: null,
      statusMessage: null,
    },
    {
      id: uid(30),
      handle: "mina",
      displayName: "미나",
      role: "member",
      deactivatedAt: null,
      statusMessage: null,
    },
    { id: uid(31), handle: "jihoon", displayName: "지훈", deactivatedAt: null, statusMessage: null },
    {
      id: uid(32),
      handle: "sora",
      displayName: "소라",
      role: "admin",
      avatarUrl: "/a.png",
      deactivatedAt: null,
      statusMessage: null,
    },
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
  const runner = agent(33, "coder", { provider: "runner" });
  const list = mentionCandidates(
    [member("agent", office.id), member("agent", orphan.id), member("agent", runner.id)],
    [office, orphan, runner],
    ME,
  );
  expect(list.slice(0, 3).map((c) => c.gateway)).toEqual(["사무실", undefined, undefined]);
});

it("삭제(보관)한 에이전트는 후보에서 빠진다 — 멤버 응답이 낡아 아직 싣고 있어도", () => {
  const gone = agent(24, "old", { archivedAt: "2026-10-05T00:00:00.000Z" });
  const list = mentionCandidates([member("agent", gone.id), member("agent", DEV.id)], [DEV, gone], ME);
  expect(list.map((c) => c.label)).toEqual(["dev", "owner"]);
});

it("mentionIdsIn — 사람·에이전트 멘션 노드 id 를 중첩까지, 손으로 친 @글자는 뺀다 [UI 시안 02]", () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "mention", attrs: { id: "a:1", label: "dev" } },
          { type: "text", text: " @fin" },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "mention", attrs: { id: "u:2", label: "mia" } }] },
            ],
          },
        ],
      },
    ],
  };
  expect([...mentionIdsIn(doc)]).toEqual(["a:1", "u:2"]);
});

it("mentionContent — 고른 순서대로 멘션 노드, 노드마다 뒤에 공백 하나", () => {
  expect(
    mentionContent([
      { id: "a:1", label: "dev" },
      { id: "u:2", label: "mia" },
    ]),
  ).toEqual([
    { type: "mention", attrs: { id: "a:1", label: "dev" } },
    { type: "text", text: " " },
    { type: "mention", attrs: { id: "u:2", label: "mia" } },
    { type: "text", text: " " },
  ]);
});

it("후보는 아바타 사진을 싣는다 — 에이전트·초대한 에이전트·사람·나, 사진이 없으면 키가 없다", () => {
  const pic = (n: number) => `https://example.test/a${n}.png`;
  const withPic = agent(31, "pic", { avatarUrl: pic(1) });
  const guest = agent(32, "guest", { avatarUrl: pic(2) });
  const people: Person[] = [
    {
      id: uid(41),
      handle: "mia",
      displayName: "미아",
      role: "member",
      deactivatedAt: null,
      avatarUrl: pic(3),
      statusMessage: null,
    },
  ];
  const list = mentionCandidates(
    [member("agent", withPic.id), member("agent", DEV.id)],
    [withPic, DEV],
    ME,
    people,
    [guest],
  );
  expect(list.map((c) => [c.label, c.avatarUrl])).toEqual([
    ["pic", pic(1)],
    ["dev", undefined],
    ["guest", pic(2)],
    ["mia", pic(3)],
  ]);
  expect("avatarUrl" in (list[1] as MentionCandidate)).toBe(false);
  const meOnly = mentionCandidates([], [], { ...ME, user: { ...ME.user, avatarUrl: pic(4) } });
  expect(meOnly.map((c) => c.avatarUrl)).toEqual([pic(4)]);
});
