const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { unzipSync } = require("node:zlib");
const { unzipSync: unzipArchiveSync } = require("fflate");
const sharp = require("sharp");

const MAX_SIZE = 256;
const MAX_FPS = 30;
const MAX_FRAMES = 90;

let rendererAssetsPromise;
let renderQueue = Promise.resolve();

async function createRenderer() {
  if (!rendererAssetsPromise) {
    const wasmPath = require.resolve("rlottie/wasm");
    rendererAssetsPromise = Promise.all([
      import(pathToFileURL(path.join(path.dirname(wasmPath), "rlottie.js"))),
      readFile(wasmPath),
    ]).then(([{ default: createModule }, wasm]) => ({
      createModule,
      wasmURL: `data:application/wasm;base64,${wasm.toString("base64")}`,
    }));
  }

  const { createModule, wasmURL } = await rendererAssetsPromise;
  const module = await createModule({ locateFile: () => wasmURL });
  return {
    init: module.cwrap("lottie_init", "number", []),
    destroy: module.cwrap("lottie_destroy", null, ["number"]),
    resize: module.cwrap("lottie_resize", null, ["number", "number", "number"]),
    buffer: module.cwrap("lottie_buffer", "number", ["number"]),
    render: module.cwrap("lottie_render", null, ["number", "number"]),
    load: module.cwrap("lottie_load_from_data", "number", ["number"]),
    heap: module.HEAPU8,
    malloc: module._malloc,
  };
}

function decodeLottie(buffer) {
  let json = buffer;
  const firstByte = buffer.find((byte) => byte > 0x20);

  if (buffer.subarray(0, 4).equals(Buffer.from("PK\x03\x04"))) {
    const files = unzipArchiveSync(buffer);
    json = files["animation/animation.json"];
    if (!json) throw new Error("WhatsApp Lottie archive has no animation.json");
    json = Buffer.from(json);
  } else if (firstByte !== 0x7b && firstByte !== 0x5b) {
    json = unzipSync(buffer);
  }

  const text = json.toString("utf8");
  return { data: JSON.parse(text), text };
}

async function renderLottieGif(buffer) {
  const pending = renderQueue.then(async () => {
    const { data, text } = decodeLottie(buffer);
    const sourceFps = Math.max(Number(data.fr) || MAX_FPS, 1);
    const duration = Math.max(
      ((Number(data.op) || 1) - (Number(data.ip) || 0)) / sourceFps,
      1 / sourceFps
    );
    const fps = Math.min(sourceFps, MAX_FPS);
    const renderer = await createRenderer();
    const renderHandle = renderer.init();
    const json = Buffer.from(`${text}\0`);
    const jsonPointer = renderer.malloc(json.length);
    renderer.heap.set(json, jsonPointer);

    const sourceFrames = renderer.load(renderHandle, jsonPointer);
    if (!sourceFrames) throw new Error("Lottie animation has no frames");

    const scale = Math.min(
      MAX_SIZE / Math.max(Number(data.w) || MAX_SIZE, 1),
      MAX_SIZE / Math.max(Number(data.h) || MAX_SIZE, 1),
      1
    );
    const width = Math.max(1, Math.round((Number(data.w) || MAX_SIZE) * scale));
    const height = Math.max(1, Math.round((Number(data.h) || MAX_SIZE) * scale));
    const frameCount = Math.min(
      Math.max(1, Math.ceil(duration * fps)),
      sourceFrames,
      MAX_FRAMES
    );
    const delay = Math.max(20, Math.round((duration * 1000) / frameCount));
    const frames = Buffer.alloc(width * height * 4 * frameCount);

    renderer.resize(renderHandle, width, height);
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sourceFrame = Math.min(
        sourceFrames - 1,
        Math.floor((frame * sourceFrames) / frameCount)
      );
      renderer.render(renderHandle, sourceFrame);
      const start = renderer.buffer(renderHandle);
      frames.set(
        renderer.heap.subarray(start, start + width * height * 4),
        frame * width * height * 4
      );
    }
    renderer.destroy(renderHandle);

    return sharp(frames, {
      raw: {
        width,
        height: height * frameCount,
        channels: 4,
        pageHeight: height,
      },
      animated: true,
    })
      .gif({
        delay,
        loop: 0,
        effort: 3,
        colours: 128,
        keepDuplicateFrames: true,
      })
      .toBuffer();
  });

  renderQueue = pending.catch(() => {});
  return pending;
}

module.exports = { renderLottieGif };
