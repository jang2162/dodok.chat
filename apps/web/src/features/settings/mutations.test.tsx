import type { Channel, ChannelMember } from "@dodok/shared";
import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { CH, DEV, FIN, OWNER, gate, memberOf } from "../../../test/settingsServer";
import { channelOf, json } from "../../../test/shellApi";
import { useAddMember, usePatchChannel, usePatchMember, useRemoveMember } from "./mutations";

/**
 * 응답과 wire(`channel.updated`·`channel.member.changed`)는 어느 쪽이 먼저 올지 모른다. 여기서는 wire 가 먼저 와
 * 캐시를 더 새 값으로 바꿔 둔 뒤 응답이 늦게 도착하는 경우를 만든다 — 늦은 응답이 그 새 값을 옛 값으로 덮으면 안 된다
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 붙잡아 둔 응답 하나. 풀기 전에 캐시를 바꾸고(wire 흉내) 푼다 */
function holdFetch(body: unknown) {
  const held = gate();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      await held.opened;
      return json(200, body);
    }),
  );
  return held;
}

function setup() {
  const qc = createQueryClient(() => {});
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const seedChannel = (qc: QueryClient, channel: Channel) => {
  qc.setQueryData(qk.channel(CH), channel);
  qc.setQueryData(qk.channels, [channel]);
};

it("채널 PATCH 응답은 보낸 필드만 — 그 사이 wire 로 바뀐 다른 필드(주제)를 되돌리지 않는다", async () => {
  const { qc, wrapper } = setup();
  seedChannel(qc, channelOf(CH, { name: "general", topic: "옛 주제" }));
  // 서버는 이름을 먼저 바꿨고, 그 뒤 다른 탭이 주제를 바꿨다 — 이름 PATCH 응답에는 옛 주제가 실려 있다
  const held = holdFetch({ channel: channelOf(CH, { name: "dev-talk", topic: "옛 주제" }) });
  const { result } = renderHook(() => usePatchChannel(CH), { wrapper });
  const done = act(() => result.current.mutateAsync({ name: "dev-talk" }));
  seedChannel(qc, channelOf(CH, { name: "dev-talk", topic: "새 주제" })); // wire channel.updated
  held.open();
  await done;
  expect(qc.getQueryData<Channel>(qk.channel(CH))).toMatchObject({ name: "dev-talk", topic: "새 주제" });
  expect(qc.getQueryData<Channel[]>(qk.channels)?.[0]).toMatchObject({ topic: "새 주제" });
});

it("채널 PATCH 로 지운 필드(null)는 캐시에서도 빠진다", async () => {
  const { qc, wrapper } = setup();
  seedChannel(qc, channelOf(CH, { topic: "옛 주제", prompt: "p" }));
  const held = holdFetch({ channel: channelOf(CH, { prompt: "p" }) });
  held.open();
  const { result } = renderHook(() => usePatchChannel(CH), { wrapper });
  await act(() => result.current.mutateAsync({ topic: null }));
  expect(qc.getQueryData<Channel>(qk.channel(CH))).not.toHaveProperty("topic");
  expect(qc.getQueryData<Channel>(qk.channel(CH))).toHaveProperty("prompt", "p");
});

it("멤버 PATCH 응답은 그 멤버의 보낸 필드만 — 다른 필드의 새 값도, 그 사이 빠진 멤버도 되살리지 않는다", async () => {
  const { qc, wrapper } = setup();
  qc.setQueryData(qk.members(CH), [memberOf("user", OWNER), memberOf("agent", DEV), memberOf("agent", FIN)]);
  const held = holdFetch({ member: memberOf("agent", DEV, { autoRespond: true }) });
  const { result } = renderHook(() => usePatchMember(CH), { wrapper });
  const done = act(() => result.current.mutateAsync({ memberId: DEV, patch: { autoRespond: true } }));
  // wire: dev 의 오버라이드가 바뀌고 fin 은 빠졌다
  qc.setQueryData(qk.members(CH), [
    memberOf("user", OWNER),
    memberOf("agent", DEV, { promptOverride: "새" }),
  ]);
  held.open();
  await done;
  expect(qc.getQueryData<ChannelMember[]>(qk.members(CH))).toEqual([
    memberOf("user", OWNER),
    memberOf("agent", DEV, { promptOverride: "새", autoRespond: true }),
  ]);
});

it("멤버 PATCH 응답이 wire 로 먼저 빠진 멤버를 되살리지 않는다", async () => {
  const { qc, wrapper } = setup();
  qc.setQueryData(qk.members(CH), [memberOf("agent", DEV)]);
  const held = holdFetch({ member: memberOf("agent", DEV, { autoRespond: true }) });
  const { result } = renderHook(() => usePatchMember(CH), { wrapper });
  const done = act(() => result.current.mutateAsync({ memberId: DEV, patch: { autoRespond: true } }));
  qc.setQueryData(qk.members(CH), []);
  held.open();
  await done;
  expect(qc.getQueryData(qk.members(CH))).toEqual([]);
});

it("DELETE 응답 목록으로 통째로 바꾸지 않는다 — 그 사이 wire 로 들어온 멤버를 지킨다", async () => {
  const { qc, wrapper } = setup();
  qc.setQueryData(qk.members(CH), [memberOf("user", OWNER), memberOf("agent", DEV)]);
  const held = holdFetch({ members: [memberOf("user", OWNER)] });
  const { result } = renderHook(() => useRemoveMember(CH), { wrapper });
  const done = act(() => result.current.mutateAsync(DEV));
  qc.setQueryData(qk.members(CH), [memberOf("user", OWNER), memberOf("agent", DEV), memberOf("agent", FIN)]);
  held.open();
  await done;
  expect(qc.getQueryData(qk.members(CH))).toEqual([memberOf("user", OWNER), memberOf("agent", FIN)]);
});

it("POST 응답: wire 로 먼저 들어와 있으면 겹치지 않고, 목록이 없으면 만들지 않는다", async () => {
  const { qc, wrapper } = setup();
  qc.setQueryData(qk.members(CH), [memberOf("user", OWNER)]);
  const held = holdFetch({ member: memberOf("agent", DEV) });
  const { result } = renderHook(() => useAddMember(CH), { wrapper });
  const done = act(() => result.current.mutateAsync(DEV));
  qc.setQueryData(qk.members(CH), [memberOf("user", OWNER), memberOf("agent", DEV)]);
  held.open();
  await done;
  expect(qc.getQueryData(qk.members(CH))).toEqual([memberOf("user", OWNER), memberOf("agent", DEV)]);

  qc.removeQueries({ queryKey: qk.members(CH) });
  await act(() => result.current.mutateAsync(FIN));
  expect(qc.getQueryData(qk.members(CH))).toBeUndefined();
});
