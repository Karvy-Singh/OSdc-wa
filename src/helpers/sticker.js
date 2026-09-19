const sharp = require("sharp");

async function renderWebpSticker(buffer, animated) {
  const image = sharp(buffer, { animated: Boolean(animated) });

  if (!animated) {
    return image
      .resize(160, 160, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  }

  return image
    .resize(160, 160, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .gif({ effort: 3, colours: 128, keepDuplicateFrames: true })
    .toBuffer();
}

module.exports = { renderWebpSticker };
