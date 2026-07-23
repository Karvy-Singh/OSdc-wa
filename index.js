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

const whatsappNumber = process.env.WHATSAPP_NUMBER.replace(/\D/g, "");
const WHATSAPP_CHAT_ID = `${whatsappNumber}@c.us`;

discord.once("ready", () => {
  console.log(`Discord connected as ${discord.user.tag}`);
});

whatsapp.on("qr", (qr) => {
  console.log("Scan this QR code with WhatsApp:");
  qrcode.generate(qr, { small: true });
});

// NOTE: to anyone working on the code, do not use getchats, 
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

  try {
    await whatsapp.sendMessage(
      WHATSAPP_CHAT_ID,
      `[Discord] ${message.author.username}: ${message.content}`
    );
  } catch (error) {
    console.error("Discord -> WhatsApp failed:", error.message);
  }
});

/* WhatsApp -> Discord */
whatsapp.on("message", async (message) => {
  if (message.from !== WHATSAPP_CHAT_ID) return;
  if (!message.body) return;

  try {
    const channel = await discord.channels.fetch(DISCORD_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      throw new Error("Discord channel is not a text channel");
    }

    await channel.send(`[WhatsApp] ${message.body}`);
  } catch (error) {
    console.error("WhatsApp -> Discord failed:", error.message);
  }
});

discord.login(process.env.DISCORD_TOKEN);
whatsapp.initialize();
