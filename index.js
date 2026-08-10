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
const webhook = new WebhookClient({
  url: process.env.DISCORD_WEBHOOK_URL,
});

let whatsapp;
let baileys;

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
});

/* Discord -> WhatsApp */
discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== DISCORD_GUILD_ID) return;
  if (!message.content && message.attachments.size === 0) return;

  const whatsappChatId = discordToWhatsApp.get(message.channelId);
  if (!whatsappChatId || !whatsapp) return;

  try {
    const customEmojis = [...message.content.matchAll(/<(a?):(\w+):(\d+)>/g)];
    const content = customEmojis
      .reduce(
        (text, [, , name]) => text.replace(`:${name}:`, ""),
        message.cleanContent
      )
      .trim();

    await whatsapp.sendMessage(whatsappChatId, {
      text: `*${message.member?.displayName || message.author.displayName}*:${content ? `\n${content}` : ""
        }`,
    });

    for (const [, animated, , id] of customEmojis) {
      await whatsapp.sendMessage(whatsappChatId, {
        sticker: {
          url: `https://cdn.discordapp.com/emojis/${id}.webp?size=160&quality=lossless`,
        },
        isAnimated: Boolean(animated),
      });
    }

    for (const attachment of message.attachments.values()) {
      const media = { url: attachment.url };
      const mimeType = attachment.contentType || "application/octet-stream";
      let payload;

      if (mimeType.startsWith("image/") && mimeType !== "image/gif") {
        payload = { image: media, mimetype: mimeType };
      } else if (mimeType.startsWith("video/")) {
        payload = { video: media, mimetype: mimeType };
      } else if (mimeType.startsWith("audio/")) {
        payload = { audio: media, mimetype: mimeType, ptt: false };
      } else {
        payload = {
          document: media,
          mimetype: mimeType,
          fileName: attachment.name || "attachment",
        };
      }

      await whatsapp.sendMessage(whatsappChatId, payload);
    }
  } catch (error) {
    console.error("Discord -> WhatsApp failed:", error);
  }
});

async function handleWhatsAppMessage(whatsappMessage) {
  if (whatsappMessage.key.fromMe) return;

  const chatId = whatsappMessage.key.remoteJid;
  const discordChannelId = whatsappToDiscord.get(chatId);
  if (!discordChannelId) return;

  const message = baileys.normalizeMessageContent(whatsappMessage.message);
  const type = baileys.getContentType(message);
  if (!type) return;

  const body = message[type];
  let content =
    message.conversation ||
    body?.text ||
    body?.caption ||
    body?.selectedDisplayText ||
    body?.title ||
    "";
  const mediaTypes = new Set([
    "audioMessage",
    "documentMessage",
    "imageMessage",
    "stickerMessage",
    "videoMessage",
  ]);
  const hasMedia = mediaTypes.has(type);
  if (!content && !hasMedia) return;

  try {
    const senderId =
      whatsappMessage.key.participantAlt ||
      whatsappMessage.key.participant ||
      whatsappMessage.key.remoteJidAlt ||
      chatId;
    const senderName =
      whatsappMessage.pushName || senderId.split("@")[0] || "Unknown";
    const avatarURL = await whatsapp
      .profilePictureUrl(senderId, "image")
      .catch(() => undefined);

    const files = [];
    if (hasMedia) {
      const media = await baileys.downloadMediaMessage(
        whatsappMessage,
        "buffer",
        {}
      );
      const mimeType = body.mimetype?.split(";")[0] || "application/octet-stream";
      const extension = mimeType.split("/")[1] || "bin";

      files.push({
        attachment: media,
        name:
          body.fileName ||
          `whatsapp-${whatsappMessage.key.id}.${extension}`,
      });
    }

    await webhook.send({
      username: senderName.slice(0, 80),
      avatarURL,
      content,
      files,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("WhatsApp -> Discord failed:", error);
  }
}

async function connectWhatsApp() {
  const { state, saveCreds } = await baileys.useMultiFileAuthState(
    "auth_info_baileys"
  );

  whatsapp = baileys.default({ auth: state });
  whatsapp.ev.on("creds.update", saveCreds);
  whatsapp.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
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
        console.error("WhatsApp logged out; delete auth_info_baileys and reconnect");
      }
    }
  });
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
