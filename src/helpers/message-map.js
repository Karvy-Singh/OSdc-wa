const MESSAGE_ID_CACHE_SIZE = 10_000;
const MESSAGE_LINK_TTL_MS = 15 * 60 * 1000;

function createMessageMap({ ttlMs = MESSAGE_LINK_TTL_MS } = {}) {
  const discordToWhatsApp = new Map();
  const whatsappToDiscord = new Map();
  const linkMetadata = new Map();

  function getWhatsAppKey(chatId, messageId) {
    return `${chatId}:${messageId}`;
  }

  function unlinkDiscordMessage(discordMessageId) {
    const entry = discordToWhatsApp.get(discordMessageId);
    const whatsappMessages = entry?.messages || [];
    discordToWhatsApp.delete(discordMessageId);
    if (entry?.timeout) clearTimeout(entry.timeout);

    for (const whatsappMessage of whatsappMessages) {
      const whatsappKey = getWhatsAppKey(
        whatsappMessage.key.remoteJid,
        whatsappMessage.key.id
      );
      if (whatsappToDiscord.get(whatsappKey) === discordMessageId) {
        whatsappToDiscord.delete(whatsappKey);
        linkMetadata.delete(whatsappKey);
      }
    }

    return whatsappMessages;
  }

  return {
    getWhatsAppMessage(discordMessageId) {
      return discordToWhatsApp.get(discordMessageId)?.messages[0];
    },

    getWhatsAppMessages(discordMessageId) {
      return [...(discordToWhatsApp.get(discordMessageId)?.messages || [])];
    },

    getEditableWhatsAppMessage(discordMessageId) {
      return discordToWhatsApp
        .get(discordMessageId)
        ?.messages.find(({ key }) =>
          linkMetadata.get(getWhatsAppKey(key.remoteJid, key.id))?.editable
        );
    },

    getDiscordMessageId(chatId, whatsappMessageId) {
      return whatsappToDiscord.get(
        getWhatsAppKey(chatId, whatsappMessageId)
      );
    },

    getLinkMetadata(chatId, whatsappMessageId) {
      return linkMetadata.get(getWhatsAppKey(chatId, whatsappMessageId));
    },

    link(discordMessageId, chatId, whatsappMessage, metadata = {}) {
      let entry = discordToWhatsApp.get(discordMessageId);
      if (!entry) {
        entry = { messages: [] };
        entry.timeout = setTimeout(
          () => unlinkDiscordMessage(discordMessageId),
          ttlMs
        );
        entry.timeout.unref?.();
        discordToWhatsApp.set(discordMessageId, entry);
      }
      const whatsappMessages = entry.messages;

      const whatsappKey = getWhatsAppKey(chatId, whatsappMessage.key.id);
      const previousDiscordMessageId = whatsappToDiscord.get(whatsappKey);
      if (
        previousDiscordMessageId &&
        previousDiscordMessageId !== discordMessageId
      ) {
        const previousEntry = discordToWhatsApp.get(previousDiscordMessageId);
        const remainingMessages = previousEntry?.messages.filter(
          ({ key }) => getWhatsAppKey(key.remoteJid, key.id) !== whatsappKey
        );
        if (remainingMessages?.length) {
          previousEntry.messages = remainingMessages;
        } else {
          unlinkDiscordMessage(previousDiscordMessageId);
        }
      }

      if (
        !whatsappMessages.some(
          ({ key }) => getWhatsAppKey(key.remoteJid, key.id) === whatsappKey
        )
      ) {
        whatsappMessages.push(whatsappMessage);
      }
      whatsappToDiscord.set(whatsappKey, discordMessageId);
      linkMetadata.set(whatsappKey, metadata);

      if (discordToWhatsApp.size > MESSAGE_ID_CACHE_SIZE) {
        unlinkDiscordMessage(discordToWhatsApp.keys().next().value);
      }
    },

    unlinkDiscordMessage,

    unlinkWhatsAppMessage(chatId, whatsappMessageId) {
      const discordMessageId = whatsappToDiscord.get(
        getWhatsAppKey(chatId, whatsappMessageId)
      );
      if (!discordMessageId) return undefined;

      unlinkDiscordMessage(discordMessageId);
      return discordMessageId;
    },
  };
}

module.exports = { createMessageMap };
