/**
 * dodok 채널 정의 — Gateway 프로세스 안에서 돈다. SDK 에 닿는 코드는 여기와 index.ts·runtime.ts 에만 둔다
 * (나머지는 openclaw 를 import 하지 않는 순수 모듈이라 Node 22 에서 단위 테스트한다).
 *
 * 경로:
 *   서버 --inbound.deliver--> bridge-client --> dispatchInbound --> runtime.channel.inbound.dispatch --> 에이전트 런
 *   에이전트 최종 응답 --delivery.deliver--> outbound.message
 *   에이전트 message 툴(send) --actions.handleAction--> outbound.message (components 포함)
 */
import { randomUUID } from "node:crypto";
import type { InboundDeliver, InboundDeliverResult } from "@dodok/shared";
import {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { createBridgeClient, type BridgeClient, type BridgeLogger } from "./bridge-client";
import { componentsJsonSchema } from "./components-schema";
import {
  DEFAULT_ACCOUNT_ID,
  DodokChannelSection,
  listDodokAccountIds,
  resolveDodokAccount,
  resolveDodokChannelEntry,
  type ResolvedDodokAccount,
} from "./config";
import { writeChannelConfig } from "./config-writer";
import { toInboundFacts } from "./inbound";
import {
  buildOutboundMessage,
  channelIdFromSessionKey,
  formatDodokTarget,
  messageToolSendToOutbound,
  parseDodokTarget,
  type OutboundCorrelation,
} from "./outbound";
import { getDodokRuntime } from "./runtime";

export const DODOK_CHANNEL_ID = "dodok";
declare const __DODOK_PLUGIN_VERSION__: string;
declare const __OPENCLAW_SDK_VERSION__: string;
const PLUGIN_VERSION = typeof __DODOK_PLUGIN_VERSION__ === "string" ? __DODOK_PLUGIN_VERSION__ : "0.0.0";
const SDK_VERSION = typeof __OPENCLAW_SDK_VERSION__ === "string" ? __OPENCLAW_SDK_VERSION__ : "unknown";

type ChannelRuntime = PluginRuntime["channel"];

/** 계정별 브리지 연결. message 툴 액션은 계정 id 로 연결을 찾는다 */
const bridges = new Map<string, BridgeClient>();
/** 세션 키 → 마지막 인바운드 상관관계. message 툴 send 를 우리 런에 묶는다 */
const correlations = new Map<string, OutboundCorrelation>();

function sectionOf(cfg: OpenClawConfig): unknown {
  return (cfg.channels as Record<string, unknown> | undefined)?.[DODOK_CHANNEL_ID];
}

function logLine(event: string, detail: Record<string, unknown>): string {
  // 스파이크 러너가 Gateway 로그에서 grep 한다 — 한 줄 JSON, 값에 시크릿 없음
  return `dodok:${event} ${JSON.stringify(detail)}`;
}

function pluginLogger(
  log: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void } | undefined,
): BridgeLogger {
  return {
    info: (m) => (log?.info ?? console.log)(m),
    warn: (m) => (log?.warn ?? console.warn)(m),
    error: (m) => (log?.error ?? console.error)(m),
  };
}

