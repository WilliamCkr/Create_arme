import { access } from "node:fs/promises";
import { DEFAULT_CONFIG_PATH, loadConfig } from "../lib/config.mjs";
import { resolveBlenderBinary } from "../lib/blender-paths.mjs";
import { runHunyuanMeshBlenderTexturePipeline } from "../lib/hunyuan-pipeline.mjs";

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

  const blenderBinary = resolveBlenderBinary();
  if (!(await pathExists(blenderBinary))) {
    throw new Error(`Blender was not found: ${blenderBinary}`);
  }

  const result = await runHunyuanMeshBlenderTexturePipeline({
    config: {
      ...config,
      configPath: resolvedConfigPath
    },
    emitLog: (level, source, message) => {
      const prefix = `${source}:${level}`;
      console.log(`[${prefix}] ${message}`);
    }
  });

  console.log(`Hunyuan pipeline output: ${result.outputDir}`);
  console.log(`Textured GLB: ${result.texturedGlbPath}`);
  console.log(`Active model: ${result.activeModelPath}`);
  console.log(`Mesh provider: ${result.meshProvider}`);
}

main().catch((error) => {
  console.error("Hunyuan pipeline failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
