import type { ChannelMember } from "@dodok/shared";
import { expect, it } from "vitest";
import { uid } from "../../../test/fixtures";
import { autoRespondPlan } from "./autoRespond";

const DEV = uid(11);
const FIN = uid(12);
const OPS = uid(13);
const OWNER = uid(10);

const member = (memberType: ChannelMember["memberType"], memberId: string, autoRespond = false) =>
  ({
    id: `m-${memberId}`,
    channelId: uid(1),
    memberType,
    memberId,
    autoRespond,
    aliases: [],
    joinedAt: "2026-09-19T00:00:00.000Z",
  }) satisfies ChannelMember;

it("켜진 것 없음 + dev 켜기 → dev 만", () => {
  const members = [member("user", OWNER), member("agent", DEV), member("agent", FIN)];
  expect(autoRespondPlan(members, DEV, true)).toEqual([{ memberId: DEV, autoRespond: true }]);
});

it("fin 켜짐 + dev 켜기 → fin 을 먼저 끄고 dev 를 켠다", () => {
  const members = [member("agent", DEV), member("agent", FIN, true)];
  expect(autoRespondPlan(members, DEV, true)).toEqual([
    { memberId: FIN, autoRespond: false },
    { memberId: DEV, autoRespond: true },
  ]);
});

it("여럿이 켜져 있으면(다른 곳에서 어긋남) 모두 먼저 끈다", () => {
  const members = [member("agent", FIN, true), member("agent", DEV), member("agent", OPS, true)];
  expect(autoRespondPlan(members, DEV, true)).toEqual([
    { memberId: FIN, autoRespond: false },
    { memberId: OPS, autoRespond: false },
    { memberId: DEV, autoRespond: true },
  ]);
});

it("dev 끄기 → dev 만(다른 것은 건드리지 않는다)", () => {
  const members = [member("agent", DEV, true), member("agent", FIN, true)];
  expect(autoRespondPlan(members, DEV, false)).toEqual([{ memberId: DEV, autoRespond: false }]);
});

it("사람 멤버는 보지 않는다", () => {
  const members = [{ ...member("user", OWNER), autoRespond: true }, member("agent", DEV)];
  expect(autoRespondPlan(members, DEV, true)).toEqual([{ memberId: DEV, autoRespond: true }]);
});
