const MESSAGE_ID_CACHE_SIZE = 10_000;

function createMessageMap() {
  const discordToWhatsApp = new Map();
  const whatsappToDiscord = new Map();

  function getWhatsAppKey(chatId, messageId) {
    return `${chatId}:${messageId}`;
  }

  function unlinkDiscordMessage(discordMessageId) {
    const whatsappMessages = discordToWhatsApp.get(discordMessageId) || [];
    discordToWhatsApp.delete(discordMessageId);

    for (const whatsappMessage of whatsappMessages) {
      whatsappToDiscord.delete(
        getWhatsAppKey(
          whatsappMessage.key.remoteJid,
          whatsappMessage.key.id
        )
      );
    }

    return whatsappMessages;
  }

  return {
    getWhatsAppMessage(discordMessageId) {
      return discordToWhatsApp.get(discordMessageId)?.[0];
    },

    getWhatsAppMessages(discordMessageId) {
      return [...(discordToWhatsApp.get(discordMessageId) || [])];
    },

    getDiscordMessageId(chatId, whatsappMessageId) {
      return whatsappToDiscord.get(
        getWhatsAppKey(chatId, whatsappMessageId)
      );
    },

    link(discordMessageId, chatId, whatsappMessage) {
      let whatsappMessages = discordToWhatsApp.get(discordMessageId);
      if (!whatsappMessages) {
        whatsappMessages = [];
        discordToWhatsApp.set(discordMessageId, whatsappMessages);
      }

      const whatsappKey = getWhatsAppKey(chatId, whatsappMessage.key.id);
      if (!whatsappMessages.some(({ key }) => key.id === whatsappMessage.key.id)) {
        whatsappMessages.push(whatsappMessage);
      }
      whatsappToDiscord.set(whatsappKey, discordMessageId);

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
