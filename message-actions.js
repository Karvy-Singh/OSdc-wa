const REACTION_SUPPRESSION_MS = 30_000;

function createMessageActionHandlers({
  baileys,
  discord,
  discordGuildId,
  getWhatsApp,
  messageMap,
  whatsappToDiscord,
}) {
  const suppressedWhatsAppReactions = new Map();
  const forwardedDiscordReactions = new Map();
  const whatsappReactions = new Map();

  function getWhatsAppKey(chatId, messageId) {
    return `${chatId}:${messageId}`;
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
    handleDiscordMessageDelete,
    handleDiscordReactionAdd: createDiscordReactionHandler(),
    handleDiscordReactionRemove: createDiscordReactionHandler(true),
    handleWhatsAppMessageUpdates,
    handleWhatsAppReactions,
  };
}

module.exports = { createMessageActionHandlers };
