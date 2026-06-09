import path from "node:path";
import sharp from "sharp";
import { loadConfig, DEFAULT_CONFIG_PATH, resolveOutputDir } from "../lib/config.mjs";
import { ensureDir } from "../lib/paths.mjs";
import { frameFileNameForAngle } from "../lib/manifest.mjs";

function resolveConfigPathFromArgs(argv) {
  const configFlagIndex = argv.indexOf("--config");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) {
    return argv[configFlagIndex + 1];
  }
  const positional = argv.find((value) => !value.startsWith("-"));
  return positional ?? DEFAULT_CONFIG_PATH;
}

function swordSvg(angle, width, height) {
  const cx = width / 2;
  const cy = height / 2;
  return `
  <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="blade" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#d9dde6" stop-opacity="0.95"/>
        <stop offset="50%" stop-color="#9ca8ba" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="#f7fbff" stop-opacity="0.95"/>
      </linearGradient>
      <linearGradient id="hilt" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#5a341e"/>
        <stop offset="100%" stop-color="#2d1b12"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="transparent"/>
    <g transform="translate(${cx} ${cy}) rotate(${angle}) translate(${-cx} ${-cy})">
      <path d="M ${cx - 14} ${cy + 120}
               L ${cx + 14} ${cy + 120}
               L ${cx + 20} ${cy - 36}
               L ${cx + 8} ${cy - 160}
               L ${cx - 8} ${cy - 160}
               L ${cx - 20} ${cy - 36}
               Z"
            fill="url(#blade)" stroke="#51555f" stroke-width="3" />
      <rect x="${cx - 34}" y="${cy + 90}" width="68" height="20" rx="6" fill="#a67c52" stroke="#4c3020" stroke-width="3"/>
      <rect x="${cx - 10}" y="${cy + 108}" width="20" height="70" rx="8" fill="url(#hilt)" stroke="#1a120d" stroke-width="3"/>
      <circle cx="${cx}" cy="${cy + 98}" r="9" fill="#d4b26c" stroke="#6a531f" stroke-width="3"/>
    </g>
    <g>
      <rect x="18" y="18" width="120" height="42" rx="10" fill="rgba(0,0,0,0.35)"/>
      <text x="34" y="46" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="700">${String(angle).padStart(3, "0")}°</text>
    </g>
  </svg>`;
}

async function main() {
  const configPath = resolveConfigPathFromArgs(process.argv.slice(2));
  const { config, configPath: resolvedConfigPath } = await loadConfig(configPath);
  const outputDir = resolveOutputDir(resolvedConfigPath, config);
  const framesDir = path.join(outputDir, "frames");

  await ensureDir(framesDir);

  const width = config.frameSize.width;
  const height = config.frameSize.height;
  const angles = config.angles ?? [];

  if (!Array.isArray(angles) || angles.length === 0) {
    throw new Error("Config angles array is missing or empty.");
  }

  for (const angle of angles) {
    const fileName = frameFileNameForAngle(angle);
    const outputPath = path.join(framesDir, fileName);
    const svg = swordSvg(angle, width, height);
    await sharp(Buffer.from(svg)).png().toFile(outputPath);
    console.log(`Wrote ${outputPath}`);
  }

  console.log(`Placeholder frames created in ${framesDir}`);
}

main().catch((error) => {
  console.error("Placeholder generation failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

