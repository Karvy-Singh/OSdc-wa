const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { createWhatsAppMessageHandler } = require("../src/whatsapp-to-discord");

function createHarness() {
  const webhookCalls = [];
  const channelCalls = [];
  const links = [];
  const downloads = [];
  const invalidatedChats = [];
  const channel = {
    isTextBased: () => true,
    isSendable: () => true,
    async send(payload) {
      channelCalls.push(payload);
      return { id: `channel-${channelCalls.length}` };
    },
  };
  const baileys = {
    DEF_MEDIA_HOST: "mmg.whatsapp.net",
    normalizeMessageContent: (message) => message,
    getContentType(message) {
      return Object.keys(message || {})[0];
    },
    async downloadMediaMessage(...args) {
      downloads.push(args);
      return Buffer.from("media");
    },
  };
  const messageMap = {
    getDiscordMessageId(chatId, id) {
      return chatId === "chat-a" && id === "quoted-wa" ? "quoted-discord" : undefined;
    },
    link(...args) {
      links.push(args);
    },
  };
  const handler = createWhatsAppMessageHandler({
    baileys,
    discord: { channels: { fetch: async () => channel } },
    webhook: {
      async send(payload) {
        webhookCalls.push(payload);
        return { id: `webhook-${webhookCalls.length}` };
      },
    },
    whatsapp: { profilePictureUrl: async () => "https://example.test/avatar.png" },
    whatsappToDiscord: new Map([["chat-a", "channel-a"]]),
    messageMap,
    invalidateDiscordSenderContext: (chatId) => invalidatedChats.push(chatId),
  });
  return { channelCalls, downloads, handler, invalidatedChats, links, webhookCalls };
}

function whatsappMessage(message, overrides = {}) {
  return {
    pushName: "Alice",
    messageTimestamp: 1700000000,
    message,
    ...overrides,
    key: {
      id: "wa-1",
      remoteJid: "chat-a",
      participant: "alice@s.whatsapp.net",
      fromMe: false,
      ...overrides.key,
    },
  };
}

test("only manual own messages invalidate context among ignored messages", async () => {
  const { handler, invalidatedChats, links, webhookCalls } = createHarness();
  await handler(whatsappMessage({ conversation: "own" }, { key: { fromMe: true } }));
  await handler(whatsappMessage({ conversation: "bridge output" }, { key: { fromMe: true, id: "quoted-wa" } }));
  await handler(whatsappMessage({ conversation: "other" }, { key: { remoteJid: "other" } }));
  await handler(whatsappMessage({ reactionMessage: { text: "👍" } }));
  await handler(whatsappMessage({ extendedTextMessage: {} }));
  await handler(whatsappMessage({ locationMessage: { degreesLatitude: 1 } }));

  assert.equal(webhookCalls.length, 0);
  assert.equal(links.length, 0);
  assert.deepEqual(invalidatedChats, ["chat-a"]);
});

test("forwards converted text through the webhook with sender identity and safe mentions", async () => {
  const { handler, invalidatedChats, links, webhookCalls } = createHarness();
  const incoming = whatsappMessage({ conversation: "hello *everyone* @everyone" });

  await handler(incoming);

  assert.deepEqual(webhookCalls, [{
    username: "Alice",
    avatarURL: "https://example.test/avatar.png",
    content: "hello **everyone** @everyone",
    files: [],
    allowedMentions: { parse: [] },
  }]);
  assert.deepEqual(links[0], ["webhook-1", "chat-a", incoming]);
  assert.deepEqual(invalidatedChats, ["chat-a"]);
});

test("shows WhatsApp mentions using observed push names", async () => {
  const { handler, webhookCalls } = createHarness();
  await handler(whatsappMessage(
    { conversation: "first message" },
    {
      pushName: "Karvy",
      key: { participant: "105252938350827@lid" },
    }
  ));

  await handler(whatsappMessage({
    extendedTextMessage: {
      text: "hello @105252938350827",
      contextInfo: { mentionedJid: ["105252938350827@lid"] },
    },
  }));

  assert.equal(webhookCalls[1].content, "hello @Karvy");
  assert.deepEqual(webhookCalls[1].allowedMentions, { parse: [] });
});

test("sends mapped replies through the channel with an embed and reply reference", async () => {
  const { channelCalls, handler, webhookCalls } = createHarness();
  await handler(whatsappMessage({
    extendedTextMessage: {
      text: "reply *text*\nsecond line",
      contextInfo: { stanzaId: "quoted-wa" },
    },
  }));

  assert.equal(webhookCalls.length, 0);
  assert.deepEqual(channelCalls, [{
    embeds: [{
      color: 0x25d366,
      author: { name: "Alice", icon_url: "https://example.test/avatar.png" },
      description: "reply **text**\nsecond line",
      footer: { text: "Reply from WhatsApp" },
      timestamp: "2023-11-14T22:13:20.000Z",
    }],
    files: [],
    reply: { messageReference: "quoted-discord", failIfNotExists: false },
  }]);
});

test("downloads media and preserves its filename and MIME type", async () => {
  const { downloads, handler, webhookCalls } = createHarness();
  const incoming = whatsappMessage({
    documentMessage: {
      caption: "document caption",
      mimetype: "application/pdf; charset=binary",
      fileName: "report.pdf",
    },
  });

  await handler(incoming);

  assert.equal(downloads.length, 1);
  assert.equal(downloads[0][0], incoming);
  assert.deepEqual(downloads[0].slice(1), ["buffer", {}]);
  assert.deepEqual(webhookCalls[0].files, [{
    attachment: Buffer.from("media"),
    contentType: "application/pdf",
    name: "report.pdf",
  }]);
});