async function dispatchInbound(params: {
  delivery: InboundDeliver;
  account: ResolvedDodokAccount;
  channelRuntime: ChannelRuntime;
  bridge: BridgeClient;
  logger: BridgeLogger;
}): Promise<InboundDeliverResult> {
  const { delivery, account, channelRuntime, bridge, logger } = params;
  const factsResult = toInboundFacts(delivery, { accountId: account.accountId });
  if (!factsResult.ok) throw new Error(factsResult.error);
  const facts = factsResult.facts;
  // 계정 재시작 없이 채널 항목(systemPrompt 등)을 갱신할 수 있게 디스패치마다 현재 설정을 읽는다
  const cfg = getDodokRuntime().config.current() as OpenClawConfig;
  const entry = resolveDodokChannelEntry(sectionOf(cfg), facts.channelId);

  const ingress = await resolveStableChannelMessageIngress({
    channelId: DODOK_CHANNEL_ID,
    accountId: account.accountId,
    cfg,
    identity: { key: "sender", entryIdPrefix: "dodok-entry" },
    subject: { stableId: facts.sender.id },
    conversation: { kind: "channel", id: facts.channelId },
    contextBinding: {
      agentId: facts.agentId,
      sessionKey: facts.sessionKey,
      messageId: facts.messageId,
      inboundEventKind: "user_request",
    },
    // 인가는 브리지 토큰이 경계다 — 서버가 멘션 라우팅을 끝낸 인바운드만 온다
    dmPolicy: "open",
    groupPolicy: "open",
  });
  logger.info(
    logLine("ingress", {
      deliveryId: facts.correlation.deliveryId,
      admission: ingress.ingress.admission,
      decision: ingress.ingress.decision,
    }),
  );

  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: DODOK_CHANNEL_ID,
    accountId: account.accountId,
    messageId: facts.messageId,
    messageIdFull: facts.messageId,
    timestamp: facts.timestamp,
    from: facts.sender.id,
    sender: { id: facts.sender.id, name: facts.sender.name, isBot: facts.sender.isBot },
    conversation: { kind: "channel", id: facts.channelId, label: facts.channelId },
    route: {
      agentId: facts.agentId,
      accountId: account.accountId,
      routeSessionKey: facts.sessionKey,
      dispatchSessionKey: facts.sessionKey,
    },
    reply: { to: facts.target, originatingTo: facts.target },
    message: {
      body: facts.body,
      bodyForAgent: facts.body,
      rawBody: facts.rawBody,
      commandBody: facts.rawBody,
    },
    channelIngress: ingress,
    extra: {
      CommandInterpretationSuppressed: true,
      ...(entry.systemPrompt ? { GroupSystemPrompt: entry.systemPrompt } : {}),
    },
  });

  const correlation: OutboundCorrelation = {
    runId: facts.correlation.runId,
    replyToInboundId: facts.correlation.replyToInboundId,
  };
  correlations.set(facts.sessionKey, correlation);

  let resolveStarted: (runId: string | undefined) => void = () => {};
  const started = new Promise<string | undefined>((resolve) => {
    resolveStarted = resolve;
  });

  const dispatch = channelRuntime.inbound
    .dispatch({
      cfg,
      channel: DODOK_CHANNEL_ID,
      accountId: account.accountId,
      route: { agentId: facts.agentId, sessionKey: facts.sessionKey },
      ctxPayload,
      replyPipeline: {},
      replyOptions: {
        // Gateway 런 id 를 우리 런 id 로 맞춘다 — WS 경로(chat/agent 이벤트)와 runId 로 dedupe
        runId: facts.correlation.runId,
        onAgentRunStart: (runId: string) => {
          correlation.providerRunId = runId;
          logger.info(logLine("run-start", { deliveryId: facts.correlation.deliveryId, runId }));
          resolveStarted(runId);
        },
      },
      ...(facts.botLoopProtection
        ? {
            botLoopProtection: {
              ...facts.botLoopProtection,
              config: entry.botLoopProtection ?? entry.sectionBotLoopProtection,
              defaultsConfig: (cfg.channels as { defaults?: { botLoopProtection?: unknown } } | undefined)
                ?.defaults?.botLoopProtection as never,
              defaultEnabled: true,
            },
          }
        : {}),
      delivery: {
        deliver: async (payload, info) => {
          const text = payload.text ?? "";
          logger.info(
            logLine("deliver", {
              deliveryId: facts.correlation.deliveryId,
              kind: info.kind,
              textLength: text.length,
              payloadKeys: Object.keys(payload),
            }),
          );
          if (info.kind !== "final" || !text.trim()) return;
          const built = buildOutboundMessage({
            outboundId: `dodok-reply-${randomUUID()}`,
            channelId: facts.channelId,
            agentId: facts.agentId,
            sessionKey: facts.sessionKey,
            text,
            correlation,
            now: new Date(),
          });
          if (!built.ok) throw new Error(built.error);
          const ack = await bridge.sendOutbound(built.message);
          return { messageIds: [ack.messageId], visibleReplySent: true };
        },
        onError: (error, info) => {
          logger.error(logLine("deliver-error", { kind: info.kind, error: String(error) }));
        },
      },
    })
    .then((result) => {
      logger.info(
        logLine("dispatch-result", {
          deliveryId: facts.correlation.deliveryId,
          admission: result.admission,
          dispatched: result.dispatched,
          routeSessionKey: result.routeSessionKey,
        }),
      );
      resolveStarted(undefined);
      return result;
    })
    .catch((error: unknown) => {
      logger.error(
        logLine("dispatch-error", { deliveryId: facts.correlation.deliveryId, error: String(error) }),
      );
      resolveStarted(undefined);
    });
  void dispatch;

  // ack 는 런이 시작되거나(Gateway 런 id 확보) 디스패치가 런 없이 끝났을 때(루프 보호 등) 보낸다
  const providerRunId = await started;
  return providerRunId ? { providerRunId } : {};
}

