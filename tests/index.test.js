const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("startup reports every missing required environment variable", () => {
  const env = { ...process.env };
  delete env.DISCORD_TOKEN;
  delete env.DISCORD_GUILD_ID;
  delete env.DISCORD_WEBHOOK_URL;
  const result = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
    cwd: "/tmp",
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /DISCORD_TOKEN/);
  assert.match(result.stderr, /DISCORD_GUILD_ID/);
  assert.match(result.stderr, /DISCORD_WEBHOOK_URL/);
});
