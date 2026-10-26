import { type Approval, type Message, PushPayload } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import { type TriggerLookups, targetsForApproval, targetsForMessage } from "../src/modules/push/triggers";

const CH = "0199a000-0000-7000-8000-000000000001";
/** CH 의 세션 — 채널 id 와 다르게 둬 링크·tag 가 세션을 가리키는지 보인다 */
const CONV = "0199a000-0000-7000-8000-000000000c01";
const ALICE = "0199a000-0000-7000-8000-00000000a11c";
const BOB = "0199a000-0000-7000-8000-000000000b0b";
const SAM = "0199a000-0000-7000-8000-000000005a70";
const DEV = "0199a000-0000-7000-8000-000000000de0";
const AP = "0199a000-0000-7000-8000-0000000000a9";
const GHOST = "0199a000-0000-7000-8000-00000000dead";
const DAWN = "0199a000-0000-7000-8000-00000000da00";
const MORNING = "0199a000-0000-7000-8000-000000000a0e";

const L: TriggerLookups = {
  channelName: (id) => ({ [CH]: "프로젝트" })[id],
  userHandle: (id) => ({ [ALICE]: "alice", [BOB]: "bob", [SAM]: "sam" })[id],
  agentHandle: (id) => ({ [DEV]: "dev" })[id],
  automationName: (id) => ({ [DAWN]: "새벽 배포", [MORNING]: "아침 점검" })[id],
  humanMembers: (id) => (id === CH ? [ALICE, BOB] : []),
  // SAM 은 채널 밖 admin, ALICE 는 채널 안 member — 승인은 채널 참여와 무관하게 owner·admin 에게만
  admins: () => [SAM, BOB],
  channelArchived: () => false,
  dmOwner: () => null,
};

function msg(over: Partial<Message>): Message {
  return {
    id: "0199a000-0000-7000-8000-0000000000ff",
    channelId: CH,
    conversationId: CONV,
    seq: 1,
    kind: "normal",
    authorType: "user",
    authorId: ALICE,
    bodyMd: "",
    mentions: { users: [], agents: [] },
    attachments: [],
    interactions: [],
    reactions: [],
    createdAt: "2026-09-23T00:00:00.000Z",
    ...over,
  };
}

function approval(over: Partial<Approval>): Approval {
  return {
    id: AP,
    providerApprovalId: "plugin:x",
    kind: "plugin",
    channelId: CH,
    conversationId: CONV,
    agentId: DEV,
    title: "t",
    severity: "warning",
    allowedDecisions: ["allow-once", "deny"],
    status: "pending",
    expiresAt: "2026-09-23T00:02:00.000Z",
    createdAt: "2026-09-23T00:00:00.000Z",
    ...over,
  };
}

