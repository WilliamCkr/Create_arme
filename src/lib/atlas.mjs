import sharp from "sharp";
import path from "node:path";
import { readFile } from "node:fs/promises";

export async function buildAtlasImage({
  framePaths,
  frameSize,
  columns,
  rows,
  outputPath
}) {
  const atlasWidth = columns * frameSize.width;
  const atlasHeight = rows * frameSize.height;
  const composites = [];

  for (let index = 0; index < framePaths.length; index += 1) {
    const framePath = framePaths[index];
    const x = (index % columns) * frameSize.width;
    const y = Math.floor(index / columns) * frameSize.height;
    const buffer = await sharp(framePath)
      .resize(frameSize.width, frameSize.height, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png()
      .toBuffer();

    composites.push({ input: buffer, left: x, top: y });
  }

  await sharp({
    create: {
      width: atlasWidth,
      height: atlasHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite(composites)
    .png()
    .toFile(outputPath);

  return { width: atlasWidth, height: atlasHeight };
}

export async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

