const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { createDiscordMessageHandler } = require("../src/discord-to-whatsapp");

function createHarness(overrides = {}) {
  const calls = [];
  const links = [];
  const quoted = { key: { remoteJid: "chat-a", id: "quoted-wa" } };
  const whatsapp = {
    async sendMessage(chatId, payload, options) {
      calls.push({ chatId, payload, options });
      return {
        key: { remoteJid: chatId, id: `sent-${calls.length}` },
        message: payload.text
          ? { extendedTextMessage: { text: payload.text } }
          : undefined,
      };
    },
  };
  const messageMap = {
    getWhatsAppMessage(id) {
      return id === "reply-target" ? quoted : undefined;
    },
    link(...args) {
      links.push(args);
    },
  };
  const handler = createDiscordMessageHandler({
    discordGuildId: "guild-a",
    discordToWhatsApp: new Map([["channel-a", "chat-a"]]),
    getWhatsApp: () => whatsapp,
    messageMap,
    ...overrides,
  });
  return { calls, handler, links, quoted, whatsapp };
}

function discordMessage(overrides = {}) {
  return {
    id: "discord-1",
    author: { id: "user-a", bot: false, displayName: "Fallback" },
    member: { displayName: "Alice" },
    guildId: "guild-a",
    channelId: "channel-a",
    content: "hello",
    cleanContent: "hello",
    createdTimestamp: 1_000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
    ...overrides,
  };
}

test("ignores bots, other guilds, empty messages, unmapped channels, and disconnects", async () => {
  const { calls, handler } = createHarness();
  await handler(discordMessage({ author: { id: "bot", bot: true } }));
  await handler(discordMessage({ guildId: "other" }));
  await handler(discordMessage({ content: "", cleanContent: "" }));
  await handler(discordMessage({ channelId: "other" }));

  const disconnected = createHarness({ getWhatsApp: () => undefined });
  await disconnected.handler(discordMessage());

  assert.equal(calls.length, 0);
  assert.equal(disconnected.calls.length, 0);
});

test("forwards text with sender grouping and records each sent message", async () => {
  const { calls, handler, links } = createHarness();

  await handler(discordMessage());
  await handler(discordMessage({ id: "discord-2", content: "again", cleanContent: "again", createdTimestamp: 30_999 }));
  await handler(discordMessage({ id: "discord-3", content: "later", cleanContent: "later", createdTimestamp: 31_000 }));

  assert.deepEqual(calls.map(({ payload }) => payload), [
    { text: "_*Alice*_\nhello" },
    { text: "again" },
    { text: "later" },
  ]);
  assert.deepEqual(links.map(([discordId, chatId]) => [discordId, chatId]), [
    ["discord-1", "chat-a"],
    ["discord-2", "chat-a"],
    ["discord-3", "chat-a"],
  ]);
  assert.equal(links[0].length, 3);
  assert.equal(links[1].length, 3);
});

test("forwards Discord edits to the mapped WhatsApp message", async () => {
  const mapped = {
    key: { remoteJid: "chat-a", id: "wa-text" },
    message: { extendedTextMessage: { text: "_*Alice*_\nhello" } },
  };
  const { calls, handler } = createHarness({
    messageMap: {
      getWhatsAppMessage: () => mapped,
      link: () => {},
    },
  });

  await handler.handleUpdate(null, discordMessage({
    cleanContent: "edited text",
    content: "edited text",
  }));

  assert.deepEqual(calls, [{
    chatId: "chat-a",
    payload: {
      text: "_*Alice*_\nedited text",
      edit: mapped.key,
    },
    options: undefined,
  }]);
});

test("uses the Discord user display name for mentions on WhatsApp", async () => {
  const { calls, handler } = createHarness();
  const mentionedUser = { id: "123456789012345678", displayName: "Global Name" };
  const mentionedMember = { displayName: "Server Nickname" };

  await handler(discordMessage({
    content: "hello <@123456789012345678>",
    cleanContent: "hello @Server Nickname",
    mentions: {
      users: new Map([[mentionedUser.id, mentionedUser]]),
      members: new Map([[mentionedUser.id, mentionedMember]]),
    },
  }));

  assert.equal(calls[0].payload.text, "_*Alice*_\nhello @Global Name");
});

