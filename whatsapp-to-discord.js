const { renderLottieGif } = require("./lottie");

const MEDIA_TYPES = new Set([
  "audioMessage",
  "documentMessage",
  "imageMessage",
  "stickerMessage",
  "videoMessage",
]);

function createWhatsAppMessageHandler({
  baileys,
  discord,
  webhook,
  whatsapp,
  whatsappToDiscord,
  messageMap,
}) {
  return async function handleWhatsAppMessage(whatsappMessage) {
    if (whatsappMessage.key.fromMe) return;

    const chatId = whatsappMessage.key.remoteJid;
    const discordChannelId = whatsappToDiscord.get(chatId);
    if (!discordChannelId) return;

    let message = baileys.normalizeMessageContent(whatsappMessage.message);
    const isLottieSticker = Boolean(message?.lottieStickerMessage?.message);
    if (isLottieSticker) {
      message = baileys.normalizeMessageContent(
        message.lottieStickerMessage.message
      );
    }
    const type = baileys.getContentType(message);
    if (!type) return;

    const body = message[type];
    const content =
      message.conversation ||
      body?.text ||
      body?.caption ||
      body?.selectedDisplayText ||
      body?.title ||
      "";
    const hasMedia = MEDIA_TYPES.has(type);
    if (!content && !hasMedia) return;

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

      const files = [];
      if (hasMedia) {
        const media = await baileys.downloadMediaMessage(
          isLottieSticker
            ? { ...whatsappMessage, message }
            : whatsappMessage,
          "buffer",
          { host: baileys.DEF_MEDIA_HOST }
        );
        let attachment = media;
        let mimeType = body.mimetype?.split(";")[0] || "application/octet-stream";
        let extension = mimeType.split("/")[1] || "bin";

        if (isLottieSticker || body.isLottie) {
          try {
            attachment = await renderLottieGif(media);
            mimeType = "image/gif";
            extension = "gif";
          } catch (error) {
            console.error("Could not render WhatsApp Lottie sticker:", error);
            if (body.pngThumbnail?.length) {
              attachment = Buffer.from(body.pngThumbnail);
              mimeType = "image/png";
              extension = "png";
            }
          }
        }

        files.push({
          attachment,
          name:
            body.fileName ||
            `whatsapp-${whatsappMessage.key.id}.${extension}`,
        });
      }

      let sentMessage;
      if (quotedDiscordMessageId) {
        const channel = await discord.channels.fetch(discordChannelId);
        if (!channel?.isTextBased() || !channel.isSendable()) return;

        sentMessage = await channel.send({
          content: `**${senderName}:**${content ? ` ${content}` : ""}`,
          files,
          reply: {
            messageReference: quotedDiscordMessageId,
            failIfNotExists: false,
          },
          allowedMentions: { parse: [], repliedUser: false },
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
