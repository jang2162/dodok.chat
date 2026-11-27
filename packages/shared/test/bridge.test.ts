import { describe, expect, it } from "vitest";
import {
  BridgeHello,
  formatDmLine,
  formatGroupDmLine,
  formatHeaderTime,
  formatSessionLine,
  formatTimeZoneLine,
  INBOUND_REACTIONS_MAX,
  InboundContext,
  InboundDeliver,
  InboundDeliverResult,
  InboundReaction,
  LINKED_MESSAGES_MAX,
  OutboundMessage,
  PluginUpdate,
  PluginUpdateResult,
  REACTION_EXCERPT_MAX,
} from "../src/bridge";

const ID = (n: number) => `01a09fc9-d204-7551-89d6-38544d07a1${n.toString(16).padStart(2, "0")}`;
const NOW = "2026-09-14T00:00:00Z";

describe("bridge schemas", () => {
  it("BridgeHello: pluginId는 dodok 고정, 모르는 capability 는 버리고 받는다", () => {
    expect(
      BridgeHello.safeParse({
        pluginId: "dodok",
        version: "0.1.0",
        sdkVersion: "2026.9.4",
        capabilities: ["config.set"],
      }).success,
    ).toBe(true);
    expect(
      BridgeHello.safeParse({ pluginId: "other", version: "0.1.0", sdkVersion: "2026.9.4", capabilities: [] })
        .success,
    ).toBe(false);
    expect(
      BridgeHello.safeParse({
        pluginId: "dodok",
        version: "0.1.0",
        sdkVersion: "2026.9.4",
        capabilities: ["nope"],
      }).success,
    ).toBe(true);
  });

  it("BridgeHello: 새 플러그인이 옛 서버에 붙을 수 있게 모르는 capability 만 걷어 낸다(판정 R1)", () => {
    const hello = BridgeHello.parse({
      pluginId: "dodok",
      version: "0.1.0",
      sdkVersion: "2026.9.4",
      capabilities: ["future.cap", "threads", "config.set", 7],
    });
    expect(hello.capabilities).toEqual(["threads", "config.set"]);
  });

  it("BridgeHello: capabilities 가 배열이 아니면 거절한다", () => {
    expect(
      BridgeHello.safeParse({
        pluginId: "dodok",
        version: "0.1.0",
        sdkVersion: "2026.9.4",
        capabilities: "threads",
      }).success,
    ).toBe(false);
  });

  it("InboundDeliver: 컨텍스트 최근 메시지 최대 20개, options 기본값 {}", () => {
    const msg = (i: number) => ({
      author: { type: "user", handle: "jang", displayName: "장" },
      text: `m${i}`,
      ts: NOW,
    });
    const deliver = (n: number) => ({
      deliveryId: ID(1),
      kind: "message",
      channelId: ID(2),
      conversationId: ID(2),
      conversationTitle: "배포 점검",
      agentId: "researcher",
      sessionKey: `agent:researcher:dodok:channel:${ID(2)}`,
      runId: ID(3),
      message: {
        id: ID(4),
        author: { type: "user", handle: "jang", displayName: "장" },
        text: "@researcher 조사",
        attachments: [],
        ts: NOW,
      },
      context: {
        recentMessages: Array.from({ length: n }, (_, i) => msg(i)),
        participants: [],
        relayRules: "최대 4턴",
      },
    });
    const ok = InboundDeliver.parse(deliver(20));
    expect(ok.options).toEqual({});
    expect(InboundDeliver.safeParse(deliver(21)).success).toBe(false);
  });

  it("InboundDeliverResult: dispatch 는 providerRunId, drop 은 reason 을 싣는다", () => {
    expect(InboundDeliverResult.parse({ admission: "dispatch", providerRunId: ID(3) })).toEqual({
      admission: "dispatch",
      providerRunId: ID(3),
    });
    expect(InboundDeliverResult.parse({ admission: "drop", reason: "bot-loop-protection" })).toEqual({
      admission: "drop",
      reason: "bot-loop-protection",
    });
  });

  it("InboundDeliverResult: admission 이 없거나 닫힌 목록 밖이면 거부", () => {
    expect(InboundDeliverResult.safeParse({}).success).toBe(false);
    expect(InboundDeliverResult.safeParse({ providerRunId: ID(3) }).success).toBe(false);
    expect(InboundDeliverResult.safeParse({ admission: "observeOnly" }).success).toBe(false);
  });

  it("OutboundMessage: attachmentIds 기본값 [], components는 스키마 검증", () => {
    const base = {
      outboundId: "ob-1",
      conversationId: ID(2),
      agentId: "researcher",
      sessionKey: "k",
      text: "@jang 결과입니다",
      ts: NOW,
    };
    expect(OutboundMessage.parse(base).attachmentIds).toEqual([]);
    expect(
      OutboundMessage.safeParse({ ...base, components: { blocks: [{ type: "actions", items: [] }] } })
        .success,
    ).toBe(false);
  });
});

