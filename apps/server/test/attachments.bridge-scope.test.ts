/**
 * 브리지 첨부 범위(멀티 Gateway 스펙 6.4 — 러너 판정 R5 와 같게). 브리지 토큰으로 읽을 수 있는 첨부는 그 토큰의 Gateway 에서 열린
 * 런이 받은 트리거 첨부와 그 Gateway 가 올린 첨부뿐이고, 정본에 묶을 수 있는 것은 그 Gateway 가 올린 첨부뿐이다. 범위 밖은 없는
 * id 와 같은 404 다.
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import type { Attachment, OutboundMessage } from "@dodok/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import { hasGateways } from "../src/adapters/types";
import type { App } from "../src/app";
import { attachments } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { uploadAttachment } from "../src/modules/attachments/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, getMessage } from "../src/modules/messages/service";
import { issueRunnerToken } from "../src/modules/runners/tokens";
import { getRun } from "../src/modules/runs/store";
import { issueBridgeToken } from "../src/modules/setup/tokens";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID, insertGateway } from "./helpers/gateways";
import { makePng, PDF_BYTES } from "./helpers/png";

const HOME_ID = "00000000-0000-4000-8000-0000000000b2";

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

/** 사무실(FAKE_GATEWAY_ID)·집 두 Gateway, 각자의 브리지 토큰, 두 Gateway 의 main 이 든 채널 */
async function setup() {
  const app = await bootTestApp({}, { adapters: [new FakeAdapter()] });
  apps.push(app);
  const home = insertGateway(app.db, app.workspaceId, { id: HOME_ID, name: "집" });
  const openclaw = app.registry.forProvider("openclaw");
  if (openclaw && hasGateways(openclaw)) openclaw.upsertGateway(home);
  const tokens = {
    office: issueBridgeToken(app.db, app.workspaceId, FAKE_GATEWAY_ID, "office").token,
    home: issueBridgeToken(app.db, app.workspaceId, HOME_ID, "home").token,
  };
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "att",
  });
  for (const [gatewayId, handle] of [
    [FAKE_GATEWAY_ID, "main-office"],
    [HOME_ID, "main-home"],
  ] as const) {
    const agent = createAgent(app.db, {
      workspaceId: app.workspaceId,
      providerAgentId: "main",
      handle,
      name: handle,
      gatewayId,
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: agent.id }, app.logger);
  }
  const { headers } = await login(app);

  const userUpload = async () => {
    const res = await app.fastify.inject({
      method: "POST",
      url: `/api/v1/attachments?channelId=${channel.id}`,
      headers: { ...headers, "content-type": "image/png" },
      payload: makePng(4, 4),
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Attachment;
  };
  const bridgeUpload = async (token: string) => {
    const res = await app.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: {
        authorization: `Bearer ${token}`,
        "x-dodok-channel-id": channel.id,
        "content-type": "application/octet-stream",
      },
      payload: PDF_BYTES,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as Attachment;
  };
  const bridgeGet = async (token: string, id: string) =>
    (
      await app.fastify.inject({
        method: "GET",
        url: `/bridge/attachments/${id}`,
        headers: { authorization: `Bearer ${token}` },
      })
    ).statusCode;
  /** 사람이 이미지를 붙여 그 핸들을 멘션 — 그 에이전트의 런이 열린다 */
  const mentionWithImage = async (handle: string) => {
    const image = await userUpload();
    const message = createUserMessage(app.db, app.bus, {
      channelId: channel.id,
      authorId: app.ownerUserId,
      bodyMd: `@${handle} 이 그림`,
      clientMsgId: `img-${handle}-${image.id}`,
      attachments: [image.id],
    });
    await app.services.router.routeMessage(message);
    const run = app.db.$client.prepare("SELECT id FROM runs WHERE trigger_message_id = ?").get(message.id) as
      | { id: string }
      | undefined;
    expect(run).toBeDefined();
    return { image, runId: run?.id as string };
  };
  /** 그 연결의 플러그인이 보낸 정본(어댑터가 onCanonical 을 부르는 길) — 저장된 메시지의 첨부 id */
  const canonical = async (connectionId: string, attachmentIds: string[]) => {
    const message: OutboundMessage = {
      outboundId: `out-${connectionId}-${attachmentIds.join(",")}`,
      channelId: channel.id,
      agentId: "main",
      sessionKey: `agent:main:dodok:channel:${channel.id}`,
      text: "파일입니다",
      attachmentIds,
      ts: new Date().toISOString(),
    };
    const { messageId } = await app.orchestrator.onCanonical(message, "openclaw", connectionId);
    return getMessage(app.db, messageId ?? "")?.attachments.map((a) => a.id);
  };
  return { app, headers, tokens, channel, bridgeUpload, bridgeGet, mentionWithImage, canonical };
}

describe("브리지 첨부 범위 — 토큰의 Gateway 로", () => {
  it("집 런의 트리거 첨부는 집 토큰만 읽는다 — 사무실 토큰은 404, 런이 닫히면 집 토큰도 404", async () => {
    const { app, tokens, bridgeGet, mentionWithImage } = await setup();
    const { image, runId } = await mentionWithImage("main-home");
    expect(getRun(app.db, runId)?.status).not.toBe("error");
    expect(await bridgeGet(tokens.office, image.id)).toBe(404);
    expect(await bridgeGet(tokens.home, image.id)).toBe(200);

    await app.orchestrator.signal(runId, { kind: "gateway_aborted" });
    expect(await bridgeGet(tokens.home, image.id)).toBe(404);
  });

  it("사무실 런의 트리거 첨부는 사무실 토큰이 읽는다", async () => {
    const { tokens, bridgeGet, mentionWithImage } = await setup();
    const { image } = await mentionWithImage("main-office");
    expect(await bridgeGet(tokens.office, image.id)).toBe(200);
    expect(await bridgeGet(tokens.home, image.id)).toBe(404);
  });

  it("그 Gateway 가 올린 첨부는 묶이기 전에도 그 Gateway 만 읽는다", async () => {
    const { tokens, bridgeUpload, bridgeGet } = await setup();
    const own = await bridgeUpload(tokens.office);
    expect(await bridgeGet(tokens.office, own.id)).toBe(200);
    expect(await bridgeGet(tokens.home, own.id)).toBe(404);
  });

  it("업로드 행에 올린 Gateway 가 남는다", async () => {
    const { app, tokens, bridgeUpload } = await setup();
    const own = await bridgeUpload(tokens.home);
    const row = app.db
      .select()
      .from(attachments)
      .all()
      .find((r) => r.id === own.id);
    expect(row).toMatchObject({ uploaderType: "bridge", gatewayId: HOME_ID });
  });

  it("다른 Gateway 가 올린 첨부는 정본에 묶이지 않는다 — 자기 것은 묶인다", async () => {
    const { tokens, bridgeUpload, canonical } = await setup();
    const fromOffice = await bridgeUpload(tokens.office);
    expect(await canonical(HOME_ID, [fromOffice.id])).toEqual([]);
    expect(await canonical(FAKE_GATEWAY_ID, [fromOffice.id])).toEqual([fromOffice.id]);
  });

  it("Gateway 를 지운 뒤 비어 버린 플러그인 업로드는 러너 정본도 묶지 못한다 — 러너는 자기 토큰이 올린 것만", async () => {
    const { app, headers, tokens, channel, bridgeUpload } = await setup();
    const orphan = await bridgeUpload(tokens.home);
    const del = await app.fastify.inject({ method: "DELETE", url: `/api/v1/gateways/${HOME_ID}`, headers });
    expect(del.statusCode).toBe(200);
    const row = app.db
      .select()
      .from(attachments)
      .all()
      .find((r) => r.id === orphan.id);
    expect(row).toMatchObject({ gatewayId: null, uploaderId: null });

    const runner = issueRunnerToken(app.db, app.workspaceId, "laptop").record.id;
    const other = issueRunnerToken(app.db, app.workspaceId, "desktop").record.id;
    const coder = createAgent(app.db, {
      workspaceId: app.workspaceId,
      provider: "claude",
      providerAgentId: "coder",
      handle: "coder",
      name: "coder",
      runnerTokenId: runner,
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: coder.id }, app.logger);
    // 묶기는 행만 본다 — 블롭은 버리는 디렉터리에
    const dir = mkdtempSync(join(tmpdir(), "dodok-bscope-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const upload = (runnerTokenId: string) =>
      uploadAttachment(
        { db: app.db, dir },
        { channelId: channel.id, uploader: { type: "bridge", runnerTokenId }, bytes: PDF_BYTES },
      );
    const [own, others] = [await upload(runner), await upload(other)];
    const message: OutboundMessage = {
      outboundId: "out-runner",
      channelId: channel.id,
      agentId: "coder",
      sessionKey: `agent:coder:dodok:channel:${channel.id}`,
      text: "파일입니다",
      attachmentIds: [orphan.id, others.id, own.id],
      ts: new Date().toISOString(),
    };
    const { messageId } = await app.orchestrator.onCanonical(message, "claude", runner);
    expect(getMessage(app.db, messageId ?? "")?.attachments.map((a) => a.id)).toEqual([own.id]);
  });

  it("꺼진 Gateway 의 브리지 토큰은 첨부 HTTP 에서도 거절된다 — 핸드셰이크와 같은 401, 실패로 세지 않는다", async () => {
    const { app, headers, tokens, channel, bridgeUpload, bridgeGet } = await setup();
    const own = await bridgeUpload(tokens.home);
    const patch = (enabled: boolean) =>
      app.fastify.inject({
        method: "PATCH",
        url: `/api/v1/gateways/${HOME_ID}`,
        headers,
        payload: { enabled },
      });
    expect((await patch(false)).statusCode).toBe(200);

    const post = await app.fastify.inject({
      method: "POST",
      url: "/bridge/attachments",
      headers: {
        authorization: `Bearer ${tokens.home}`,
        "x-dodok-channel-id": channel.id,
        "content-type": "application/octet-stream",
      },
      payload: PDF_BYTES,
    });
    expect([post.statusCode, post.json().code]).toEqual([401, "UNAUTHORIZED"]);
    const get = await app.fastify.inject({
      method: "GET",
      url: `/bridge/attachments/${own.id}`,
      headers: { authorization: `Bearer ${tokens.home}` },
    });
    expect([get.statusCode, get.json().code]).toEqual([401, "UNAUTHORIZED"]);
    // 다른 Gateway 는 그대로
    expect(await bridgeGet(tokens.office, (await bridgeUpload(tokens.office)).id)).toBe(200);
    // 끈 것은 고장이 아니다 — 거듭 거절돼도 주소가 막히지 않아 다시 켜면 곧바로 통한다
    for (let i = 0; i < 30; i++) expect(await bridgeGet(tokens.home, own.id)).toBe(401);
    expect((await patch(true)).statusCode).toBe(200);
    expect(await bridgeGet(tokens.home, own.id)).toBe(200);
  });
});