async function startDodokAccount(ctx: {
  cfg: OpenClawConfig;
  accountId: string;
  account: ResolvedDodokAccount;
  abortSignal: AbortSignal;
  log?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  channelRuntime?: ChannelRuntime;
  setStatus: (next: never) => void;
}): Promise<void> {
  const { account } = ctx;
  if (!account.configured || !account.bridgeUrl || !account.token) {
    throw new Error(`dodok: account "${account.accountId}" is not configured (bridgeUrl, token)`);
  }
  const runtime = getDodokRuntime();
  const channelRuntime = ctx.channelRuntime ?? runtime.channel;
  const logger = pluginLogger(ctx.log);
  const setStatus = ctx.setStatus as (next: Record<string, unknown>) => void;
  setStatus({ accountId: account.accountId, running: true, configured: true, enabled: account.enabled });

  const bridge: BridgeClient = createBridgeClient({
    url: account.bridgeUrl,
    token: account.token,
    hello: {
      pluginId: "dodok",
      version: PLUGIN_VERSION,
      sdkVersion: SDK_VERSION,
      gatewayVersion: runtime.version,
      capabilities: ["run_id_in_outbound", "config.set"],
    },
    logger,
    handlers: {
      onInbound: (delivery) => dispatchInbound({ delivery, account, channelRuntime, bridge, logger }),
      onConfigSet: (payload) => writeChannelConfig(runtime, payload, logger),
      onReady: () => setStatus({ accountId: account.accountId, running: true, connected: true }),
    },
  });
  bridges.set(account.accountId, bridge);
  bridge.start();
  try {
    await waitUntilAbort(ctx.abortSignal);
  } finally {
    bridges.delete(account.accountId);
    await bridge.stop();
    setStatus({ accountId: account.accountId, running: false, connected: false });
  }
}

const dodokConfigSchema = buildChannelConfigSchema(DodokChannelSection as never, {
  uiHints: {
    "accounts.*.bridgeUrl": { label: "dodok bridge URL", help: "wss://<dodok server>/bridge" },
    "accounts.*.token": { label: "dodok bridge token", sensitive: true },
    "channels.*.systemPrompt": { label: "Channel system prompt" },
  },
});

