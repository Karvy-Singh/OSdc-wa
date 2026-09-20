const sharp = require("sharp");

async function renderWebpSticker(buffer, animated) {
  const image = sharp(buffer, { animated: Boolean(animated) });

  const resized = image.resize(160, 160, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
    withoutEnlargement: true,
  });

  if (!animated) {
    return resized
      .png()
      .toBuffer();
  }

  return resized
    .gif({
      effort: 3,
      colours: 128,
      keepDuplicateFrames: true,
    })
    .toBuffer();
}

module.exports = { renderWebpSticker };
