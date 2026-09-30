import { describe, expect, it } from "vitest";
import {
  BridgeHello,
  IssueBridgeTokenInput,
  IssueBridgeTokenResult,
  IssueRunnerTokenResult,
  SetupStatus,
  Sha256Hex,
} from "../src";

const ID = "01a09fc9-d204-7551-89d6-38544d07a101";
const NOW = "2026-09-24T00:00:00Z";
const SHA = "a".repeat(64);
const TOKEN = `dbt_${"A".repeat(40)}_-9`;
const RECORD = {
  id: ID,
  label: "env",
  prefix: "AAAAAA",
  createdAt: NOW,
  lastUsedAt: null,
  revokedAt: null,
  connected: false,
};
const STATUS = {
  server: { version: "0.0.0" },
  gateway: {
    state: "connected",
    host: "gw.example",
    version: "2026.9.5",
    pinned: "2026.9.4",
    drift: true,
    pairing: null,
  },
  bridge: {
    state: "connected",
    publicUrl: "wss://chat.example/bridge",
    plugin: {
      version: "0.0.0",
      sdkVersion: "2026.9.4",
      gatewayVersion: null,
      bundleSha256: null,
      tokenId: null,
      connectedAt: NOW,
    },
  },
  pluginFile: { available: false },
  pluginMatches: null,
  envTokenIgnored: false,
  runners: { list: [], runnerFile: { available: false } },
};

describe("Sha256Hex", () => {
  it("소문자 hex 64자만 통과한다", () => {
    expect(Sha256Hex.safeParse(SHA).success).toBe(true);
    expect(Sha256Hex.safeParse("0123456789abcdef".repeat(4)).success).toBe(true);
  });
  it("63·65자·대문자·hex 밖 글자는 거부한다", () => {
    for (const bad of ["a".repeat(63), "a".repeat(65), "A".repeat(64), `${"a".repeat(63)}g`, ""]) {
      expect(Sha256Hex.safeParse(bad).success).toBe(false);
    }
  });
});

describe("BridgeHello.bundleSha256", () => {
  const hello = { pluginId: "dodok", version: "0.0.0", sdkVersion: "2026.9.4", capabilities: [] };
  it("없어도(옛 플러그인)·있어도 통과한다", () => {
    expect(BridgeHello.safeParse(hello).success).toBe(true);
    expect(BridgeHello.parse({ ...hello, bundleSha256: SHA }).bundleSha256).toBe(SHA);
  });
  it("형식이 틀리면 거부한다", () => {
    expect(BridgeHello.safeParse({ ...hello, bundleSha256: "A".repeat(64) }).success).toBe(false);
  });
});

describe("IssueBridgeTokenInput", () => {
  it("라벨 앞뒤 공백을 걷는다", () => {
    expect(IssueBridgeTokenInput.parse({ label: "  gw-1 " })).toEqual({ label: "gw-1" });
  });
  it("60자까지 통과, 61자·공백만·빈 값은 거부한다", () => {
    expect(IssueBridgeTokenInput.safeParse({ label: "x".repeat(60) }).success).toBe(true);
    for (const label of ["x".repeat(61), "   ", ""]) {
      expect(IssueBridgeTokenInput.safeParse({ label }).success).toBe(false);
    }
  });
});

describe("IssueBridgeTokenResult", () => {
  it("dbt_ + base64url 43자 토큰은 통과한다", () => {
    expect(IssueBridgeTokenResult.safeParse({ token: TOKEN, record: RECORD, pluginConfig: {} }).success).toBe(
      true,
    );
  });
  it("접두어·길이·글자가 틀린 토큰은 거부한다", () => {
    for (const token of [
      `dbx_${"A".repeat(43)}`,
      `dbt_${"A".repeat(42)}`,
      `dbt_${"A".repeat(44)}`,
      `dbt_${"A".repeat(42)}+`,
      `dbt_${"A".repeat(42)}=`,
    ]) {
      expect(IssueBridgeTokenResult.safeParse({ token, record: RECORD, pluginConfig: {} }).success).toBe(
        false,
      );
    }
  });
  it("record 는 원문을 싣지 않는다(모르는 키는 걷힌다)", () => {
    const parsed = IssueBridgeTokenResult.parse({
      token: TOKEN,
      record: { ...RECORD, token: TOKEN },
      pluginConfig: {},
    });
    expect(parsed.record).not.toHaveProperty("token");
  });
  it("prefix 는 6자", () => {
    for (const prefix of ["AAAAA", "AAAAAAA"]) {
      expect(
        IssueBridgeTokenResult.safeParse({ token: TOKEN, record: { ...RECORD, prefix }, pluginConfig: {} })
          .success,
      ).toBe(false);
    }
  });
});

describe("IssueRunnerTokenResult", () => {
  const runnerConfig = { serverUrl: "https://chat.example", tokenFile: "~/.dodok-runner/token" };
  it("drn_ + base64url 43자 토큰은 통과한다", () => {
    const token = `drn_${"A".repeat(40)}_-9`;
    expect(IssueRunnerTokenResult.safeParse({ token, record: RECORD, runnerConfig }).success).toBe(true);
  });
  it("브리지 토큰 접두어·길이가 틀린 토큰은 거부한다", () => {
    for (const token of [TOKEN, `drn_${"A".repeat(42)}`, `drn_${"A".repeat(42)}=`]) {
      expect(IssueRunnerTokenResult.safeParse({ token, record: RECORD, runnerConfig }).success).toBe(false);
    }
  });
  it("runnerConfig 가 없으면 거부한다", () => {
    const token = `drn_${"A".repeat(43)}`;
    expect(IssueRunnerTokenResult.safeParse({ token, record: RECORD }).success).toBe(false);
  });
});

