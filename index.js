require("dotenv").config();

const requiredEnvironmentVariables = [
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_WEBHOOK_URL",
];
const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
  (name) => !process.env[name]
);

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
  WebhookClient,
} = require("discord.js");
const qrcode = require("qrcode-terminal");
const { createDiscordMessageHandler } = require("./discord-to-whatsapp");
const { createMessageMap } = require("./message-map");
const { createWhatsAppMessageHandler } = require("./whatsapp-to-discord");

const discord = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const whatsappToDiscord = new Map(
  Object.entries(JSON.parse(process.env.BRIDGE_MAP || "{}"))
);
const discordToWhatsApp = new Map(
  [...whatsappToDiscord].map(([chatId, channelId]) => [channelId, chatId])
);
const messageMap = createMessageMap();
const webhook = new WebhookClient({
  url: process.env.DISCORD_WEBHOOK_URL,
});

let whatsapp;
let baileys;

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
});

discord.on(
  "messageCreate",
  createDiscordMessageHandler({
    discordGuildId: DISCORD_GUILD_ID,
    discordToWhatsApp,
    getWhatsApp: () => whatsapp,
    messageMap,
  })
);

async function connectWhatsApp() {
  const { state, saveCreds } = await baileys.useMultiFileAuthState(
    "auth_info_baileys"
  );

  whatsapp = baileys.default({ auth: state });
  const handleWhatsAppMessage = createWhatsAppMessageHandler({
    baileys,
    discord,
    webhook,
    whatsapp,
    whatsappToDiscord,
    messageMap,
  });
  whatsapp.ev.on("creds.update", saveCreds);
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
    for (const message of messages) await handleWhatsAppMessage(message);
  });
}

async function main() {
  baileys = await import("@whiskeysockets/baileys");
  await connectWhatsApp();
  await discord.login(process.env.DISCORD_TOKEN);
}

main().catch(console.error);
