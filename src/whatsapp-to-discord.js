const { renderLottieGif } = require("./helpers/lottie");
const { whatsappToDiscordMarkdown } = require("./helpers/markdown");
const { renderWebpSticker } = require("./helpers/sticker");

const MEDIA_TYPES = new Set([
  "audioMessage",
  "documentMessage",
  "imageMessage",
  "ptvMessage",
  "stickerMessage",
  "videoMessage",
]);

function createWhatsAppMessageHandler({
  baileys,
  discord,
  webhooks,
  whatsapp,
  whatsappToDiscord,
  messageMap,
  pushNames = new Map(),
  invalidateDiscordSenderContext = () => { },
}) {
  return async function handleWhatsAppMessage(whatsappMessage) {
    const chatId = whatsappMessage.key.remoteJid;
    const discordChannelId = whatsappToDiscord.get(chatId);
    if (!discordChannelId) return;
    const webhook = webhooks.get(discordChannelId);
    if (!webhook) return;

    if (whatsappMessage.pushName) {
      const senderJids = whatsappMessage.key.participant
        ? [whatsappMessage.key.participant, whatsappMessage.key.participantAlt]
        : [chatId, whatsappMessage.key.remoteJidAlt];
      for (const jid of senderJids) {
        if (jid) pushNames.set(jid, whatsappMessage.pushName);
      }
    }

    if (whatsappMessage.key.fromMe) {
      const isBridgeOutput = messageMap.getDiscordMessageId(
        chatId,
        whatsappMessage.key.id
      );
      if (!isBridgeOutput) invalidateDiscordSenderContext(chatId);
      return;
    }

    let message = baileys.normalizeMessageContent(whatsappMessage.message);
    const isLottieSticker = Boolean(message?.lottieStickerMessage?.message);
    if (isLottieSticker) {
      message = baileys.normalizeMessageContent(
        message.lottieStickerMessage.message
      );
    }
    if (message?.reactionMessage || message?.encReactionMessage) return;

    const type = baileys.getContentType(message);
    if (!type) return;

    const body = message[type];
    let content =
      message.conversation ||
      body?.text ||
      body?.caption ||
      body?.selectedDisplayText ||
      body?.title ||
      "";
    for (const mentionedJid of body?.contextInfo?.mentionedJid || []) {
      const pushName = pushNames.get(mentionedJid);
      if (pushName) {
        const mention = `@${mentionedJid.split("@")[0].split(":")[0]}`;
        content = content.split(mention).join(`@${pushName}`);
      }
    }
    content = whatsappToDiscordMarkdown(content);
    const hasMedia = MEDIA_TYPES.has(type);
    if (!content && !hasMedia) return;

    invalidateDiscordSenderContext(chatId);

    try {
      const senderId =
        whatsappMessage.key.participantAlt ||
        whatsappMessage.key.participant ||
        whatsappMessage.key.remoteJidAlt ||
        chatId;
      const senderName =
        whatsappMessage.pushName || senderId.split("@")[0] || "Unknown";
      const quotedDiscordMessageId = messageMap.getDiscordMessageId(
        chatId,
        body?.contextInfo?.stanzaId
      );
      const avatarURL = await whatsapp
        .profilePictureUrl(senderId, "image")
        .catch(() => undefined);
      const messageTimestamp = Number(whatsappMessage.messageTimestamp);
      const timestamp = Number.isFinite(messageTimestamp) && messageTimestamp > 0
        ? new Date(messageTimestamp * 1000).toISOString()
        : undefined;

      const files = [];
      if (hasMedia) {
        let downloadMessage = isLottieSticker
          ? { ...whatsappMessage, message }
          : whatsappMessage;
        const downloadOptions = {};
        try {
          const mediaUrl = new URL(body.url);
          if (mediaUrl.hostname === "a.whatsapp.net") {
            downloadOptions.host = baileys.DEF_MEDIA_HOST;
            mediaUrl.hostname = baileys.DEF_MEDIA_HOST;
            downloadMessage = {
              ...whatsappMessage,
              message: {
                ...message,
                [type]: { ...body, url: mediaUrl.toString() },
              },
            };
          }
        } catch {
          // Missing and relative URLs are handled by Baileys through directPath.
        }
        const media = await baileys.downloadMediaMessage(
          downloadMessage,
          "buffer",
          downloadOptions
        );
        let attachment = media;
        let mimeType = body.mimetype?.split(";")[0] || "application/octet-stream";
        let extension = mimeType.split("/")[1] || "bin";
        let convertedSticker = false;

        if (isLottieSticker || body.isLottie) {
          try {
            attachment = await renderLottieGif(media);
            mimeType = "image/gif";
            extension = "gif";
            convertedSticker = true;
          } catch (error) {
            console.error("Could not render WhatsApp Lottie sticker:", error);
            if (body.pngThumbnail?.length) {
              attachment = Buffer.from(body.pngThumbnail);
              mimeType = "image/png";
              extension = "png";
              convertedSticker = true;
            }
          }
        } else if (type === "stickerMessage") {
          try {
            attachment = await renderWebpSticker(media, body.isAnimated);
            mimeType = body.isAnimated ? "image/gif" : "image/png";
            extension = body.isAnimated ? "gif" : "png";
            convertedSticker = true;
          } catch (error) {
            console.error("Could not convert WhatsApp WebP sticker:", error);
          }
        }

        files.push({
          attachment,
          contentType: mimeType,
          name:
            (!convertedSticker && body.fileName) ||
            `whatsapp-${whatsappMessage.key.id}.${extension}`,
        });
      }

      let sentMessage;
      if (quotedDiscordMessageId) {
        const channel = await discord.channels.fetch(discordChannelId);
        if (!channel?.isTextBased() || !channel.isSendable()) return;

        sentMessage = await channel.send({
          embeds: [{
            color: 0x25d366,
            author: {
              name: senderName,
              icon_url: avatarURL,
            },
            description: content,
            footer: { text: "Reply from WhatsApp" },
            timestamp,
          }],
          files,
          reply: quotedDiscordMessageId
            ? {
              messageReference: quotedDiscordMessageId,
              failIfNotExists: false,
            }
            : undefined,
        });
      } else {
        sentMessage = await webhook.send({
          username: senderName.slice(0, 80),
          avatarURL,
          content,
          files,
          allowedMentions: { parse: [] },
        });
      }

      messageMap.link(sentMessage.id, chatId, whatsappMessage);
    } catch (error) {
      console.error("WhatsApp -> Discord failed:", error);
    }
  };
}

module.exports = { createWhatsAppMessageHandler };
