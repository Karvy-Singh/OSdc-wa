const test = require("node:test");
const assert = require("node:assert/strict");

const { createMessageActionHandlers } = require("../src/helpers/message-actions");
const { createMessageMap } = require("../src/helpers/message-map");

function waMessage(id = "wa-1") {
  return { key: { remoteJid: "chat-a", id } };
}

function createHarness() {
  const sent = [];
  const deleted = [];
  const reacted = [];
  const removed = [];
  const pinned = [];
  const unpinned = [];
  const edited = [];
  const webhookEdits = [];
  const fetched = [];
  const pinnedIds = new Set();
  const discordMessage = {
    webhookId: "webhook-1",
    embeds: [],
    async delete() { deleted.push("discord-1"); },
    async edit(payload) { edited.push(payload); },
    async react(emoji) { reacted.push(emoji); },
    async pin(reason) { pinned.push(reason); },
    async unpin(reason) { unpinned.push(reason); },
    reactions: {
      cache: new Map([
        ["thumb", {
          emoji: { id: null, name: "👍" },
          users: { remove: async (id) => removed.push(id) },
        }],
      ]),
    },
  };
  const messageMap = createMessageMap();
  const whatsapp = {
    async sendMessage(chatId, payload) {
      sent.push({ chatId, payload });
    },
  };
  const channel = {
    id: "channel-a",
    isTextBased: () => true,
    messages: {
      fetch: async (id) => {
        fetched.push(id);
        return discordMessage;
      },
      fetchPinned: async () => new Map(
        [...pinnedIds].map((id) => [id, { id }])
      ),
    },
  };
  const webhook = {
    async editMessage(id, payload) { webhookEdits.push({ id, payload }); },
  };
  const handlers = createMessageActionHandlers({
    baileys: {
      WAMessageStubType: { REVOKE: 1 },
      normalizeMessageContent: (message) => message,
      getContentType: (message) => Object.keys(message || {})[0],
    },
    discord: {
      user: { id: "bridge-bot" },
      channels: {
        fetch: async () => channel,
      },
    },
    discordGuildId: "guild-a",
    getWhatsApp: () => whatsapp,
    messageMap,
    webhook,
    whatsappToDiscord: new Map([["chat-a", "channel-a"]]),
  });
  return {
    channel,
    deleted,
    discordMessage,
    edited,
    fetched,
    handlers,
    messageMap,
    pinned,
    pinnedIds,
    reacted,
    removed,
    sent,
    unpinned,
    webhook,
    webhookEdits,
  };
}

test("Discord deletion revokes every linked WhatsApp output", async () => {
  const { handlers, messageMap, sent } = createHarness();
  const first = waMessage("wa-1");
  const second = waMessage("wa-2");
  messageMap.link("discord-1", "chat-a", first);
  messageMap.link("discord-1", "chat-a", second);

  await handlers.handleDiscordMessageDelete({ id: "discord-1", guildId: "guild-a" });

  assert.deepEqual(sent, [
    { chatId: "chat-a", payload: { delete: first.key } },
    { chatId: "chat-a", payload: { delete: second.key } },
  ]);
  assert.deepEqual(messageMap.getWhatsAppMessages("discord-1"), []);
});

test("WhatsApp revocation deletes and unlinks the mapped Discord message", async () => {
  const { deleted, handlers, messageMap } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());

  await handlers.handleWhatsAppMessageUpdates([
    { key: { remoteJid: "chat-a", id: "wa-1" }, update: { messageStubType: 1 } },
    { key: { remoteJid: "chat-a", id: "ignored" }, update: { messageStubType: 2 } },
  ]);

  assert.deepEqual(deleted, ["discord-1"]);
  assert.equal(messageMap.getDiscordMessageId("chat-a", "wa-1"), undefined);
});