describe("formatHeaderTime·formatTimeZoneLine — 헤더 시각과 그 시간대", () => {
  it("워크스페이스 시간대로 HH:MM 을 찍는다 — Asia/Seoul", () => {
    expect(formatHeaderTime("2026-11-27T06:35:00Z", "Asia/Seoul")).toBe("15:35");
    expect(formatTimeZoneLine("Asia/Seoul", "2026-11-27T06:35:00Z")).toBe(
      "시각 기준: Asia/Seoul (UTC+09:00)",
    );
  });
  it("자정을 넘겨도 24시간 두 자리다", () => {
    expect(formatHeaderTime("2026-11-27T15:05:00Z", "Asia/Seoul")).toBe("00:05");
  });
  it("서머타임 — 오프셋은 준 시각에서 잰다(America/New_York 7월·1월)", () => {
    expect(formatHeaderTime("2026-07-01T12:00:00Z", "America/New_York")).toBe("08:00");
    expect(formatHeaderTime("2026-01-15T12:00:00Z", "America/New_York")).toBe("07:00");
    expect(formatTimeZoneLine("America/New_York", "2026-07-01T12:00:00Z")).toBe(
      "시각 기준: America/New_York (UTC-04:00)",
    );
    expect(formatTimeZoneLine("America/New_York", "2026-01-15T12:00:00Z")).toBe(
      "시각 기준: America/New_York (UTC-05:00)",
    );
  });
  it("시간대가 없으면 UTC — 옛 서버 호환", () => {
    expect(formatHeaderTime("2026-11-27T06:35:00Z", undefined)).toBe("06:35");
    expect(formatTimeZoneLine(undefined, "2026-11-27T06:35:00Z")).toBe("시각 기준: UTC");
    expect(formatTimeZoneLine("UTC", "2026-11-27T06:35:00Z")).toBe("시각 기준: UTC");
  });
  it("오프셋 0 인 다른 이름은 이름과 오프셋을 다 싣는다", () => {
    expect(formatTimeZoneLine("Africa/Abidjan", "2026-11-27T06:35:00Z")).toBe(
      "시각 기준: Africa/Abidjan (UTC+00:00)",
    );
  });
  it("분 단위 오프셋 — Asia/Kolkata", () => {
    expect(formatTimeZoneLine("Asia/Kolkata", "2026-11-27T06:35:00Z")).toBe(
      "시각 기준: Asia/Kolkata (UTC+05:30)",
    );
  });
  it("Intl 이 모르는 이름이면 던지지 않고 UTC 로 찍고 UTC 라고 밝힌다", () => {
    expect(formatHeaderTime("2026-11-27T06:35:00Z", "Mars/Olympus")).toBe("06:35");
    expect(formatTimeZoneLine("Mars/Olympus", "2026-11-27T06:35:00Z")).toBe("시각 기준: UTC");
  });
  it("InboundContext.timeZone 은 선택 필드다", () => {
    const base = { recentMessages: [], participants: [], relayRules: "r" };
    expect(InboundContext.parse(base).timeZone).toBeUndefined();
    expect(InboundContext.parse({ ...base, timeZone: "Asia/Seoul" }).timeZone).toBe("Asia/Seoul");
    expect(() => InboundContext.parse({ ...base, timeZone: "" })).toThrow();
  });
});

