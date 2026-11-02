import { describe, expect, it } from "vitest";
import { Agent, User } from "../src/domain";
import { Person } from "../src/members";
import {
  AVATAR_MAX_BYTES,
  AvatarUrl,
  MyStatus,
  PresenceEntry,
  StatusMessage,
  UpdateMyStatusBody,
} from "../src/profile";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const SHA = "a".repeat(64);

describe("UpdateMyStatusBody", () => {
  it("auto 에 만료를 붙이면 거절한다", () => {
    expect(
      UpdateMyStatusBody.safeParse({ mode: "auto", modeUntil: "2026-11-02T10:00:00.000Z" }).success,
    ).toBe(false);
  });
  it("수동 모드는 만료 없이(null) 받는다", () => {
    expect(UpdateMyStatusBody.safeParse({ mode: "busy", modeUntil: null }).success).toBe(true);
  });
  it("auto 에 null 만료는 받는다", () => {
    expect(UpdateMyStatusBody.safeParse({ mode: "auto", modeUntil: null }).success).toBe(true);
  });
  it("부분 본문(방해 금지 옵션만)을 받는다", () => {
    expect(UpdateMyStatusBody.safeParse({ dndAllowApprovals: false }).success).toBe(true);
  });
  it("모르는 모드를 거절한다", () => {
    expect(UpdateMyStatusBody.safeParse({ mode: "sleeping" }).success).toBe(false);
  });
});

describe("StatusMessage", () => {
  const msg = (text: string) => ({ emoji: null, text, until: null });
  it("공백뿐인 글을 거절한다", () => {
    expect(StatusMessage.safeParse(msg("   ")).success).toBe(false);
  });
  it("101자를 거절하고 100자를 받는다", () => {
    expect(StatusMessage.safeParse(msg("가".repeat(101))).success).toBe(false);
    expect(StatusMessage.safeParse(msg("가".repeat(100))).success).toBe(true);
  });
  it("글의 앞뒤 공백을 걷는다", () => {
    expect(StatusMessage.parse(msg("  회의 중  ")).text).toBe("회의 중");
  });
  it("이모지는 16 code unit 이하", () => {
    expect(StatusMessage.safeParse({ emoji: "🌴", text: "휴가", until: null }).success).toBe(true);
    expect(StatusMessage.safeParse({ emoji: "x".repeat(17), text: "휴가", until: null }).success).toBe(false);
  });
});

describe("MyStatus", () => {
  it("네 칸을 모두 받는다", () => {
    expect(
      MyStatus.safeParse({ mode: "dnd", modeUntil: null, message: null, dndAllowApprovals: true }).success,
    ).toBe(true);
  });
});

describe("AvatarUrl", () => {
  it("올린 사진의 상대 경로와 https URL 을 받는다", () => {
    expect(AvatarUrl.safeParse(`/api/v1/avatars/${SHA}.webp`).success).toBe(true);
    expect(AvatarUrl.safeParse(`/api/v1/avatars/${SHA}.png`).success).toBe(true);
    expect(AvatarUrl.safeParse(`/api/v1/avatars/${SHA}.jpeg`).success).toBe(true);
    expect(AvatarUrl.safeParse("https://x/y.png").success).toBe(true);
  });
  it("경로 탈출·http·gif·짧은 해시를 거절한다", () => {
    expect(AvatarUrl.safeParse("/api/v1/avatars/../x").success).toBe(false);
    expect(AvatarUrl.safeParse("http://x/y.png").success).toBe(false);
    expect(AvatarUrl.safeParse(`/api/v1/avatars/${SHA}.gif`).success).toBe(false);
    expect(AvatarUrl.safeParse("/api/v1/avatars/abc.png").success).toBe(false);
  });
  it("상한 상수", () => {
    expect(AVATAR_MAX_BYTES).toBe(262_144);
  });
});

describe("PresenceEntry", () => {
  it("에이전트의 working 을 받고 사람 상태 online 을 거절한다", () => {
    expect(PresenceEntry.safeParse({ kind: "agent", id: ID, state: "working" }).success).toBe(true);
    expect(PresenceEntry.safeParse({ kind: "agent", id: ID, state: "online" }).success).toBe(false);
  });
  it("사람의 dnd 표지와 state null(점 없음)을 받는다", () => {
    expect(
      PresenceEntry.safeParse({ kind: "user", id: ID, state: "offline", dnd: { until: null } }).success,
    ).toBe(true);
    expect(PresenceEntry.safeParse({ kind: "user", id: ID, state: null }).success).toBe(true);
  });
});

describe("Person·User·Agent 의 새 필드", () => {
  const agentBase = {
    id: ID,
    workspaceId: ID,
    provider: "openclaw",
    providerAgentId: "main",
    handle: "main",
    name: "Main",
    enabled: true,
    createdAt: "2026-11-02T00:00:00.000Z",
    archivedAt: null,
  };
  it("Agent 에 createdBy·model 이 없으면 null 로 채운다", () => {
    const a = Agent.parse(agentBase);
    expect(a.createdBy).toBeNull();
    expect(a.model).toBeNull();
  });
  it("Agent.avatarUrl 이 올린 사진의 상대 경로를 받는다", () => {
    expect(Agent.safeParse({ ...agentBase, avatarUrl: `/api/v1/avatars/${SHA}.webp` }).success).toBe(true);
  });
  it("User.avatarUrl 이 올린 사진의 상대 경로를 받는다", () => {
    expect(
      User.safeParse({
        id: ID,
        workspaceId: ID,
        handle: "alice",
        displayName: "Alice",
        authProvider: "local",
        avatarUrl: `/api/v1/avatars/${SHA}.png`,
        createdAt: "2026-11-02T00:00:00.000Z",
      }).success,
    ).toBe(true);
  });
  it("Person 의 statusMessage 기본값은 null", () => {
    const p = Person.parse({ id: ID, handle: "alice", displayName: "Alice", deactivatedAt: null });
    expect(p.statusMessage).toBeNull();
  });
});
