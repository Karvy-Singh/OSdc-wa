# OSdc-wa

A self-hosted, two-way bridge between WhatsApp groups and Discord channels.

## Features

- Two-way message bridging: WhatsApp to Discord and Discord to WhatsApp
- Multiple WhatsApp group-to-Discord channel mappings
- Sender names and profile pictures on Discord, with Discord display names on
  WhatsApp and 30-second grouping for consecutive messages from the same sender
- Text and common bold, italic, bold-italic, and strikethrough formatting in
  both directions
- Images, video, audio, and document attachments in both directions
- WhatsApp video notes to Discord, plus Discord embeds and forwarded-message
  snapshots to WhatsApp
- Replies in both directions while preserving the original message reference
- Text edits, message deletions, and WhatsApp revocations in both directions
- Unicode reaction additions and removals in both directions
- Pin and unpin changes in both directions
- WhatsApp mentions displayed with known contact names when available
- Static, animated, and Lottie WhatsApp stickers converted to PNG or GIF for
  Discord when possible
- Discord custom emoji and non-Lottie stickers converted to WhatsApp stickers
- Loop prevention for messages and actions created by the bridge
- Persistent WhatsApp linked-device authentication between restarts

WhatsApp is connected as a linked device through
[Baileys](https://github.com/WhiskeySockets/Baileys). Discord uses a bot for
receiving messages and performing message actions, plus a webhook so WhatsApp
messages appear with the sender's name and profile picture.

P.S. Originally was made for the Discord server of my community of nerds and open source lovers :P :
https://discord.gg/uBTF3yrrV
as the name and about of the repo suggests, but it **works on any discord server and whatsapp group/contact**

## Requirements

- Node.js 22 or newer
- A Discord server where you can add a bot and create webhooks
- A WhatsApp account that can join the group being bridged
- A machine that can remain running and connected to the internet

## Discord setup

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Open **Bot**, create the bot, and copy its token. Keep this token private.
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**.
4. Use **OAuth2 > URL Generator** to invite the bot to your server with the
   `bot` scope.
5. Give the bot access to the channel being bridged. It needs **View Channel**,
   **Send Messages**, **Read Message History**, **Attach Files**,
   **Add Reactions**, and **Manage Messages**. Manage Messages is needed to
   mirror pins and remove reactions.
6. In each target Discord channel, open **Edit Channel > Integrations >
   Webhooks**, create a webhook, and copy its URL.
7. Enable Discord Developer Mode under **User Settings > Advanced**, then
   right-click the server and target channel to copy their IDs.

Each webhook must belong to the Discord channel assigned to it. This is what
ensures messages from each WhatsApp group appear in the correct channel.

## Installation

Clone the repository and install its dependencies:

```bash
git clone https://github.com/Karvy-Singh/OSdc-wa.git
cd OSdc-wa
npm install
```

Create your local configuration from the example:

```bash
cp .env.example .env
```

Fill in the Discord values first. Leave `BRIDGE_MAP` empty and use an empty
webhook map for the initial WhatsApp connection:

```dotenv
DISCORD_TOKEN=your_discord_bot_token
DISCORD_GUILD_ID=123456789012345678
DISCORD_WEBHOOK_URLS={}
BRIDGE_MAP=
```

Start the bridge:

```bash
npm start
```

A QR code will appear in the terminal. In WhatsApp, open **Settings > Linked
devices > Link a device** and scan it. After connecting, the terminal prints
every group name and its WhatsApp chat ID:

```text
WhatsApp connected
My Group 120000000000000000@g.us
```

Stop the process with `Ctrl+C`, then map each WhatsApp chat ID to its target
Discord channel ID. Also map each Discord channel ID to the webhook created in
that same channel:

```dotenv
BRIDGE_MAP={"120000000000000000@g.us":"111111111111111111","120000000000000001@g.us":"222222222222222222"}
DISCORD_WEBHOOK_URLS={"111111111111111111":"https://discord.com/api/webhooks/111/token-a","222222222222222222":"https://discord.com/api/webhooks/222/token-b"}
```

Both values must be valid JSON, with double quotes around every ID and URL.
Every Discord channel used by `BRIDGE_MAP` must have an entry in
`DISCORD_WEBHOOK_URLS`. Start the bridge again with `npm start`. A successful
startup prints both connection messages:

```text
WhatsApp connected
Discord connected as MyBridgeBot#0000
```

WhatsApp credentials are saved in `auth_info_baileys/`, so the QR code normally
only needs to be scanned once. This directory and `.env` are ignored by Git.
Treat both as secrets and include the credentials directory when backing up or
moving the service.

## Limitations

The bridge keeps message links in memory, up to the latest 10,000 Discord
messages. Restarting the process clears those links, so replies and actions on
older messages cannot be mirrored after a restart. New messages continue to
work normally.

Discord custom emoji reactions cannot be represented by WhatsApp. In addition,
all Discord users act through the one connected WhatsApp account, and WhatsApp
allows that account one reaction per message. The latest reaction forwarded
from Discord therefore replaces the previous one.

## Running continuously

For a server, use a process manager so the bridge restarts after a crash or
reboot. One option is [PM2](https://pm2.keymetrics.io/):

```bash
npm install --global pm2
pm2 start src/index.js --name osdc-wa
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup` to finish enabling startup for your
operating system. View runtime output with `pm2 logs osdc-wa` and restart after
configuration changes with `pm2 restart osdc-wa`.

## Testing

Run the Node.js test suite with:

```bash
npm test
```

The tests cover message routing, media and sticker conversion, Markdown,
message mapping, edits, deletions, reactions, and pins.

## Troubleshooting

**The bot starts but Discord messages are not forwarded**

Check that Message Content Intent is enabled, the bot is in the server, the
guild and channel IDs are correct, and the bot can read the mapped channel.

**WhatsApp messages appear in the wrong Discord channel**

The webhook determines where ordinary WhatsApp messages are posted. Verify that
the channel ID in `DISCORD_WEBHOOK_URLS` matches `BRIDGE_MAP` and that its
webhook was created in that channel.

**The QR code appears on every start**

Ensure `auth_info_baileys/` is writable and is not deleted between runs. In a
container or ephemeral host, mount that directory as persistent storage.

**WhatsApp reports that the device was logged out**

Stop the bridge, delete `auth_info_baileys/`, start it again, and scan the new
QR code. Deleting this directory intentionally removes the saved session.

**Edits, replies, reactions, or pins do not mirror for an older message**

Message relationships are held in memory and only exist for messages observed
during the current process run. Restarting the service clears them.

