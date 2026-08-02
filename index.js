require("dotenv").config();

const { getGroups, getProfilePic, downloadMedia } = require('./utils.js')

const {
  Client: DiscordClient,
  GatewayIntentBits,
  WebhookClient,
} = require("discord.js");

const {
  Client: WhatsAppClient,
  LocalAuth,
  MessageMedia,
} = require("whatsapp-web.js");

const qrcode = require("qrcode-terminal");

const discord = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const whatsapp = new WhatsAppClient({
  authStrategy: new LocalAuth(),
  puppeteer: {
    executablePath: "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
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

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
});

whatsapp.on("qr", (qr) => {
  console.log("Scan this QR code with WhatsApp:");
  qrcode.generate(qr, { small: true });
});


whatsapp.once("ready", async () => {
  console.log("WhatsApp connected");

  const groups = await getGroups(whatsapp);

  for (const group of groups) {
    console.log(group.name, group.id);
  }
});

/* Discord -> WhatsApp */
discord.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.guildId !== DISCORD_GUILD_ID) return;
  if (!message.content) return;

  const whatsappChatId = discordToWhatsApp.get(message.channelId);
  if (!whatsappChatId) return;

  try {
    const customEmojis = [...message.content.matchAll(/<(a?):(\w+):(\d+)>/g)];
    const content = customEmojis
      .reduce(
        (text, [, , name]) => text.replace(`:${name}:`, ""),
        message.cleanContent
      )
      .trim();

    await whatsapp.sendMessage(
      whatsappChatId,
      `*${message.member?.displayName || message.author.displayName}*:${content ? `\n${content}` : ""
      }`
    );

    for (const [, animated, , id] of customEmojis) {
      const extension = animated ? "gif" : "png";
      const media = await MessageMedia.fromUrl(
        `https://cdn.discordapp.com/emojis/${id}.${extension}?size=160&quality=lossless`
      );

      await whatsapp.sendMessage(whatsappChatId, media, {
        sendMediaAsSticker: true,
      });
    }
  } catch (error) {
    console.error("Discord -> WhatsApp failed:", error);
  }
});

/* WhatsApp -> Discord */
whatsapp.on("message", async (whatsappMessage) => {
  if (!whatsappMessage.body && !whatsappMessage.hasMedia) return;

  const discordChannelId = whatsappToDiscord.get(whatsappMessage.from);
  if (!discordChannelId) return;

  try {
    const contact = await whatsappMessage.getContact();

    const senderName =
      contact.pushname ||
      contact.shortName ||
      contact.number ||
      "Unknown";

    const channel = await discord.channels.fetch(discordChannelId);

    if (!channel?.isTextBased()) {
      throw new Error("Discord channel is not a text channel");
    }
    const avatarURL = await getProfilePic(
      whatsapp,
      contact.id._serialized
    ).catch(() => undefined);

    let content = whatsappMessage.body || "";
    const mentions = await whatsappMessage.getMentions();

    for (const mention of mentions) {
      const name =
        mention.pushname ||
        mention.shortName ||
        mention.number;

      content = content.replaceAll(`@${mention.number}`, `@${name}`);
    }

    const files = [];

    if (whatsappMessage.hasMedia) {
      const media = await downloadMedia(whatsappMessage);
      if (media) {
        const mimeType = media.mimetype.split(";")[0];
        let extension = mimeType.split("/")[1] || "bin";

        files.push({
          attachment: Buffer.from(media.data, "base64"),
          name:
            media.filename ||
            `whatsapp-${whatsappMessage.id.id}.${extension}`,
        });
      }
    }

    await webhook.send({
      username: senderName.slice(0, 80),
      avatarURL,
      content: content,
      files,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("WhatsApp -> Discord failed:", error);
  }
});

discord.login(process.env.DISCORD_TOKEN);
whatsapp.initialize();
