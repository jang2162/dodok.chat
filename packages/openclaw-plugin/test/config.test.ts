import { ATTACHMENT_LIMITS } from "@dodok/shared";
import { describe, expect, it } from "vitest";
import {
  applyChannelConfigSet,
  DodokChannelSection,
  listDodokAccountIds,
  resolveDodokAccount,
  resolveDodokChannelEntry,
} from "../src/config";

const CH = "01a09fc9-d204-7551-89d6-38544d07a102";

describe("DodokChannelSection", () => {
  it("계정·채널별 설정을 받는다", () => {
    const parsed = DodokChannelSection.parse({
      accounts: { default: { bridgeUrl: "wss://dodok.example.com/bridge", token: "t0k" } },
      channels: {
        [CH]: {
          requireMention: true,
          systemPrompt: "버그 분류 채널",
          botLoopProtection: { enabled: false },
        },
      },
    });
    expect(parsed.accounts?.default?.bridgeUrl).toBe("wss://dodok.example.com/bridge");
    expect(parsed.channels?.[CH]?.botLoopProtection?.enabled).toBe(false);
  });

  it("브리지 URL 은 ws/wss/http/https 만 받는다", () => {
    const bad = DodokChannelSection.safeParse({
      accounts: { default: { bridgeUrl: "ftp://x.example.com", token: "t" } },
    });
    expect(bad.success).toBe(false);
  });

  it("모르는 키는 거부한다 (Gateway 설정 검증과 같은 strict)", () => {
    const bad = DodokChannelSection.safeParse({ channels: { [CH]: { requireMentoin: true } } });
    expect(bad.success).toBe(false);
  });

  it("채널 키는 dodok 채널 id(uuid)다", () => {
    const bad = DodokChannelSection.safeParse({ channels: { c1: {} } });
    expect(bad.success).toBe(false);
  });
});

describe("resolveDodokAccount", () => {
  it("accountId 가 없으면 default 를 쓴다", () => {
    const account = resolveDodokAccount(
      { accounts: { default: { bridgeUrl: "ws://127.0.0.1:19100/bridge", token: "t0k" } } },
      undefined,
    );
    expect(account).toEqual({
      accountId: "default",
      enabled: true,
      configured: true,
      bridgeUrl: "ws://127.0.0.1:19100/bridge",
      token: "t0k",
      mediaMaxBytes: 20 * 1024 * 1024,
      issues: [],
    });
  });

  it("mediaMaxMb(1~20)는 MiB 로 풀고, 없으면 20 MiB — 에이전트 파일 상한을 넘지 않는다", () => {
    const at = (mediaMaxMb?: number) =>
      resolveDodokAccount(
        {
          accounts: {
            default: { bridgeUrl: "ws://h/bridge", token: "t", ...(mediaMaxMb ? { mediaMaxMb } : {}) },
          },
        },
        "default",
      );
    expect(at(5).mediaMaxBytes).toBe(5 * 1024 * 1024);
    expect(at().mediaMaxBytes).toBe(ATTACHMENT_LIMITS.agentFileMaxBytes);
    expect(resolveDodokAccount({}, "other").mediaMaxBytes).toBe(ATTACHMENT_LIMITS.agentFileMaxBytes);
    for (const bad of [0, 21, 1.5]) {
      expect(
        DodokChannelSection.safeParse({
          accounts: { a: { bridgeUrl: "ws://h/b", token: "t", mediaMaxMb: bad } },
        }).success,
      ).toBe(false);
    }
  });

  it("섹션 enabled:false 면 계정도 꺼진다", () => {
    const account = resolveDodokAccount(
      { enabled: false, accounts: { default: { bridgeUrl: "ws://127.0.0.1:1/bridge", token: "t" } } },
      "default",
    );
    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });

  it("없는 계정은 configured:false", () => {
    const account = resolveDodokAccount({}, "other");
    expect(account.configured).toBe(false);
    expect(account.bridgeUrl).toBeUndefined();
  });

  it("섹션이 검증에 실패하면 configured:false 와 이슈 경로를 돌려준다 (토큰 값은 싣지 않는다)", () => {
    const account = resolveDodokAccount(
      { accounts: { default: { bridgeUrl: "nope", token: "secret-value" } } },
      "default",
    );
    expect(account.configured).toBe(false);
    expect(account.issues.join("\n")).toContain("accounts.default.bridgeUrl");
    expect(account.issues.join("\n")).not.toContain("secret-value");
  });
});

