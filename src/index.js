require("dotenv").config();

const requiredEnvironmentVariables = [
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
];
const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  (name) => !process.env[name]
);
if (!process.env.DISCORD_WEBHOOK_URL && !process.env.DISCORD_WEBHOOK_URLS) {
  missingEnvironmentVariables.push(
    "DISCORD_WEBHOOK_URL or DISCORD_WEBHOOK_URLS"
  );
}

if (missingEnvironmentVariables.length > 0) {
  console.error(
    `Missing required environment variables: ${missingEnvironmentVariables.join(
      ", "
    )}. Create a .env file using .env.example.`
  );
  process.exit(1);
}

const {
  Client: DiscordClient,
  GatewayIntentBits,
  Partials,
  WebhookClient,
} = require("discord.js");
const qrcode = require("qrcode-terminal");
const { createDiscordMessageHandler } = require("./discord-to-whatsapp");
const { createMessageActionHandlers } = require("./helpers/message-actions");
const { createMessageMap } = require("./helpers/message-map");
const { createWhatsAppMessageHandler } = require("./whatsapp-to-discord");

const discord = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const whatsappToDiscord = new Map(
  Object.entries(JSON.parse(process.env.BRIDGE_MAP || "{}"))
);
const discordToWhatsApp = new Map(
  [...whatsappToDiscord].map(([chatId, channelId]) => [channelId, chatId])
);
const messageMap = createMessageMap();
const whatsappPushNames = new Map();
const webhookUrls = new Map(
  Object.entries(JSON.parse(process.env.DISCORD_WEBHOOK_URLS || "{}"))
);
const webhooks = new Map();
for (const channelId of new Set(whatsappToDiscord.values())) {
  const url = webhookUrls.get(channelId) || process.env.DISCORD_WEBHOOK_URL;
  if (!url) {
    console.error(`No Discord webhook configured for channel ${channelId}`);
    process.exit(1);
  }
  webhooks.set(channelId, new WebhookClient({ url }));
}

let whatsapp;
let baileys;
let messageActionHandlers;

function rememberWhatsAppPushNames(contacts) {
  for (const contact of contacts || []) {
    if (!contact.notify) continue;
    for (const jid of [contact.id, contact.lid, contact.phoneNumber]) {
      if (jid) whatsappPushNames.set(jid, contact.notify);
    }
  }
}

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
  messageActionHandlers?.initializeDiscordPins();
});

const handleDiscordMessage = createDiscordMessageHandler({
  discordGuildId: DISCORD_GUILD_ID,
  discordWebhookIds: new Set([...webhooks.values()].map(({ id }) => id)),
  discordToWhatsApp,
  getWhatsApp: () => whatsapp,
  messageMap,
});
discord.on("messageCreate", handleDiscordMessage);
discord.on("messageUpdate", handleDiscordMessage.handleUpdate);
discord.on("messageDelete", (message) =>
  messageActionHandlers?.handleDiscordMessageDelete(message)
);
discord.on("messageReactionAdd", (reaction, user) =>
  messageActionHandlers?.handleDiscordReactionAdd(reaction, user)
);
discord.on("messageReactionRemove", (reaction, user) =>
  messageActionHandlers?.handleDiscordReactionRemove(reaction, user)
);
discord.on("channelPinsUpdate", (channel) =>
  messageActionHandlers?.handleDiscordPinsUpdate(channel)
);

async function connectWhatsApp() {
  const { state, saveCreds } = await baileys.useMultiFileAuthState(
    "auth_info_baileys"
  );

  whatsapp = baileys.default({
    auth: state,
    getMessage: async ({ remoteJid, id }) => {
      if (!remoteJid || !id) return undefined;
      return messageMap.getWhatsAppMessageById(remoteJid, id)?.message;
    },
  });
  messageActionHandlers = createMessageActionHandlers({
    baileys,
    discord,
    discordGuildId: DISCORD_GUILD_ID,
    getWhatsApp: () => whatsapp,
    messageMap,
    webhooks,
    whatsappToDiscord,
  });
  if (discord.isReady()) await messageActionHandlers.initializeDiscordPins();
  const handleWhatsAppMessage = createWhatsAppMessageHandler({
    baileys,
    discord,
    webhooks,
    whatsapp,
    whatsappToDiscord,
    messageMap,
    pushNames: whatsappPushNames,
    invalidateDiscordSenderContext:
      handleDiscordMessage.invalidateSenderContext,
  });
  whatsapp.ev.on("creds.update", saveCreds);
  whatsapp.ev.on("messages.update", (updates) =>
    messageActionHandlers.handleWhatsAppMessageUpdates(updates)
  );
  whatsapp.ev.on("messages.reaction", (reactions) =>
    messageActionHandlers.handleWhatsAppReactions(reactions)
  );
  whatsapp.ev.on("contacts.upsert", rememberWhatsAppPushNames);
  whatsapp.ev.on("contacts.update", rememberWhatsAppPushNames);
  whatsapp.ev.on("messaging-history.set", ({ contacts }) =>
    rememberWhatsAppPushNames(contacts)
  );
  whatsapp.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        console.log("Scan this QR code with WhatsApp:");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        console.log("WhatsApp connected");
        const groups = await whatsapp.groupFetchAllParticipating();
        for (const group of Object.values(groups)) {
          rememberWhatsAppPushNames(group.participants);
          console.log(group.subject || "Unnamed group", group.id);
        }
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode !== baileys.DisconnectReason.loggedOut) {
          connectWhatsApp().catch(console.error);
        } else {
          console.error(
            "WhatsApp logged out; delete auth_info_baileys and reconnect"
          );
        }
      }
    }
  );
  whatsapp.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const message of messages) {
      if (await messageActionHandlers.handleWhatsAppPin(message)) continue;
      await handleWhatsAppMessage(message);
    }
  });
}

async function main() {
  baileys = await import("@whiskeysockets/baileys");
  await connectWhatsApp();
  await discord.login(process.env.DISCORD_TOKEN);
}

main().catch(console.error);
