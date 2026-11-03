/**
 * 연결의 주인(연결 탭 통합 스펙 5장) — member 가 자기 Gateway·러너를 만들고 관리하고, 남의 연결은 admin 이상만. member 가 만든 Gateway 는
 * admin 이상의 승인 뒤에야 서버가 접속하고, 승인된 Gateway 의 주소를 member 가 바꾸면 다시 승인 대기다(5.4). 제어 도구도 REST 와 같은
 * 정책 함수를 지난다(5.3)
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { type Agent, GatewaySummary, IssueRunnerTokenResult, type RunnerSummary } from "@dodok/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import { createGateway, getGatewayRow } from "../src/modules/gateways/service";
import { createProject } from "../src/modules/runners/projects";
import { issueRunnerToken } from "../src/modules/runners/tokens";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { type FakeRunner, startFakeRunner } from "./fakes/fake-runner";
import { bootTestApp, login, userWithRole } from "./helpers/app";
import { errorOf, expectOk, pat } from "./helpers/control";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

describe("연결의 주인 — REST·제어 도구", () => {
  let app: App;
  let adapter: FakeAdapter;
  let ownerToken: string;
  let mia: { id: string; token: string };
  let bob: { id: string; token: string };
  let ada: { id: string; token: string };
  const fakeRunners: FakeRunner[] = [];
  /** mia 의 붙은 러너 둘, owner 의 붙은 러너 하나 */
  let miaRunnerA = "";
  let miaRunnerB = "";
  let ownerRunner = "";
  let n = 0;

  beforeAll(async () => {
    adapter = new FakeAdapter();
    app = await bootTestApp({}, { adapters: [adapter], runnerAdapter: true });
    await app.fastify.listen({ host: "127.0.0.1", port: 0 });
    ownerToken = (await login(app)).token;
    mia = await userWithRole(app, "mia", "member");
    bob = await userWithRole(app, "bob", "member");
    ada = await userWithRole(app, "ada", "admin");
    const connect = async (label: string, ownerUserId: string) => {
      const issued = issueRunnerToken(app.db, app.workspaceId, label, ownerUserId);
      fakeRunners.push(await startFakeRunner({ url: app.url, token: issued.token }));
      return issued.record.id;
    };
    miaRunnerA = await connect("mia-a", mia.id);
    miaRunnerB = await connect("mia-b", mia.id);
    ownerRunner = await connect("owner-mac", app.ownerUserId);
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
  const lastUpsert = () => adapter.calls.upsertGateway.at(-1);
  /** 승인 — 본문에 지금 행의 주소(화면이 본 주소)를 싣는다 */
  const approve = (token: string, id: string, url?: string) =>
    call(token, "POST", `/gateways/${id}/approve`, {
      url: url ?? getGatewayRow(app.db, app.workspaceId, id)?.url,
    });
  const gatewayOf = (userId: string, role: "member" | "admin" | "owner" = "member") =>
    createGateway(
      app.db,
      app.workspaceId,
      { name: `gw${++n}`, url: `ws://127.0.0.1:${10_000 + n}`, token: "t" },
      { userId, role },
    ).id;
  const openclawAgent = (gatewayId: string | null): Agent =>
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      ...(gatewayId === null ? {} : { gatewayId }),
      providerAgentId: `oc${++n}`,
      handle: `oc${n}`,
      name: `oc${n}`,
    });
  const projectOn = (runnerTokenId: string) =>
    createProject(app.db, {
      workspaceId: app.workspaceId,
      runnerTokenId,
      rootId: "src",
      relPath: `own-${++n}`,
    });
  const runnerAgentOn = (runnerTokenId: string): Agent =>
    createAgent(app.db, {
      workspaceId: app.workspaceId,
      provider: "runner",
      runnerProjectId: projectOn(runnerTokenId).id,
      program: "claude",
      handle: `ra${++n}`,
      name: `ra${n}`,
    });

  it("member can create a gateway and a runner token — 주인은 그 사람, Gateway 는 승인 대기라 어댑터에는 꺼진 채로 간다", async () => {
    const created = await call(mia.token, "POST", "/gateways", {
      name: "mia 집",
      url: "ws://10.0.0.5:18789",
      token: "s",
    });
    expect(created.statusCode).toBe(201);
    const gateway = GatewaySummary.parse(created.json());
    expect(gateway).toMatchObject({ ownerUserId: mia.id, approved: false, enabled: true });
    expect(lastUpsert()).toMatchObject({ id: gateway.id, enabled: false });

    const issued = await call(mia.token, "POST", "/setup/runner-tokens", { label: "mia 맥북" });
    expect(issued.statusCode).toBe(201);
    expect(IssueRunnerTokenResult.parse(issued.json()).record.ownerUserId).toBe(mia.id);
  });

  it("member changing url of own approved gateway drops approval and disconnects — 같은 PATCH 의 enabled:true 로도 접속하지 않는다", async () => {
    const id = gatewayOf(mia.id);
    const approved = await approve(ada.token, id);
    expect(approved.statusCode).toBe(200);
    expect(GatewaySummary.parse(approved.json()).approved).toBe(true);
    expect(lastUpsert()).toMatchObject({ id, enabled: true });

    const moved = await call(mia.token, "PATCH", `/gateways/${id}`, {
      url: "ws://169.254.169.254:80",
      enabled: true,
    });
    expect(moved.statusCode).toBe(200);
    expect(GatewaySummary.parse(moved.json()).approved).toBe(false);
    expect(lastUpsert()).toMatchObject({ id, url: "ws://169.254.169.254:80", enabled: false });

    // 이름만 바꾸면 승인 상태는 그대로(여기서는 이미 미승인) — 다시 켜지지 않는다
    await call(mia.token, "PATCH", `/gateways/${id}`, { name: `renamed${++n}` });
    expect(lastUpsert()).toMatchObject({ id, enabled: false });
  });

  it("member cannot approve — 자기 Gateway 도. admin 이상만", async () => {
    const id = gatewayOf(mia.id);
    expect((await approve(mia.token, id)).statusCode).toBe(403);
    expect(lastUpsert()?.id === id && lastUpsert()?.enabled).not.toBe(true);
    expect((await approve(ownerToken, id)).statusCode).toBe(200);
  });

  it("approve binds the url the approver saw — 그 사이 주소가 바뀌었으면 409, 승인도 접속도 없다(리뷰 M1)", async () => {
    const id = gatewayOf(mia.id);
    const seen = getGatewayRow(app.db, app.workspaceId, id)?.url ?? "";
    expect(
      (await call(mia.token, "PATCH", `/gateways/${id}`, { url: "ws://169.254.169.254:80" })).statusCode,
    ).toBe(200);
    const upserts = adapter.calls.upsertGateway.length;
    const stale = await approve(ownerToken, id, seen);
    expect([stale.statusCode, stale.json().code]).toEqual([409, "CONFLICT"]);
    expect(getGatewayRow(app.db, app.workspaceId, id)).toMatchObject({ approvedAt: null, approvedBy: null });
    expect(adapter.calls.upsertGateway.length).toBe(upserts);
    // 본문 없는 승인도 받지 않는다
    expect((await call(ownerToken, "POST", `/gateways/${id}/approve`)).statusCode).toBe(400);
    expect(adapter.calls.upsertGateway.length).toBe(upserts);

    const fresh = await approve(ownerToken, id, "ws://169.254.169.254:80");
    expect(fresh.statusCode).toBe(200);
    expect(GatewaySummary.parse(fresh.json()).approved).toBe(true);
    expect(lastUpsert()).toMatchObject({ id, url: "ws://169.254.169.254:80", enabled: true });
  });

  it("GET /gateways — member 는 자기 Gateway 만(남의 id·주소가 응답에 없다), admin 은 모두(리뷰 L1)", async () => {
    const own = gatewayOf(mia.id);
    const others = gatewayOf(bob.id);
    const ownUrl = getGatewayRow(app.db, app.workspaceId, own)?.url ?? "";
    const othersUrl = getGatewayRow(app.db, app.workspaceId, others)?.url ?? "";
    const asMia = await call(mia.token, "GET", "/gateways");
    expect(asMia.statusCode).toBe(200);
    const miaIds = (asMia.json() as GatewaySummary[]).map((g) => g.id);
    expect(miaIds).toContain(own);
    expect(asMia.body).toContain(ownUrl);
    expect(asMia.body).not.toContain(others);
    expect(asMia.body).not.toContain(othersUrl);
    expect(asMia.body).not.toContain(FAKE_GATEWAY_ID);
    expect((asMia.json() as GatewaySummary[]).every((g) => g.ownerUserId === mia.id)).toBe(true);

    const asAda = await call(ada.token, "GET", "/gateways");
    const adaIds = (asAda.json() as GatewaySummary[]).map((g) => g.id);
    expect(adaIds).toEqual(expect.arrayContaining([own, others, FAKE_GATEWAY_ID]));
    expect(asAda.body).toContain(othersUrl);
  });

  it("member manages own gateway and its bridge tokens but not another's", async () => {
    const own = gatewayOf(mia.id);
    const others = gatewayOf(app.ownerUserId, "owner");
    const othersToken = issueBridgeToken(app.db, app.workspaceId, others, "office").record.id;
    for (const [method, url, payload] of [
      ["PATCH", `/gateways/${others}`, { name: `x${++n}` }],
      ["DELETE", `/gateways/${others}/bridge-tokens/${othersToken}`, undefined],
      ["DELETE", `/gateways/${others}`, undefined],
      ["GET", `/gateways/${others}/bridge-tokens`, undefined],
      ["POST", `/gateways/${others}/bridge-tokens`, { label: "x" }],
    ] as const)
      expect((await call(mia.token, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);

    const issued = await call(mia.token, "POST", `/gateways/${own}/bridge-tokens`, { label: "집" });
    expect(issued.statusCode).toBe(201);
    expect((await call(mia.token, "GET", `/gateways/${own}/bridge-tokens`)).statusCode).toBe(200);
    expect((await call(bob.token, "GET", `/gateways/${own}/bridge-tokens`)).statusCode).toBe(403);
    expect((await call(ada.token, "GET", `/gateways/${own}/bridge-tokens`)).statusCode).toBe(200);
    expect((await call(mia.token, "DELETE", `/gateways/${own}`)).statusCode).toBe(200);
  });

  it("member reissues and revokes own runner token but not another's", async () => {
    const own = issueRunnerToken(app.db, app.workspaceId, `own${++n}`, mia.id).record.id;
    const others = issueRunnerToken(app.db, app.workspaceId, `theirs${++n}`, bob.id).record.id;
    expect((await call(mia.token, "POST", `/setup/runner-tokens/${others}/reissue`)).statusCode).toBe(403);
    expect((await call(mia.token, "DELETE", `/setup/runner-tokens/${others}`)).statusCode).toBe(403);
    expect((await call(mia.token, "POST", `/setup/runner-tokens/${own}/reissue`)).statusCode).toBe(200);
    expect((await call(mia.token, "DELETE", `/setup/runner-tokens/${own}`)).statusCode).toBe(204);
    expect((await call(ada.token, "DELETE", `/setup/runner-tokens/${others}`)).statusCode).toBe(204);
  });

  it("member can manage agents on own runner but not on others'", async () => {
    const added = await call(mia.token, "POST", `/runners/${miaRunnerA}/projects`, {
      rootId: "src",
      relPath: `mine-${++n}`,
    });
    expect(added.statusCode).toBe(201);
    const projectId = (added.json() as { project: { id: string } }).project.id;
    const made = await call(mia.token, "POST", "/agents", {
      provider: "runner",
      runnerProjectId: projectId,
      program: "claude",
      handle: `mine${++n}`,
      name: "내 에이전트",
    });
    expect(made.statusCode).toBe(201);
    const agentId = (made.json() as { agent: Agent }).agent.id;
    expect((await call(mia.token, "PATCH", `/agents/${agentId}`, { name: "바꿈" })).statusCode).toBe(200);
    expect((await call(mia.token, "POST", `/runner-projects/${projectId}/check`)).statusCode).toBe(200);
    expect((await call(mia.token, "GET", `/runners/${miaRunnerA}/projects`)).statusCode).toBe(200);

    const theirs = runnerAgentOn(ownerRunner);
    const theirProject = projectOn(ownerRunner);
    for (const [method, url, payload] of [
      ["POST", `/runners/${ownerRunner}/projects`, { rootId: "src", relPath: `x-${++n}` }],
      ["GET", `/runners/${ownerRunner}/projects`, undefined],
      ["GET", `/runners/${ownerRunner}/fs?rootId=src`, undefined],
      ["PATCH", `/runner-projects/${theirProject.id}`, { label: "x" }],
      ["POST", `/runner-projects/${theirProject.id}/archive`, undefined],
      [
        "POST",
        "/agents",
        {
          provider: "runner",
          runnerProjectId: theirProject.id,
          program: "claude",
          handle: `no${++n}`,
          name: "남의 것",
        },
      ],
      ["PATCH", `/agents/${theirs.id}`, { name: "x" }],
      ["DELETE", `/agents/${theirs.id}`, undefined],
    ] as const)
      expect((await call(mia.token, method, url, payload)).statusCode, `${method} ${url}`).toBe(403);

    expect((await call(mia.token, "DELETE", `/agents/${agentId}`)).statusCode).toBe(200);
  });

  it("admin can manage agents on a member's runner", async () => {
    const agent = runnerAgentOn(miaRunnerA);
    expect(
      (await call(ada.token, "PATCH", `/agents/${agent.id}`, { name: "admin 이 바꿈" })).statusCode,
    ).toBe(200);
    expect((await call(bob.token, "PATCH", `/agents/${agent.id}`, { name: "x" })).statusCode).toBe(403);
  });

  it("member's runner agent definition is shown to the runner owner and admins only", async () => {
    const own = runnerAgentOn(miaRunnerA);
    const theirs = runnerAgentOn(ownerRunner);
    const listed = async (token: string) =>
      new Map(
        ((await call(token, "GET", "/agents")).json() as { agents: Agent[] }).agents.map((a) => [a.id, a]),
      );
    const forMia = await listed(mia.token);
    expect(forMia.get(own.id)?.runnerAgent).toBeDefined();
    expect(forMia.get(theirs.id)?.runnerAgent).toBeUndefined();
    expect((await listed(bob.token)).get(own.id)?.runnerAgent).toBeUndefined();
  });

  it("member moves agent between own gateways only", async () => {
    const g1 = gatewayOf(mia.id);
    const g2 = gatewayOf(mia.id);
    const theirs = gatewayOf(bob.id);
    const own = openclawAgent(g1);
    expect((await call(mia.token, "PUT", `/agents/${own.id}/gateway`, { gatewayId: g2 })).statusCode).toBe(
      200,
    );
    expect(
      (await call(mia.token, "PUT", `/agents/${own.id}/gateway`, { gatewayId: theirs })).statusCode,
    ).toBe(403);
    const onOwners = openclawAgent(FAKE_GATEWAY_ID);
    expect(
      (await call(mia.token, "PUT", `/agents/${onOwners.id}/gateway`, { gatewayId: g1 })).statusCode,
    ).toBe(403);
    const orphan = openclawAgent(null);
    expect((await call(mia.token, "PUT", `/agents/${orphan.id}/gateway`, { gatewayId: g1 })).statusCode).toBe(
      403,
    );
    // admin 은 owner 만이던 옮기기를 이제 한다(스펙 5.2)
    expect((await call(ada.token, "PUT", `/agents/${orphan.id}/gateway`, { gatewayId: g1 })).statusCode).toBe(
      200,
    );
  });

  it("project move needs both runners to be the member's own", async () => {
    const mine = projectOn(miaRunnerA);
    expect(
      (await call(mia.token, "POST", `/runner-projects/${mine.id}/move`, { runnerId: miaRunnerB }))
        .statusCode,
    ).toBe(200);
    const again = projectOn(miaRunnerA);
    expect(
      (await call(mia.token, "POST", `/runner-projects/${again.id}/move`, { runnerId: ownerRunner }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(ada.token, "POST", `/runner-projects/${again.id}/move`, { runnerId: ownerRunner }))
        .statusCode,
    ).toBe(200);
  });

  it("restoring an archived agent follows its connection owner, admin only when the connection is gone", async () => {
    const own = openclawAgent(gatewayOf(mia.id));
    const theirs = openclawAgent(FAKE_GATEWAY_ID);
    const orphan = openclawAgent(null);
    for (const agent of [own, theirs, orphan])
      expect((await call(ownerToken, "DELETE", `/agents/${agent.id}`)).statusCode).toBe(200);
    expect((await call(mia.token, "POST", `/agents/${own.id}/restore`)).statusCode).toBe(200);
    expect((await call(mia.token, "POST", `/agents/${theirs.id}/restore`)).statusCode).toBe(403);
    expect((await call(mia.token, "POST", `/agents/${orphan.id}/restore`)).statusCode).toBe(403);
    expect((await call(ada.token, "POST", `/agents/${orphan.id}/restore`)).statusCode).toBe(200);
  });

  it("member lists only own runners in GET /runners — admin sees all", async () => {
    const ids = async (token: string) =>
      ((await call(token, "GET", "/runners")).json() as { runners: RunnerSummary[] }).runners.map(
        (r) => r.id,
      );
    const forMia = await ids(mia.token);
    expect(forMia).toContain(miaRunnerA);
    expect(forMia).toContain(miaRunnerB);
    expect(forMia).not.toContain(ownerRunner);
    expect(await ids(ada.token)).toContain(ownerRunner);
  });

  it("control tool register follows the same owner rule", async () => {
    const own = gatewayOf(mia.id);
    const ok = await app.control.call(pat(mia.id), "register_agent", {
      providerAgentId: `ctl${++n}`,
      handle: `ctl${n}`,
      name: "도구로",
      gatewayId: own,
    });
    expectOk(ok);
    const denied = await app.control.call(pat(mia.id), "register_agent", {
      providerAgentId: `ctl${++n}`,
      handle: `ctl${n}`,
      name: "남의 것",
      gatewayId: FAKE_GATEWAY_ID,
    });
    expect(errorOf(denied).code).toBe("FORBIDDEN");
    // 남의 연결의 에이전트를 도구로 고치지도 못한다
    const theirs = openclawAgent(FAKE_GATEWAY_ID);
    expect(
      errorOf(await app.control.call(pat(mia.id), "update_agent", { agentId: theirs.id, name: "x" })).code,
    ).toBe("FORBIDDEN");
  });
});
