const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createDiscordWebhooks } = require("../src/helpers/webhooks");

test("startup reports every missing required environment variable", () => {
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_GUILD_ID;
  delete env.DISCORD_WEBHOOK_URL;
  delete env.DISCORD_WEBHOOK_URLS;
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
    cwd: "/tmp",
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DISCORD_TOKEN/);
  assert.match(result.stderr, /DISCORD_GUILD_ID/);
  assert.doesNotMatch(result.stderr, /DISCORD_WEBHOOK/);
});

test("missing webhook disables only its channel pair", () => {
  const warnings = [];
  const webhooks = createDiscordWebhooks({
    channelIds: ["channel-a", "channel-b"],
    webhookUrls: new Map([["channel-b", "webhook-b"]]),
    createWebhook: (url) => ({ url }),
    logger: { warn: (message) => warnings.push(message) },
  });

  assert.equal(webhooks.has("channel-a"), false);
  assert.deepEqual(webhooks.get("channel-b"), { url: "webhook-b" });
  assert.deepEqual(warnings, [
    "No Discord webhook configured for channel channel-a; " +
      "WhatsApp -> Discord forwarding is disabled for this pair",
  ]);
});
