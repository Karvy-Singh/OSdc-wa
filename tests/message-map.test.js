const test = require("node:test");
const assert = require("node:assert/strict");

const { createMessageMap } = require("../src/helpers/message-map");

function whatsappMessage(chatId, id) {
  return { key: { remoteJid: chatId, id } };
}

test("links one Discord message to all of its WhatsApp messages", () => {
  const map = createMessageMap();
  const first = whatsappMessage("chat-a", "wa-1");
  const second = whatsappMessage("chat-a", "wa-2");

  map.link("discord-1", "chat-a", first);
  map.link("discord-1", "chat-a", second);
  map.link("discord-1", "chat-a", first);

  assert.equal(map.getWhatsAppMessage("discord-1"), first);
  assert.deepEqual(map.getWhatsAppMessages("discord-1"), [first, second]);
  assert.equal(map.getWhatsAppMessageById("chat-a", "wa-2"), second);
  assert.equal(map.getDiscordMessageId("chat-a", "wa-1"), "discord-1");
  assert.equal(map.getDiscordMessageId("chat-a", "wa-2"), "discord-1");
});

test("keeps identical WhatsApp IDs in different chats distinct", () => {
  const map = createMessageMap();
  const first = whatsappMessage("chat-a", "same-id");
  const second = whatsappMessage("chat-b", "same-id");

  map.link("discord-1", "chat-a", first);
  map.link("discord-1", "chat-b", second);

  assert.deepEqual(map.getWhatsAppMessages("discord-1"), [first, second]);
  assert.equal(map.getDiscordMessageId("chat-a", "same-id"), "discord-1");
  assert.equal(map.getDiscordMessageId("chat-b", "same-id"), "discord-1");
});

test("returns a defensive copy and unlinks in both directions", () => {
  const map = createMessageMap();
  const linked = whatsappMessage("chat-a", "wa-1");
  map.link("discord-1", "chat-a", linked);

  map.getWhatsAppMessages("discord-1").length = 0;
  assert.equal(map.getWhatsAppMessage("discord-1"), linked);
  assert.deepEqual(map.unlinkDiscordMessage("discord-1"), [linked]);
  assert.equal(map.getWhatsAppMessage("discord-1"), undefined);
  assert.equal(map.getDiscordMessageId("chat-a", "wa-1"), undefined);
});

test("relinking a WhatsApp message removes its stale forward mapping", () => {
  const map = createMessageMap();
  const linked = whatsappMessage("chat-a", "wa-1");

  map.link("discord-old", "chat-a", linked);
  map.link("discord-new", "chat-a", linked);

  assert.deepEqual(map.getWhatsAppMessages("discord-old"), []);
  assert.equal(map.getWhatsAppMessage("discord-new"), linked);
  assert.equal(map.getDiscordMessageId("chat-a", "wa-1"), "discord-new");
  map.unlinkDiscordMessage("discord-old");
  assert.equal(map.getDiscordMessageId("chat-a", "wa-1"), "discord-new");
});

test("unlinking by a WhatsApp ID removes every output for that Discord message", () => {
  const map = createMessageMap();
  map.link("discord-1", "chat-a", whatsappMessage("chat-a", "wa-1"));
  map.link("discord-1", "chat-a", whatsappMessage("chat-a", "wa-2"));

  assert.equal(map.unlinkWhatsAppMessage("chat-a", "wa-2"), "discord-1");
  assert.deepEqual(map.getWhatsAppMessages("discord-1"), []);
  assert.equal(map.getDiscordMessageId("chat-a", "wa-1"), undefined);
});

test("evicts the oldest Discord message after 10,000 entries", () => {
  const map = createMessageMap();
  for (let index = 0; index <= 10_000; index += 1) {
    map.link(
      `discord-${index}`,
      "chat-a",
      whatsappMessage("chat-a", `wa-${index}`)
    );
  }

  assert.equal(map.getWhatsAppMessage("discord-0"), undefined);
  assert.equal(map.getDiscordMessageId("chat-a", "wa-0"), undefined);
  assert.equal(map.getDiscordMessageId("chat-a", "wa-10000"), "discord-10000");
});
