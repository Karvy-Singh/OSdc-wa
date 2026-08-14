const MESSAGE_ID_CACHE_SIZE = 10_000;

function createMessageMap() {
  const discordToWhatsApp = new Map();
  const whatsappToDiscord = new Map();

  function cache(map, key, value) {
    map.set(key, value);
    if (map.size > MESSAGE_ID_CACHE_SIZE) {
      map.delete(map.keys().next().value);
    }
  }

  function getWhatsAppKey(chatId, messageId) {
    return `${chatId}:${messageId}`;
  }

  return {
    getWhatsAppMessage(discordMessageId) {
      return discordToWhatsApp.get(discordMessageId);
    },

    getDiscordMessageId(chatId, whatsappMessageId) {
      return whatsappToDiscord.get(
        getWhatsAppKey(chatId, whatsappMessageId)
      );
    },

    link(discordMessageId, chatId, whatsappMessage) {
      if (!discordToWhatsApp.has(discordMessageId)) {
        cache(discordToWhatsApp, discordMessageId, whatsappMessage);
      }
      cache(
        whatsappToDiscord,
        getWhatsAppKey(chatId, whatsappMessage.key.id),
        discordMessageId
      );
    },
  };
}

module.exports = { createMessageMap };
