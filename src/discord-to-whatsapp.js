const { StickerFormatType } = require("discord.js");
const sharp = require("sharp");

const MESSAGE_GROUP_WINDOW_MS = 30_000;

function createDiscordMessageHandler({
  discordGuildId,
  discordToWhatsApp,
  getWhatsApp,
  messageMap,
}) {
  const lastSenderByChat = new Map();
  const senderGenerationByChat = new Map();

  async function sendMessage(chatId, discordMessageId, payload, options) {
    const sentMessage = await getWhatsApp().sendMessage(chatId, payload, options);
    messageMap.link(discordMessageId, chatId, sentMessage);
  }

  async function sendSticker(chatId, discordMessageId, url, options) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not download Discord sticker (${response.status})`);
    }

    const input = Buffer.from(await response.arrayBuffer());
    const sticker = await sharp(input, { animated: true })
      .resize(512, 512, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
        withoutEnlargement: true,
      })
      .webp({ quality: 80 })
      .toBuffer();

    await sendMessage(chatId, discordMessageId, { sticker }, options);
  }

  async function handleDiscordMessage(message) {
    if (message.author.bot) return;
    if (message.guildId !== discordGuildId) return;
    if (
      !message.content &&
      message.attachments.size === 0 &&
      message.stickers.size === 0
    )
      return;

    const chatId = discordToWhatsApp.get(message.channelId);
    if (!chatId || !getWhatsApp()) return;

    try {
      const senderGeneration = senderGenerationByChat.get(chatId) || 0;
      const quoted = messageMap.getWhatsAppMessage(message.reference?.messageId);
      const sendOptions = quoted ? { quoted } : undefined;
      const customEmojis = [...message.content.matchAll(/<(a?):(\w+):(\d+)>/g)];
      const content = customEmojis
        .reduce(
          (text, [, , name]) => text.replace(`:${name}:`, ""),
          message.cleanContent
        )
        .trim();
      const previousMessage = lastSenderByChat.get(chatId);
      const senderName = message.member?.displayName || message.author.displayName;
      const showSenderName =
        !previousMessage ||
        previousMessage.senderId !== message.author.id ||
        previousMessage.senderName !== senderName ||
        message.createdTimestamp - previousMessage.timestamp >=
        MESSAGE_GROUP_WINDOW_MS;

      const text = showSenderName
        ? `_*${senderName}*_${content ? `\n${content}` : ""}`
        : content;
      let forwarded = false;

      if (text) {
        await sendMessage(chatId, message.id, { text }, sendOptions);
        forwarded = true;
      }

      for (const [, animated, , id] of customEmojis) {
        const extension = animated ? "gif" : "png";
        try {
          await sendSticker(
            chatId,
            message.id,
            `https://cdn.discordapp.com/emojis/${id}.${extension}?size=512&quality=lossless`,
            sendOptions
          );
          forwarded = true;
        } catch (error) {
          console.error(`Could not forward Discord emoji ${id}:`, error);
        }
      }

      for (const sticker of message.stickers.values()) {
        if (sticker.format === StickerFormatType.Lottie) {
          console.warn(`Cannot forward Lottie Discord sticker: ${sticker.name}`);
          continue;
        }

        try {
          await sendSticker(
            chatId,
            message.id,
            sticker.url,
            sendOptions
          );
          forwarded = true;
        } catch (error) {
          console.error(`Could not forward Discord sticker ${sticker.name}:`, error);
        }
      }

      for (const attachment of message.attachments.values()) {
        const media = { url: attachment.url };
        const mimeType = attachment.contentType || "application/octet-stream";
        let payload;

        if (mimeType.startsWith("image/") && mimeType !== "image/gif") {
          payload = { image: media, mimetype: mimeType };
        } else if (mimeType.startsWith("video/")) {
          payload = { video: media, mimetype: mimeType };
        } else if (mimeType.startsWith("audio/")) {
          payload = { audio: media, mimetype: mimeType, ptt: false };
        } else {
          payload = {
            document: media,
            mimetype: mimeType,
            fileName: attachment.name || "attachment",
          };
        }

        await sendMessage(chatId, message.id, payload, sendOptions);
        forwarded = true;
      }

      const currentMessage = lastSenderByChat.get(chatId);
      if (
        forwarded &&
        (senderGenerationByChat.get(chatId) || 0) === senderGeneration &&
        (!currentMessage || message.createdTimestamp >= currentMessage.timestamp)
      ) {
        lastSenderByChat.set(chatId, {
          senderId: message.author.id,
          senderName,
          timestamp: message.createdTimestamp,
        });
      }
    } catch (error) {
      console.error("Discord -> WhatsApp failed:", error);
    }
  }

  handleDiscordMessage.invalidateSenderContext = (chatId) => {
    lastSenderByChat.delete(chatId);
    senderGenerationByChat.set(
      chatId,
      (senderGenerationByChat.get(chatId) || 0) + 1
    );
  };

  return handleDiscordMessage;
}

module.exports = { createDiscordMessageHandler };
