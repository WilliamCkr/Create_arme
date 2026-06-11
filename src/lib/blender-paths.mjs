import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { resolveProjectPath } from "./paths.mjs";

function normalizeCandidate(candidate) {
  if (!candidate || typeof candidate !== "string") {
    return null;
  }
  return candidate.trim().replace(/^["']|["']$/g, "");
}

function pushCandidate(candidates, candidate, source) {
  const normalized = normalizeCandidate(candidate);
  if (!normalized) {
    return;
  }

  if (candidates.some((entry) => entry.path === normalized)) {
    return;
  }

  candidates.push({ path: normalized, source });
}

function addWindowsBlenderCandidates(candidates) {
  const roots = [
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : null
  ].filter(Boolean);

  for (const root of roots) {
    const foundationDir = path.join(root, "Blender Foundation");
    if (!existsSync(foundationDir)) {
      continue;
    }

    try {
      for (const entry of readdirSync(foundationDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }

        if (!/^Blender/i.test(entry.name)) {
          continue;
        }

        pushCandidate(
          candidates,
          path.join(foundationDir, entry.name, "blender.exe"),
          "Windows Blender install"
        );
      }
    } catch {
      // Ignore unreadable folders.
    }
  }
}

export function getBlenderCandidates() {
  const candidates = [];

  pushCandidate(candidates, process.env.BLENDER_PATH, "BLENDER_PATH");

  pushCandidate(
    candidates,
    resolveProjectPath("tools", "blender", "blender-4.5.1-windows-x64", "blender.exe"),
    "project portable Blender"
  );

  pushCandidate(
    candidates,
    resolveProjectPath("tools", "blender", "blender.exe"),
    "project Blender"
  );

  addWindowsBlenderCandidates(candidates);

  return candidates;
}

export function resolveBlenderBinary() {
  for (const candidate of getBlenderCandidates()) {
    if (existsSync(candidate.path)) {
      return candidate.path;
    }
  }

  return getBlenderCandidates()[0]?.path ?? "blender";
}

export function resolveBlenderSource() {
  const resolved = resolveBlenderBinary();
  const found = getBlenderCandidates().find((candidate) => candidate.path === resolved);
  return found?.source ?? "unknown";
}

export function resolveBlenderScriptPath(...parts) {
  return resolveProjectPath("blender", ...parts);
}
