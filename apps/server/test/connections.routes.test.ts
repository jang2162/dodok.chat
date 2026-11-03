/**
 * 누구나 읽는 연결 목록과 걸러진 설정 상태(연결 탭 통합 스펙 5.3) — 트리는 멤버 누구나 그리고(이름·상태·주인·승인 대기), 연결의 주소·
 * 토큰 목록·러너 연결 정보는 그 연결의 주인과 admin 이상에게만 간다. REST·실시간(setup.status) 둘 다
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { ConnectionsResponse, RunnerTokenRecord, SetupStatus } from "@dodok/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createGateway } from "../src/modules/gateways/service";
import { createProject } from "../src/modules/runners/projects";
import { issueRunnerToken } from "../src/modules/runners/tokens";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { connectWire, recordEvents, waitFor, type WireClient } from "./helpers/wire";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

type Method = "GET" | "POST" | "PATCH" | "DELETE";

const OWNER_GATEWAY_URL = "ws://secret-host.internal:4321";
const OWNER_GATEWAY_TOKEN = "owner-gateway-shared-secret";
const MIA_GATEWAY_URL = "ws://mia-home.lan:18789";

describe("연결 목록·걸러진 설정 상태", () => {
  let app: App;
  let ownerToken: string;
  let mia: { id: string; token: string };
  let bob: { id: string; token: string };
  let ada: { id: string; token: string };
  let ownerGateway = "";
  let miaGateway = "";
  let ownerRunner = { id: "", token: "", prefix: "" };
  let miaRunner = { id: "", token: "", prefix: "" };
  let ownerBridgePrefix = "";
  const fakeRunners: FakeRunner[] = [];
  const sockets: WireClient[] = [];
  let n = 0;

  beforeAll(async () => {
    app = await bootTestApp({}, { adapters: [new FakeAdapter()], runnerAdapter: true }, { gateway: false });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ownerToken = (await login(app)).token;
    mia = await userWithRole(app, "mia", "member");
    bob = await userWithRole(app, "bob", "member");
    ada = await userWithRole(app, "ada", "admin");
    ownerGateway = createGateway(
      app.db,
      app.workspaceId,
      { name: "사무실", url: OWNER_GATEWAY_URL, token: OWNER_GATEWAY_TOKEN },
      { userId: app.ownerUserId, role: "owner" },
    ).id;
    ownerBridgePrefix = issueBridgeToken(app.db, app.workspaceId, ownerGateway, "office").record.prefix;
    miaGateway = createGateway(
      app.db,
      app.workspaceId,
      { name: "mia 집", url: MIA_GATEWAY_URL, token: "mia-secret" },
      { userId: mia.id, role: "member" },
    ).id;
    const issue = async (label: string, owner: string) => {
      const issued = issueRunnerToken(app.db, app.workspaceId, label, owner);
      fakeRunners.push(await startFakeRunner({ url: app.url, token: issued.token }));
      return { id: issued.record.id, token: issued.token, prefix: issued.record.prefix };
    };
    ownerRunner = await issue("owner 맥", app.ownerUserId);
    miaRunner = await issue("mia 맥북", mia.id);
    createProject(app.db, {
      workspaceId: app.workspaceId,
      runnerTokenId: miaRunner.id,
      rootId: "src",
      relPath: "dodok",
    });
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
  });
  afterAll(async () => {
    for (const runner of fakeRunners.splice(0)) runner.close();
    await app.close();
  });

  const call = (token: string, method: Method, url: string, payload?: object) =>
    app.fastify.inject({
      method,
      url: `/api/v1${url}`,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });
  const statusFor = async (token: string) => {
    const res = await call(token, "GET", "/setup/status");
    expect(res.statusCode).toBe(200);
    return SetupStatus.parse(res.json());
  };
  const runnerTokensFor = async (token: string) => {
    const res = await call(token, "GET", "/setup/runner-tokens");
    expect(res.statusCode).toBe(200);
    return (res.json() as { tokens: unknown[] }).tokens.map((t) => RunnerTokenRecord.parse(t));
  };

  it("member reads all connections without urls or tokens — 이름·상태·주인·승인 대기, 프로젝트는 id·이름·러너", async () => {
    const res = await call(bob.token, "GET", "/connections");
    expect(res.statusCode).toBe(200);
    const body = ConnectionsResponse.parse(res.json());
    expect(body.gateways).toEqual(
      expect.arrayContaining([
        {
          id: ownerGateway,
          name: "사무실",
          enabled: true,
          approved: true,
          owner: { id: app.ownerUserId, name: expect.any(String) },
        },
        {
          id: miaGateway,
          name: "mia 집",
          enabled: true,
          approved: false,
          owner: { id: mia.id, name: "mia" },
        },
      ]),
    );
    expect(body.runners).toEqual(
      expect.arrayContaining([
        {
          id: miaRunner.id,
          label: "mia 맥북",
          connected: true,
          revoked: false,
          owner: { id: mia.id, name: "mia" },
        },
      ]),
    );
    expect(body.projects).toEqual([
      { id: expect.any(String), runnerId: miaRunner.id, label: "dodok", archived: false },
    ]);
    // 주소·호스트·공유 토큰·토큰 원문·접두사·루트는 응답 어디에도 없다
    for (const secret of [
      OWNER_GATEWAY_URL,
      "secret-host",
      OWNER_GATEWAY_TOKEN,
      MIA_GATEWAY_URL,
      "mia-home",
      ownerRunner.token,
      ownerRunner.prefix,
      ownerBridgePrefix,
      "src",
    ])
      expect(res.body).not.toContain(secret);
  });

  it("unapproved gateway is listed with approved false — 설정 상태에서는 꺼진 채(접속하지 않는다)", async () => {
    const listed = ConnectionsResponse.parse((await call(mia.token, "GET", "/connections")).json());
    expect(listed.gateways.find((g) => g.id === miaGateway)?.approved).toBe(false);
    const own = (await statusFor(mia.token)).gateways.find((g) => g.id === miaGateway);
    expect(own).toMatchObject({ approved: false, gateway: { state: "disabled" } });
  });

  it("member sees only own gateways and runners in setup status — 남의 주소·러너 연결 정보는 없다", async () => {
    const res = await call(mia.token, "GET", "/setup/status");
    expect(res.statusCode).toBe(200);
    const status = SetupStatus.parse(res.json());
    expect(status.gateways.map((g) => g.id)).toEqual([miaGateway]);
    expect(status.runners.list.map((r) => r.tokenId)).toEqual([miaRunner.id]);
    expect(res.body).not.toContain(OWNER_GATEWAY_URL);
    expect(res.body).not.toContain("secret-host");
    // 아무것도 갖지 않은 member 는 빈 목록 — 머리 값(브리지 주소·품은 파일)만
    const empty = await statusFor(bob.token);
    expect(empty.gateways).toEqual([]);
    expect(empty.runners.list).toEqual([]);
  });

  it("admin sees all in setup status", async () => {
    const status = await statusFor(ada.token);
    expect(status.gateways.map((g) => g.id).sort()).toEqual([miaGateway, ownerGateway].sort());
    expect(status.runners.list.map((r) => r.tokenId).sort()).toEqual([miaRunner.id, ownerRunner.id].sort());
  });

  it("member's runner token list has only own runners — admin sees all", async () => {
    expect((await runnerTokensFor(mia.token)).map((t) => t.id)).toEqual([miaRunner.id]);
    expect(await runnerTokensFor(bob.token)).toEqual([]);
    expect((await runnerTokensFor(ada.token)).map((t) => t.id).sort()).toEqual(
      [miaRunner.id, ownerRunner.id].sort(),
    );
  });

  it("member asking another's gateway bridge tokens gets 403 and no token rows", async () => {
    const res = await call(mia.token, "GET", `/gateways/${ownerGateway}/bridge-tokens`);
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(ownerBridgePrefix);
  });

  it("setup.status 실시간은 사람마다 걸러진다 — member 는 자기 것만(가진 연결이 없으면 받지 않는다), admin 은 모두", async () => {
    const miaSocket = await connectWire(app, mia.token);
    const adaSocket = await connectWire(app, ada.token);
    const bobSocket = await connectWire(app, bob.token);
    sockets.push(miaSocket, adaSocket, bobSocket);
    const forMia = waitFor(miaSocket, "setup.status");
    const forAda = waitFor(adaSocket, "setup.status");
    const bobSeen = recordEvents(bobSocket, ["setup.status"]);
    // 아무 Gateway 변경 — 라우트가 setup.status 를 다시 알린다
    expect(
      (await call(ownerToken, "PATCH", `/gateways/${ownerGateway}`, { name: `사무실${++n}` })).statusCode,
    ).toBe(200);
    const [miaStatus, adaStatus] = await Promise.all([forMia, forAda]);
    expect(miaStatus.status.gateways.map((g) => g.id)).toEqual([miaGateway]);
    expect(miaStatus.status.runners.list.map((r) => r.tokenId)).toEqual([miaRunner.id]);
    expect(JSON.stringify(miaStatus)).not.toContain(OWNER_GATEWAY_URL);
    // 같은 팬아웃에서 나간다 — mia·ada 가 받은 뒤 잠깐 더 기다려도 bob 에게는 없다
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bobSeen).toEqual([]);
    expect(adaStatus.status.gateways.map((g) => g.id).sort()).toEqual([miaGateway, ownerGateway].sort());
  });

  it("connections.changed 를 연결 추가·승인·삭제, 러너 토큰 발급·폐기, 프로젝트 더하기·이름·보관 뒤에 낸다", async () => {
    let changed = 0;
    const off = app.bus.on("connections.changed", () => void changed++);
    const step = async (label: string, run: () => Promise<{ statusCode: number }>, ok: number) => {
      const before = changed;
      expect((await run()).statusCode, label).toBe(ok);
      expect(changed, label).toBe(before + 1);
    };
    try {
      let gatewayId = "";
      await step(
        "POST /gateways",
        async () => {
          const res = await call(mia.token, "POST", "/gateways", {
            name: `새${++n}`,
            url: "ws://x:1",
            token: "t",
          });
          gatewayId = (res.json() as { id: string }).id;
          return res;
        },
        201,
      );
      await step(
        "approve",
        () => call(ada.token, "POST", `/gateways/${gatewayId}/approve`, { url: "ws://x:1" }),
        200,
      );
      await step(
        "PATCH /gateways",
        () => call(mia.token, "PATCH", `/gateways/${gatewayId}`, { name: `바꿈${++n}` }),
        200,
      );
      await step("DELETE /gateways", () => call(mia.token, "DELETE", `/gateways/${gatewayId}`), 200);
      let runnerId = "";
      await step(
        "POST /setup/runner-tokens",
        async () => {
          const res = await call(mia.token, "POST", "/setup/runner-tokens", { label: `r${++n}` });
          runnerId = (res.json() as { record: { id: string } }).record.id;
          return res;
        },
        201,
      );
      await step(
        "DELETE /setup/runner-tokens",
        () => call(mia.token, "DELETE", `/setup/runner-tokens/${runnerId}`),
        204,
      );
      let projectId = "";
      await step(
        "POST /runners/:id/projects",
        async () => {
          const res = await call(mia.token, "POST", `/runners/${miaRunner.id}/projects`, {
            rootId: "src",
            relPath: `p${++n}`,
          });
          projectId = (res.json() as { project: { id: string } }).project.id;
          return res;
        },
        201,
      );
      await step(
        "PATCH /runner-projects",
        () => call(mia.token, "PATCH", `/runner-projects/${projectId}`, { label: "새 이름" }),
        200,
      );
      await step("archive", () => call(mia.token, "POST", `/runner-projects/${projectId}/archive`), 200);
    } finally {
      off();
    }
  });

  it("connections.changed 는 워크스페이스의 모든 멤버에게 간다(본문 없음)", async () => {
    const bobSocket = await connectWire(app, bob.token);
    sockets.push(bobSocket);
    const got = waitFor(bobSocket, "connections.changed");
    await call(mia.token, "POST", "/setup/runner-tokens", { label: `w${++n}` });
    expect(await got).toEqual({});
  });
});
