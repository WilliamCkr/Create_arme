import { spawnSync } from "node:child_process";
import { DEFAULT_CONFIG_PATH, loadConfig, resolveOutputDir } from "../lib/config.mjs";
import { ensureDir } from "../lib/paths.mjs";
import { resolveBlenderBinary, resolveBlenderSource } from "../lib/blender-paths.mjs";

function printBanner(title) {
  console.log(`\n${title}`);
}

function resolveConfigPathFromArgs(argv) {
  const configFlagIndex = argv.indexOf("--config");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) {
    return argv[configFlagIndex + 1];
  }
  const positional = argv.find((value) => !value.startsWith("-"));
  return positional ?? DEFAULT_CONFIG_PATH;
}

function detectNpmVersion() {
  const userAgent = process.env.npm_config_user_agent;
  if (userAgent) {
    const match = userAgent.match(/npm\/([^\s]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

async function main() {
  printBanner("Arena Object Forge environment check");
  console.log(`Node: ${process.version}`);

  const npmVersion = detectNpmVersion();
  if (npmVersion) {
    console.log(`npm: ${npmVersion}`);
  } else {
    console.log("npm: unavailable");
  }

  const blenderCommand = resolveBlenderBinary();
  const blenderResult = spawnSync(blenderCommand, ["--version"], {
    encoding: "utf8",
    windowsHide: true
  });

  if (blenderResult.status === 0) {
    const versionLine = blenderResult.stdout.split(/\r?\n/).find(Boolean) ?? "available";
    console.log(`Blender: ${versionLine} (${resolveBlenderSource()})`);
    console.log(`Blender path: ${blenderCommand}`);
  } else {
    console.warn(`Warning: Blender was not found for Retexture Only.`);
    console.warn(`Expected path: ${blenderCommand}`);
    console.warn("Install Blender or set BLENDER_PATH before launching the UI.");
  }

  const configPath = resolveConfigPathFromArgs(process.argv.slice(2));
  const { config, configPath: resolvedConfigPath } = await loadConfig(configPath);
  console.log(`Config loaded: ${resolvedConfigPath}`);

  const outputDir = resolveOutputDir(resolvedConfigPath, config);
  await ensureDir(outputDir);
  console.log(`Output directory ready: ${outputDir}`);

  console.log("Environment check complete.");
}

main().catch((error) => {
  console.error("Environment check failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