test("starts a new sender group after 30 seconds or a sender change", async () => {
  const { calls, handler } = createHarness();
  await handler(discordMessage());
  await handler(discordMessage({ id: "discord-2", content: "late", cleanContent: "late", createdTimestamp: 31_000 }));
  await handler(discordMessage({
    id: "discord-3",
    author: { id: "user-b", bot: false, displayName: "Bob" },
    member: null,
    content: "hi",
    cleanContent: "hi",
    createdTimestamp: 31_002,
  }));

  assert.deepEqual(calls.map(({ payload }) => payload.text), [
    "_*Alice*_\nhello",
    "_*Alice*_\nlate",
    "_*Bob*_\nhi",
  ]);
});

test("starts a new sender group after WhatsApp activity or a display-name change", async () => {
  const { calls, handler } = createHarness();
  await handler(discordMessage());
  handler.invalidateSenderContext("chat-a");
  await handler(discordMessage({ id: "discord-2", content: "after WA", cleanContent: "after WA", createdTimestamp: 2_000 }));
  await handler(discordMessage({
    id: "discord-3",
    content: "renamed",
    cleanContent: "renamed",
    createdTimestamp: 3_000,
    member: { displayName: "Alicia" },
  }));

  assert.deepEqual(calls.map(({ payload }) => payload.text), [
    "_*Alice*_\nhello",
    "_*Alice*_\nafter WA",
    "_*Alicia*_\nrenamed",
  ]);
});

