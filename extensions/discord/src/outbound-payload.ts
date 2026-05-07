import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  resolveDiscordComponentSpec,
  sendDiscordComponentMessageLazy,
} from "./outbound-components.js";
import { createDiscordPayloadSendContext } from "./outbound-send-context.js";
import type { DiscordSendComponents } from "./send.shared.js";

type OutboundPayload = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0]["payload"];

/**
 * Extract raw Discord API components stored in channelData by the gateway send
 * handler. These are passed through to the Discord API as-is (e.g. action rows
 * with buttons for HITL approval flows).
 */
function resolveDiscordRawComponents(payload: OutboundPayload): DiscordSendComponents | undefined {
  const discordData = payload.channelData?.discord as
    | { rawComponents?: unknown }
    | undefined;
  const raw = discordData?.rawComponents;
  if (Array.isArray(raw) && raw.length > 0) {
    return raw as DiscordSendComponents;
  }
  return undefined;
}

export async function sendDiscordOutboundPayload(params: {
  ctx: Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];
  fallbackAdapter: ChannelOutboundAdapter;
}): Promise<Awaited<ReturnType<NonNullable<ChannelOutboundAdapter["sendPayload"]>>>> {
  const ctx = params.ctx;
  const payload = normalizeDiscordApprovalPayload({
    ...ctx.payload,
    text: ctx.payload.text ?? "",
  });
  const mediaUrls = resolvePayloadMediaUrls(payload);
  const sendContext = await createDiscordPayloadSendContext(ctx);

  if (payload.audioAsVoice && mediaUrls.length > 0) {
    let lastResult = await sendContext.withRetry(
      async () =>
        await sendContext.sendVoice(sendContext.target, mediaUrls[0], {
          cfg: ctx.cfg,
          replyTo: sendContext.resolveReplyTo(),
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
        }),
    );
    if (payload.text?.trim()) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, payload.text, {
            verbose: false,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    }
    for (const mediaUrl of mediaUrls.slice(1)) {
      lastResult = await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, "", {
            verbose: false,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    }
    return attachChannelToResult("discord", lastResult);
  }

  const componentSpec = await resolveDiscordComponentSpec(payload);
  if (!componentSpec) {
    const rawComponents = resolveDiscordRawComponents(payload);
    if (rawComponents) {
      const result = await sendPayloadMediaSequenceOrFallback({
        text: payload.text ?? "",
        mediaUrls,
        fallbackResult: { messageId: "", channelId: sendContext.target },
        sendNoMedia: async () =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, payload.text ?? "", {
                replyTo: sendContext.resolveReplyTo(),
                accountId: ctx.accountId ?? undefined,
                silent: ctx.silent ?? undefined,
                cfg: ctx.cfg,
                components: rawComponents,
                ...sendContext.formatting,
              }),
          ),
        send: async ({ text, mediaUrl, isFirst }) =>
          await sendContext.withRetry(
            async () =>
              await sendContext.send(sendContext.target, text, {
                verbose: false,
                mediaUrl,
                mediaAccess: ctx.mediaAccess,
                mediaLocalRoots: ctx.mediaLocalRoots,
                mediaReadFile: ctx.mediaReadFile,
                replyTo: sendContext.resolveReplyTo(),
                accountId: ctx.accountId ?? undefined,
                silent: ctx.silent ?? undefined,
                cfg: ctx.cfg,
                ...(isFirst ? { components: rawComponents } : {}),
                ...sendContext.formatting,
              }),
          ),
      });
      return attachChannelToResult("discord", result);
    }
    return await sendTextMediaPayload({
      channel: "discord",
      ctx: {
        ...ctx,
        payload,
      },
      adapter: params.fallbackAdapter,
    });
  }

  const result = await sendPayloadMediaSequenceOrFallback({
    text: payload.text ?? "",
    mediaUrls,
    fallbackResult: { messageId: "", channelId: sendContext.target },
    sendNoMedia: async () =>
      await sendContext.withRetry(
        async () =>
          await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      ),
    send: async ({ text, mediaUrl, isFirst }) => {
      if (isFirst) {
        return await sendContext.withRetry(
          async () =>
            await sendDiscordComponentMessageLazy(sendContext.target, componentSpec, {
              mediaUrl,
              mediaAccess: ctx.mediaAccess,
              mediaLocalRoots: ctx.mediaLocalRoots,
              mediaReadFile: ctx.mediaReadFile,
              replyTo: sendContext.resolveReplyTo(),
              accountId: ctx.accountId ?? undefined,
              silent: ctx.silent ?? undefined,
              cfg: ctx.cfg,
              ...sendContext.formatting,
            }),
        );
      }
      return await sendContext.withRetry(
        async () =>
          await sendContext.send(sendContext.target, text, {
            verbose: false,
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: sendContext.resolveReplyTo(),
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
            ...sendContext.formatting,
          }),
      );
    },
  });
  return attachChannelToResult("discord", result);
}
