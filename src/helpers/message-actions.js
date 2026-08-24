const REACTION_SUPPRESSION_MS = 30_000;
const PIN_SUPPRESSION_MS = 30_000;
const WHATSAPP_PIN_DURATION_SECONDS = 2_592_000;

function createMessageActionHandlers({
  baileys,
  discord,
  discordGuildId,
  getWhatsApp,
  messageMap,
  webhook,
  whatsappToDiscord,
}) {
  const suppressedWhatsAppReactions = new Map();
  const forwardedDiscordReactions = new Map();
  const whatsappReactions = new Map();
  const discordPinnedMessages = new Map();
  const suppressedDiscordPins = new Map();
  const suppressedWhatsAppPins = new Map();
  const discordToWhatsApp = new Map(
    [...whatsappToDiscord].map(([chatId, channelId]) => [channelId, chatId])
  );

  function getWhatsAppKey(chatId, messageId) {
    return `${chatId}:${messageId}`;
  }

  function getPinKey(containerId, messageId, isPinned) {
    return `${containerId}:${messageId}:${isPinned}`;
  }

  function suppressPin(suppressions, key) {
    suppressions.set(key, Date.now() + PIN_SUPPRESSION_MS);
  }

  function consumeSuppressedPin(suppressions, key) {
    const expiresAt = suppressions.get(key);
    suppressions.delete(key);
    return Boolean(expiresAt && expiresAt > Date.now());
  }

  function suppressWhatsAppReaction(chatId, messageId, text) {
    const key = getWhatsAppKey(chatId, messageId);
    const pending = suppressedWhatsAppReactions.get(key) || [];
    pending.push({ text, expiresAt: Date.now() + REACTION_SUPPRESSION_MS });
    suppressedWhatsAppReactions.set(key, pending);
  }

  function consumeSuppressedWhatsAppReaction(chatId, messageId, text) {
    const key = getWhatsAppKey(chatId, messageId);
    const now = Date.now();
    const pending = (suppressedWhatsAppReactions.get(key) || []).filter(
      ({ expiresAt }) => expiresAt > now
    );
    const index = pending.findIndex((reaction) => reaction.text === text);

    if (index === -1) {
      if (pending.length) suppressedWhatsAppReactions.set(key, pending);
      else suppressedWhatsAppReactions.delete(key);
      return false;
    }

    pending.splice(index, 1);
    if (pending.length) suppressedWhatsAppReactions.set(key, pending);
    else suppressedWhatsAppReactions.delete(key);
    return true;
  }

  async function fetchDiscordMessage(chatId, discordMessageId) {
    const channelId = whatsappToDiscord.get(chatId);
    if (!channelId) return undefined;

    const channel = await discord.channels.fetch(channelId);
    if (!channel?.isTextBased() || !channel.messages) return undefined;
    return channel.messages.fetch(discordMessageId);
  }

  async function initializeDiscordPins() {
    for (const channelId of new Set(whatsappToDiscord.values())) {
      try {
        const channel = await discord.channels.fetch(channelId);
        if (!channel?.isTextBased() || !channel.messages?.fetchPinned) continue;
        const pinned = await channel.messages.fetchPinned();
        discordPinnedMessages.set(channelId, new Set(pinned.keys()));
      } catch (error) {
        console.error("Could not initialize Discord pins:", error);
      }
    }
  }

  async function forwardDiscordPin(chatId, discordMessageId, isPinned) {
    const whatsapp = getWhatsApp();
    if (!whatsapp) return;

    const whatsappMessages = messageMap
      .getWhatsAppMessages(discordMessageId)
      .filter(({ key }) => key.remoteJid === chatId);
    for (const whatsappMessage of whatsappMessages) {
      const suppressionKey = getPinKey(
        chatId,
        whatsappMessage.key.id,
        isPinned
      );
      suppressPin(suppressedWhatsAppPins, suppressionKey);
      try {
        await whatsapp.sendMessage(chatId, isPinned
          ? {
            pin: whatsappMessage.key,
            type: 1,
            time: WHATSAPP_PIN_DURATION_SECONDS,
          }
          : { pin: whatsappMessage.key, type: 2 });
      } catch (error) {
        consumeSuppressedPin(suppressedWhatsAppPins, suppressionKey);
        console.error("Discord -> WhatsApp pin failed:", error);
      }
    }
  }

  async function handleDiscordPinsUpdate(channel) {
    const chatId = discordToWhatsApp.get(channel.id);
    if (!chatId || !channel.messages?.fetchPinned) return;

    try {
      const pinned = await channel.messages.fetchPinned();
      const current = new Set(pinned.keys());
      const previous = discordPinnedMessages.get(channel.id);
      discordPinnedMessages.set(channel.id, current);
      if (!previous) return;

      for (const discordMessageId of new Set([...previous, ...current])) {
        const wasPinned = previous.has(discordMessageId);
        const isPinned = current.has(discordMessageId);
        if (wasPinned === isPinned) continue;

        const suppressionKey = getPinKey(
          channel.id,
          discordMessageId,
          isPinned
        );
        if (consumeSuppressedPin(suppressedDiscordPins, suppressionKey)) {
          continue;
        }
        await forwardDiscordPin(chatId, discordMessageId, isPinned);
      }
    } catch (error) {
      console.error("Discord -> WhatsApp pin sync failed:", error);
    }
  }

  async function handleWhatsAppPin(whatsappMessage) {
    const content = baileys.normalizeMessageContent(whatsappMessage.message);
    const pin = content?.pinInChatMessage;
    if (!pin) return false;

    const chatId = pin.key?.remoteJid || whatsappMessage.key.remoteJid;
    const whatsappMessageId = pin.key?.id;
    const isPinned = pin.type === 1;
    if (!chatId || !whatsappMessageId || (!isPinned && pin.type !== 2)) {
      return true;
    }

    const whatsappSuppressionKey = getPinKey(
      chatId,
      whatsappMessageId,
      isPinned
    );
    if (
      whatsappMessage.key.fromMe &&
      consumeSuppressedPin(suppressedWhatsAppPins, whatsappSuppressionKey)
    ) {
      return true;
    }

    const discordMessageId = messageMap.getDiscordMessageId(
      chatId,
      whatsappMessageId
    );
    if (!discordMessageId) return true;

    const channelId = whatsappToDiscord.get(chatId);
    const discordSuppressionKey = getPinKey(
      channelId,
      discordMessageId,
      isPinned
    );
    suppressPin(suppressedDiscordPins, discordSuppressionKey);
    try {
      const message = await fetchDiscordMessage(chatId, discordMessageId);
      if (!message) {
        consumeSuppressedPin(suppressedDiscordPins, discordSuppressionKey);
        return true;
      }
      if (isPinned) await message.pin("Mirrored WhatsApp pin");
      else await message.unpin("Mirrored WhatsApp unpin");
    } catch (error) {
      consumeSuppressedPin(suppressedDiscordPins, discordSuppressionKey);
      console.error("WhatsApp -> Discord pin failed:", error);
    }
    return true;
  }

  async function removeDiscordReaction(message, emoji) {
    const reaction = [...message.reactions.cache.values()].find(
      ({ emoji: discordEmoji }) =>
        !discordEmoji.id && discordEmoji.name === emoji
    );
    if (reaction && discord.user) {
      await reaction.users.remove(discord.user.id);
    }
  }

  async function handleDiscordMessageDelete(message) {
    if (message.guildId !== discordGuildId) return;

    const whatsappMessages = messageMap.getWhatsAppMessages(message.id);
    const whatsapp = getWhatsApp();
    if (!whatsappMessages.length || !whatsapp) return;
    messageMap.unlinkDiscordMessage(message.id);

    for (const whatsappMessage of whatsappMessages) {
      try {
        await whatsapp.sendMessage(whatsappMessage.key.remoteJid, {
          delete: whatsappMessage.key,
        });
      } catch (error) {
        console.error("Discord -> WhatsApp delete failed:", error);
      }
    }
  }

  function createDiscordReactionHandler(isRemoval = false) {
    return async function handleDiscordReaction(reaction, user) {
      if (user.bot || reaction.message.guildId !== discordGuildId) return;
      if (reaction.emoji.id) {
        console.warn("Cannot forward custom Discord emoji reactions to WhatsApp");
        return;
      }

      const whatsappMessage = messageMap.getWhatsAppMessage(
        reaction.message.id
      );
      const whatsapp = getWhatsApp();
      if (!whatsappMessage || !whatsapp) return;

      const stateKey = getWhatsAppKey(
        whatsappMessage.key.remoteJid,
        whatsappMessage.key.id
      );
      const emoji = reaction.emoji.name;
      const previousForwarded = forwardedDiscordReactions.get(stateKey);
      if (isRemoval) {
        if (
          previousForwarded?.userId !== user.id ||
          previousForwarded.emoji !== emoji
        ) {
          return;
        }
        forwardedDiscordReactions.delete(stateKey);
      } else {
        forwardedDiscordReactions.set(stateKey, { userId: user.id, emoji });
      }

      const whatsappText = isRemoval ? "" : emoji;
      suppressWhatsAppReaction(
        whatsappMessage.key.remoteJid,
        whatsappMessage.key.id,
        whatsappText
      );

      try {
        await whatsapp.sendMessage(whatsappMessage.key.remoteJid, {
          react: { text: whatsappText, key: whatsappMessage.key },
        });
      } catch (error) {
        if (previousForwarded) {
          forwardedDiscordReactions.set(stateKey, previousForwarded);
        } else {
          forwardedDiscordReactions.delete(stateKey);
        }
        consumeSuppressedWhatsAppReaction(
          whatsappMessage.key.remoteJid,
          whatsappMessage.key.id,
          whatsappText
        );
        console.error("Discord -> WhatsApp reaction failed:", error);
      }
    };
  }

  async function handleWhatsAppMessageUpdates(updates) {
    for (const { key, update } of updates) {
      const editedContent = update.message?.editedMessage?.message;
      if (editedContent && !key.fromMe && key.remoteJid && key.id) {
        const discordMessageId = messageMap.getDiscordMessageId(
          key.remoteJid,
          key.id
        );
        const message = baileys.normalizeMessageContent(editedContent);
        const type = baileys.getContentType(message);
        const body = message?.[type];
        const content =
          message?.conversation ||
          body?.text ||
          body?.caption ||
          body?.selectedDisplayText ||
          body?.title ||
          "";

        if (discordMessageId && content) {
          try {
            await webhook.editMessage(discordMessageId, {
              content,
              allowedMentions: { parse: [] },
            });
          } catch (webhookError) {
            try {
              const discordMessage = await fetchDiscordMessage(
                key.remoteJid,
                discordMessageId
              );
              if (!discordMessage || discordMessage.webhookId) {
                throw webhookError;
              }
              await discordMessage.edit({
                embeds: [{
                  author: discordMessage.embeds[0]?.author,
                  description: content,
                }],
              });
            } catch (error) {
              console.error("WhatsApp -> Discord edit failed:", error);
            }
          }
        }
        continue;
      }

      if (
        update.messageStubType !== baileys.WAMessageStubType.REVOKE ||
        !key.remoteJid ||
        !key.id
      ) {
        continue;
      }

      const discordMessageId = messageMap.unlinkWhatsAppMessage(
        key.remoteJid,
        key.id
      );
      if (!discordMessageId) continue;

      try {
        const message = await fetchDiscordMessage(
          key.remoteJid,
          discordMessageId
        );
        await message?.delete();
      } catch (error) {
        console.error("WhatsApp -> Discord delete failed:", error);
      }
    }
  }

  async function handleWhatsAppReactions(reactions) {
    for (const { key, reaction } of reactions) {
      if (!key.remoteJid || !key.id) continue;

      const text = reaction.text || "";
      if (
        reaction.key?.fromMe &&
        consumeSuppressedWhatsAppReaction(key.remoteJid, key.id, text)
      ) {
        continue;
      }

      const discordMessageId = messageMap.getDiscordMessageId(
        key.remoteJid,
        key.id
      );
      if (!discordMessageId) continue;

      const stateKey = getWhatsAppKey(key.remoteJid, key.id);
      const reactionsBySender = whatsappReactions.get(stateKey) || new Map();
      const senderId =
        reaction.key?.participantAlt ||
        reaction.key?.participant ||
        reaction.key?.remoteJidAlt ||
        reaction.key?.remoteJid ||
        "unknown";
      const previousText = reactionsBySender.get(senderId);

      try {
        const message = await fetchDiscordMessage(
          key.remoteJid,
          discordMessageId
        );
        if (!message) continue;

        if (text && previousText && previousText !== text) {
          reactionsBySender.delete(senderId);
          if (![...reactionsBySender.values()].includes(previousText)) {
            await removeDiscordReaction(message, previousText);
          }
        }

        if (text) {
          reactionsBySender.set(senderId, text);
          whatsappReactions.set(stateKey, reactionsBySender);
          await message.react(text);
        } else if (previousText) {
          reactionsBySender.delete(senderId);
          if (reactionsBySender.size) {
            whatsappReactions.set(stateKey, reactionsBySender);
          } else {
            whatsappReactions.delete(stateKey);
          }
          if (![...reactionsBySender.values()].includes(previousText)) {
            await removeDiscordReaction(message, previousText);
          }
        }
      } catch (error) {
        console.error("WhatsApp -> Discord reaction failed:", error);
      }
    }
  }

  return {
    handleDiscordPinsUpdate,
    handleDiscordMessageDelete,
    handleDiscordReactionAdd: createDiscordReactionHandler(),
    handleDiscordReactionRemove: createDiscordReactionHandler(true),
    handleWhatsAppMessageUpdates,
    handleWhatsAppPin,
    handleWhatsAppReactions,
    initializeDiscordPins,
  };
}

module.exports = { createMessageActionHandlers };