test("forwards WhatsApp edits to webhook messages", async () => {
  const { fetched, handlers, messageMap, webhookEdits } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());

  await handlers.handleWhatsAppMessageUpdates([{
    key: { remoteJid: "chat-a", id: "wa-1", fromMe: false },
    update: {
      message: { editedMessage: { message: { conversation: "edited text" } } },
    },
  }]);

  assert.deepEqual(webhookEdits, [{
    id: "discord-1",
    payload: {
      content: "edited text",
      allowedMentions: { parse: [] },
    },
  }]);
  assert.deepEqual(fetched, []);
});

test("ignores the WhatsApp echo of a Discord edit", async () => {
  const { edited, handlers, messageMap, webhookEdits } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());

  await handlers.handleWhatsAppMessageUpdates([{
    key: { remoteJid: "chat-a", id: "wa-1", fromMe: true },
    update: {
      message: { editedMessage: { message: { conversation: "echo" } } },
    },
  }]);

  assert.deepEqual(edited, []);
  assert.deepEqual(webhookEdits, []);
});

test("forwards WhatsApp reply edits to Discord embeds", async () => {
  const {
    discordMessage,
    edited,
    fetched,
    handlers,
    messageMap,
    webhook,
  } = createHarness();
  const author = { name: "Alice", iconURL: "https://example.test/a.png" };
  const timestamp = "2023-11-14T22:13:20.000Z";
  discordMessage.webhookId = null;
  discordMessage.embeds = [{ author, timestamp }];
  webhook.editMessage = async () => { throw new Error("Not a webhook message"); };
  messageMap.link("discord-1", "chat-a", waMessage());

  await handlers.handleWhatsAppMessageUpdates([{
    key: { remoteJid: "chat-a", id: "wa-1", fromMe: false },
    update: {
      message: {
        editedMessage: {
          message: { extendedTextMessage: { text: "edited *reply*\nsecond line" } },
        },
      },
    },
  }]);

  assert.deepEqual(edited, [{
    embeds: [{
      color: 0x25d366,
      author,
      description: "edited **reply**\nsecond line",
      footer: { text: "Reply from WhatsApp" },
      timestamp,
    }],
  }]);
  assert.deepEqual(fetched, ["discord-1"]);
});

test("forwards Unicode Discord reaction adds and matching removals", async () => {
  const { handlers, messageMap, sent } = createHarness();
  const linked = waMessage();
  messageMap.link("discord-1", "chat-a", linked);
  const reaction = {
    emoji: { id: null, name: "👍" },
    message: { id: "discord-1", guildId: "guild-a" },
  };
  const user = { id: "user-a", bot: false };

  await handlers.handleDiscordReactionAdd(reaction, user);
  await handlers.handleDiscordReactionRemove(reaction, { id: "other", bot: false });
  await handlers.handleDiscordReactionRemove(reaction, user);

  assert.deepEqual(sent, [
    { chatId: "chat-a", payload: { react: { text: "👍", key: linked.key } } },
    { chatId: "chat-a", payload: { react: { text: "", key: linked.key } } },
  ]);
});

test("ignores custom Discord emoji reactions", async () => {
  const { handlers, messageMap, sent } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await handlers.handleDiscordReactionAdd({
      emoji: { id: "custom", name: "party" },
      message: { id: "discord-1", guildId: "guild-a" },
    }, { id: "user-a", bot: false });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(sent.length, 0);
});

test("keeps a shared WhatsApp reaction until its final sender removes it", async () => {
  const { handlers, messageMap, reacted, removed } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());
  const update = (sender, text) => ({
    key: { remoteJid: "chat-a", id: "wa-1" },
    reaction: { text, key: { participant: sender } },
  });

  await handlers.handleWhatsAppReactions([update("alice", "👍")]);
  await handlers.handleWhatsAppReactions([update("bob", "👍")]);
  await handlers.handleWhatsAppReactions([update("alice", "")]);
  assert.deepEqual(removed, []);
  await handlers.handleWhatsAppReactions([update("bob", "")]);

  assert.deepEqual(reacted, ["👍", "👍"]);
  assert.deepEqual(removed, ["bridge-bot"]);
});

