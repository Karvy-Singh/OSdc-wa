function createDiscordWebhooks({
  channelIds,
  webhookUrls,
  fallbackUrl,
  createWebhook,
  logger = console,
}) {
  const webhooks = new Map();

  for (const channelId of new Set(channelIds)) {
    const url = webhookUrls.get(channelId) || fallbackUrl;
    if (!url) {
      logger.warn(
        `No Discord webhook configured for channel ${channelId}; ` +
        "WhatsApp -> Discord forwarding is disabled for this pair"
      );
      continue;
    }

    webhooks.set(channelId, createWebhook(url));
  }

  return webhooks;
}

module.exports = { createDiscordWebhooks };
