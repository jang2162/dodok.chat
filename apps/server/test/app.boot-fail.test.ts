import { FakeAdapter } from "@dodok/openclaw-adapter/fake";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { v7 as uuid } from "uuid";
import { describe, expect, it } from "vitest";
import { createAgent } from "../src/modules/agents/service";
import { addMember, createChannel } from "../src/modules/channels/service";
import { upsertSubscription } from "../src/modules/push/service";
import { bootTestApp } from "./helpers/app";
import { FAKE_GATEWAY_ID } from "./helpers/gateways";
import { channelConversation, seedSession } from "./helpers/seed";

const KEYS = {
  p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
  auth: "tBHItJI5svbpez7KI4CCXg",
};

describe("부팅이 실패해 되돌릴 때", () => {
  it("진행 중인 푸시 발송을 db 를 닫기 전에 기다린다(정상 종료의 push-drain 과 같다)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dodok-boot-fail-push-"));
    const DB_PATH = join(dir, "dodok.sqlite");
    try {
      // 첫 부팅: owner 의 웹 푸시 구독·에이전트·채널을 남긴다
      const first = await bootTestApp({ DB_PATH });
      const dev = createAgent(first.db, {
        gatewayId: FAKE_GATEWAY_ID,
        workspaceId: first.workspaceId,
        providerAgentId: "dev",
        handle: "dev",
        name: "Dev",
      });
      const channel = createChannel(first.db, {
        workspaceId: first.workspaceId,
        createdBy: first.ownerUserId,
        name: "boot-fail",
      });
      addMember(first.db, channel.id, { memberType: "agent", memberId: dev.id }, first.logger);
      upsertSubscription(first.db, seedSession(first.db, first.ownerUserId), {
        endpoint: "https://push.example.test/owner",
        keys: KEYS,
      });
      const conversationId = channelConversation(first.db, channel.id);
      await first.close();

      // 둘째 부팅: 어댑터 connect 가 승인을 흘려(→ owner 에게 푸시) 발송이 떠 있는 동안 부팅이 실패한다
      class ApprovalThenFail extends FakeAdapter {
        override async connect(): Promise<void> {
          const createdAt = new Date();
          this.emitApproval({
            providerApprovalId: `plugin:${uuid()}`,
            kind: "plugin",
            sessionKey: this.sessionKeyFor("dev", conversationId),
            providerAgentId: "dev",
            conversationId,
            toolCallId: "toolu_boot",
            toolName: "Write",
            pluginId: "fs",
            title: "Write 실행",
            description: "{}",
            severity: "warning",
            allowedDecisions: ["allow-once", "deny"],
            status: "pending",
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + 120_000).toISOString(),
          });
          throw new Error("connect boom");
        }
      }
      // connect 실패는 원래 부팅을 막지 않는다 — 그 경고 로그가 던지게 해 connect 뒤(트리거를 붙인 뒤)에 부팅을 실패시킨다
      const logger = pino({ level: "warn" }, { write: () => undefined });
      const warn = logger.warn.bind(logger);
      logger.warn = ((...args: unknown[]) => {
        if (args[1] === "adapter connect failed") throw new Error("boot boom");
        return (warn as (...a: unknown[]) => void)(...args);
      }) as typeof logger.warn;
      let sent = 0;
      let finished = false;
      await expect(
        bootTestApp(
          { DB_PATH },
          {
            adapters: [new ApprovalThenFail()],
            logger,
            pushSend: async () => {
              sent++;
              await new Promise((r) => setTimeout(r, 200));
              finished = true;
              return { statusCode: 410 }; // 구독 정리 — 닫힌 db 를 치면 안 된다
            },
          },
        ),
      ).rejects.toThrow("boot boom");
      expect(sent).toBe(1);
      expect(finished).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
