/**
 * 세션 닫기가 멈추는 런의 범위(채널 세션 태스크 3 리뷰 중간 1) — 닫은 세션의 열린 런만 멈추고 그 런의 승인은 cancelled, 같은 채널 다른
 * 세션의 열린 런·대기 런은 그대로. 세션이 병렬로 도는 뒤 태스크에서 orchestrator.abortConversation 의 거르기가 실제로 가르는 것을 지킨다
 */
import type { ProviderApproval } from "@dodok/openclaw-adapter";
import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { dodokSessionKey } from "@dodok/shared";
import { v7 as uuid } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { App } from "../src/app";
import { createAgent } from "../src/modules/agents/service";
import * as approvalStore from "../src/modules/approvals/store";
import { addMember, createChannel } from "../src/modules/channels/service";
import { createUserMessage } from "../src/modules/messages/service";
import { getRun, listOpenRuns } from "../src/modules/runs/store";
import { bootTestApp, login } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { seedConversation } from "./helpers/seed";

const apps: App[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function approvalFor(sessionKey: string, conversationId: string): ProviderApproval {
  const createdAt = new Date();
  return {
    providerApprovalId: `plugin:${uuid()}`,
    kind: "plugin",
    sessionKey,
    providerAgentId: "dev",
    conversationId,
    toolCallId: "toolu_close",
    toolName: "Write",
    pluginId: "fs",
    title: "Write 실행",
    description: '{"path":"a.ts"}',
    severity: "warning",
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    status: "pending",
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + 120_000).toISOString(),
  };
}

describe("세션 닫기 — 그 세션의 런만 멈춘다", () => {
  it("[중간 1] A 를 닫으면 A 의 열린 런은 aborted·승인은 cancelled, 같은 채널 B 의 열린 런·대기 런은 그대로", async () => {
    const adapter = new FakeAdapter();
    const app = await bootTestApp({}, { adapters: [adapter] });
    apps.push(app);
    const dev = createAgent(app.db, {
      gatewayId: FAKE_GATEWAY_ID,
      workspaceId: app.workspaceId,
      providerAgentId: "dev",
      handle: "dev",
      name: "Dev",
    });
    const channel = createChannel(app.db, {
      workspaceId: app.workspaceId,
      createdBy: app.ownerUserId,
      name: "sessions",
    });
    addMember(app.db, channel.id, { memberType: "agent", memberId: dev.id }, app.logger);
    const a = seedConversation(app.db, channel.id, { title: "A" });
    const b = seedConversation(app.db, channel.id, { title: "B" });
    let n = 0;
    const mention = async (conversationId: string) => {
      const message = createUserMessage(app.db, app.bus, {
        conversationId,
        authorId: app.ownerUserId,
        bodyMd: "@dev 봐 줘",
        clientMsgId: `close-${++n}`,
      });
      await app.services.router.routeMessage(message);
    };
    // 열린 런(만든 순서) — 대기 런도 든다
    const runIdsOf = (conversationId: string) =>
      listOpenRuns(app.db)
        .filter((r) => r.conversationId === conversationId)
        .map((r) => r.id);

    await mention(a);
    await mention(b);
    await vi.waitFor(() => expect(adapter.calls.send).toHaveLength(2));
    // B 의 두 번째 멘션은 같은 세션 키의 앞 런 뒤에 대기한다 — 어댑터로 나가지 않는다
    await mention(b);
    await vi.waitFor(() => expect(runIdsOf(b)).toHaveLength(2));
    const [runA] = runIdsOf(a);
    const [runB1, runB2] = runIdsOf(b);
    if (!runA || !runB1 || !runB2) throw new Error("runs missing");
    expect(adapter.calls.send.map((s) => s.runId)).toEqual([runA, runB1]);
    expect(getRun(app.db, runB2)?.status).toBe("queued");

    const approval = approvalFor(dodokSessionKey("dev", a), a);
    adapter.emitApproval(approval);
    await vi.waitFor(() =>
      expect(approvalStore.getApprovalByProviderId(app.db, approval.providerApprovalId)).toMatchObject({
        runId: runA,
        status: "pending",
      }),
    );
    const statusB = [runB1, runB2].map((id) => getRun(app.db, id)?.status);

    const { headers } = await login(app);
    const closed = await app.fastify.inject({
      method: "PATCH",
      url: `/api/v1/conversations/${a}`,
      headers,
      payload: { closed: true },
    });
    expect(closed.statusCode).toBe(200);

    await vi.waitFor(() => expect(getRun(app.db, runA)?.status).toBe("aborted"));
    expect(approvalStore.getApprovalByProviderId(app.db, approval.providerApprovalId)).toMatchObject({
      status: "cancelled",
      reason: "run-aborted",
    });
    expect([runB1, runB2].map((id) => getRun(app.db, id)?.status)).toEqual(statusB);
    expect(adapter.calls.abort.map((c) => c.runId)).toEqual([runA]);
    expect(runIdsOf(b)).toEqual([runB1, runB2]);
  });
});
