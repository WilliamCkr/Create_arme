import path from "node:path";
import { mkdir } from "node:fs/promises";

export function projectRoot() {
  return process.cwd();
}

export function resolveProjectPath(...parts) {
  return path.resolve(projectRoot(), ...parts);
}

export function resolveFromProject(value) {
  return path.isAbsolute(value) ? value : resolveProjectPath(value);
}

export function pathForConfigFile(configPath) {
  return resolveFromProject(configPath);
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

export function parentDir(filePath) {
  return path.dirname(filePath);
}

