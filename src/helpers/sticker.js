const sharp = require("sharp");

async function renderWebpSticker(buffer, animated) {
  const image = sharp(buffer, { animated: Boolean(animated) });

  if (!animated) return image.png().toBuffer();

  return image
    .resize(256, 256, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .gif({ effort: 3, colours: 128, keepDuplicateFrames: true })
    .toBuffer();
}

module.exports = { renderWebpSticker };
