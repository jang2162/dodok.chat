import type { Channel, DmSummary } from "@dodok/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qk } from "@/api/queries";
import { createQueryClient } from "@/app/queryClient";
import { useApprovalStore } from "@/features/approvals/approvalStore";
import { resetApprovalNotices } from "@/features/approvals/notify";
import { useUnread } from "@/features/reads/useUnread";
import { stubNotification } from "../../test/domStubs";
import { dmChannelOf, dmOf } from "../../test/dms";
import { createFakeSocket } from "../../test/fakeSocket";
import { AGENT, approval, CH, CH2, uid, USER } from "../../test/fixtures";
import { agentOf } from "../../test/settingsServer";
import { channelOf } from "../../test/shellApi";
import { attachHandlers } from "./handlers";
import { createSubscriptions } from "./subscriptions";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

// 에이전트 DM 계획 태스크 5 Step 0·5 — DM 의 채널 사실은 채널 목록이 아니라 DM 목록 캐시로(판정 PD3), 에이전트가 바뀌면 DM 목록을 다시 받는다

const DM = uid(9);
const CONV = uid(91);
const dmChannel = (over: Partial<Channel> = {}) => dmChannelOf(DM, USER, AGENT, over);

const detachers: Array<() => void> = [];
const notify = {
  currentChannelId: () => undefined,
  currentConversationId: () => undefined,
  openActivity: () => {},
};