describe("targetsForMessage — 멘션(스펙 5.2 첫 줄)", () => {
  it("에이전트가 사람을 멘션 → 그 사람에게, 본문 없음(josa(dev) = 「가」)", () => {
    const m = msg({
      authorType: "agent",
      authorId: DEV,
      bodyMd: `비밀 계획입니다 <@u:${ALICE}>`,
      mentions: { users: [ALICE], agents: [] },
    });
    const t = targetsForMessage(m, L);
    expect(t).toEqual([
      {
        userId: ALICE,
        conversationId: CONV,
        payload: {
          kind: "mention",
          channelId: CH,
          title: "dodok",
          body: "@dev가 #프로젝트에서 불렀습니다",
          url: `/c/${CH}/s/${CONV}`,
          tag: `mention:${CONV}`,
        },
      },
    ]);
    expect(JSON.stringify(t)).not.toContain("비밀");
    // 계약 스키마를 통과한다(상한 포함)
    for (const x of t) expect(PushPayload.safeParse(x.payload).success).toBe(true);
  });

  it("[판정 PS7] 같은 채널의 다른 세션 멘션은 그 세션을 가리킨다 — 링크·tag·거르기 세션이 메시지의 세션", () => {
    const OTHER_CONV = "0199a000-0000-7000-8000-000000000c02";
    const t = targetsForMessage(
      msg({
        authorType: "agent",
        authorId: DEV,
        conversationId: OTHER_CONV,
        mentions: { users: [ALICE], agents: [] },
      }),
      L,
    );
    expect(t).toEqual([
      expect.objectContaining({
        conversationId: OTHER_CONV,
        payload: expect.objectContaining({ url: `/c/${CH}/s/${OTHER_CONV}`, tag: `mention:${OTHER_CONV}` }),
      }),
    ]);
  });

  it("[Review Focus 3] 자기 멘션은 없다, 사람이 사람을 멘션하면 있다(josa(alice) = 「가」 — 끝 묵음 e 앞 c)", () => {
    expect(
      targetsForMessage(
        msg({ authorType: "user", authorId: ALICE, mentions: { users: [ALICE], agents: [] } }),
        L,
      ),
    ).toEqual([]);
    const t = targetsForMessage(
      msg({ authorType: "user", authorId: ALICE, mentions: { users: [ALICE, BOB], agents: [] } }),
      L,
    );
    expect(t.map((x) => [x.userId, x.payload.body])).toEqual([[BOB, "@alice가 #프로젝트에서 불렀습니다"]]);
  });

  it("자동화가 사람을 멘션 → 그 사람에게, 보낸 이는 「자동화 <이름>」(받침에 따라 이·가), 지운 자동화면 「자동화가」", () => {
    const by = (authorId: string) =>
      targetsForMessage(
        msg({ authorType: "automation", authorId, mentions: { users: [ALICE, BOB], agents: [] } }),
        L,
      );
    const dawn = by(DAWN);
    expect(dawn.map((x) => x.userId)).toEqual([ALICE, BOB]);
    expect(dawn[0]?.payload).toEqual({
      kind: "mention",
      channelId: CH,
      title: "dodok",
      body: "자동화 새벽 배포가 #프로젝트에서 불렀습니다",
      url: `/c/${CH}/s/${CONV}`,
      tag: `mention:${CONV}`,
    });
    for (const x of dawn) expect(PushPayload.safeParse(x.payload).success).toBe(true);
    expect(by(MORNING)[0]?.payload.body).toBe("자동화 아침 점검이 #프로젝트에서 불렀습니다");
    expect(by(GHOST)[0]?.payload.body).toBe("자동화가 #프로젝트에서 불렀습니다");
  });

  it("받침으로 끝나는 핸들은 「이」(josa(sam) = 「이」), 받침 없는 핸들은 「가」(josa(bob) = 「가」)", () => {
    const bySam = targetsForMessage(
      msg({ authorType: "user", authorId: SAM, mentions: { users: [ALICE], agents: [] } }),
      L,
    );
    expect(bySam[0]?.payload.body).toBe("@sam이 #프로젝트에서 불렀습니다");
    const byBob = targetsForMessage(
      msg({ authorType: "user", authorId: BOB, mentions: { users: [ALICE], agents: [] } }),
      L,
    );
    expect(byBob[0]?.payload.body).toBe("@bob가 #프로젝트에서 불렀습니다");
  });

  it("핸들을 못 풀면 「누군가가」, 채널 이름을 못 풀면 「채널」", () => {
    const t = targetsForMessage(
      msg({
        authorType: "agent",
        authorId: GHOST,
        channelId: GHOST,
        conversationId: GHOST,
        mentions: { users: [ALICE], agents: [] },
      }),
      L,
    );
    expect(t[0]?.payload.body).toBe("누군가가 #채널에서 불렀습니다");
    expect(t[0]?.payload).toMatchObject({ url: `/c/${GHOST}/s/${GHOST}`, tag: `mention:${GHOST}` });
  });

  it("에이전트 id 와 같은 사람 id 가 멘션돼도 에이전트 작성자는 자기 멘션이 아니다 — 작성자 = 사람일 때만 뺀다", () => {
    // authorType 을 보지 않고 id 만 비교하면 이 줄이 빠진다(서로 다른 테이블의 id 는 겹치지 않지만 규칙은 사람 기준)
    const t = targetsForMessage(
      msg({ authorType: "agent", authorId: ALICE, mentions: { users: [ALICE], agents: [] } }),
      L,
    );
    expect(t.map((x) => x.userId)).toEqual([ALICE]);
  });

  it("같은 사람이 두 번 들어 있어도 한 번만", () => {
    const t = targetsForMessage(
      msg({ authorType: "agent", authorId: DEV, mentions: { users: [BOB, BOB], agents: [] } }),
      L,
    );
    expect(t.map((x) => x.userId)).toEqual([BOB]);
  });

  it("에이전트만 멘션한 메시지는 없다", () => {
    expect(targetsForMessage(msg({ mentions: { users: [], agents: [DEV] } }), L)).toEqual([]);
  });
});

