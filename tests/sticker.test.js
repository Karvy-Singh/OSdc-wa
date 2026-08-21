const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

const { renderWebpSticker } = require("./sticker");

test("converts a static WebP sticker to PNG", async () => {
  const webp = await sharp({
    create: { width: 8, height: 8, channels: 4, background: "#ff000080" },
  }).webp().toBuffer();

  const png = await renderWebpSticker(webp, false);
  const metadata = await sharp(png).metadata();

  assert.equal(metadata.format, "png");
  assert.equal(metadata.width, 8);
  assert.equal(metadata.height, 8);
  assert.equal(metadata.hasAlpha, true);
});

test("converts an animated WebP sticker to a bounded GIF", async () => {
  const frames = Buffer.concat([
    Buffer.alloc(8 * 8 * 4, 0xff),
    Buffer.alloc(8 * 8 * 4, 0x40),
  ]);
  const webp = await sharp(frames, {
    raw: { width: 8, height: 16, channels: 4, pageHeight: 8 },
    animated: true,
  }).webp({ loop: 0, delay: [50, 50] }).toBuffer();

  const gif = await renderWebpSticker(webp, true);
  const metadata = await sharp(gif, { animated: true }).metadata();

  assert.equal(metadata.format, "gif");
  assert.equal(metadata.pages, 2);
  assert.ok(metadata.width <= 256);
  assert.ok(metadata.pageHeight <= 256);
});

test("rejects invalid sticker data", async () => {
  await assert.rejects(renderWebpSticker(Buffer.from("not an image"), false));
});
