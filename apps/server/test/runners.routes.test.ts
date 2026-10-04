import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import {
  type Agent,
  Attachment,
  BRIDGE_ATTACHMENT_HEADERS,
  BRIDGE_ATTACHMENTS_PATH,
  IssueRunnerTokenResult,
  RUNNER_ATTACHMENTS_PATH,
  RUNNER_NAMESPACE,
  RunnerTokenRecord,
  SetupStatus,
} from "@dodok/shared";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import pino from "pino";
import { io } from "socket.io-client";
import { v7 as uuid } from "uuid";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { opsEvents } from "../src/db/schema.sqlite";
import { markBound } from "../src/modules/attachments/service";
import { createUserMessage } from "../src/modules/messages/service";
import { RUNNER_BUNDLE_ENTRY } from "../src/modules/runners/runner-file";
import { RUNNER_TOKEN_FILE } from "../src/modules/runners/routes";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { makePng } from "./helpers/png";

/** 그 앱의 가짜 Gateway(bootTestApp 이 넣는다)에 브리지 토큰 하나 — 원문 */
const bridgeTokenOf = (app: App) => issueBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, "gw").token;
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function captureLogger() {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => void lines.push(line) });
  return { logger, lines };
}

/** package/dist/main.js 하나만 든 tgz(ustar 한 블록 — 체크섬은 읽는 쪽이 보지 않는다) */
function tinyRunnerTgz(bundle: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(RUNNER_BUNDLE_ENTRY, 0);
  header.write(`${bundle.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write("0", 156);
  header.write("ustar\0", 257);
  const body = Buffer.alloc(Math.ceil(bundle.length / 512) * 512);
  bundle.copy(body);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}

/** 핸드셰이크만 해 본다 — 붙으면 "connected", 거절되면 connect_error 메시지 */
function tryRunner(url: string, token: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = io(`${url}${RUNNER_NAMESPACE}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    socket.once("connect", () => {
      socket.close();
      resolve("connected");
    });
    socket.once("connect_error", (err) => {
      socket.close();
      resolve(err.message);
    });
  });
}