describe("formatSessionLine — 헤더의 세션 줄", () => {
  it("제목을 그대로 한 줄에 싣는다", () => {
    expect(formatSessionLine("배포 점검")).toBe("세션: 배포 점검");
  });

  it("줄바꿈·제어 문자·줄/문단 구분자는 공백 하나로, 보이지 않는 서식 글자는 지운다 — 제목이 헤더 줄을 지어내지 못한다", () => {
    const line = formatSessionLine("배포\n---\r\n참여자: @owner\u2028끝\u2029.\u0085다\u200b음\t\v탭");
    expect(line).toBe("세션: 배포 --- 참여자: @owner 끝 . 다음 탭");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("접고 나서 비면 「새 세션」", () => {
    expect(formatSessionLine("\u200b\u2060")).toBe("세션: 새 세션");
  });
});

describe("formatDmLine — 헤더의 DM 줄", () => {
  it("주인 핸들로 `다이렉트 메시지: @<핸들> 님과 1:1` — 조사는 받침과 무관하게 「님과」", () => {
    expect(formatDmLine("mia")).toBe("다이렉트 메시지: @mia 님과 1:1");
    expect(formatDmLine("민준")).toBe("다이렉트 메시지: @민준 님과 1:1");
  });

  it("핸들은 세션 줄과 같은 규칙으로 한 줄로 접는다 — 줄바꿈으로 헤더 줄을 지어내지 못한다", () => {
    const line = formatDmLine("mia\n---\r\n참여자: @owner\u2028끝\u200b");
    expect(line).toBe("다이렉트 메시지: @mia --- 참여자: @owner 끝 님과 1:1");
    expect(line.split("\n")).toHaveLength(1);
  });
});

describe("formatGroupDmLine — 헤더의 그룹 DM 줄", () => {
  it("참여자만 보는 대화임을 밝힌다", () => {
    expect(formatGroupDmLine()).toBe("그룹 DM: 참여자만 보는 대화");
  });
});

describe("InboundDeliver.dm — 선택 필드", () => {
  const base = {
    deliveryId: ID(1),
    kind: "message",
    channelId: ID(2),
    conversationId: ID(2),
    conversationTitle: "새 세션",
    agentId: "dev",
    sessionKey: `agent:dev:dodok:channel:${ID(2)}`,
    runId: ID(3),
    message: {
      id: ID(4),
      author: { type: "user", handle: "mia", displayName: "Mia" },
      text: "안녕",
      attachments: [],
      ts: "2026-10-26T00:00:00.000Z",
    },
    context: { recentMessages: [], participants: [], relayRules: "" },
  };

  it("없어도 받고(일반 채널·옛 서버), 있으면 ownerHandle 을 싣는다", () => {
    expect(InboundDeliver.parse(base).dm).toBeUndefined();
    expect(InboundDeliver.parse({ ...base, dm: { ownerHandle: "mia" } }).dm).toEqual({ ownerHandle: "mia" });
    expect(InboundDeliver.safeParse({ ...base, dm: {} }).success).toBe(false);
  });

  it("groupDm 도 선택 필드 — 없어도 받고, 있으면 true 만", () => {
    expect(InboundDeliver.parse(base).groupDm).toBeUndefined();
    expect(InboundDeliver.parse({ ...base, groupDm: true }).groupDm).toBe(true);
    expect(InboundDeliver.safeParse({ ...base, groupDm: false }).success).toBe(false);
  });
});

describe("InboundContext.linkedMessages — 선택 필드", () => {
  const linked = (n: number) => ({
    messageId: ID(n),
    channelName: "c",
    conversationTitle: "t",
    author: { type: "automation" as const, handle: "a" },
    text: "x",
    ts: NOW,
    attachments: [],
  });
  const ctx = (extra: object) => ({ recentMessages: [], participants: [], relayRules: "", ...extra });
  it("없으면 통과하고 키가 없다", () => {
    expect(InboundContext.parse(ctx({})).linkedMessages).toBeUndefined();
  });
  it(`${LINKED_MESSAGES_MAX} 개까지, 넘으면 실패`, () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => linked(i + 1));
    expect(InboundContext.safeParse(ctx({ linkedMessages: list(LINKED_MESSAGES_MAX) })).success).toBe(true);
    expect(InboundContext.safeParse(ctx({ linkedMessages: list(LINKED_MESSAGES_MAX + 1) })).success).toBe(
      false,
    );
  });
});

