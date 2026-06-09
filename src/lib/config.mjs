import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathForConfigFile, resolveProjectPath } from "./paths.mjs";

export const DEFAULT_CONFIG_PATH = resolveProjectPath("configs", "cursed_sword.example.json");

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  const resolvedPath = pathForConfigFile(configPath);
  const raw = await readFile(resolvedPath, "utf8");
  const config = JSON.parse(raw);
  return { config, configPath: resolvedPath };
}

export function resolveConfigRelativePath(configPath, value) {
  if (!value) {
    return value;
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(path.dirname(configPath), "..", value);
}

export function resolveOutputDir(configPath, config) {
  const outputDirValue = config.outputDir ?? "output";
  if (path.isAbsolute(outputDirValue)) {
    return outputDirValue;
  }
  return resolveProjectPath(outputDirValue);
}

export function resolveInputModelPath(configPath, config) {
  return resolveConfigRelativePath(configPath, config.inputModel);
}

