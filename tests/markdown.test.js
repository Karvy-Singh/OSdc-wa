const test = require("node:test");
const assert = require("node:assert/strict");

const {
  discordToWhatsAppMarkdown,
  whatsappToDiscordMarkdown,
} = require("../src/helpers/markdown");

test("converts WhatsApp formatting to Discord Markdown", () => {
  assert.equal(
    whatsappToDiscordMarkdown("*bold* _italic_ _*both*_ ~gone~"),
    "**bold** _italic_ ***both*** ~~gone~~"
  );
});

test("converts Discord formatting to WhatsApp Markdown", () => {
  assert.equal(
    discordToWhatsAppMarkdown("**bold** *italic* _italic_ ***both*** ~~gone~~"),
    "*bold* _italic_ _italic_ _*both*_ ~gone~"
  );
});

test("preserves code, URLs, link destinations, escapes, and list markers", () => {
  const discord = [
    "**bold** `**code**` https://example.test/a_*_b",
    "[**label**](https://example.test/a_(b)?x=*y*)",
    "\\*literal\\*",
    "* list item",
    "```js\nconst value = '**code**';\n```",
  ].join("\n");

  assert.equal(discordToWhatsAppMarkdown(discord), [
    "*bold* `**code**` https://example.test/a_*_b",
    "[*label*](https://example.test/a_(b)?x=*y*)",
    "\\*literal\\*",
    "* list item",
    "```js\nconst value = '**code**';\n```",
  ].join("\n"));
});

test("leaves unmatched formatting delimiters unchanged", () => {
  assert.equal(whatsappToDiscordMarkdown("an *unfinished message"), "an *unfinished message");
  assert.equal(discordToWhatsAppMarkdown("an **unfinished message"), "an **unfinished message");
});