test("forwards images using the media URL host", async () => {
  const { downloads, handler, webhookCalls } = createHarness();
  const incoming = whatsappMessage({
    imageMessage: {
      mimetype: "image/jpeg",
      url: "https://media.example.test/image.enc",
    },
  });

  await handler(incoming);

  assert.deepEqual(downloads[0], [incoming, "buffer", {}]);
  assert.equal(webhookCalls[0].files[0].contentType, "image/jpeg");
  assert.equal(webhookCalls[0].files[0].name, "whatsapp-wa-1.jpeg");
});

test("replaces the unresolvable a.whatsapp.net media alias", async () => {
  const { downloads, handler } = createHarness();
  const incoming = whatsappMessage({
    imageMessage: {
      mimetype: "image/jpeg",
      url: "https://a.whatsapp.net/image.enc?token=abc",
      directPath: "/image.enc",
    },
  });

  await handler(incoming);

  assert.equal(
    downloads[0][0].message.imageMessage.url,
    "https://mmg.whatsapp.net/image.enc?token=abc"
  );
  assert.deepEqual(downloads[0].slice(1), [
    "buffer",
    { host: "mmg.whatsapp.net" },
  ]);
});

test("forwards WhatsApp video notes", async () => {
  const { downloads, handler, webhookCalls } = createHarness();
  const incoming = whatsappMessage({
    ptvMessage: { mimetype: "video/mp4" },
  });

  await handler(incoming);

  assert.deepEqual(downloads[0], [incoming, "buffer", {}]);
  assert.equal(webhookCalls[0].files[0].contentType, "video/mp4");
  assert.equal(webhookCalls[0].files[0].name, "whatsapp-wa-1.mp4");
});

test("continues without an avatar when profile lookup fails", async () => {
  const harness = createHarness();
  const handler = createWhatsAppMessageHandler({
    baileys: {
      DEF_MEDIA_HOST: "host",
      normalizeMessageContent: (message) => message,
      getContentType: () => "conversation",
    },
    discord: { channels: { fetch: async () => undefined } },
    webhook: { send: async (payload) => {
      harness.webhookCalls.push(payload);
      return { id: "sent" };
    } },
    whatsapp: { profilePictureUrl: async () => { throw new Error("private"); } },
    whatsappToDiscord: new Map([["chat-a", "channel-a"]]),
    messageMap: { getDiscordMessageId: () => undefined, link: () => {} },
  });

  await handler(whatsappMessage({ conversation: "hello" }));
  assert.equal(harness.webhookCalls[0].avatarURL, undefined);
});

test("converts a static WhatsApp WebP sticker to a Discord PNG", async () => {
  const harness = createHarness();
  const webp = await sharp({
    create: { width: 8, height: 8, channels: 4, background: "#0000ff80" },
  }).webp().toBuffer();
  harness.handler = createWhatsAppMessageHandler({
    baileys: {
      DEF_MEDIA_HOST: "host",
      normalizeMessageContent: (message) => message,
      getContentType: () => "stickerMessage",
      downloadMediaMessage: async () => webp,
    },
    discord: { channels: { fetch: async () => undefined } },
    webhook: { send: async (payload) => {
      harness.webhookCalls.push(payload);
      return { id: "sent" };
    } },
    whatsapp: { profilePictureUrl: async () => undefined },
    whatsappToDiscord: new Map([["chat-a", "channel-a"]]),
    messageMap: { getDiscordMessageId: () => undefined, link: () => {} },
  });

  await harness.handler(whatsappMessage({
    stickerMessage: { mimetype: "image/webp", isAnimated: false },
  }));

  const [file] = harness.webhookCalls[0].files;
  assert.equal(file.contentType, "image/png");
  assert.equal(file.name, "whatsapp-wa-1.png");
  assert.equal((await sharp(file.attachment).metadata()).format, "png");
});

test("uses the thumbnail when a WhatsApp Lottie sticker cannot render", async () => {
  const harness = createHarness();
  const thumbnail = await sharp({
    create: { width: 2, height: 2, channels: 4, background: "#ffffff" },
  }).png().toBuffer();
  const baileys = {
    DEF_MEDIA_HOST: "host",
    normalizeMessageContent: (message) => message,
    getContentType: () => "stickerMessage",
    downloadMediaMessage: async () => Buffer.from("invalid lottie"),
  };
  const handler = createWhatsAppMessageHandler({
    baileys,
    discord: { channels: { fetch: async () => undefined } },
    webhook: { send: async (payload) => {
      harness.webhookCalls.push(payload);
      return { id: "sent" };
    } },
    whatsapp: { profilePictureUrl: async () => undefined },
    whatsappToDiscord: new Map([["chat-a", "channel-a"]]),
    messageMap: { getDiscordMessageId: () => undefined, link: () => {} },
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await handler(whatsappMessage({
      stickerMessage: {
        mimetype: "application/was",
        isLottie: true,
        pngThumbnail: thumbnail,
      },
    }));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(harness.webhookCalls[0].files, [{
    attachment: thumbnail,
    contentType: "image/png",
    name: "whatsapp-wa-1.png",
  }]);
});
