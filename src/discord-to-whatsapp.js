const { StickerFormatType } = require("discord.js");
const sharp = require("sharp");
const { discordToWhatsAppMarkdown } = require("./helpers/markdown");

const MESSAGE_GROUP_WINDOW_MS = 30_000;

function getCleanContent(message, customEmojis) {
  let cleanContent = message.cleanContent || "";
  for (const [, userId] of (message.content || "").matchAll(/<@!?(\d+)>/g)) {
    const user = message.mentions?.users.get(userId);
    const member =
      message.mentions?.members?.get(userId) ||
      message.guild?.members.cache.get(userId);
    if (user && member && user.displayName !== member.displayName) {
      cleanContent = cleanContent.replace(
        `@${member.displayName}`,
        `@${user.displayName}`
      );
    }
  }
  return customEmojis
    .reduce((text, [, , name]) => text.replace(`:${name}:`, ""), cleanContent)
    .trim();
}

function getUrlMimeType(url) {
  try {
    const extension = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return {
      avif: "image/avif",
      gif: "image/gif",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      mov: "video/quicktime",
      mp4: "video/mp4",
      png: "image/png",
      webm: "video/webm",
      webp: "image/webp",
    }[extension];
  } catch {
    return undefined;
  }
}

function getEmbedMediaPayload(embed) {
  const embedType = embed.data?.type || embed.type;
  const video = embed.video;
  if (video?.url) {
    const url = video.proxyURL || video.proxy_url || video.url;
    const mimetype =
      embed.data?.video?.content_type ||
      video.contentType ||
      video.content_type ||
      getUrlMimeType(video.url);
    if (embedType === "gifv" || mimetype?.startsWith("video/")) {
      return {
        video: { url },
        mimetype: mimetype?.startsWith("video/") ? mimetype : "video/mp4",
        ...(embedType === "gifv" ? { gifPlayback: true } : {}),
      };
    }
  }

  const image = embed.image || embed.thumbnail;
  if (!image?.url) return undefined;

  const url = image.proxyURL || image.proxy_url || image.url;
  const mimetype =
    embed.data?.image?.content_type ||
    embed.data?.thumbnail?.content_type ||
    image.contentType ||
    image.content_type ||
    getUrlMimeType(image.url) ||
    "image/jpeg";
  if (mimetype === "image/gif") {
    return {
      document: { url },
      mimetype,
      fileName: "discord-embed.gif",
    };
  }

  return { image: { url }, mimetype };
}

function createDiscordMessageHandler({
  discordWebhookIds = new Set(),
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
      })
      .webp({ quality: 80 })
      .toBuffer();

    await sendMessage(chatId, discordMessageId, { sticker }, options);
  }

  async function handleDiscordMessage(message) {
    if (
      message.author.id === message.client?.user?.id ||
      discordWebhookIds.has(message.webhookId)
    ) return;
    if (message.guildId !== discordGuildId) return;
    const forwardedMessage = message.messageSnapshots?.values().next().value;
    const sourceMessage = forwardedMessage || message;
    const embedMedia = (sourceMessage.embeds || [])
      .map(getEmbedMediaPayload)
      .filter(Boolean);
    if (
      !sourceMessage.content &&
      embedMedia.length === 0 &&
      sourceMessage.attachments.size === 0 &&
      sourceMessage.stickers.size === 0
    )
      return;

    const chatId = discordToWhatsApp.get(message.channelId);
    if (!chatId || !getWhatsApp()) return;

    try {
      const senderGeneration = senderGenerationByChat.get(chatId) || 0;
      const quoted = forwardedMessage
        ? undefined
        : messageMap.getWhatsAppMessage(message.reference?.messageId);
      const sendOptions = quoted ? { quoted } : undefined;
      const customEmojis = [
        ...(sourceMessage.content || "").matchAll(/<(a?):(\w+):(\d+)>/g),
      ];
      const content = discordToWhatsAppMarkdown(
        getCleanContent(sourceMessage, customEmojis)
      );
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

      for (const sticker of sourceMessage.stickers.values()) {
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

      for (const payload of embedMedia) {
        await sendMessage(chatId, message.id, payload, sendOptions);
        forwarded = true;
      }

      for (const attachment of sourceMessage.attachments.values()) {
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

  async function handleDiscordMessageUpdate(_oldMessage, message) {
    if (message.partial) {
      try {
        message = await message.fetch();
      } catch (error) {
        console.error("Could not fetch edited Discord message:", error);
        return;
      }
    }
    if (
      message.author?.id === message.client?.user?.id ||
      discordWebhookIds.has(message.webhookId) ||
      message.guildId !== discordGuildId
    ) return;

    const whatsappMessage = messageMap.getWhatsAppMessage(message.id);
    const whatsapp = getWhatsApp();
    if (!whatsappMessage || !whatsapp) return;

    const customEmojis = [
      ...(message.content || "").matchAll(/<(a?):(\w+):(\d+)>/g),
    ];
    const content = discordToWhatsAppMarkdown(
      getCleanContent(message, customEmojis)
    );
    const previousText =
      whatsappMessage.message?.conversation ||
      whatsappMessage.message?.extendedTextMessage?.text ||
      "";
    const senderHeader = previousText.match(/^_\*.+\*_(?=\n|$)/)?.[0];
    const text = senderHeader
      ? `${senderHeader}${content ? `\n${content}` : ""}`
      : content;
    if (!text) return;

    try {
      await whatsapp.sendMessage(whatsappMessage.key.remoteJid, {
        text,
        edit: whatsappMessage.key,
      });
    } catch (error) {
      console.error("Discord -> WhatsApp edit failed:", error);
    }
  }

  handleDiscordMessage.invalidateSenderContext = (chatId) => {
    lastSenderByChat.delete(chatId);
    senderGenerationByChat.set(
      chatId,
      (senderGenerationByChat.get(chatId) || 0) + 1
    );
  };
  handleDiscordMessage.handleUpdate = handleDiscordMessageUpdate;

  return handleDiscordMessage;
}

module.exports = { createDiscordMessageHandler };