test("does not retain sender context when delivery fails", async () => {
  const calls = [];
  let attempt = 0;
  const whatsapp = {
    async sendMessage(chatId, payload) {
      calls.push({ chatId, payload });
      attempt += 1;
      if (attempt === 1) throw new Error("offline");
      return { key: { remoteJid: chatId, id: "sent" } };
    },
  };
  const { handler } = createHarness({ getWhatsApp: () => whatsapp });
  const originalError = console.error;
  console.error = () => {};
  try {
    await handler(discordMessage());
    await handler(discordMessage({ id: "discord-2", content: "retry", cleanContent: "retry", createdTimestamp: 2_000 }));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(calls.map(({ payload }) => payload.text), [
    "_*Alice*_\nhello",
    "_*Alice*_\nretry",
  ]);
});

test("an in-flight Discord delivery cannot restore invalidated context", async () => {
  const calls = [];
  let releaseFirstSend;
  const firstSend = new Promise((resolve) => {
    releaseFirstSend = resolve;
  });
  const whatsapp = {
    async sendMessage(chatId, payload) {
      calls.push({ chatId, payload });
      if (calls.length === 1) await firstSend;
      return { key: { remoteJid: chatId, id: `sent-${calls.length}` } };
    },
  };
  const { handler } = createHarness({ getWhatsApp: () => whatsapp });

  const pending = handler(discordMessage());
  await Promise.resolve();
  handler.invalidateSenderContext("chat-a");
  releaseFirstSend();
  await pending;
  await handler(discordMessage({ id: "discord-2", content: "after WA", cleanContent: "after WA", createdTimestamp: 2_000 }));

  assert.deepEqual(calls.map(({ payload }) => payload.text), [
    "_*Alice*_\nhello",
    "_*Alice*_\nafter WA",
  ]);
});

test("quotes the mapped WhatsApp message when forwarding a Discord reply", async () => {
  const { calls, handler, quoted } = createHarness();
  await handler(discordMessage({ reference: { messageId: "reply-target" } }));
  assert.deepEqual(calls[0].options, { quoted });
});

test("forwards Discord message snapshots as new WhatsApp messages", async () => {
  const { calls, handler } = createHarness();
  await handler(discordMessage({
    content: "",
    cleanContent: "",
    reference: { messageId: "reply-target" },
    messageSnapshots: new Map([["source", {
      content: "forwarded text",
      cleanContent: "forwarded text",
      attachments: new Map([["image", {
        url: "https://example.test/forwarded.png",
        contentType: "image/png",
        name: "forwarded.png",
      }]]),
      embeds: [{
        data: { type: "gifv", video: { content_type: "video/mp4" } },
        video: { url: "https://example.test/forwarded.mp4" },
      }],
      stickers: new Map(),
    }]]),
  }));

  assert.deepEqual(calls, [
    {
      chatId: "chat-a",
      payload: { text: "_*Alice*_\nforwarded text" },
      options: undefined,
    },
    {
      chatId: "chat-a",
      payload: {
        video: { url: "https://example.test/forwarded.mp4" },
        mimetype: "video/mp4",
        gifPlayback: true,
      },
      options: undefined,
    },
    {
      chatId: "chat-a",
      payload: {
        image: { url: "https://example.test/forwarded.png" },
        mimetype: "image/png",
      },
      options: undefined,
    },
  ]);
});

test("forwards Discord embed media in addition to its link", async () => {
  const { calls, handler } = createHarness();
  await handler(discordMessage({
    content: "https://tenor.example/animation",
    cleanContent: "https://tenor.example/animation",
    embeds: [
      {
        data: { type: "gifv", video: { content_type: "video/mp4" } },
        video: {
          url: "https://media.example/animation.mp4",
          proxyURL: "https://proxy.example/animation.mp4",
        },
      },
      {
        data: { image: { content_type: "image/png" } },
        image: {
          url: "https://media.example/image.png",
          proxyURL: "https://proxy.example/image.png",
        },
      },
      {
        data: { image: { content_type: "image/gif" } },
        image: {
          url: "https://media.example/fallback.gif",
          proxyURL: "https://proxy.example/fallback.gif",
        },
      },
    ],
  }));

  assert.deepEqual(calls.map(({ payload }) => payload), [
    { text: "_*Alice*_\nhttps://tenor.example/animation" },
    {
      video: { url: "https://proxy.example/animation.mp4" },
      mimetype: "video/mp4",
      gifPlayback: true,
    },
    {
      image: { url: "https://proxy.example/image.png" },
      mimetype: "image/png",
    },
    {
      document: { url: "https://proxy.example/fallback.gif" },
      mimetype: "image/gif",
      fileName: "discord-embed.gif",
    },
  ]);
});

test("forwards embed-only Discord images", async () => {
  const { calls, handler } = createHarness();
  await handler(discordMessage({
    content: "",
    cleanContent: "",
    embeds: [{ image: { url: "https://example.test/embed.jpg" } }],
  }));

  assert.deepEqual(calls.map(({ payload }) => payload), [
    { text: "_*Alice*_" },
    {
      image: { url: "https://example.test/embed.jpg" },
      mimetype: "image/jpeg",
    },
  ]);
});

test("routes Discord attachments to the matching WhatsApp media payload", async () => {
  const { calls, handler } = createHarness();
  const attachments = new Map([
    ["image", { url: "https://example.test/a.png", contentType: "image/png", name: "a.png" }],
    ["gif", { url: "https://example.test/a.gif", contentType: "image/gif", name: "a.gif" }],
    ["video", { url: "https://example.test/a.mp4", contentType: "video/mp4", name: "a.mp4" }],
    ["audio", { url: "https://example.test/a.ogg", contentType: "audio/ogg", name: "a.ogg" }],
    ["file", { url: "https://example.test/a.pdf", contentType: "application/pdf", name: "a.pdf" }],
  ]);

  await handler(discordMessage({ content: "", cleanContent: "", attachments }));

  assert.deepEqual(calls.map(({ payload }) => payload), [
    { text: "_*Alice*_" },
    { image: { url: "https://example.test/a.png" }, mimetype: "image/png" },
    { document: { url: "https://example.test/a.gif" }, mimetype: "image/gif", fileName: "a.gif" },
    { video: { url: "https://example.test/a.mp4" }, mimetype: "video/mp4" },
    { audio: { url: "https://example.test/a.ogg" }, mimetype: "audio/ogg", ptt: false },
    { document: { url: "https://example.test/a.pdf" }, mimetype: "application/pdf", fileName: "a.pdf" },
  ]);
});

test("converts custom Discord emoji to a WhatsApp WebP sticker", async () => {
  const { calls, handler } = createHarness();
  const png = await sharp({
    create: { width: 8, height: 8, channels: 4, background: "#00ff00" },
  }).png().toBuffer();
  const originalFetch = global.fetch;
  const requestedURLs = [];
  global.fetch = async (url) => {
    requestedURLs.push(url);
    return new Response(png);
  };

  try {
    await handler(discordMessage({
      content: "<:wave:12345>",
      cleanContent: ":wave:",
    }));
  } finally {
    global.fetch = originalFetch;
  }

  assert.deepEqual(requestedURLs, [
    "https://cdn.discordapp.com/emojis/12345.png?size=512&quality=lossless",
  ]);
  assert.equal(calls[0].payload.text, "_*Alice*_");
  assert.ok(Buffer.isBuffer(calls[1].payload.sticker));
  assert.equal((await sharp(calls[1].payload.sticker).metadata()).format, "webp");
});

test("skips unsupported Discord Lottie stickers", async () => {
  const { calls, handler } = createHarness();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await handler(discordMessage({
      content: "",
      cleanContent: "",
      stickers: new Map([["sticker", { format: 3, name: "animated", url: "unused" }]]),
    }));
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(calls.map(({ payload }) => payload), [{ text: "_*Alice*_" }]);
});
