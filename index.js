require("dotenv").config();

const {
  Client: DiscordClient,
  GatewayIntentBits,
} = require("discord.js");

const {
  Client: WhatsAppClient,
  LocalAuth,
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

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
});

whatsapp.on("qr", (qr) => {
  console.log("Scan this QR code with WhatsApp:");
  qrcode.generate(qr, { small: true });
});

// NOTE: to anyone working on the code, do not use .getchats(), 
// that throws an error with some new changes in wa, 
// and it is not yet fixed in upstream

async function getGroups(client) {
  return client.pupPage.evaluate(() =>
    window.require("WAWebCollections").Chat
      .getModelsArray()
      .map(chat => ({
        id: chat.id?.toString?.(),
        name: chat.formattedTitle || chat.name || "Unnamed group",
      }))
      .filter(chat => chat.id?.endsWith("@g.us"))
  );
}

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
    await whatsapp.sendMessage(
      whatsappChatId,
      `*${message.author.displayName}*:\n${message.content}`
    );
  } catch (error) {
    console.error("Discord -> WhatsApp failed:", error.message);
  }
});

/* WhatsApp -> Discord */
whatsapp.on("message", async (whatsappMessage) => {
  if (!whatsappMessage.body) return;

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

    await channel.send({
      content: `**${senderName}**:\n${whatsappMessage.body}`,
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("WhatsApp -> Discord failed:", error.message);
  }
});

discord.login(process.env.DISCORD_TOKEN);
whatsapp.initialize();