describe("listDodokAccountIds / resolveDodokChannelEntry", () => {
  it("계정 id 목록", () => {
    expect(
      listDodokAccountIds({
        accounts: {
          default: { bridgeUrl: "ws://a/bridge", token: "t" },
          b: { bridgeUrl: "ws://b/bridge", token: "t" },
        },
      }),
    ).toEqual(["default", "b"]);
    expect(listDodokAccountIds(undefined)).toEqual([]);
  });

  it("채널 항목과 섹션 기본 봇 루프 설정을 합친다 (채널 값 우선)", () => {
    const entry = resolveDodokChannelEntry(
      {
        botLoopProtection: { maxEventsPerWindow: 8, windowSeconds: 30 },
        channels: { [CH]: { systemPrompt: "p", botLoopProtection: { maxEventsPerWindow: 2 } } },
      },
      CH,
    );
    expect(entry).toEqual({
      requireMention: true,
      systemPrompt: "p",
      botLoopProtection: { maxEventsPerWindow: 2 },
      sectionBotLoopProtection: { maxEventsPerWindow: 8, windowSeconds: 30 },
    });
  });

  it("설정이 없는 채널은 requireMention 기본 true", () => {
    expect(resolveDodokChannelEntry({}, CH)).toEqual({ requireMention: true });
  });

  it("모르는 키 inboundChannelPrompt 는 섹션 검증에서 거부한다 (계획서 10장 #18 로 제거)", () => {
    for (const value of ["prefix", "context"]) {
      expect(
        DodokChannelSection.safeParse({ channels: { [CH]: { inboundChannelPrompt: value } } }).success,
      ).toBe(false);
    }
    expect(resolveDodokChannelEntry({ channels: { [CH]: { inboundChannelPrompt: "context" } } }, CH)).toEqual(
      {
        requireMention: true,
      },
    );
  });
});

describe("applyChannelConfigSet", () => {
  it("브리지 config.set 을 channels.dodok.channels.<id> 에 병합한다 (다른 키는 보존)", () => {
    const draft: Record<string, unknown> = {
      gateway: { mode: "local" },
      channels: { dodok: { accounts: { default: { bridgeUrl: "ws://a/bridge", token: "t" } } } },
    };
    const changed = applyChannelConfigSet(draft, { channelId: CH, config: { systemPrompt: "새 프롬프트" } });
    expect(changed).toBe(true);
    expect(draft).toEqual({
      gateway: { mode: "local" },
      channels: {
        dodok: {
          accounts: { default: { bridgeUrl: "ws://a/bridge", token: "t" } },
          channels: { [CH]: { systemPrompt: "새 프롬프트" } },
        },
      },
    });
  });

  it("같은 값이면 changed:false, 기존 채널 항목의 다른 키는 유지", () => {
    const draft: Record<string, unknown> = {
      channels: { dodok: { channels: { [CH]: { requireMention: false, systemPrompt: "p" } } } },
    };
    expect(applyChannelConfigSet(draft, { channelId: CH, config: { systemPrompt: "p" } })).toBe(false);
    expect(applyChannelConfigSet(draft, { channelId: CH, config: { requireMention: true } })).toBe(true);
    expect(draft).toEqual({
      channels: { dodok: { channels: { [CH]: { requireMention: true, systemPrompt: "p" } } } },
    });
  });
});
