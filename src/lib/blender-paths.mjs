import { resolveProjectPath } from "./paths.mjs";

export function resolveBlenderBinary() {
  const envPath = process.env.BLENDER_PATH;
  if (envPath && envPath.length > 0) {
    return envPath;
  }
  return resolveProjectPath("tools", "blender", "blender-4.5.1-windows-x64", "blender.exe");
}

export function resolveBlenderScriptPath(...parts) {
  return resolveProjectPath("blender", ...parts);
}