describe("targetsForMessage — 시스템 메시지(스펙 5.2 셋째 줄)", () => {
  it("릴레이 한도 시스템 메시지 → 채널의 사람 멤버 모두", () => {
    const m = msg({
      kind: "system",
      authorType: "system",
      authorId: undefined,
      bodyMd: "@dev 와 @fin 의 대화가 상한 2 에 닿았습니다",
      systemMeta: { kind: "relay_limit" },
      mentions: { users: [], agents: [] },
    });
    const t = targetsForMessage(m, L);
    expect(t.map((x) => [x.userId, x.payload.kind, x.payload.body, x.payload.url, x.payload.tag])).toEqual([
      [
        ALICE,
        "relay_limit",
        "#프로젝트의 에이전트 대화가 한도에 닿았습니다",
        `/c/${CH}/s/${CONV}`,
        `relay:${CONV}`,
      ],
      [
        BOB,
        "relay_limit",
        "#프로젝트의 에이전트 대화가 한도에 닿았습니다",
        `/c/${CH}/s/${CONV}`,
        `relay:${CONV}`,
      ],
    ]);
    // 거르기는 그 세션으로(채널 세션 계획 판정 PS7)
    expect(t.map((x) => x.conversationId)).toEqual([CONV, CONV]);
    expect(t[0]?.payload.title).toBe("dodok");
    expect(JSON.stringify(t)).not.toContain("상한 2");
  });

  it("다른 시스템 메시지(run_error·info·relay_denied·systemMeta 없음)는 없다 — 멘션이 있어도", () => {
    for (const systemMeta of [
      { kind: "run_error" as const },
      { kind: "info" as const },
      { kind: "relay_denied" as const },
      undefined,
    ]) {
      const m = msg({
        kind: "system",
        authorType: "system",
        authorId: undefined,
        ...(systemMeta ? { systemMeta } : {}),
        mentions: { users: [ALICE], agents: [] },
      });
      expect(targetsForMessage(m, L)).toEqual([]);
    }
  });
});

describe("targetsForApproval (스펙 5.2 둘째 줄)", () => {
  it("승인 요청 → 워크스페이스의 owner·admin(채널 참여와 무관), 활동 탭 url, 승인 제목·설명은 싣지 않는다", () => {
    const t = targetsForApproval(
      approval({ title: "rm -rf 실행", description: "비밀", detail: "기밀 세부", toolName: "Bash" }),
      L,
    );
    expect(t.map((x) => x.userId)).toEqual([SAM, BOB]);
    expect(t.map((x) => x.payload)).toEqual([
      {
        kind: "approval",
        channelId: CH,
        title: "dodok",
        body: "#프로젝트에 승인 요청이 있습니다",
        url: `/c/${CH}/s/${CONV}/activity`,
        tag: `approval:${AP}`,
      },
      expect.objectContaining({ tag: `approval:${AP}` }),
    ]);
    expect(t.map((x) => x.conversationId)).toEqual([CONV, CONV]);
    for (const x of t) expect(PushPayload.safeParse(x.payload).success).toBe(true);
    expect(JSON.stringify(t)).not.toMatch(/rm -rf|비밀|기밀|Bash/);
  });

  it("owner·admin 이 없으면 없다 — 채널의 사람 멤버에게로 새지 않는다", () => {
    expect(targetsForApproval(approval({}), { ...L, admins: () => [] })).toEqual([]);
  });

  it("확인 카드(dodok_control)는 시킨 사람 본인에게만 — owner·admin 에게 가지 않는다", () => {
    const t = targetsForApproval(approval({ kind: "dodok_control", requestedBy: ALICE }), L);
    expect(t.map((x) => x.userId)).toEqual([ALICE]);
    expect(t[0]?.payload).toMatchObject({ kind: "approval", tag: `approval:${AP}` });
    expect(targetsForApproval(approval({ kind: "dodok_control" }), L)).toEqual([]);
  });
});

describe("targetsForMessage — 스레드(스펙 4.2 푸시)", () => {
  const ROOT = "0199a000-0000-7000-8000-00000000f00d";

  it("스레드 멘션 → 「스레드에서 불렀습니다」, 링크는 그 스레드, tag 는 스레드마다", () => {
    const t = targetsForMessage(
      msg({
        authorType: "agent",
        authorId: DEV,
        threadRootId: ROOT,
        mentions: { users: [ALICE], agents: [] },
      }),
      L,
    );
    expect(t).toEqual([
      {
        userId: ALICE,
        conversationId: CONV,
        payload: {
          kind: "mention",
          channelId: CH,
          title: "dodok",
          body: "@dev가 #프로젝트 스레드에서 불렀습니다",
          url: `/c/${CH}/s/${CONV}/t/${ROOT}`,
          tag: `mention:t:${ROOT}`,
        },
      },
    ]);
    // tag 상한 80 — 스레드 꼴이 가장 길다
    expect(`mention:t:${ROOT}`.length).toBeLessThanOrEqual(80);
    for (const x of t) expect(PushPayload.safeParse(x.payload).success).toBe(true);
  });

  it("스레드 안 relay_limit → 스레드 문구·링크", () => {
    const t = targetsForMessage(
      msg({
        kind: "system",
        authorType: "system",
        authorId: undefined,
        threadRootId: ROOT,
        systemMeta: { kind: "relay_limit" },
      }),
      L,
    );
    expect(t.map((x) => [x.payload.body, x.payload.url])).toEqual([
      ["#프로젝트 스레드의 에이전트 대화가 한도에 닿았습니다", `/c/${CH}/s/${CONV}/t/${ROOT}`],
      ["#프로젝트 스레드의 에이전트 대화가 한도에 닿았습니다", `/c/${CH}/s/${CONV}/t/${ROOT}`],
    ]);
    for (const x of t) expect(PushPayload.safeParse(x.payload).success).toBe(true);
  });
});
