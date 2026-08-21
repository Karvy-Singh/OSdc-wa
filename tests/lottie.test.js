const test = require("node:test");
const assert = require("node:assert/strict");
const { gzipSync } = require("node:zlib");
const sharp = require("sharp");

const { renderLottieGif } = require("../src/helpers/lottie");

test("rejects malformed plain Lottie JSON", async () => {
  await assert.rejects(
    renderLottieGif(Buffer.from("{not-json")),
    /JSON/
  );
});

test("decodes compressed input before validating Lottie JSON", async () => {
  await assert.rejects(
    renderLottieGif(gzipSync(Buffer.from("not-json"))),
    /JSON/
  );
});

test("a failed render does not block the following queued render", async () => {
  const results = await Promise.allSettled([
    renderLottieGif(Buffer.from("{")),
    renderLottieGif(Buffer.from("[")),
  ]);
  assert.deepEqual(results.map(({ status }) => status), ["rejected", "rejected"]);
});

test("renders a valid Lottie animation as a GIF", async () => {
  const input = Buffer.from(JSON.stringify({
    v: "5.5.7",
    fr: 30,
    ip: 0,
    op: 2,
    w: 8,
    h: 8,
    layers: [],
  }));

  const gif = await renderLottieGif(input);
  const metadata = await sharp(gif, { animated: true }).metadata();

  assert.equal(metadata.format, "gif");
  assert.equal(metadata.width, 8);
  assert.equal(metadata.pageHeight, 8);
  assert.equal(metadata.pages, 2);
});