function setup() {
  const fake = createFakeSocket();
  fake.socket.connected = true;
  fake.socket.active = true;
  const queryClient = createQueryClient(vi.fn());
  queryClient.setQueryData(qk.me, { user: { id: USER, handle: "mia" }, workspaceId: "w", role: "member" });
  const subscriptions = createSubscriptions({ socket: fake.wire, queryClient });
  detachers.push(attachHandlers(fake.wire, { queryClient, subscriptions, onUnauthorized: vi.fn(), notify }));
  return { fake, queryClient };
}
const invalidated = (qc: ReturnType<typeof setup>["queryClient"], key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated;

beforeEach(() => {
  useUnread.getState().reset();
  useApprovalStore.getState().reset();
  resetApprovalNotices();
});
afterEach(() => {
  for (const detach of detachers.splice(0)) detach();
  vi.restoreAllMocks();
});

describe("DM 의 채널 사실", () => {
  it("channel.created(DM) 는 채널 목록에 넣지 않고 DM 목록을 다시 받는다 — 채널 절에 「dm」이 생기지 않는다", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.channels, [channelOf(CH)]);
    queryClient.setQueryData<DmSummary[]>(qk.dms, []);

    fake.serverEmit("channel.created", { channel: dmChannel() });

    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.id)).toEqual([CH]);
    expect(invalidated(queryClient, qk.dms)).toBe(true);
  });

  it("channel.updated(DM — 「이 DM 의 지시」)는 상세만 바꾸고 채널·보관 목록에 넣지 않는다, DM 목록은 다시 받는다", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.channels, [channelOf(CH)]);
    queryClient.setQueryData(qk.archivedChannels, []);
    queryClient.setQueryData<DmSummary[]>(qk.dms, [dmOf(dmChannel())]);

    fake.serverEmit("channel.updated", { channel: dmChannel({ prompt: "짧게 답해" }) });

    expect(queryClient.getQueryData<Channel>(qk.channel(DM))?.prompt).toBe("짧게 답해");
    expect(queryClient.getQueryData<Channel[]>(qk.channels)?.map((c) => c.id)).toEqual([CH]);
    expect(queryClient.getQueryData<Channel[]>(qk.archivedChannels)).toEqual([]);
    expect(invalidated(queryClient, qk.dms)).toBe(true);
  });

  it("agents.changed 는 DM 목록도 다시 받는다 — 읽기 전용 사유(보관·꺼짐·허용 범위)가 바뀌었을 수 있다(Review Focus 4)", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData<DmSummary[]>(qk.dms, [dmOf(dmChannel())]);

    fake.serverEmit("agents.changed", {});

    expect(invalidated(queryClient, qk.dms)).toBe(true);
  });

  it("내 역할이 바뀌면(people.changed) DM 목록을 다시 받는다 — 강등되면 admins 에이전트와의 DM 이 읽기 전용(Review Focus 3)", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData<DmSummary[]>(qk.dms, [dmOf(dmChannel())]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );

    // 다른 사람의 변화는 다시 받지 않는다
    fake.serverEmit("people.changed", {
      people: [{ id: USER, handle: "mia", displayName: "미아", role: "member" }],
    });
    expect(invalidated(queryClient, qk.dms)).toBe(false);

    fake.serverEmit("people.changed", {
      people: [{ id: USER, handle: "mia", displayName: "미아", role: "admin" }],
    });
    expect(invalidated(queryClient, qk.dms)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("다시 붙으면 DM 목록을 다시 받는다 — 끊긴 사이의 새 DM·읽기 전용 사유", () => {
    const { fake, queryClient } = setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    fake.serverEmit("connect");
    queryClient.setQueryData<DmSummary[]>(qk.dms, [dmOf(dmChannel())]);
    expect(invalidated(queryClient, qk.dms)).toBe(false);
    fake.serverEmit("connect");
    expect(invalidated(queryClient, qk.dms)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("channel.activity(DM) 는 그 DM 을 목록 맨 위로 올리고 마지막 글 시각을 채운다 — 글 없던 DM 도 사이드바에 든다", () => {
    const { fake, queryClient } = setup();
    const other = dmChannelOf(CH2, USER, uid(12));
    queryClient.setQueryData<DmSummary[]>(qk.dms, [
      dmOf(other),
      dmOf(dmChannel(), undefined, { lastMessageAt: null }),
    ]);

    fake.serverEmit("channel.activity", {
      channelId: DM,
      conversationId: CONV,
      seq: 1,
      authorType: "agent",
      authorId: AGENT,
      mentionedUserIds: [USER],
    });

    const list = queryClient.getQueryData<DmSummary[]>(qk.dms) ?? [];
    expect(list.map((d) => d.channel.id)).toEqual([DM, CH2]);
    expect(list[0]?.lastMessageAt).not.toBeNull();
    expect(invalidated(queryClient, qk.dms)).toBe(false);
  });

  it("모르는 채널의 channel.activity 는 DM 목록을 다시 받는다 — 다른 기기에서 처음 쓴 DM", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.channels, [channelOf(CH)]);
    queryClient.setQueryData<DmSummary[]>(qk.dms, []);

    fake.serverEmit("channel.activity", {
      channelId: DM,
      conversationId: CONV,
      seq: 1,
      authorType: "user",
      authorId: USER,
      mentionedUserIds: [],
    });
    expect(invalidated(queryClient, qk.dms)).toBe(true);
  });

  it("DM 의 에이전트 글은 읽지 않음 항목을 만들고 배지를 센다 — DM 은 채널 목록 밖이어도 사이드바 목록이다(PD10)", () => {
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.channels, [channelOf(CH)]);
    queryClient.setQueryData<DmSummary[]>(qk.dms, [dmOf(dmChannel())]);
    useUnread.getState().applySnapshot({ conversations: [], channels: [CH, DM] });

    fake.serverEmit("channel.activity", {
      channelId: DM,
      conversationId: CONV,
      seq: 3,
      authorType: "agent",
      authorId: AGENT,
      mentionedUserIds: [USER],
    });

    expect(useUnread.getState().byConversation[CONV]).toMatchObject({ unread: true, mentions: 1 });
  });
});

describe("DM 의 승인 알림", () => {
  let stub: ReturnType<typeof stubNotification>;
  afterEach(() => stub.restore());

  it("member 주인에게도 알린다 — DM 의 승인은 역할과 상관없이 주인이 결정한다(PD7), 본문은 채널 이름이 아니라 「DM」", () => {
    stub = stubNotification("granted");
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.agents, [agentOf(AGENT, "dev")]);
    queryClient.setQueryData<DmSummary[]>(qk.dms, [dmOf(dmChannel())]);

    fake.serverEmit("approval.requested", { approval: approval({ channelId: DM, conversationId: CONV }) });

    expect(stub.made).toHaveLength(1);
    expect(stub.made[0]?.options?.body).toBe("DM");
  });

  it("일반 채널의 승인은 지금 규칙 그대로 — member 에게는 알리지 않는다", () => {
    stub = stubNotification("granted");
    const { fake, queryClient } = setup();
    queryClient.setQueryData(qk.channels, [channelOf(CH)]);

    fake.serverEmit("approval.requested", { approval: approval() });

    expect(stub.made).toHaveLength(0);
  });
});
