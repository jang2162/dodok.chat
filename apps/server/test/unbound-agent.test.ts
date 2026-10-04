/**
 * Gateway 가 빈 OpenClaw 에이전트(Gateway 가 지워져 옮기기를 기다림 — 멀티 Gateway 스펙 「오류 처리」 절) — 연결 id 가 null 이라 어댑터가
 * ADAPTER_UNAVAILABLE 로 거절하고 「다시 실행」 카드가 남는다. 스레드 런도 재설치 안내(PLUGIN_OUTDATED)가 아니라 같은 사유다.
 * 그 런은 대기열에 남지 않는다(조율자 판정 2 — 연결이 null 인 런과 묶인 뒤 런의 대기열 키가 갈리는 경계).
 */
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { agents } from "../src/db/schema.sqlite";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage, runErrorMessages } from "../src/modules/messages/service";
import { RETRY_RUN_ITEM } from "../src/modules/router/service";
import { getRun } from "../src/modules/runs/store";
import { bootTestApp } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function setup() {
  const adapter = new FakeAdapter();
  const app = await bootTestApp({}, { adapters: [adapter] });
  apps.push(app);
  const orphan = createAgent(app.db, {
    workspaceId: app.workspaceId,
    providerAgentId: "main",
    handle: "main",
    name: "main",
  });
  const channel = createChannel(app.db, {
    workspaceId: app.workspaceId,
    createdBy: app.ownerUserId,
    name: "orphan",
  });
  addMember(app.db, channel.id, { memberType: "agent", memberId: orphan.id }, app.logger);
  let n = 0;
  const say = async (bodyMd: string, threadRootId?: string) => {
    const message = createUserMessage(app.db, app.bus, {
      channelId: channel.id,
      authorId: app.ownerUserId,
      bodyMd,
      clientMsgId: `orphan-${++n}`,
      ...(threadRootId === undefined ? {} : { threadRootId }),
    });
    await app.services.router.routeMessage(message);
    return message;
  };
  return { app, adapter, orphan, channel, say };
}

/** 그 채널의 런 — 만든 차례 */
function runsIn(app: App, channelId: string) {
  return app.db.$client
    .prepare("SELECT id FROM runs WHERE channel_id = ? ORDER BY created_at, id")
    .all(channelId)
    .map((r) => getRun(app.db, (r as { id: string }).id));
}

describe("Gateway 가 빈 OpenClaw 에이전트", () => {
  it("멘션하면 런은 ADAPTER_UNAVAILABLE 로 끝나고 「다시 실행」 카드가 남는다 — 어댑터에는 null 연결로 한 번 닿아 거절된다", async () => {
    const { app, adapter, channel, say } = await setup();
    await say("@main 안녕");
    await vi.waitFor(() => expect(runsIn(app, channel.id)[0]?.status).toBe("error"));
    const [run] = runsIn(app, channel.id);
    expect(run?.error?.code).toBe("ADAPTER_UNAVAILABLE");
    expect(adapter.calls.connections.send).toEqual([null]);
    expect(adapter.calls.send).toHaveLength(1);
    const [card] = runErrorMessages(app.db, channel.id, run?.id ?? "");
    expect(card?.components?.blocks).toEqual([
      expect.objectContaining({ items: [expect.objectContaining({ id: RETRY_RUN_ITEM })] }),
    ]);
  });

  it("스레드 멘션도 같은 사유다 — 붙은 플러그인이 스레드를 알아도 재설치 안내(PLUGIN_OUTDATED)가 아니다", async () => {
    const { app, channel, say } = await setup();
    const root = createUserMessage(app.db, app.bus, {
      channelId: channel.id,
      authorId: app.ownerUserId,
      bodyMd: "루트",
      clientMsgId: "orphan-root",
    });
    await say("@main 스레드에서", root.id);
    await vi.waitFor(() => expect(runsIn(app, channel.id)[0]?.status).toBe("error"));
    expect(runsIn(app, channel.id)[0]).toMatchObject({
      threadRootId: root.id,
      error: { code: "ADAPTER_UNAVAILABLE" },
    });
  });

  it("대기열에 남지 않는다 — 곧바로 다시 불러도 앞 런을 기다리지 않고 닫히고, Gateway 로 옮긴 뒤 「다시 실행」하면 그 Gateway 로 간다", async () => {
    const { app, adapter, orphan, channel, say } = await setup();
    await say("@main 하나");
    await say("@main 둘");
    await vi.waitFor(() => expect(runsIn(app, channel.id).map((r) => r?.status)).toEqual(["error", "error"]));
    expect(adapter.calls.connections.send).toEqual([null, null]);

    // 옮기기(태스크 4 의 API)와 같은 결과 — 에이전트를 Gateway 에 묶는다
    app.db.update(agents).set({ gatewayId: FAKE_GATEWAY_ID }).where(eq(agents.id, orphan.id)).run();
    const failed = runsIn(app, channel.id)[1];
    const [card] = runErrorMessages(app.db, channel.id, failed?.id ?? "");
    await app.services.runs.interact({
      messageId: card?.id as string,
      componentId: card?.components?.id as string,
      itemId: RETRY_RUN_ITEM,
      values: {},
      userId: app.ownerUserId,
    });
    await vi.waitFor(() => expect(adapter.calls.connections.send).toEqual([null, null, FAKE_GATEWAY_ID]));
    const retried = runsIn(app, channel.id)[2];
    expect(retried?.parentRunId).toBe(failed?.id);
    expect(retried?.status).not.toBe("error");
  });
});
