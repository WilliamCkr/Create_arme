import path from "node:path";
import { access } from "node:fs/promises";
import { requiredManifestFields } from "./manifest.mjs";

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function validateManifestObject(manifest, { manifestPath }) {
  const errors = [];

  for (const field of requiredManifestFields()) {
    if (manifest[field] === undefined || manifest[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (manifest.frameSize) {
    const { width, height } = manifest.frameSize;
    if (!(typeof width === "number" && width > 0)) {
      errors.push("frameSize.width must be a positive number");
    }
    if (!(typeof height === "number" && height > 0)) {
      errors.push("frameSize.height must be a positive number");
    }
  }

  if (manifest.pivot) {
    const { x, y } = manifest.pivot;
    if (typeof x !== "number") {
      errors.push("pivot.x must be a number");
    }
    if (typeof y !== "number") {
      errors.push("pivot.y must be a number");
    }
  }

  if (!Array.isArray(manifest.angleFrames) || manifest.angleFrames.length === 0) {
    errors.push("angleFrames must be a non-empty array");
  } else {
    const seenAngles = new Set();
    manifest.angleFrames.forEach((entry, index) => {
      if (entry == null || typeof entry !== "object") {
        errors.push(`angleFrames[${index}] must be an object`);
        return;
      }
      if (typeof entry.angle !== "number") {
        errors.push(`angleFrames[${index}].angle must be a number`);
      } else if (seenAngles.has(entry.angle)) {
        errors.push(`Duplicate angle detected: ${entry.angle}`);
      } else {
        seenAngles.add(entry.angle);
      }
      if (entry.frame !== index) {
        errors.push(`angleFrames[${index}].frame must be sequential and equal ${index}`);
      }
      if (typeof entry.src !== "string" || entry.src.length === 0) {
        errors.push(`angleFrames[${index}].src must be a non-empty string`);
      }
    });
  }

  const manifestDir = path.dirname(manifestPath);
  if (manifest.atlas && typeof manifest.atlas === "string") {
    const atlasPath = path.resolve(manifestDir, manifest.atlas);
    if (!(await pathExists(atlasPath))) {
      errors.push(`Atlas file does not exist: ${atlasPath}`);
    }
  }

  if (Array.isArray(manifest.angleFrames)) {
    for (const entry of manifest.angleFrames) {
      if (!entry || typeof entry.src !== "string") {
        continue;
      }
      const framePath = path.resolve(manifestDir, entry.src);
      if (!(await pathExists(framePath))) {
        errors.push(`Missing frame source: ${framePath}`);
      }
    }
  }

  return errors;
}

