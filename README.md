# OSdc-wa
Discord &lt;-> WhatsApp bridge for the OSDC server and group.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the Discord bot token, guild ID, webhook URL, and bridge map.
3. Run `npm install` and then `node index.js`.

`BRIDGE_MAP` maps WhatsApp chat IDs to Discord channel IDs. For example:

```dotenv
BRIDGE_MAP={"120000000000000000@g.us":"123456789012345678"}
```

The bot prints the WhatsApp group names and IDs after WhatsApp connects.