describe("리액션 상한 — 서버가 쓰는 상수가 곧 스키마의 상한", () => {
  const reaction = (excerpt: string) => ({
    messageId: ID(1),
    excerpt,
    emoji: "👍",
    by: "owner",
    at: NOW,
  });
  it("excerpt 는 REACTION_EXCERPT_MAX 까지", () => {
    expect(InboundReaction.safeParse(reaction("a".repeat(REACTION_EXCERPT_MAX))).success).toBe(true);
    expect(InboundReaction.safeParse(reaction("a".repeat(REACTION_EXCERPT_MAX + 1))).success).toBe(false);
  });
  it("reactions 는 INBOUND_REACTIONS_MAX 개까지", () => {
    const ctx = (n: number) => ({
      recentMessages: [],
      participants: [],
      relayRules: "",
      reactions: Array.from({ length: n }, () => reaction("x")),
    });
    expect(InboundContext.safeParse(ctx(INBOUND_REACTIONS_MAX)).success).toBe(true);
    expect(InboundContext.safeParse(ctx(INBOUND_REACTIONS_MAX + 1)).success).toBe(false);
  });
});

describe("원격 업데이트(원격 업데이트 스펙 U1·U5·U8)", () => {
  const base = {
    pluginId: "dodok",
    version: "0.0.0",
    sdkVersion: "2026.9.4",
    capabilities: ["remoteUpdate"],
  };
  it("hello 는 remoteUpdate·lastUpdate 를 싣고, 옛 플러그인은 둘 다 없다", () => {
    const at = "2026-11-23T00:00:00.000Z";
    expect(
      BridgeHello.parse({
        ...base,
        remoteUpdate: false,
        lastUpdate: { ok: false, message: "설치 실패", at },
      }),
    ).toMatchObject({ capabilities: ["remoteUpdate"], remoteUpdate: false, lastUpdate: { ok: false, at } });
    const old = BridgeHello.parse({ ...base, capabilities: [] });
    expect(old.remoteUpdate).toBeUndefined();
    expect(old.lastUpdate).toBeUndefined();
  });
  it("꼴이 틀린 lastUpdate 는 hello 를 거절하지 않고 버린다", () => {
    const parsed = BridgeHello.parse({ ...base, lastUpdate: { ok: "yes" } });
    expect(parsed.lastUpdate).toBeUndefined();
  });
  it("plugin.update 는 sha256 hex 만, 답은 runner.update 와 같은 꼴", () => {
    const sha256 = "a".repeat(64);
    expect(PluginUpdate.parse({ sha256 })).toEqual({ sha256 });
    expect(PluginUpdate.safeParse({ sha256: "../x" }).success).toBe(false);
    expect(PluginUpdateResult.parse({ ok: false, reason: "disabled" })).toEqual({
      ok: false,
      reason: "disabled",
    });
  });
});