describe("연결 페이지 러너 API /api/v1/setup/runner-*", () => {
  let app: App;
  let owner: { authorization: string };
  let admin: { authorization: string };
  let member: { authorization: string };
  let runnerDir: string;
  let log: ReturnType<typeof captureLogger>;
  const runners: FakeRunner[] = [];
  const BUNDLE = Buffer.from("#!/usr/bin/env node\n");
  let tgz: Buffer;

  beforeAll(async () => {
    runnerDir = mkdtempSync(join(tmpdir(), "dodok-runner-dir-"));
    tgz = tinyRunnerTgz(BUNDLE);
    writeFileSync(join(runnerDir, "dodok-claude-runner-0.0.0.tgz"), tgz);
    log = captureLogger();
    app = await bootTestApp(
      { APP_ORIGIN: "https://chat.example.com" },
      { adapters: [new FakeAdapter()], runnerAdapter: true, runnerDirs: [runnerDir], logger: log.logger },
    );
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    owner = (await login(app)).headers;
    admin = { authorization: `Bearer ${(await userWithRole(app, "ada", "admin")).token}` };
    member = { authorization: `Bearer ${(await userWithRole(app, "bee", "member")).token}` };
  });
  afterEach(() => {
    for (const runner of runners.splice(0)) runner.close();
  });
  afterAll(async () => {
    await app.close();
    rmSync(runnerDir, { recursive: true, force: true });
  });

  const call = (
    headers: Record<string, string> | undefined,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: object,
  ) =>
    app.fastify.inject({
      method,
      url: `/api/v1/setup${url}`,
      ...(headers ? { headers } : {}),
      ...(payload === undefined ? {} : { payload }),
    });
  const issue = async (label: string) => {
    const res = await call(owner, "POST", "/runner-tokens", { label });
    expect(res.statusCode).toBe(201);
    return IssueRunnerTokenResult.parse(res.json());
  };
  const status = async () => SetupStatus.parse((await call(owner, "GET", "/status")).json());
  const connect = async (token: string) => {
    const runner = await startFakeRunner({ url: app.url, token });
    runners.push(runner);
    return runner;
  };

  it("admin·member 는 네 경로 모두 403, 세션이 없으면 401 — 러너 토큰은 owner 몫", async () => {
    const routes: Array<["GET" | "POST" | "PUT" | "DELETE", string, object?]> = [
      ["GET", "/runner-tokens"],
      ["POST", "/runner-tokens", { label: "x" }],
      ["DELETE", `/runner-tokens/${uuid()}`],
      ["PUT", `/runner-tokens/${uuid()}/agents/coder`],
      ["GET", "/runner.tgz"],
    ];
    for (const [method, url, body] of routes) {
      for (const who of [admin, member]) {
        const res = await call(who, method, url, body);
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json().code).toBe("FORBIDDEN");
      }
      expect((await call(undefined, method, url, body)).statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("owner 발급 201 — 원문 drn_ 는 이 응답에만 한 번(no-store), 목록에는 prefix 만, 설정 조각은 serverUrl·tokenFile", async () => {
    const res = await call(owner, "POST", "/runner-tokens", { label: " macbook " });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const issued = IssueRunnerTokenResult.parse(res.json());
    expect(issued.record).toMatchObject({
      label: "macbook",
      prefix: issued.token.slice(4, 10),
      connected: false,
    });
    expect(issued.runnerConfig).toEqual({
      serverUrl: "https://chat.example.com",
      tokenFile: RUNNER_TOKEN_FILE,
    });

    const list = await call(owner, "GET", "/runner-tokens");
    expect(list.statusCode).toBe(200);
    const tokens = (list.json() as { tokens: unknown[] }).tokens.map((t) => RunnerTokenRecord.parse(t));
    expect(tokens.find((t) => t.id === issued.record.id)).toEqual(issued.record);
    expect(list.body).not.toContain(issued.token.slice(4));
    expect((await status()).runners.list).toEqual([]);
    expect(log.lines.join("\n")).not.toContain(issued.token.slice(4));
  });

  it("어댑터 상태 runners 는 붙은 수·폐기 안 된 토큰 수, 러너 어댑터가 붙어 있어도 claude 에이전트가 없으면 usage 를 믿는 제공자가 없다", async () => {
    type Status = { provider: string; runners?: { connected: number; tokens: number } };
    const claudeStatus = async () => {
      const res = await app.fastify.inject({ method: "GET", url: "/api/v1/adapter/status", headers: owner });
      return (res.json() as { statuses: Status[] }).statuses.find((s) => s.provider === "claude");
    };
    const before = await claudeStatus();
    await issue("counted");
    const after = await claudeStatus();
    expect(after).toMatchObject({ provider: "claude", runners: { connected: 0 } });
    expect(after?.runners?.tokens).toBe((before?.runners?.tokens ?? -1) + 1);

    const usage = async () =>
      (
        (
          await app.fastify.inject({ method: "GET", url: "/api/v1/ops/runs?days=1", headers: owner })
        ).json() as {
          usageTrustedProviders: string[];
        }
      ).usageTrustedProviders;
    // OpenClaw 만 쓰는 배포와 같다 — 웹은 「측정 불가」
    expect(await usage()).toEqual([]);
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/v1/agents",
      headers: owner,
      payload: { provider: "claude", providerAgentId: "usage-coder", handle: "usage-coder", name: "U" },
    });
    expect(created.statusCode).toBe(201);
    expect(await usage()).toEqual(["claude"]);
  });

  it("라벨이 비면 400", async () => {
    const res = await call(owner, "POST", "/runner-tokens", { label: "   " });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION");
  });

  it("붙은 러너는 목록 connected·SetupStatus.runners.list 에 보이고, 폐기하면 그 소켓이 곧바로 끊기고 빠진다", async () => {
    const issued = await issue("desk");
    const runner = await connect(issued.token);
    expect(runner.helloResult).toMatchObject({ ok: true, conflicts: [] });
    const listed = (await call(owner, "GET", "/runner-tokens")).json() as { tokens: RunnerTokenRecord[] };
    expect(listed.tokens.find((t) => t.id === issued.record.id)?.connected).toBe(true);
    expect((await status()).runners.list).toEqual([
      expect.objectContaining({
        tokenId: issued.record.id,
        label: "desk",
        agents: [expect.objectContaining({ id: "coder", conflict: false })],
      }),
    ]);

    const setupEvents: unknown[] = [];
    const off = app.bus.on("setup.status", (p) => setupEvents.push(p));
    const revoked = await call(owner, "DELETE", `/runner-tokens/${issued.record.id}`);
    off();
    expect(revoked.statusCode).toBe(204);
    await vi.waitFor(() => expect(runner.connected).toBe(false));
    expect(setupEvents.length).toBeGreaterThan(0);
    await vi.waitFor(async () => expect((await status()).runners.list).toEqual([]));
    const after = (await call(owner, "GET", "/runner-tokens")).json() as { tokens: RunnerTokenRecord[] };
    expect(after.tokens.find((t) => t.id === issued.record.id)).toMatchObject({ connected: false });
    expect(after.tokens.find((t) => t.id === issued.record.id)?.revokedAt).not.toBeNull();
    // 폐기된 토큰은 다시 못 붙는다
    expect(await tryRunner(app.url, issued.token)).toBe("UNAUTHORIZED");
  });

  describe("에이전트↔러너 토큰 묶임", () => {
    const agentsApi = (method: "GET" | "POST", payload?: object) =>
      app.fastify.inject({
        method,
        url: "/api/v1/agents",
        headers: owner,
        ...(payload === undefined ? {} : { payload }),
      });
    const register = async (providerAgentId: string, provider: "claude" | "openclaw" = "claude") => {
      const res = await agentsApi("POST", {
        provider,
        providerAgentId,
        handle: providerAgentId,
        name: providerAgentId,
        ...(provider === "openclaw" ? { gatewayId: FAKE_GATEWAY_ID } : {}),
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as { agent: Agent }).agent;
    };
    const listed = async (providerAgentId: string) =>
      ((await agentsApi("GET")).json() as { agents: Agent[] }).agents.find(
        (a) => a.providerAgentId === providerAgentId,
      );
    const connectWith = async (token: string, id: string) => {
      const runner = await startFakeRunner({
        url: app.url,
        token,
        agents: [{ id, name: id, model: "sonnet", workdirLabel: "repo" }],
      });
      runners.push(runner);
      return runner;
    };

    it("등록 때 그 id 를 알린 러너 토큰에 묶이고, 다른 토큰 러너는 충돌 — PUT 으로 그 러너에 다시 묶는다", async () => {
      const a = await issue("bind-a");
      const b = await issue("bind-b");
      await connectWith(a.token, "binder");
      const agent = await register("binder");
      expect(agent.runner).toEqual({ tokenId: a.record.id, label: "bind-a", revoked: false });
      const other = await connectWith(b.token, "binder");
      expect(other.helloResult).toMatchObject({ ok: true, conflicts: ["binder"] });
      const card = (label: string) => status().then((s) => s.runners.list.find((r) => r.label === label));
      expect((await card("bind-b"))?.agents).toEqual([
        expect.objectContaining({ id: "binder", conflict: true, boundTokenId: a.record.id }),
      ]);

      const setupEvents: unknown[] = [];
      const off = app.bus.on("setup.status", (p) => setupEvents.push(p));
      const res = await call(owner, "PUT", `/runner-tokens/${b.record.id}/agents/binder`);
      off();
      expect(res.statusCode).toBe(200);
      expect((res.json() as { agent: Agent }).agent.runner).toEqual({
        tokenId: b.record.id,
        label: "bind-b",
        revoked: false,
      });
      expect(setupEvents.length).toBeGreaterThan(0);
      expect((await card("bind-b"))?.agents[0]).toMatchObject({ conflict: false, boundTokenId: b.record.id });
      expect((await card("bind-a"))?.agents[0]).toMatchObject({ conflict: true, boundTokenId: b.record.id });
      expect((await listed("binder"))?.runner).toMatchObject({ tokenId: b.record.id, label: "bind-b" });
    });

    it("폐기해도 묶임은 남는다 — 목록에 revoked, 폐기된 토큰으로 다시 묶기는 409, 없는 에이전트·openclaw 에이전트·없는 토큰은 404", async () => {
      const a = await issue("gone");
      await connectWith(a.token, "keeper");
      await register("keeper");
      expect((await call(owner, "DELETE", `/runner-tokens/${a.record.id}`)).statusCode).toBe(204);
      expect((await listed("keeper"))?.runner).toEqual({
        tokenId: a.record.id,
        label: "gone",
        revoked: true,
      });

      const again = await call(owner, "PUT", `/runner-tokens/${a.record.id}/agents/keeper`);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("CONFLICT");
      const live = await issue("live");
      await register("oc-agent", "openclaw");
      for (const url of [
        `/runner-tokens/${live.record.id}/agents/nobody`,
        `/runner-tokens/${live.record.id}/agents/oc-agent`,
        `/runner-tokens/${uuid()}/agents/keeper`,
      ]) {
        const res = await call(owner, "PUT", url);
        expect(res.statusCode, url).toBe(404);
      }
      expect((await listed("oc-agent"))?.runner).toBeUndefined();
    });

    it("알리는 러너 없이 등록한 claude 에이전트는 묶임 없음 — 처음 알린 러너에 묶인다", async () => {
      const agent = await register("latecomer");
      expect(agent.runner).toBeUndefined();
      const a = await issue("late");
      await connectWith(a.token, "latecomer");
      await vi.waitFor(async () => expect((await listed("latecomer"))?.runner?.tokenId).toBe(a.record.id));
    });
  });

  it("없는 id 폐기는 404", async () => {
    const res = await call(owner, "DELETE", `/runner-tokens/${uuid()}`);
    expect(res.statusCode).toBe(404);
  });

  it("브리지 토큰으로는 /runner 에 못 붙는다", async () => {
    expect(await tryRunner(app.url, bridgeTokenOf(app))).toBe("UNAUTHORIZED");
  });

  it("러너 거절 로그의 주소는 가린 값(ipPrefix)이다 — 원래 주소는 그 줄에 없다", async () => {
    expect(await tryRunner(app.url, "drn_not-a-token")).toBe("UNAUTHORIZED");
    // 거절 줄은 주소별 1분에 한 번 — 앞 테스트의 거절이 이미 남겼을 수 있어 파일 전체의 줄을 본다
    const rejected = log.lines.filter((l) => l.includes('"runner connection rejected"'));
    expect(rejected.length).toBeGreaterThan(0);
    for (const line of rejected) {
      expect((JSON.parse(line) as { address?: string }).address).toBe("127.0.0.0/24");
      expect(line).not.toContain("127.0.0.1");
    }
  });

  it("runner.tgz — 부팅 때 잰 파일을 내려 주고 status 에는 경로 없이 해시·크기", async () => {
    const res = await call(owner, "GET", "/runner.tgz");
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="dodok-claude-runner-${sha(tgz).slice(0, 12)}.tgz"`,
    );
    expect(res.rawPayload.equals(tgz)).toBe(true);
    const s = await status();
    expect(s.runners.runnerFile).toEqual({
      available: true,
      sha256: sha(tgz),
      bundleSha256: sha(BUNDLE),
      bytes: tgz.length,
    });
    expect(JSON.stringify(s)).not.toContain(runnerDir);
  });

  describe("러너 첨부 HTTP(RUNNER_ATTACHMENTS_PATH)", () => {
    let channelId: string;
    beforeAll(async () => {
      const res = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: owner,
        payload: { name: "runner-files" },
      });
      channelId = res.json().channel.id;
    });
    const upload = (token: string, path = RUNNER_ATTACHMENTS_PATH) =>
      app.fastify.inject({
        method: "POST",
        url: path,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "image/png",
          [BRIDGE_ATTACHMENT_HEADERS.channelId]: channelId,
          [BRIDGE_ATTACHMENT_HEADERS.fileName]: encodeURIComponent("shot.png"),
        },
        payload: Buffer.from(makePng(4, 4)),
      });
    const download = (token: string, id = uuid()) =>
      app.fastify.inject({
        method: "GET",
        url: `${RUNNER_ATTACHMENTS_PATH}/${id}`,
        headers: { authorization: `Bearer ${token}` },
      });

    it("러너 토큰이면 POST 200·GET 은 인증을 지난다(없는 id 404), 브리지 토큰·틀린 토큰·폐기된 토큰은 401", async () => {
      const issued = await issue("files");
      const posted = await upload(issued.token);
      expect(posted.statusCode).toBe(200);
      expect(Attachment.parse(posted.json())).toMatchObject({ kind: "image", name: "shot.png" });
      expect((await download(issued.token)).statusCode).toBe(404);

      for (const token of [bridgeTokenOf(app), "wrong"]) {
        expect((await upload(token)).statusCode).toBe(401);
        expect((await download(token)).statusCode).toBe(401);
      }
      // 반대로 러너 토큰으로는 브리지 경로를 못 쓴다
      expect((await upload(issued.token, BRIDGE_ATTACHMENTS_PATH)).statusCode).toBe(401);

      await call(owner, "DELETE", `/runner-tokens/${issued.record.id}`);
      expect((await download(issued.token)).statusCode).toBe(401);
    });

    // 조율자 판정 R5 — 러너 토큰은 열린 런의 deliver 첨부와 자기가 올린 것만. 나머지는 없는 id 와 같은 404
    it("러너가 안 붙은 채널의 사람 첨부는 404 — 에이전트 없는 채널에 묶여 있어도(리뷰 I1 재현)", async () => {
      const issued = await issue("scope-human");
      const channel = await app.fastify.inject({
        method: "POST",
        url: "/api/v1/channels",
        headers: owner,
        payload: { name: "secret" },
      });
      const secretId = channel.json().channel.id as string;
      const human = await app.fastify.inject({
        method: "POST",
        url: `/api/v1/attachments?channelId=${secretId}`,
        headers: { ...owner, "content-type": "image/png" },
        payload: Buffer.from(makePng(3, 3)),
      });
      const attachment = Attachment.parse(human.json());
      const message = createUserMessage(app.db, app.bus, {
        channelId: secretId,
        authorId: app.ownerUserId,
        bodyMd: "비밀",
        clientMsgId: "runner-scope-human",
      });
      markBound(app.db, [attachment.id], message.id);
      // 같은 id 를 사람 세션은 받는다 — 404 는 없어서가 아니라 범위 밖이어서다
      const asOwner = await app.fastify.inject({
        method: "GET",
        url: `/api/v1/attachments/${attachment.id}`,
        headers: owner,
      });
      expect(asOwner.statusCode).toBe(200);
      const res = await download(issued.token, attachment.id);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ code: "NOT_FOUND", message: "attachment not found" });
    });

    it("그 토큰으로 올린 첨부는 묶이기 전후 모두 200, 다른 러너 토큰·브리지가 올린 것은 404", async () => {
      const [mine, other] = [await issue("scope-mine"), await issue("scope-other")];
      const own = Attachment.parse((await upload(mine.token)).json());
      const got = await download(mine.token, own.id);
      expect(got.statusCode).toBe(200);
      expect(Buffer.from(got.rawPayload)).toEqual(Buffer.from(makePng(4, 4)));
      expect((await download(other.token, own.id)).statusCode).toBe(404);

      const message = createUserMessage(app.db, app.bus, {
        channelId,
        authorId: app.ownerUserId,
        bodyMd: "묶음",
        clientMsgId: "runner-scope-mine",
      });
      markBound(app.db, [own.id], message.id);
      expect((await download(mine.token, own.id)).statusCode).toBe(200);
      expect((await download(other.token, own.id)).statusCode).toBe(404);

      const bridged = await app.fastify.inject({
        method: "POST",
        url: BRIDGE_ATTACHMENTS_PATH,
        headers: {
          authorization: `Bearer ${bridgeTokenOf(app)}`,
          "content-type": "image/png",
          [BRIDGE_ATTACHMENT_HEADERS.channelId]: channelId,
        },
        payload: Buffer.from(makePng(5, 5)),
      });
      const fromBridge = Attachment.parse(bridged.json());
      markBound(app.db, [fromBridge.id], message.id);
      expect((await download(mine.token, fromBridge.id)).statusCode).toBe(404);
    });
  });
});

describe("러너 경로 인증 실패는 브리지와 같은 가드에 쌓인다(러너 스펙 5장)", () => {
  let app: App;
  beforeEach(async () => {
    app = await bootTestApp(
      {},
      {
        adapters: [new FakeAdapter()],
        runnerAdapter: true,
        runnerDirs: [],
        limits: { bridgeFail: { maxFailures: 4, windowMs: 60_000, blockMs: 60_000, maxAddresses: 1024 } },
      },
    );
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    bridgeToken = bridgeTokenOf(app);
  });
  afterEach(async () => {
    await app.close();
  });

  let bridgeToken: string;
  const bridgeDownload = () =>
    fetch(`${app.url}${BRIDGE_ATTACHMENTS_PATH}/${uuid()}`, {
      headers: { authorization: `Bearer ${bridgeToken}` },
    });
  const runnerDownload = async () =>
    (
      await fetch(`${app.url}${RUNNER_ATTACHMENTS_PATH}/${uuid()}`, {
        headers: { authorization: "Bearer wrong" },
      })
    ).status;
  const blockedDetails = () =>
    app.db
      .select()
      .from(opsEvents)
      .all()
      .filter((r) => r.kind === "bridge_auth_blocked")
      .map((r) => r.detail);

  it("러너 핸드셰이크 2번 + 러너 첨부 2번 실패 → 정상 브리지 토큰도 /bridge/attachments 429, 막히게 한 러너 첨부가 사건 detail.path runner", async () => {
    expect((await bridgeDownload()).status).toBe(404);
    for (let i = 0; i < 2; i++) expect(await tryRunner(app.url, "wrong")).toBe("UNAUTHORIZED");
    for (let i = 0; i < 2; i++) expect(await runnerDownload()).toBe(401);
    expect((await bridgeDownload()).status).toBe(429);
    expect(await tryRunner(app.url, "wrong")).toBe("RATE_LIMITED");
    await vi.waitFor(() => expect(blockedDetails()).toEqual([{ ipPrefix: "127.0.0.0/24", path: "runner" }]));
  });

  it("러너 첨부 2번 + 러너 핸드셰이크 2번 실패 → 막히게 한 러너 핸드셰이크도 detail.path runner", async () => {
    for (let i = 0; i < 2; i++) expect(await runnerDownload()).toBe(401);
    for (let i = 0; i < 2; i++) expect(await tryRunner(app.url, "wrong")).toBe("UNAUTHORIZED");
    expect((await bridgeDownload()).status).toBe(429);
    await vi.waitFor(() => expect(blockedDetails()).toEqual([{ ipPrefix: "127.0.0.0/24", path: "runner" }]));
  });
});

describe("러너 파일이 없으면", () => {
  it("runner.tgz 404 RUNNER_FILE_MISSING, runnerFile.available false", async () => {
    const app = await bootTestApp({}, { adapters: [new FakeAdapter()], runnerAdapter: true, runnerDirs: [] });
    try {
      const { headers } = await login(app);
      const res = await app.fastify.inject({ method: "GET", url: "/api/v1/setup/runner.tgz", headers });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: "NOT_FOUND", message: "RUNNER_FILE_MISSING" });
      const s = SetupStatus.parse(
        (await app.fastify.inject({ method: "GET", url: "/api/v1/setup/status", headers })).json(),
      );
      expect(s.runners).toEqual({ list: [], runnerFile: { available: false } });
    } finally {
      await app.close();
    }
  });
});