describe("SetupStatus", () => {
  it("gateway 에 핀·드리프트가 있어야 한다(운영 보강 5.2)", () => {
    const { pinned: _p, ...noPinned } = STATUS.gateway;
    const { drift: _d, ...noDrift } = STATUS.gateway;
    expect(SetupStatus.safeParse({ ...STATUS, gateway: noPinned }).success).toBe(false);
    expect(SetupStatus.safeParse({ ...STATUS, gateway: noDrift }).success).toBe(false);
  });
  it("pluginFile 없음·gateway.pairing null 은 통과한다", () => {
    expect(SetupStatus.parse(STATUS)).toEqual(STATUS);
  });
  it("pluginFile 있음은 sha256·bundleSha256·bytes 가 있어야 한다", () => {
    const file = { available: true, sha256: SHA, bundleSha256: "b".repeat(64), bytes: 1234 };
    expect(SetupStatus.parse({ ...STATUS, pluginFile: file }).pluginFile).toEqual(file);
    expect(SetupStatus.safeParse({ ...STATUS, pluginFile: { available: true } }).success).toBe(false);
    for (const key of ["sha256", "bundleSha256"] as const) {
      const { [key]: _, ...missing } = file;
      expect(SetupStatus.safeParse({ ...STATUS, pluginFile: missing }).success).toBe(false);
    }
    expect(SetupStatus.safeParse({ ...STATUS, pluginFile: { ...file, bytes: -1 } }).success).toBe(false);
  });
  it("페어링 대기는 requestId·since 를 싣는다", () => {
    const gateway = { ...STATUS.gateway, state: "reconnecting", pairing: { requestId: "req-1", since: NOW } };
    expect(SetupStatus.parse({ ...STATUS, gateway }).gateway.pairing).toEqual({
      requestId: "req-1",
      since: NOW,
    });
  });
  it("Gateway 에 아직 못 붙었으면 gateway.version 은 null", () => {
    const gateway = { ...STATUS.gateway, state: "down", version: null };
    expect(SetupStatus.parse({ ...STATUS, gateway }).gateway.version).toBeNull();
  });
  it("pairing.since·connectedAt 은 ISO 시각만", () => {
    const pairing = { requestId: "req-1", since: "어제" };
    expect(SetupStatus.safeParse({ ...STATUS, gateway: { ...STATUS.gateway, pairing } }).success).toBe(false);
    const plugin = { ...STATUS.bridge.plugin, connectedAt: "2026-09-24" };
    expect(SetupStatus.safeParse({ ...STATUS, bridge: { ...STATUS.bridge, plugin } }).success).toBe(false);
  });
  it("플러그인이 접속하지 않았으면 bridge.plugin 은 null", () => {
    const bridge = { state: "down", publicUrl: "wss://chat.example/bridge", plugin: null };
    expect(SetupStatus.safeParse({ ...STATUS, bridge }).success).toBe(true);
  });
  it("상태 값은 닫힌 목록", () => {
    expect(SetupStatus.safeParse({ ...STATUS, gateway: { ...STATUS.gateway, state: "up" } }).success).toBe(
      false,
    );
    expect(
      SetupStatus.safeParse({ ...STATUS, bridge: { ...STATUS.bridge, state: "reconnecting" } }).success,
    ).toBe(false);
  });
});

describe("SetupStatus.runners", () => {
  const runner = {
    tokenId: ID,
    label: "노트북",
    runnerVersion: "0.0.0",
    sdkVersion: "0.3.283",
    claudeCodeVersion: "3.1.0",
    bundleSha256: SHA,
    capabilities: ["threads", "approvals"],
    connectedAt: NOW,
    agents: [
      {
        id: "coder",
        name: "코더",
        model: "sonnet",
        workdirLabel: "my-repo",
        conflict: false,
        boundTokenId: null,
      },
    ],
  };
  it("붙은 러너·러너 tgz 를 싣는다", () => {
    const runners = {
      list: [runner],
      runnerFile: { available: true, sha256: SHA, bundleSha256: SHA, bytes: 1 },
    };
    expect(SetupStatus.parse({ ...STATUS, runners }).runners).toEqual(runners);
  });
  it("runners 는 빠질 수 없고, 러너 tgz 가 있으면 해시가 있어야 한다", () => {
    const { runners: _omit, ...withoutRunners } = STATUS;
    expect(SetupStatus.safeParse(withoutRunners).success).toBe(false);
    const runnerFile = { available: true, sha256: SHA, bytes: 1 };
    expect(SetupStatus.safeParse({ ...STATUS, runners: { list: [], runnerFile } }).success).toBe(false);
  });
  it("connectedAt 은 ISO 시각, bundleSha256 은 sha256 hex 또는 null, 에이전트 boundTokenId 는 uuid 또는 null", () => {
    const agent = runner.agents[0];
    const bad = [
      { ...runner, connectedAt: "어제" },
      { ...runner, bundleSha256: "abc" },
      // 묶인 토큰은 토큰 id(uuid) 또는 null — 빠지면 웹이 「다른 러너에 묶임」을 가를 수 없다
      { ...runner, agents: [{ ...agent, boundTokenId: "laptop" }] },
      { ...runner, agents: [{ ...agent, boundTokenId: undefined }] },
    ];
    for (const r of bad) {
      expect(
        SetupStatus.safeParse({ ...STATUS, runners: { list: [r], runnerFile: { available: false } } })
          .success,
      ).toBe(false);
    }
  });
});
