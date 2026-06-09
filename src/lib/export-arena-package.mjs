import path from "node:path";
import { access, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolveProjectPath } from "./paths.mjs";
import { validateManifestObject } from "./validation.mjs";

function projectRelative(filePath) {
  return path.relative(resolveProjectPath(), filePath).replace(/\\/g, "/");
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithinRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

async function readFileInfo(filePath) {
  const fileExists = await exists(filePath);
  if (!fileExists) {
    return {
      exists: false,
      path: projectRelative(filePath),
      size: null,
      modifiedTime: null,
      url: `/api/file?path=${encodeURIComponent(projectRelative(filePath))}`
    };
  }
  const fileStats = await stat(filePath);
  return {
    exists: true,
    path: projectRelative(filePath),
    size: fileStats.size,
    modifiedTime: fileStats.mtime.toISOString(),
    url: `/api/file?path=${encodeURIComponent(projectRelative(filePath))}`
  };
}

async function copyTrackedFile({ sourcePath, destinationPath, copiedFiles }) {
  await ensureDir(path.dirname(destinationPath));
  await copyFile(sourcePath, destinationPath);
  copiedFiles.push({
    source: projectRelative(sourcePath),
    destination: projectRelative(destinationPath)
  });
}

function parseReadmeTimestamp(readmeText) {
  const match = readmeText.match(/^Generated timestamp:\s*(.+)$/im);
  return match?.[1]?.trim() ?? null;
}

function buildReadme({
  config,
  exportedAt,
  sourceOutputDir,
  exportDir,
  copiedFileCount
}) {
  const frameCount = Array.isArray(config.angles) ? config.angles.length : 0;
  const frameSize = config.frameSize ?? {};
  const lines = [
    "# Arena Bloodline Weapon Atlas Package",
    "",
    `Weapon id: ${config.id ?? "unknown"}`,
    `Generated timestamp: ${exportedAt}`,
    `Source image path: ${config.sourceTexture ?? "unknown"}`,
    `Input GLB path: ${config.inputModel ?? "unknown"}`,
    `Render mode: ${config.renderMode ?? "unknown"}`,
    `Angle count: ${frameCount}`,
    `Frame size: ${frameSize.width ?? "unknown"} x ${frameSize.height ?? "unknown"}`,
    "Intended use: Arena Bloodline weapon atlas package",
    "",
    `Source output directory: ${projectRelative(sourceOutputDir)}`,
    `Export directory: ${projectRelative(exportDir)}`,
    `Copied file count: ${copiedFileCount}`,
    ""
  ];

  return `${lines.join("\n")}\n`;
}

export function resolveArenaExportDir(config) {
  const exportId = config?.id ?? "cursed_sword";
  return resolveProjectPath("arena-export", exportId);
}

export async function readArenaExportPackageInfo({ config }) {
  const sourceOutputDir = resolveProjectPath(config.outputDir ?? "output");
  const exportDir = resolveArenaExportDir(config);
  const atlasPath = path.join(exportDir, "atlas.png");
  const manifestPath = path.join(exportDir, "weapon.manifest.json");
  const renderUiStatePath = path.join(exportDir, "render-ui-state.json");
  const readmePath = path.join(exportDir, "README.md");

  const atlasExists = await exists(atlasPath);
  const manifestExists = await exists(manifestPath);
  const renderUiStateExists = await exists(renderUiStatePath);
  const readmeExists = await exists(readmePath);

  let manifestData = null;
  if (manifestExists) {
    try {
      const rawManifest = await readFile(manifestPath, "utf8");
      manifestData = JSON.parse(rawManifest);
    } catch {
      manifestData = null;
    }
  }

  const exportFrameRecords = Array.isArray(manifestData?.angleFrames)
    ? await Promise.all(manifestData.angleFrames.map(async (entry) => {
        const relativeFramePath = entry?.src;
        if (typeof relativeFramePath !== "string" || relativeFramePath.length === 0) {
          return { path: null, exists: false };
        }
        const sourceFramePath = path.join(exportDir, relativeFramePath);
        const safeSourcePath = isWithinRoot(exportDir, sourceFramePath) ? sourceFramePath : null;
        if (!safeSourcePath) {
          return { path: relativeFramePath, exists: false };
        }
        return {
          path: relativeFramePath,
          exists: await exists(safeSourcePath)
        };
      }))
    : [];

  const exportFrameCount = exportFrameRecords.filter((entry) => entry.exists).length;
  const readmeText = readmeExists ? await readFile(readmePath, "utf8") : null;
  const lastExportTimestamp = readmeText ? parseReadmeTimestamp(readmeText) : null;

  const copiedFileCount = [
    atlasExists,
    manifestExists,
    renderUiStateExists,
    readmeExists,
    ...exportFrameRecords.map((entry) => entry.exists)
  ].filter(Boolean).length;

  return {
    path: projectRelative(exportDir),
    exists: atlasExists && manifestExists,
    atlas: {
      ...(await readFileInfo(atlasPath)),
      exists: atlasExists
    },
    manifest: {
      ...(await readFileInfo(manifestPath)),
      exists: manifestExists,
      data: manifestData
    },
    renderUiState: {
      ...(await readFileInfo(renderUiStatePath)),
      exists: renderUiStateExists
    },
    readme: {
      ...(await readFileInfo(readmePath)),
      exists: readmeExists
    },
    frameCount: exportFrameCount,
    copiedFileCount,
    lastExportTimestamp
  };
}

export async function exportArenaPackage({ config }) {
  const sourceOutputDir = resolveProjectPath(config.outputDir ?? "output");
  const exportDir = resolveArenaExportDir(config);
  const exportFramesDir = path.join(exportDir, "frames");
  const atlasSourcePath = path.join(sourceOutputDir, "atlas.png");
  const manifestSourcePath = path.join(sourceOutputDir, "weapon.manifest.json");
  const renderUiStateSourcePath = path.join(sourceOutputDir, "render-ui-state.json");
  const atlasDestinationPath = path.join(exportDir, "atlas.png");
  const manifestDestinationPath = path.join(exportDir, "weapon.manifest.json");
  const renderUiStateDestinationPath = path.join(exportDir, "render-ui-state.json");
  const readmeDestinationPath = path.join(exportDir, "README.md");

  if (!isWithinRoot(resolveProjectPath(), exportDir)) {
    throw new Error(`Export path is not within the project: ${projectRelative(exportDir)}`);
  }

  await ensureDir(exportFramesDir);

  if (!(await exists(atlasSourcePath))) {
    throw new Error(`Atlas file is missing: ${projectRelative(atlasSourcePath)}`);
  }
  if (!(await exists(manifestSourcePath))) {
    throw new Error(`Manifest file is missing: ${projectRelative(manifestSourcePath)}`);
  }

  let manifest;
  try {
    const rawManifest = await readFile(manifestSourcePath, "utf8");
    manifest = JSON.parse(rawManifest);
  } catch (error) {
    throw new Error(`Unable to read manifest JSON: ${projectRelative(manifestSourcePath)}\n${error instanceof Error ? error.message : String(error)}`);
  }

  const manifestErrors = await validateManifestObject(manifest, { manifestPath: manifestSourcePath });
  if (manifestErrors.length > 0) {
    throw new Error(`Manifest validation failed:\n${manifestErrors.map((entry) => `- ${entry}`).join("\n")}`);
  }

  const copiedFiles = [];
  await copyTrackedFile({
    sourcePath: atlasSourcePath,
    destinationPath: atlasDestinationPath,
    copiedFiles
  });
  await copyTrackedFile({
    sourcePath: manifestSourcePath,
    destinationPath: manifestDestinationPath,
    copiedFiles
  });

  if (await exists(renderUiStateSourcePath)) {
    await copyTrackedFile({
      sourcePath: renderUiStateSourcePath,
      destinationPath: renderUiStateDestinationPath,
      copiedFiles
    });
  }

  for (const entry of manifest.angleFrames ?? []) {
    if (!entry || typeof entry.src !== "string" || entry.src.length === 0) {
      continue;
    }
    const sourceFramePath = path.join(sourceOutputDir, entry.src);
    const destinationFramePath = path.join(exportDir, entry.src);
    if (!isWithinRoot(sourceOutputDir, sourceFramePath)) {
      throw new Error(`Frame source is outside the output directory: ${entry.src}`);
    }
    if (!isWithinRoot(exportDir, destinationFramePath)) {
      throw new Error(`Frame destination is outside the export directory: ${entry.src}`);
    }
    if (!(await exists(sourceFramePath))) {
      throw new Error(`Missing frame referenced by manifest: ${projectRelative(sourceFramePath)}`);
    }
    await copyTrackedFile({
      sourcePath: sourceFramePath,
      destinationPath: destinationFramePath,
      copiedFiles
    });
  }

  const exportedAt = new Date().toISOString();
  const readme = buildReadme({
    config,
    exportedAt,
    sourceOutputDir,
    exportDir,
    copiedFileCount: copiedFiles.length + 1
  });
  await writeFile(readmeDestinationPath, readme, "utf8");
  copiedFiles.push({
    source: "(generated)",
    destination: projectRelative(readmeDestinationPath)
  });

  return {
    ok: true,
    exportPath: projectRelative(exportDir),
    exportedAt,
    copiedFileCount: copiedFiles.length,
    copiedFiles,
    atlasPath: projectRelative(atlasDestinationPath),
    manifestPath: projectRelative(manifestDestinationPath),
    renderUiStatePath: (await exists(renderUiStateSourcePath))
      ? projectRelative(renderUiStateDestinationPath)
      : null,
    readmePath: projectRelative(readmeDestinationPath)
  };
}
