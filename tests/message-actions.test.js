const test = require("node:test");
const assert = require("node:assert/strict");

const { createMessageActionHandlers } = require("./message-actions");
const { createMessageMap } = require("./message-map");

function waMessage(id = "wa-1") {
  return { key: { remoteJid: "chat-a", id } };
}

function createHarness() {
  const sent = [];
  const deleted = [];
  const reacted = [];
  const removed = [];
  const discordMessage = {
    async delete() { deleted.push("discord-1"); },
    async react(emoji) { reacted.push(emoji); },
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
  const handlers = createMessageActionHandlers({
    baileys: { WAMessageStubType: { REVOKE: 1 } },
    discord: {
      user: { id: "bridge-bot" },
      channels: {
        fetch: async () => ({
          isTextBased: () => true,
          messages: { fetch: async () => discordMessage },
        }),
      },
    },
    discordGuildId: "guild-a",
    getWhatsApp: () => whatsapp,
    messageMap,
    whatsappToDiscord: new Map([["chat-a", "channel-a"]]),
  });
  return { deleted, handlers, messageMap, reacted, removed, sent };
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
