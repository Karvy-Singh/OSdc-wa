# OSdc-wa
Discord &lt;-> WhatsApp bridge for the OSDC server and group.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the Discord bot token, guild ID, webhook URL, and bridge map.
3. Run `npm install` and then `npm start`.

`BRIDGE_MAP` maps WhatsApp chat IDs to Discord channel IDs. For example:

```dotenv
BRIDGE_MAP={"120000000000000000@g.us":"123456789012345678"}
```

The bot prints the WhatsApp group names and IDs after WhatsApp connects.

## Message actions

Replies, edits, message revocations, and Unicode reactions are forwarded in both
directions while the bridge is running. The Discord bot needs Read Message
History, Add Reactions, and Manage Messages permissions in each bridged channel.

Discord custom emoji reactions cannot be represented by WhatsApp. Also,
multiple Discord users share the connected WhatsApp account, and WhatsApp
allows that account only one reaction per message, so its latest forwarded
reaction replaces its previous reaction.
