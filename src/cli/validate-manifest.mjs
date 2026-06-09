import path from "node:path";
import { readFile } from "node:fs/promises";
import { validateManifestObject } from "../lib/validation.mjs";

function resolveManifestPathFromArgs(argv) {
  const manifestFlagIndex = argv.indexOf("--manifest");
  if (manifestFlagIndex >= 0 && argv[manifestFlagIndex + 1]) {
    return argv[manifestFlagIndex + 1];
  }
  const positional = argv.find((value) => !value.startsWith("-"));
  return positional ?? path.resolve("output", "cursed_sword", "weapon.manifest.json");
}

async function main() {
  const manifestPath = resolveManifestPathFromArgs(process.argv.slice(2));
  let manifest;
  try {
    const raw = await readFile(manifestPath, "utf8");
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Unable to read manifest: ${manifestPath}\n${error instanceof Error ? error.message : String(error)}`);
  }

  const errors = await validateManifestObject(manifest, { manifestPath });
  if (errors.length > 0) {
    console.error(`Manifest validation failed for ${manifestPath}`);
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Manifest valid: ${manifestPath}`);
}

main().catch((error) => {
  console.error("Manifest validation failed:");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
