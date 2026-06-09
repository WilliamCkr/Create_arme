import path from "node:path";
import { access, readFile, writeFile } from "node:fs/promises";
import { loadConfig, DEFAULT_CONFIG_PATH, resolveOutputDir } from "../lib/config.mjs";
import { ensureDir } from "../lib/paths.mjs";
import { buildAtlasImage } from "../lib/atlas.mjs";
import { buildWeaponManifest, frameFileNameForAngle } from "../lib/manifest.mjs";

function resolveConfigPathFromArgs(argv) {
  const configFlagIndex = argv.indexOf("--config");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) {
    return argv[configFlagIndex + 1];
  }
  const positional = argv.find((value) => !value.startsWith("-"));
  return positional ?? DEFAULT_CONFIG_PATH;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const configPath = resolveConfigPathFromArgs(process.argv.slice(2));
  const { config, configPath: resolvedConfigPath } = await loadConfig(configPath);
  const outputDir = resolveOutputDir(resolvedConfigPath, config);
  const framesDir = path.join(outputDir, "frames");
  const atlasPath = path.join(outputDir, "atlas.png");
  const manifestPath = path.join(outputDir, "weapon.manifest.json");

  await ensureDir(outputDir);

  const angles = config.angles ?? [];
  if (!Array.isArray(angles) || angles.length === 0) {
    throw new Error("Config angles array is missing or empty.");
  }

  const framePaths = [];
  const missingFrames = [];
  for (const angle of angles) {
    const frameName = frameFileNameForAngle(angle);
    const framePath = path.join(framesDir, frameName);
    if (!(await pathExists(framePath))) {
      missingFrames.push(framePath);
    }
    framePaths.push(framePath);
  }

  if (missingFrames.length > 0) {
    throw new Error(`Missing expected frames:\n${missingFrames.map((file) => `- ${file}`).join("\n")}`);
  }

  const expectedCells = config.atlas.columns * config.atlas.rows;
  if (expectedCells !== framePaths.length) {
    throw new Error(`Atlas grid mismatch: atlas has ${expectedCells} cells but config has ${framePaths.length} angles.`);
  }

  await buildAtlasImage({
    framePaths,
    frameSize: config.frameSize,
    columns: config.atlas.columns,
    rows: config.atlas.rows,
    outputPath: atlasPath
  });

  const manifest = buildWeaponManifest({ config });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(`Atlas written to ${atlasPath}`);
  console.log(`Manifest written to ${manifestPath}`);
}

main().catch((error) => {
  console.error("Atlas build failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