export const dodokChannelPlugin = createChatChannelPlugin<ResolvedDodokAccount>({
  base: {
    id: DODOK_CHANNEL_ID,
    meta: {
      id: DODOK_CHANNEL_ID,
      label: "dodok",
      selectionLabel: "dodok.chat",
      docsPath: "/channels/dodok",
      blurb: "Agent-native team messenger (dodok.chat) bridge.",
    },
    capabilities: { chatTypes: ["channel"] },
    reload: {
      configPrefixes: ["channels.dodok"],
      // 채널 항목(systemPrompt·requireMention·봇 루프 조정)은 디스패치마다 읽으므로 계정 재시작이 필요 없다
      noopPrefixes: ["channels.dodok.channels"],
    },
    configSchema: dodokConfigSchema,
    config: {
      listAccountIds: (cfg: OpenClawConfig) => listDodokAccountIds(sectionOf(cfg)),
      resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
        resolveDodokAccount(sectionOf(cfg), accountId),
      defaultAccountId: () => DEFAULT_ACCOUNT_ID,
      isConfigured: (account: ResolvedDodokAccount) => account.configured,
      isEnabled: (account: ResolvedDodokAccount) => account.enabled,
      inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
        const account = resolveDodokAccount(sectionOf(cfg), accountId);
        return {
          enabled: account.enabled,
          configured: account.configured,
          tokenStatus: account.token ? "available" : "missing",
        };
      },
    },
    messaging: {
      normalizeTarget: (raw: string) => {
        const channelId = parseDodokTarget(raw);
        return channelId ? formatDodokTarget(channelId) : undefined;
      },
      inferTargetChatType: () => "channel",
      targetResolver: {
        looksLikeId: (raw: string) => parseDodokTarget(raw) !== null,
        hint: "channel:<dodok channel uuid>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const channelId = parseDodokTarget(target);
        if (!channelId) return null;
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: DODOK_CHANNEL_ID,
          accountId,
          peer: { kind: "channel", id: channelId },
          chatType: "channel",
          from: `dodok:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: formatDodokTarget(channelId),
        });
      },
    },
    actions: {
      // 코어가 채널별 스키마 조각을 message 툴에 합친다. TypeBox TSchema 자리에 JSON Schema 를 그대로 넣는다(실측: 모델이 채워 보냄)
      describeMessageTool: () => ({
        actions: ["send"],
        capabilities: [],
        schema: {
          properties: { components: componentsJsonSchema as never },
          actions: ["send"],
          visibility: "current-channel",
        },
      }),
      supportsAction: ({ action }) => action === "send",
      handleAction: async (actionCtx) => {
        const accountId = actionCtx.accountId ?? DEFAULT_ACCOUNT_ID;
        const bridge = bridges.get(accountId);
        const sessionKey = actionCtx.sessionKey ?? null;
        const correlation = sessionKey ? correlations.get(sessionKey) : undefined;
        const built = messageToolSendToOutbound({
          params: actionCtx.params,
          agentId: actionCtx.agentId ?? null,
          sessionKey,
          correlation,
          outboundId: `dodok-tool-${randomUUID()}`,
          now: new Date(),
        });
        console.info(
          logLine("tool-send", {
            action: actionCtx.action,
            accountId,
            sessionKey,
            agentId: actionCtx.agentId ?? null,
            paramKeys: Object.keys(actionCtx.params),
            hasComponents: actionCtx.params["components"] !== undefined,
            ok: built.ok,
            error: built.ok ? undefined : built.error,
          }),
        );
        if (!built.ok) throw new Error(built.error);
        if (!bridge) throw new Error(`dodok: account "${accountId}" bridge is not running`);
        const ack = await bridge.sendOutbound(built.message);
        return {
          content: [
            { type: "text", text: `sent to dodok channel ${built.message.channelId} (${ack.messageId})` },
          ],
          details: { ok: true, messageId: ack.messageId, channelId: built.message.channelId },
        };
      },
    },
    gateway: {
      startAccount: async (ctx) => await startDodokAccount(ctx as never),
    },
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: DODOK_CHANNEL_ID,
      sendText: async ({ to, text, accountId }) => {
        const channelId = parseDodokTarget(to) ?? channelIdFromSessionKey(to);
        if (!channelId) throw new Error(`dodok: invalid target ${to}`);
        const bridge = bridges.get(accountId ?? DEFAULT_ACCOUNT_ID);
        if (!bridge) throw new Error("dodok: bridge is not running");
        // 코어의 일반 전송(크론·하트비트 전달 등) 경로 — 에이전트 컨텍스트가 없다. 스파이크에서는 호출되지 않았다(Phase 1 에서 정한다)
        const built = buildOutboundMessage({
          outboundId: `dodok-out-${randomUUID()}`,
          channelId,
          agentId: "unknown",
          sessionKey: `agent:unknown:dodok:channel:${channelId}`,
          text,
          now: new Date(),
        });
        if (!built.ok) throw new Error(built.error);
        console.info(logLine("outbound-sendText", { channelId, textLength: text.length }));
        const ack = await bridge.sendOutbound(built.message);
        return { to, messageId: ack.messageId };
      },
    },
  },
});
