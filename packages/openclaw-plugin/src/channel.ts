/**
 * dodok 채널 정의 — Gateway 프로세스 안에서 돈다. SDK 에 닿는 코드는 여기와 index.ts·runtime.ts 에만 둔다
 * (나머지는 openclaw 를 import 하지 않는 순수 모듈이다. `channel.ts` 도 핀 SDK 를 그대로 불러 `test/channel.test.ts` 에서 시험한다).
 *
 * 경로:
 *   서버 --inbound.deliver--> bridge-client --> dispatchInbound --> runtime.channel.inbound.dispatch --> 에이전트 런
 *   에이전트 최종 응답 --delivery.deliver--> outbound.message
 *   에이전트 message 툴(send) --actions.handleAction--> outbound.message (components 포함)
 *   첨부 바이트는 브리지 오리진 HTTP 로 — 인바운드 이미지는 GET 해 Gateway 미디어 저장소에, 아웃바운드 미디어는 POST 해 attachmentIds 로
 */
import { randomUUID } from "node:crypto";
import {
  dodokSessionKey,
  Id,
  type BridgeCapability,
  type InboundDeliver,
  type InboundDeliverResult,
} from "@dodok/shared";
import {
  buildChannelConfigSchema,
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
  type OpenClawConfig,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { toInboundMediaFacts } from "openclaw/plugin-sdk/channel-inbound";
import { resolveStableChannelMessageIngress } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { loadWebMediaRaw } from "openclaw/plugin-sdk/web-media";
import { createBridgeClient, type BridgeClient, type BridgeLogger } from "./bridge-client";
import { getBridge, getCorrelation, registerBridge, releaseBridge, setCorrelation } from "./bridge-registry";
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
import { channelPromptContext } from "./context";
import { toDeliverResult, toInboundFacts } from "./inbound";
import { appendNotes, inboundSaveArgs, prepareInboundMedia } from "./inbound-media";
import { bridgeHttpOrigin, downloadAttachment, uploadAttachment } from "./media-http";
import {
  buildOutboundMessage,
  channelIdFromSessionKey,
  formatDodokTarget,
  messageToolSendToOutbound,
  outboundRouteThreadId,
  parseDodokTarget,
  toolInputError,
  type OutboundCorrelation,
} from "./outbound";
import {
  collectDeliverMediaSources,
  collectToolMediaSources,
  deliverFailureLine,
  loaderOptions,
  shouldDeliverFinal,
  toolFailureMessage,
  uploadOutboundMedia,
} from "./outbound-media";
import { computeBundleSha256 } from "./bundle-hash";
import { getDodokRuntime } from "./runtime";

export const DODOK_CHANNEL_ID = "dodok";
declare const __DODOK_PLUGIN_VERSION__: string;
declare const __OPENCLAW_SDK_VERSION__: string;
const PLUGIN_VERSION = typeof __DODOK_PLUGIN_VERSION__ === "string" ? __DODOK_PLUGIN_VERSION__ : "0.0.0";
const SDK_VERSION = typeof __OPENCLAW_SDK_VERSION__ === "string" ? __OPENCLAW_SDK_VERSION__ : "unknown";
// 번들(scripts/build.mjs, format esm)에서 import.meta.url 은 dist/index.js 자신이다. 빌드를 CJS 로 바꾸거나
// import.meta 를 define 으로 치환하면 해시가 조용히 사라져 서버는 늘 「빌드를 알 수 없습니다」로 본다
const BUNDLE_SHA256 = computeBundleSha256(import.meta.url);
/** hello 로 서버에 알리는 능력. `threads` 가 없으면 서버는 스레드 런을 PLUGIN_OUTDATED 로 끝낸다(스펙 3.2) */
export const DODOK_BRIDGE_CAPABILITIES: BridgeCapability[] = ["run_id_in_outbound", "config.set", "threads"];

type ChannelRuntime = PluginRuntime["channel"];

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
  // 계정 재시작 없이 채널 항목(systemPrompt 등)을 갱신할 수 있게 디스패치마다 현재 설정을 읽는다
  const cfg = getDodokRuntime().config.current() as OpenClawConfig;
  const entry = resolveDodokChannelEntry(sectionOf(cfg), delivery.channelId);
  const promptContext = channelPromptContext(delivery);
  const factsResult = toInboundFacts(delivery, { accountId: account.accountId });
  if (!factsResult.ok) throw new Error(factsResult.error);
  const facts = factsResult.facts;

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
      sessionKey: facts.sessionKey,
      groupSystemPromptChars: entry.systemPrompt?.length ?? 0,
      channelPromptContextItems: promptContext?.length ?? 0,
    }),
  );

  // 브리지 토큰·URL 은 startDodokAccount 가 확인했다
  const origin = bridgeHttpOrigin(account.bridgeUrl!);
  const token = account.token!;
  const save = channelRuntime.media?.saveMediaBuffer ?? getDodokRuntime().channel.media?.saveMediaBuffer;
  const inboundMedia = await prepareInboundMedia(delivery.message.attachments, {
    download: (id) => downloadAttachment({ origin, token, id }),
    save: async (bytes, mime, name) => {
      if (!save) throw new Error("saveMediaBuffer unavailable");
      return await save(...inboundSaveArgs(bytes, mime, name));
    },
  });
  // fact 에 url 은 넣지 않는다(전사에 남는다). 옛 MediaPath* 필드는 쓰지 않는다
  const media = inboundMedia.facts.length > 0 ? toInboundMediaFacts(inboundMedia.facts) : undefined;
  const body = appendNotes(facts.body, inboundMedia.notes);
  if (delivery.message.attachments.length > 0) {
    // 경로는 싣지 않는다 — 개수와 실패 단계·종류(download:http-404 등)만
    logger.info(
      logLine("inbound-media", {
        deliveryId: facts.correlation.deliveryId,
        images: inboundMedia.facts.length,
        notes: inboundMedia.notes.length,
        reasons: inboundMedia.reasons,
      }),
    );
  }

  const ctxPayload = channelRuntime.inbound.buildContext({
    channel: DODOK_CHANNEL_ID,
    accountId: account.accountId,
    messageId: facts.messageId,
    messageIdFull: facts.messageId,
    timestamp: facts.timestamp,
    from: facts.sender.id,
    sender: { id: facts.sender.id, name: facts.sender.name, isBot: facts.sender.isBot },
    conversation: facts.conversation,
    route: facts.route,
    reply: facts.reply,
    message: {
      body,
      bodyForAgent: body,
      rawBody: facts.rawBody,
      commandBody: facts.rawBody,
    },
    ...(media ? { media } : {}),
    channelIngress: ingress,
    extra: {
      CommandInterpretationSuppressed: true,
      ...(entry.systemPrompt ? { GroupSystemPrompt: entry.systemPrompt } : {}),
      ...(promptContext ? { ChannelPromptContext: promptContext } : {}),
    },
  });

  const correlation: OutboundCorrelation = {
    runId: facts.correlation.runId,
    replyToInboundId: facts.correlation.replyToInboundId,
  };
  setCorrelation(facts.sessionKey, correlation);

  // ack 는 먼저 오는 쪽으로 한 번만 정해진다 — 런 시작(onAgentRunStart) 또는 런 없이 끝난 디스패치 결과
  let resolveAck: (result: InboundDeliverResult) => void = () => {};
  let rejectAck: (error: unknown) => void = () => {};
  const ack = new Promise<InboundDeliverResult>((resolve, reject) => {
    resolveAck = resolve;
    rejectAck = reject;
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
          resolveAck(toDeliverResult({ kind: "dispatch" }, runId));
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
          const sources = collectDeliverMediaSources(payload);
          logger.info(
            logLine("deliver", {
              deliveryId: facts.correlation.deliveryId,
              kind: info.kind,
              textLength: text.length,
              payloadKeys: Object.keys(payload),
              media: sources.length,
            }),
          );
          // 미디어만 있는 최종 응답도 보낸다(스펙 5.2 결함). 텍스트도 미디어도 없을 때만 돌아간다
          if (!shouldDeliverFinal(info.kind, text, sources.length)) return;
          const outcome =
            sources.length === 0
              ? { ids: [], failures: [] }
              : await uploadOutboundMedia(sources, {
                  // deliver 에는 mediaAccess 가 없다 — 스테이징 경로는 기본 루트 안이다(스파이크 2-9). fs.readFile 직접 금지
                  load: async (src) => {
                    const r = await loadWebMediaRaw(src, loaderOptions(undefined, account.mediaMaxBytes));
                    return {
                      bytes: r.buffer,
                      ...(r.contentType ? { contentType: r.contentType } : {}),
                      ...(r.fileName ? { fileName: r.fileName } : {}),
                    };
                  },
                  upload: (bytes, name, mime) =>
                    uploadAttachment({
                      origin,
                      token,
                      channelId: facts.channelId,
                      bytes,
                      name,
                      ...(mime ? { mime } : {}),
                    }),
                  maxBytes: account.mediaMaxBytes,
                });
          if (sources.length > 0) {
            logger.info(
              logLine("deliver-media", {
                deliveryId: facts.correlation.deliveryId,
                uploaded: outcome.ids.length,
                failed: outcome.failures.length,
                // 원문은 가린 뒤 로그에만 — 채널 본문에는 고정 사유만 간다
                details: outcome.failures.map((f) => f.detail),
              }),
            );
          }
          // 모델에게 돌려줄 길이 없다 — 성공한 첨부로 보내고 본문 끝에 실패 줄
          const finalText =
            outcome.failures.length > 0 ? appendNotes(text, [deliverFailureLine(outcome.failures)]) : text;
          const built = buildOutboundMessage({
            outboundId: `dodok-reply-${randomUUID()}`,
            channelId: facts.channelId,
            agentId: facts.agentId,
            sessionKey: facts.sessionKey,
            ...(facts.threadId ? { threadId: facts.threadId } : {}),
            text: finalText,
            attachmentIds: outcome.ids,
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
      resolveAck(toDeliverResult(result.admission));
      return result;
    })
    .catch((error: unknown) => {
      logger.error(
        logLine("dispatch-error", { deliveryId: facts.correlation.deliveryId, error: String(error) }),
      );
      // 런 시작 전 실패면 ack 를 오류(Result ok:false)로 — drop 은 「런 없이 정상 종료」만 뜻한다
      rejectAck(error);
    });
  void dispatch;

  return await ack;
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
      ...(BUNDLE_SHA256 ? { bundleSha256: BUNDLE_SHA256 } : {}),
      capabilities: DODOK_BRIDGE_CAPABILITIES,
    },
    logger,
    handlers: {
      onInbound: (delivery) => dispatchInbound({ delivery, account, channelRuntime, bridge, logger }),
      onConfigSet: (payload) => writeChannelConfig(runtime, payload, logger),
      onReady: () => setStatus({ accountId: account.accountId, running: true, connected: true }),
    },
  });
  registerBridge(account.accountId, bridge);
  bridge.start();
  try {
    await waitUntilAbort(ctx.abortSignal);
  } finally {
    releaseBridge(account.accountId, bridge);
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
      // 돌려준 경로의 키가 코어의 delivery-mirror 전사 자리다 — 채널 키만 돌려주면 스레드 세션의 툴 전송이 채널 세션
      // 전사에 샌다(ADR 0006 「아웃바운드와 delivery-mirror 누수」 절). SDK 기본 precedence 는 replyToId 를 먼저 보는데
      // 우리 replyToId 는 인바운드 메시지 id 라 `:thread:<메시지 id>` 라는 없는 세션으로 가므로 쓰지 않는다
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target, currentSessionKey, threadId }) => {
        const channelId = parseDodokTarget(target);
        if (!channelId) return null;
        const route = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: DODOK_CHANNEL_ID,
          accountId,
          peer: { kind: "channel", id: channelId },
          chatType: "channel",
          from: `dodok:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: formatDodokTarget(channelId),
        });
        const routeThreadId = outboundRouteThreadId({ currentSessionKey, threadId });
        return buildThreadAwareOutboundSessionRoute({
          route,
          ...(routeThreadId === undefined ? {} : { threadId: routeThreadId }),
          ...(currentSessionKey ? { currentSessionKey } : {}),
          precedence: ["threadId", "currentSession"],
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
        const bridge = getBridge(accountId);
        const sessionKey = actionCtx.sessionKey ?? null;
        const correlation = sessionKey ? getCorrelation(sessionKey) : undefined;
        const sources = collectToolMediaSources(actionCtx.params);
        const built = messageToolSendToOutbound({
          params: actionCtx.params,
          agentId: actionCtx.agentId ?? null,
          sessionKey,
          correlation,
          outboundId: `dodok-tool-${randomUUID()}`,
          now: new Date(),
          hasMedia: sources.length > 0,
        });
        console.info(
          logLine("tool-send", {
            action: actionCtx.action,
            accountId,
            sessionKey,
            agentId: actionCtx.agentId ?? null,
            paramKeys: Object.keys(actionCtx.params),
            hasComponents: actionCtx.params["components"] !== undefined,
            media: sources.length,
            ok: built.ok,
            error: built.ok ? undefined : built.error,
          }),
        );
        if (!built.ok) throw toolInputError(built.error);
        // 스레드의 정본은 세션 키다. 코어가 넘긴 현재 스레드는 대조만 한다 — 어긋나면 코어·우리 중 하나의 가정이 틀렸다
        const currentThreadTs = actionCtx.toolContext?.currentThreadTs;
        if (currentThreadTs && currentThreadTs.toLowerCase() !== (built.message.threadId ?? "")) {
          console.warn(
            logLine("tool-send-thread-mismatch", {
              sessionKey,
              threadId: built.message.threadId ?? null,
              currentThreadTs,
            }),
          );
        }
        if (!bridge) throw new Error(`dodok: account "${accountId}" bridge is not running`);
        if (sources.length > 0) {
          // handleAction 은 세대 2 에서 돌 수 있다(ADR 0004) — 계정은 액션 문맥의 cfg 로 푼다
          const account = resolveDodokAccount(sectionOf(actionCtx.cfg), accountId);
          if (!account.bridgeUrl || !account.token)
            throw new Error(`dodok: account "${accountId}" is not configured`);
          const origin = bridgeHttpOrigin(account.bridgeUrl);
          const token = account.token;
          const maxBytes = account.mediaMaxBytes;
          const access = actionCtx.mediaAccess;
          const channelId = built.message.channelId;
          const outcome = await uploadOutboundMedia(sources, {
            // 호스트 정책(localRoots·readFile·workspaceDir)을 그대로 넘긴다 — fs.readFile 직접 금지
            load: async (src) => {
              const r = await loadWebMediaRaw(src, loaderOptions(access, maxBytes));
              return {
                bytes: r.buffer,
                ...(r.contentType ? { contentType: r.contentType } : {}),
                ...(r.fileName ? { fileName: r.fileName } : {}),
              };
            },
            upload: (bytes, name, mime) =>
              uploadAttachment({ origin, token, channelId, bytes, name, ...(mime ? { mime } : {}) }),
            maxBytes,
          });
          console.info(
            logLine("tool-send-media", {
              uploaded: outcome.ids.length,
              failed: outcome.failures.length,
              details: outcome.failures.map((f) => f.detail),
            }),
          );
          // 하나라도 실패하면 툴 호출을 실패로 — 모델이 보고 고칠 수 있다. 이미 올린 것은 미묶음으로 남아 서버 정리가 지운다
          if (outcome.failures.length > 0) throw toolInputError(toolFailureMessage(outcome.failures));
          built.message.attachmentIds = outcome.ids;
        }
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
      sendText: async ({ to, text, accountId, threadId: rawThreadId }) => {
        const channelId = parseDodokTarget(to) ?? channelIdFromSessionKey(to);
        if (!channelId) throw new Error(`dodok: invalid target ${to}`);
        // 스레드 런이 실패하면 코어가 오류 알림을 threadId 와 함께 여기로 보낸다(ADR 0006) — 버리면 채널 최상위에 뜬다
        const threadId =
          rawThreadId === undefined || rawThreadId === null || rawThreadId === ""
            ? undefined
            : String(rawThreadId);
        if (threadId !== undefined && !Id.safeParse(threadId).success) {
          throw new Error(`dodok: invalid threadId ${threadId}`);
        }
        const bridge = getBridge(accountId ?? DEFAULT_ACCOUNT_ID);
        if (!bridge) throw new Error("dodok: bridge is not running");
        // 코어의 일반 전송(크론·하트비트 전달·런 오류 알림 등) 경로 — 에이전트 컨텍스트가 없다
        const built = buildOutboundMessage({
          outboundId: `dodok-out-${randomUUID()}`,
          channelId,
          agentId: "unknown",
          sessionKey: dodokSessionKey("unknown", channelId, threadId),
          ...(threadId ? { threadId } : {}),
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
