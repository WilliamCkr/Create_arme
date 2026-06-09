import { DEFAULT_CONFIG_PATH, loadConfig } from "../lib/config.mjs";
import { exportArenaPackage } from "../lib/export-arena-package.mjs";

function resolveConfigPathFromArgs(argv) {
  const configFlagIndex = argv.indexOf("--config");
  if (configFlagIndex >= 0 && argv[configFlagIndex + 1]) {
    return argv[configFlagIndex + 1];
  }
  const positional = argv.find((value) => !value.startsWith("-"));
  return positional ?? DEFAULT_CONFIG_PATH;
}

async function main() {
  const configPath = resolveConfigPathFromArgs(process.argv.slice(2));
  const { config, configPath: resolvedConfigPath } = await loadConfig(configPath);
  const result = await exportArenaPackage({ config, configPath: resolvedConfigPath });

  console.log(`Arena package exported to ${result.exportPath}`);
  console.log(`Copied files: ${result.copiedFileCount}`);
  for (const file of result.copiedFiles) {
    console.log(`- ${file.destination}`);
  }
}

main().catch((error) => {
  console.error("Arena package export failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