test("suppresses the WhatsApp echo of a forwarded Discord reaction", async () => {
  const { handlers, messageMap, reacted } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());
  await handlers.handleDiscordReactionAdd({
    emoji: { id: null, name: "👍" },
    message: { id: "discord-1", guildId: "guild-a" },
  }, { id: "user-a", bot: false });

  await handlers.handleWhatsAppReactions([{
    key: { remoteJid: "chat-a", id: "wa-1" },
    reaction: { text: "👍", key: { fromMe: true, remoteJid: "me" } },
  }]);

  assert.deepEqual(reacted, []);
});

test("forwards Discord pin and unpin changes to every linked WhatsApp message", async () => {
  const { channel, handlers, messageMap, pinnedIds, sent } = createHarness();
  const first = waMessage("wa-1");
  const second = waMessage("wa-2");
  messageMap.link("discord-1", "chat-a", first);
  messageMap.link("discord-1", "chat-a", second);
  await handlers.initializeDiscordPins();

  pinnedIds.add("discord-1");
  await handlers.handleDiscordPinsUpdate(channel);
  pinnedIds.delete("discord-1");
  await handlers.handleDiscordPinsUpdate(channel);

  assert.deepEqual(sent, [
    {
      chatId: "chat-a",
      payload: { pin: first.key, type: 1, time: 2_592_000 },
    },
    {
      chatId: "chat-a",
      payload: { pin: second.key, type: 1, time: 2_592_000 },
    },
    { chatId: "chat-a", payload: { pin: first.key, type: 2 } },
    { chatId: "chat-a", payload: { pin: second.key, type: 2 } },
  ]);
});

test("forwards WhatsApp pin and unpin messages to Discord", async () => {
  const { handlers, messageMap, pinned, unpinned } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());
  const pinMessage = (type) => ({
    key: { remoteJid: "chat-a", id: `pin-${type}`, fromMe: false },
    message: {
      pinInChatMessage: {
        key: { remoteJid: "chat-a", id: "wa-1" },
        type,
      },
    },
  });

  assert.equal(await handlers.handleWhatsAppPin(pinMessage(1)), true);
  assert.equal(await handlers.handleWhatsAppPin(pinMessage(2)), true);

  assert.deepEqual(pinned, ["Mirrored WhatsApp pin"]);
  assert.deepEqual(unpinned, ["Mirrored WhatsApp unpin"]);
});

test("suppresses the Discord echo of a forwarded WhatsApp pin", async () => {
  const { channel, handlers, messageMap, pinnedIds, sent } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());
  await handlers.initializeDiscordPins();

  await handlers.handleWhatsAppPin({
    key: { remoteJid: "chat-a", id: "pin-1", fromMe: false },
    message: {
      pinInChatMessage: {
        key: { remoteJid: "chat-a", id: "wa-1" },
        type: 1,
      },
    },
  });
  pinnedIds.add("discord-1");
  await handlers.handleDiscordPinsUpdate(channel);

  assert.deepEqual(sent, []);
});

test("suppresses the WhatsApp echo of a forwarded Discord pin", async () => {
  const {
    channel,
    handlers,
    messageMap,
    pinned,
    pinnedIds,
  } = createHarness();
  messageMap.link("discord-1", "chat-a", waMessage());
  await handlers.initializeDiscordPins();
  pinnedIds.add("discord-1");
  await handlers.handleDiscordPinsUpdate(channel);

  await handlers.handleWhatsAppPin({
    key: { remoteJid: "chat-a", id: "pin-echo", fromMe: true },
    message: {
      pinInChatMessage: {
        key: { remoteJid: "chat-a", id: "wa-1" },
        type: 1,
      },
    },
  });

  assert.deepEqual(pinned, []);
});
