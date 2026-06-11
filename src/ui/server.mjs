import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { buildAtlasImage } from "../lib/atlas.mjs";
import { resolveBlenderBinary } from "../lib/blender-paths.mjs";
import { exportArenaPackage, readArenaExportPackageInfo } from "../lib/export-arena-package.mjs";
import {
  resolveHunyuanBakedTexturePath,
  resolveHunyuanMeshPath,
  resolveHunyuanOutputDir,
  resolveHunyuanOutputMeshPath,
  resolveHunyuanReportPath,
  resolveHunyuanTexturedGlbPath,
  runHunyuanMeshBlenderTexturePipeline,
  runHunyuanStep2TextureOnly
} from "../lib/hunyuan-pipeline.mjs";
import { buildWeaponManifest, frameFileNameForAngle } from "../lib/manifest.mjs";
import { resolveProjectPath } from "../lib/paths.mjs";
import { validateManifestObject } from "../lib/validation.mjs";

const projectRoot = resolveProjectPath();
const exampleConfigPath = resolveProjectPath("configs", "cursed_sword.example.json");
const uiConfigPath = resolveProjectPath("configs", "cursed_sword.ui.json");
const sf3dPythonPath = resolveProjectPath("tools", "sf3d-env", "python.exe");
const sf3dRunPath = resolveProjectPath("tools", "sf3d", "run.py");
const blenderScriptPath = resolveProjectPath("blender", "render_weapon_angles.py");
const blenderRoot = resolveProjectPath("tools", "blender");
const inputDir = resolveProjectPath("input");
const outputDirRoot = resolveProjectPath("output");
const configDir = resolveProjectPath("configs");
const arenaExportDirRoot = resolveProjectPath("arena-export");
const safeFileRoots = [inputDir, outputDirRoot, configDir, arenaExportDirRoot];
const uiPublicDir = resolveProjectPath("src", "ui", "public");
const sourceImageRelPath = "input/cursed_sword_source.png";
const inputModelRelPath = "input/cursed_sword.glb";
const sf3dGlbRelPath = "output/sf3d_cursed_sword/0/mesh.glb";
const renderUiStateRelPath = (outputDir) => path.join(outputDir, "render-ui-state.json");
const defaultUiConfig = {
  pipelineMode: "sf3d_full",
  sf3d: {
    foregroundRatio: 0.85,
    textureResolution: 2048,
    remeshOption: "none",
    targetVertexCount: -1
  },
  hunyuan: {
    meshProvider: "placeholder",
    runnerCommand: "node",
    runnerArgs: ["tools/hunyuan3d/launch-hunyuan3d.mjs", "--model-id", "tencent/Hunyuan3D-2"],
    outputDir: "output/hunyuan_cursed_sword",
    outputMesh: "output/hunyuan_cursed_sword/mesh.glb",
    textureBakeResolution: 2048,
    projectionMode: "smart_uv"
  },
  renderMode: "turntable_3d",
  sf3dOutputDir: "output/sf3d_cursed_sword"
};
const defaultAngles = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const clients = new Set();
const state = {
  config: null,
  logs: [],
  busy: false,
  toolStatus: null,
  port: null,
  activeJob: null,
  lastJobStatus: {},
  lastExport: null,
  validationState: "unchecked",
  lastHunyuan: null
};

function isWithinRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureAllowedRelativePath(relPath) {
  if (!relPath || typeof relPath !== "string") {
    throw new Error("Missing file path.");
  }
  if (path.isAbsolute(relPath)) {
    throw new Error("Absolute paths are not allowed.");
  }
  const absolutePath = path.resolve(projectRoot, relPath);
  const allowed = safeFileRoots.some((root) => isWithinRoot(root, absolutePath));
  if (!allowed) {
    throw new Error(`Path is not in an allowed project area: ${relPath}`);
  }
  return absolutePath;
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function ensureDirExists(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

function normalizeAngles(values) {
  if (!Array.isArray(values)) {
    return defaultAngles;
  }
  const angles = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  return angles.length > 0 ? angles : defaultAngles;
}

function stageBadgeState(fileExists, stageName) {
  if (state.activeJob?.stage === stageName) {
    return "Running";
  }
  if (state.lastJobStatus?.[stageName] === "failed" && !fileExists) {
    return "Failed";
  }
  if (state.lastJobStatus?.[stageName] === "done" && fileExists) {
    return "Done";
  }
  return fileExists ? "Ready" : "Missing";
}

function manifestBadgeState(manifestValidation, manifestExists) {
  if (state.activeJob?.stage === "validate") {
    return "Running";
  }
  if (manifestValidation === "valid") {
    return "Done";
  }
  if (manifestValidation === "invalid") {
    return "Failed";
  }
  return manifestExists ? "Ready" : "Missing";
}

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toNonEmptyString(value, fallback) {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function toStringArrayOrFallback(value, fallback) {
  const filtered = Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  return filtered.length > 0 ? filtered : fallback;
}

function normalizeUiConfig(raw) {
  const hunyuanOutputDir = raw?.hunyuan?.outputDir ?? defaultUiConfig.hunyuan.outputDir;
  const hunyuanOutputMesh = raw?.hunyuan?.outputMesh ?? path.join(hunyuanOutputDir, "mesh.glb");
  const merged = {
    ...raw,
    sf3d: {
      ...defaultUiConfig.sf3d,
      ...((raw?.sf3d) ?? {}),
      foregroundRatio: toNumber(raw?.sf3d?.foregroundRatio, defaultUiConfig.sf3d.foregroundRatio),
      textureResolution: toNumber(raw?.sf3d?.textureResolution, defaultUiConfig.sf3d.textureResolution),
      remeshOption: raw?.sf3d?.remeshOption ?? defaultUiConfig.sf3d.remeshOption,
      targetVertexCount: toNumber(raw?.sf3d?.targetVertexCount, defaultUiConfig.sf3d.targetVertexCount)
    },
    pipelineMode: raw?.pipelineMode === "hunyuan_mesh_blender_texture" ? "hunyuan_mesh_blender_texture" : "sf3d_full",
    hunyuan: {
      ...defaultUiConfig.hunyuan,
      ...((raw?.hunyuan) ?? {}),
      meshProvider: raw?.hunyuan?.meshProvider === "external" ? "external" : "placeholder",
      runnerCommand: toNonEmptyString(raw?.hunyuan?.runnerCommand, defaultUiConfig.hunyuan.runnerCommand),
      runnerArgs: toStringArrayOrFallback(raw?.hunyuan?.runnerArgs, defaultUiConfig.hunyuan.runnerArgs),
      outputDir: hunyuanOutputDir,
      outputMesh: hunyuanOutputMesh,
      textureBakeResolution: toNumber(raw?.hunyuan?.textureBakeResolution, defaultUiConfig.hunyuan.textureBakeResolution),
      projectionMode: toNonEmptyString(raw?.hunyuan?.projectionMode, defaultUiConfig.hunyuan.projectionMode)
    },
    renderMode: raw?.renderMode === "gameplay_2d" ? "gameplay_2d" : "turntable_3d",
    sf3dOutputDir: raw?.sf3dOutputDir ?? defaultUiConfig.sf3dOutputDir,
    angles: normalizeAngles(raw?.angles),
    frameSize: {
      width: toNumber(raw?.frameSize?.width, 512),
      height: toNumber(raw?.frameSize?.height, 512)
    },
    atlas: {
      columns: toNumber(raw?.atlas?.columns, 4),
      rows: toNumber(raw?.atlas?.rows, 3)
    },
    camera: {
      mode: "orthographic",
      orthographicScale: toNumber(raw?.camera?.orthographicScale, 3.0)
    },
    render: {
      engine: raw?.render?.engine ?? "BLENDER_EEVEE_NEXT",
      resolution: toNumber(raw?.render?.resolution, 512),
      samples: toNumber(raw?.render?.samples, 64),
      transparentBackground: raw?.render?.transparentBackground !== false
    },
    materialOverride: {
      enabled: raw?.materialOverride?.enabled !== false,
      metallic: toNumber(raw?.materialOverride?.metallic, 0.15),
      roughness: toNumber(raw?.materialOverride?.roughness, 0.82),
      specular: toNumber(raw?.materialOverride?.specular, 0.25),
      clearcoat: toNumber(raw?.materialOverride?.clearcoat, 0)
    },
    lighting: {
      mode: raw?.lighting?.mode ?? "studio",
      strength: toNumber(raw?.lighting?.strength, 0.8)
    },
    pivot: {
      x: toNumber(raw?.pivot?.x, 256),
      y: toNumber(raw?.pivot?.y, 256),
      mode: raw?.pivot?.mode ?? "center"
    }
  };

  return merged;
}

async function ensureUiConfigFile() {
  if (await exists(uiConfigPath)) {
    return;
  }
  const example = await readJson(exampleConfigPath);
  const seed = normalizeUiConfig({
    ...example,
    ...defaultUiConfig
  });
  await writeFile(uiConfigPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
}

async function loadUiConfig() {
  await ensureUiConfigFile();
  const raw = await readJson(uiConfigPath);
  return normalizeUiConfig(raw);
}

async function saveUiConfig(config) {
  const normalized = normalizeUiConfig(config);
  await writeFile(uiConfigPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  state.config = normalized;
  return normalized;
}

function logEntry(level, source, message) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    level,
    source,
    message,
    timestamp: new Date().toISOString()
  };
}

function emitLog(level, source, message) {
  const entry = logEntry(level, source, message);
  state.logs.push(entry);
  if (state.logs.length > 500) {
    state.logs.splice(0, state.logs.length - 500);
  }
  const payload = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
  for (const response of clients) {
    response.write(payload);
  }
  return entry;
}

function emitStatus(status) {
  const payload = `event: status\ndata: ${JSON.stringify(status)}\n\n`;
  for (const response of clients) {
    response.write(payload);
  }
}

function streamToLogs(child, source) {
  const trackers = [
    { stream: child.stdout, level: "log", buffer: "" },
    { stream: child.stderr, level: "warn", buffer: "" }
  ];

  for (const tracker of trackers) {
    tracker.stream.on("data", (chunk) => {
      tracker.buffer += chunk.toString("utf8");
      const parts = tracker.buffer.split(/\r?\n/);
      tracker.buffer = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          emitLog(tracker.level, source, trimmed);
        }
      }
    });
  }

  return () => {
    for (const tracker of trackers) {
      const trimmed = tracker.buffer.trim();
      if (trimmed.length > 0) {
        emitLog(tracker.level, source, trimmed);
      }
      tracker.buffer = "";
    }
  };
}

function spawnLoggedProcess({ source, command, args, cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    emitLog("log", source, `Running ${command} ${args.join(" ")}`);

    let settled = false;
    const flush = streamToLogs(child, source);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      flush();
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      flush();
      if (code === 0) {
        emitLog("log", source, "Process finished successfully.");
        resolve({ code, signal });
        return;
      }
      const message = signal ? `Process exited with signal ${signal}` : `Process exited with code ${code}`;
      emitLog("error", source, message);
      reject(new Error(message));
    });
  });
}

async function readFileInfo(relPath) {
  try {
    const absPath = ensureAllowedRelativePath(relPath);
    const fileStats = await stat(absPath);
    return {
      exists: true,
      path: relPath,
      size: fileStats.size,
      modifiedTime: fileStats.mtime.toISOString(),
      url: `/api/file?path=${encodeURIComponent(relPath)}`
    };
  } catch {
    return {
      exists: false,
      path: relPath,
      size: null,
      modifiedTime: null,
      url: `/api/file?path=${encodeURIComponent(relPath)}`
    };
  }
}

async function readJsonFileInfo(relPath) {
  const info = await readFileInfo(relPath);
  if (!info.exists) {
    return { ...info, data: null };
  }
  try {
    const absPath = ensureAllowedRelativePath(relPath);
    const raw = await readFile(absPath, "utf8");
    return { ...info, data: JSON.parse(raw) };
  } catch {
    return { ...info, data: null };
  }
}

async function readOptionalJson(relPath) {
  const absPath = ensureAllowedRelativePath(relPath);
  if (!(await exists(absPath))) {
    return null;
  }
  try {
    const raw = await readFile(absPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function listFrameRecords(config) {
  const records = [];
  for (const angle of config.angles) {
    const relativePath = path.join(config.outputDir, "frames", frameFileNameForAngle(angle));
    const absolutePath = path.join(projectRoot, relativePath);
    const fileStats = await exists(absolutePath) ? await stat(absolutePath) : null;
    records.push({
      angle: Number(angle),
      frame: records.length,
      path: relativePath,
      exists: Boolean(fileStats),
      size: fileStats ? fileStats.size : null,
      modifiedTime: fileStats ? fileStats.mtime.toISOString() : null,
      url: `/api/file?path=${encodeURIComponent(relativePath)}`
    });
  }
  return records;
}

function getBlenderBinary() {
  return resolveBlenderBinary();
}

async function detectToolStatus() {
  if (state.toolStatus && Date.now() - state.toolStatus.checkedAt < 5 * 60 * 1000) {
    return state.toolStatus;
  }

  const blenderBinary = getBlenderBinary();
  const blenderExists = await exists(blenderBinary);
  let blenderVersion = null;
  if (blenderExists) {
    const versionResult = spawnSync(blenderBinary, ["--version"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true
    });
    if (versionResult.status === 0) {
      blenderVersion = versionResult.stdout.split(/\r?\n/).find(Boolean) ?? null;
    }
  }

  const sf3dEnvExists = await exists(sf3dPythonPath) && await exists(sf3dRunPath);
  let cuda = {
    available: null,
    torchVersion: null,
    deviceCount: null,
    deviceName: null,
    note: "SF3D environment not ready"
  };
  if (sf3dEnvExists) {
    const probe = spawnSync(
      sf3dPythonPath,
      [
        "-c",
        [
          "import json",
          "try:",
          "    import torch",
          "    payload = {",
          "        'torchVersion': getattr(torch, '__version__', None),",
          "        'available': bool(torch.cuda.is_available()),",
          "        'deviceCount': int(torch.cuda.device_count()) if torch.cuda.is_available() else 0,",
          "        'deviceName': torch.cuda.get_device_name(0) if torch.cuda.is_available() and torch.cuda.device_count() else None,",
          "    }",
          "    print(json.dumps(payload))",
          "except Exception as exc:",
          "    print(json.dumps({'available': None, 'error': str(exc)}))"
        ].join("\n")
      ],
      { cwd: projectRoot, encoding: "utf8", windowsHide: true }
    );
    if (probe.status === 0) {
      try {
        cuda = {
          ...cuda,
          ...JSON.parse(probe.stdout.trim() || "{}"),
          note: "Detected from local Python environment"
        };
      } catch {
        cuda = {
          ...cuda,
          note: "Unable to parse CUDA probe output"
        };
      }
    } else {
      cuda = {
        ...cuda,
        note: "Could not probe CUDA in the local environment"
      };
    }
  }

  const tokenCandidates = [
    process.env.HF_TOKEN,
    process.env.HUGGINGFACE_HUB_TOKEN
  ].filter(Boolean);
  const hfTokenPath = path.join(process.env.USERPROFILE ?? process.env.HOME ?? projectRoot, ".cache", "huggingface", "token");
  const hfTokenExists = await exists(hfTokenPath);
  const huggingFaceReady = tokenCandidates.length > 0 || hfTokenExists;
  const huggingFaceStatus = huggingFaceReady
    ? "Ready"
    : "Not detected locally";

  const detected = {
    checkedAt: Date.now(),
    blender: {
      exists: blenderExists,
      path: blenderBinary,
      version: blenderVersion
    },
    sf3d: {
      exists: sf3dEnvExists,
      python: sf3dPythonPath,
      runScript: sf3dRunPath,
      cuda
    },
    huggingFace: {
      ready: huggingFaceReady,
      tokenPath: hfTokenPath,
      status: huggingFaceStatus
    }
  };

  state.toolStatus = detected;
  return detected;
}

async function buildStatus() {
  const config = state.config ?? await loadUiConfig();
  const tools = await detectToolStatus();
  const frames = await listFrameRecords(config);
  const outputPath = resolveProjectPath(config.outputDir);
  const atlasPath = path.join(outputPath, "atlas.png");
  const manifestPath = path.join(outputPath, "weapon.manifest.json");
  const renderReportPath = path.join(outputPath, "render-report.json");
  const renderUiStatePath = renderUiStateRelPath(config.outputDir);
  const hunyuanOutputPath = resolveHunyuanOutputDir(config);
  const hunyuanOutputMeshPath = resolveHunyuanOutputMeshPath(config);
  const hunyuanMeshPath = resolveHunyuanMeshPath(config);
  const hunyuanTexturedPath = resolveHunyuanTexturedGlbPath(config);
  const hunyuanBakeTexturePath = resolveHunyuanBakedTexturePath(config);
  const hunyuanReportPath = resolveHunyuanReportPath(config);
  const exportPackage = await readArenaExportPackageInfo({ config });
  const sf3dGlbInfo = await readFileInfo(sf3dGlbRelPath);
  const atlasInfo = await readFileInfo(path.relative(projectRoot, atlasPath));
  const manifestInfo = await readJsonFileInfo(path.relative(projectRoot, manifestPath));
  const renderReportInfo = await readJsonFileInfo(path.relative(projectRoot, renderReportPath));
  const renderUiState = await readOptionalJson(renderUiStatePath);
  const sourceImageInfo = await readFileInfo(sourceImageRelPath);
  const inputModelInfo = await readFileInfo(inputModelRelPath);
  const hunyuanOutputMeshInfo = await readFileInfo(path.relative(projectRoot, hunyuanOutputMeshPath));
  const hunyuanMeshInfo = await readFileInfo(path.relative(projectRoot, hunyuanMeshPath));
  const hunyuanTexturedInfo = await readFileInfo(path.relative(projectRoot, hunyuanTexturedPath));
  const hunyuanBakeTextureInfo = await readFileInfo(path.relative(projectRoot, hunyuanBakeTexturePath));
  const hunyuanReportInfo = await readJsonFileInfo(path.relative(projectRoot, hunyuanReportPath));
  const recentLogs = state.logs.slice(-200);
  let manifestValidation = "unchecked";
  if (manifestInfo.exists && manifestInfo.data) {
    const manifestErrors = await validateManifestObject(manifestInfo.data, { manifestPath });
    manifestValidation = manifestErrors.length === 0 ? "valid" : "invalid";
  }

  state.validationState = manifestValidation;

  const allFramesPresent = frames.length > 0 && frames.every((frame) => frame.exists);
  const frameCount = frames.filter((frame) => frame.exists).length;
  const renderDone = allFramesPresent && Boolean(renderUiState);
  const expectedExportFrames = Array.isArray(exportPackage.manifest.data?.angleFrames)
    ? exportPackage.manifest.data.angleFrames.length
    : 0;
  const exportDone = Boolean(
    exportPackage.atlas.exists
    && exportPackage.manifest.exists
    && exportPackage.readme.exists
    && expectedExportFrames > 0
    && exportPackage.frameCount === expectedExportFrames
  );
  const runnerConfigured = config.pipelineMode === "hunyuan_mesh_blender_texture" && Boolean(config.hunyuan?.runnerCommand?.trim());
  const lastHunyuan = state.lastHunyuan ?? null;

  return {
    ok: true,
    projectRoot,
    configPath: path.relative(projectRoot, uiConfigPath),
    config,
    tools,
    files: {
      sourceImage: sourceImageInfo,
      inputModel: inputModelInfo,
      hunyuanOutputMesh: hunyuanOutputMeshInfo,
      sf3dGlb: sf3dGlbInfo,
      hunyuanMesh: hunyuanMeshInfo,
      hunyuanTexturedModel: hunyuanTexturedInfo,
      hunyuanBakeTexture: hunyuanBakeTextureInfo,
      hunyuanReport: hunyuanReportInfo,
      atlas: atlasInfo,
      manifest: {
        ...manifestInfo,
        path: path.relative(projectRoot, manifestPath),
        validation: manifestValidation
      },
      renderReport: {
        ...renderReportInfo,
        path: path.relative(projectRoot, renderReportPath)
      },
      renderUiState: {
        exists: Boolean(renderUiState),
        path: path.relative(projectRoot, renderUiStatePath),
        data: renderUiState
      },
      exportPackage
    },
    frames,
    paths: {
      sf3dGlb: sf3dGlbRelPath,
      hunyuanOutputDir: path.relative(projectRoot, hunyuanOutputPath),
      hunyuanOutputMesh: path.relative(projectRoot, hunyuanOutputMeshPath),
      hunyuanMesh: path.relative(projectRoot, hunyuanMeshPath),
      hunyuanTexturedModel: path.relative(projectRoot, hunyuanTexturedPath),
      hunyuanBakeTexture: path.relative(projectRoot, hunyuanBakeTexturePath),
      hunyuanReport: path.relative(projectRoot, hunyuanReportPath),
      inputModel: inputModelRelPath,
      framesDir: path.join(config.outputDir, "frames"),
      atlas: path.join(config.outputDir, "atlas.png"),
      manifest: path.join(config.outputDir, "weapon.manifest.json"),
      exportDir: exportPackage.path
    },
    lastRenderMode: renderUiState?.renderMode ?? null,
    lastRenderState: renderUiState ?? null,
    lastExportTimestamp: exportPackage.lastExportTimestamp ?? state.lastExport?.exportedAt ?? null,
    lastHunyuan,
    counts: {
      expectedAngles: config.angles.length,
      existingFrames: frameCount,
      exportedFiles: exportPackage.copiedFileCount
    },
    stages: {
      sourceImage: {
        state: sourceImageInfo.exists ? "Ready" : "Missing",
        detail: sourceImageInfo.exists ? "file exists" : "missing"
      },
      hunyuanMesh: {
        state: stageBadgeState(hunyuanMeshInfo.exists, "hunyuanMesh"),
        detail: hunyuanMeshInfo.exists ? "mesh.glb exists" : "mesh.glb missing"
      },
      hunyuanRunner: {
        state: runnerConfigured ? "Ready" : "Missing",
        detail: runnerConfigured
          ? `runnerCommand=${config.hunyuan?.runnerCommand ?? "n/a"}`
          : "runnerCommand missing"
      },
      textureBake: {
        state: stageBadgeState(hunyuanTexturedInfo.exists, "textureBake"),
        detail: hunyuanTexturedInfo.exists ? "textured.glb exists" : "textured.glb missing"
      },
      sf3d: {
        state: stageBadgeState(sf3dGlbInfo.exists, "sf3d"),
        detail: sf3dGlbInfo.exists ? "mesh.glb exists" : "mesh.glb missing"
      },
      glb: {
        state: inputModelInfo.exists ? "Ready" : "Missing",
        detail: inputModelInfo.exists ? "input/cursed_sword.glb exists" : "missing"
      },
      render: {
        state: state.activeJob?.stage === "render"
          ? "Running"
          : state.lastJobStatus?.render === "failed" && frameCount === 0
            ? "Failed"
            : renderDone
              ? "Done"
              : frameCount > 0
                ? "Ready"
                : "Missing",
        detail: `${frameCount}/${config.angles.length} frames present`
      },
      atlas: {
        state: state.activeJob?.stage === "atlas"
          ? "Running"
          : state.lastJobStatus?.atlas === "failed" && !atlasInfo.exists
            ? "Failed"
            : atlasInfo.exists
              ? "Done"
              : "Missing",
        detail: atlasInfo.exists ? "atlas exists" : "missing"
      },
      export: {
        state: state.activeJob?.stage === "export"
          ? "Running"
          : state.lastJobStatus?.export === "failed" && !exportDone
            ? "Failed"
            : exportDone
              ? "Done"
              : "Missing",
        detail: exportPackage.exists
          ? `${exportPackage.copiedFileCount} files exported`
          : "missing"
      },
      pipeline: {
        state: config.pipelineMode === "hunyuan_mesh_blender_texture" ? "Hunyuan" : "SF3D",
        detail: config.pipelineMode === "hunyuan_mesh_blender_texture"
          ? `${config.hunyuan.meshProvider === "external" ? "External Hunyuan runner" : "Placeholder mesh"} + Blender texture bake`
          : "SF3D full pipeline"
      },
      hunyuan: {
        state: config.pipelineMode === "hunyuan_mesh_blender_texture" ? "Enabled" : "Disabled",
        detail: config.pipelineMode === "hunyuan_mesh_blender_texture"
          ? `Provider: ${config.hunyuan.meshProvider}; runner: ${runnerConfigured ? "configured" : "missing"}`
          : "Hunyuan pipeline not selected"
      },
      manifest: {
        state: manifestBadgeState(manifestValidation, manifestInfo.exists),
        detail: manifestValidation
      }
    },
    hunyuan: {
      pipelineMode: config.pipelineMode,
      meshProvider: config.hunyuan?.meshProvider ?? "placeholder",
      runnerConfigured,
      runnerCommand: config.hunyuan?.runnerCommand ?? "",
      runnerArgs: Array.isArray(config.hunyuan?.runnerArgs) ? config.hunyuan.runnerArgs : [],
      outputDir: path.relative(projectRoot, hunyuanOutputPath),
      outputMesh: path.relative(projectRoot, hunyuanOutputMeshPath),
      texturedGlb: path.relative(projectRoot, hunyuanTexturedPath),
      bakedTexture: path.relative(projectRoot, hunyuanBakeTexturePath),
      report: path.relative(projectRoot, hunyuanReportPath),
      lastRun: lastHunyuan
    },
    recentLogs
  };
}

async function cleanKnownRenderOutputs(config) {
  const outputPath = resolveProjectPath(config.outputDir);
  const framesDir = path.join(outputPath, "frames");
  const entries = await exists(framesDir) ? await readdir(framesDir) : [];
  for (const entry of entries) {
    if (/^angle_\d+\.png$/i.test(entry)) {
      await rm(path.join(framesDir, entry), { force: true });
    }
  }
  await rm(path.join(outputPath, "render-report.json"), { force: true });
}

function beginJob(stage) {
  state.activeJob = { stage, startedAt: new Date().toISOString() };
}

function endJob(stage, status) {
  state.activeJob = null;
  state.lastJobStatus = {
    ...state.lastJobStatus,
    [stage]: status
  };
}

async function writeRenderUiState(config) {
  const outputPath = resolveProjectPath(config.outputDir);
  const renderStatePath = path.join(outputPath, "render-ui-state.json");
  const payload = {
    renderMode: config.renderMode,
    angles: config.angles,
    frameSize: config.frameSize,
    orthographicScale: config.camera?.orthographicScale ?? 3.0,
    materialOverride: config.materialOverride,
    lightingStrength: config.lighting?.strength ?? 0.8,
    timestamp: new Date().toISOString(),
    inputModel: config.inputModel
  };
  await writeFile(renderStatePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

async function runSf3d(config) {
  const sf3d = config.sf3d ?? defaultUiConfig.sf3d;
  const outputPath = resolveProjectPath(config.sf3dOutputDir ?? defaultUiConfig.sf3dOutputDir);
  await ensureDirExists(outputPath);
  const inputImagePath = resolveProjectPath(sourceImageRelPath);
  const tools = await detectToolStatus();
  const device = tools.sf3d.cuda?.available ? "cuda" : "cpu";
  const args = [
    sf3dRunPath,
    inputImagePath,
    "--device",
    device,
    "--output-dir",
    outputPath,
    "--foreground-ratio",
    String(sf3d.foregroundRatio),
    "--texture-resolution",
    String(sf3d.textureResolution),
    "--remesh_option",
    sf3d.remeshOption,
    "--target_vertex_count",
    String(sf3d.targetVertexCount)
  ];
  const env = tools.sf3d.cuda?.available ? {} : { SF3D_USE_CPU: "1" };
  await spawnLoggedProcess({
    source: "sf3d",
    command: sf3dPythonPath,
    args,
    cwd: path.dirname(sf3dRunPath),
    env
  });

  const generatedGlbPath = path.join(outputPath, "0", "mesh.glb");
  emitLog("log", "sf3d", `Generated model: ${path.relative(projectRoot, generatedGlbPath)}`);
  const copiedModel = await copySf3dGlbToInput();
  const activeModelInfo = await readFileInfo(inputModelRelPath);
  return {
    generatedGlbPath: path.relative(projectRoot, generatedGlbPath),
    activeModelPath: copiedModel.copiedTo,
    activeModelSize: activeModelInfo.size
  };
}

async function copySf3dGlbToInput() {
  const source = resolveProjectPath(sf3dGlbRelPath);
  const destination = resolveProjectPath(inputModelRelPath);
  if (!(await exists(source))) {
    throw new Error(`SF3D GLB does not exist yet: ${path.relative(projectRoot, source)}`);
  }
  await ensureDirExists(path.dirname(destination));
  await copyFile(source, destination);
  emitLog("log", "copy-glb", `Copied ${path.relative(projectRoot, source)} to ${path.relative(projectRoot, destination)}`);
  return {
    copiedFrom: path.relative(projectRoot, source),
    copiedTo: path.relative(projectRoot, destination)
  };
}


/* AOF_ARENA_WEAPON_PACKAGE_V1_START */
function sanitizeWeaponPackageId(value) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "cursed_sword";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    || "cursed_sword";
}

function displayNameFromWeaponId(id) {
  return String(id)
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function packageVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: Math.round(toNumber(value?.x, fallback.x) * 1000000) / 1000000,
    y: Math.round(toNumber(value?.y, fallback.y) * 1000000) / 1000000,
    z: Math.round(toNumber(value?.z, fallback.z) * 1000000) / 1000000
  };
}

function buildPackageGripSocket(config) {
  const grip = config?.weaponSockets?.grip ?? {};
  return {
    kind: "weaponGripJoint",
    role: "handConnection",
    space: grip.space ?? "model-local-v1",
    position: packageVector(grip.position),
    rotationDeg: packageVector(grip.rotationDeg),
    source: "Arena Object Forge grip editor",
    note: "Attach this socket to the skeleton hand weapon joint."
  };
}

async function copyPackageFileIfExists(sourcePath, destinationPath) {
  if (!(await exists(sourcePath))) {
    return null;
  }

  await ensureDirExists(path.dirname(destinationPath));
  await copyFile(sourcePath, destinationPath);
  return path.relative(projectRoot, destinationPath).replace(/\\/g, "/");
}

async function exportArenaWeaponPackageV1(config) {
  const weaponId = sanitizeWeaponPackageId(config.id ?? "cursed_sword");
  const packageDir = path.join(arenaExportDirRoot, "weapons", weaponId);
  const modelSourceRel = config.inputModel ?? inputModelRelPath;
  const modelSourcePath = resolveProjectPath(modelSourceRel);
  const textureSourcePath = resolveHunyuanBakedTexturePath(config);

  if (!(await exists(modelSourcePath))) {
    throw new Error(`Weapon model missing: ${path.relative(projectRoot, modelSourcePath)}`);
  }

  await ensureDirExists(packageDir);

  const modelPackagePath = path.join(packageDir, "model.glb");
  const texturePackagePath = path.join(packageDir, "texture.png");
  const manifestPath = path.join(packageDir, "weapon.json");
  const readmePath = path.join(packageDir, "README.md");

  await copyFile(modelSourcePath, modelPackagePath);
  const copiedTextureRelPath = await copyPackageFileIfExists(textureSourcePath, texturePackagePath);

  const modelRotation = packageVector(
    config.weaponModel?.rotationDeg
      ?? config.weaponSockets?.grip?.previewModelRotationDeg
      ?? { x: 0, y: 0, z: 0 }
  );

  const manifest = {
    schema: "arena.weapon.v1",
    packageType: "arenaWeapon",
    packageVersion: 1,
    id: weaponId,
    name: config.name ?? displayNameFromWeaponId(weaponId),
    type: "weapon",
    createdBy: "Arena Object Forge",
    exportedAt: new Date().toISOString(),
    coordinateSystem: {
      units: "model-units",
      space: "model-local-v1",
      axes: {
        x: "right",
        y: "up",
        z: "depth"
      }
    },
    model: {
      path: "model.glb",
      format: "glb",
      sourcePath: path.relative(projectRoot, modelSourcePath).replace(/\\/g, "/"),
      defaultTransform: {
        position: { x: 0, y: 0, z: 0 },
        rotationDeg: modelRotation,
        scale: { x: 1, y: 1, z: 1 }
      }
    },
    texture: copiedTextureRelPath
      ? {
          path: "texture.png",
          format: "png",
          sourcePath: path.relative(projectRoot, textureSourcePath).replace(/\\/g, "/")
        }
      : null,
    sockets: {
      grip: buildPackageGripSocket(config)
    },
    compatibility: {
      stretchy: {
        importMode: "3dWeaponAttachment",
        attachSocket: "sockets.grip",
        targetSkeletonJoint: "hand.weapon"
      },
      arenaBloodline: {
        importMode: "weaponCompilerSource",
        attachSocket: "sockets.grip",
        renderSource: "model.path"
      }
    }
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const readme = [
    `# ${manifest.name}`,
    "",
    "Arena Weapon Package v1.",
    "",
    "Files:",
    "- weapon.json: single source of truth for Stretchy and Arena Bloodline",
    "- model.glb: final 3D weapon model",
    "- texture.png: exported texture, when available",
    "",
    "Socket:",
    "- sockets.grip is the hand connection joint used by animation/import tools",
    ""
  ].join("\n");

  await writeFile(readmePath, readme, "utf8");

  emitLog("log", "export", `Arena Weapon Package v1 exported: ${path.relative(projectRoot, packageDir)}`);

  return {
    packageType: "arenaWeapon",
    schema: "arena.weapon.v1",
    id: weaponId,
    packageDir: path.relative(projectRoot, packageDir).replace(/\\/g, "/"),
    manifestPath: path.relative(projectRoot, manifestPath).replace(/\\/g, "/"),
    modelPath: path.relative(projectRoot, modelPackagePath).replace(/\\/g, "/"),
    texturePath: copiedTextureRelPath,
    readmePath: path.relative(projectRoot, readmePath).replace(/\\/g, "/")
  };
}
/* AOF_ARENA_WEAPON_PACKAGE_V1_END */


async function renderFrames(config) {
  const blenderBinary = getBlenderBinary();
  if (!(await exists(blenderBinary))) {
    throw new Error(`Blender was not found: ${blenderBinary}`);
  }
  await cleanKnownRenderOutputs(config);
  const configPathRel = path.relative(projectRoot, uiConfigPath);
  const args = [
    "-b",
    "--python",
    blenderScriptPath,
    "--",
    "--config",
    configPathRel
  ];
  await spawnLoggedProcess({
    source: "blender",
    command: blenderBinary,
    args,
    cwd: projectRoot
  });
  await writeRenderUiState(config);
  const outputPath = resolveProjectPath(config.outputDir);
  const generatedFrames = config.angles.map((angle) => path.join(config.outputDir, "frames", frameFileNameForAngle(angle)));
  emitLog("log", "blender", `Rendered ${generatedFrames.length} frames to ${path.relative(projectRoot, outputPath)}`);
  return {
    generatedFrames
  };
}

async function buildAtlas(config) {
  const framePaths = [];
  const missing = [];
  for (const angle of config.angles) {
    const frameRelPath = path.join(config.outputDir, "frames", frameFileNameForAngle(angle));
    const frameAbsPath = resolveProjectPath(frameRelPath);
    if (!(await exists(frameAbsPath))) {
      missing.push(frameRelPath);
    }
    framePaths.push(frameAbsPath);
  }
  if (missing.length > 0) {
    throw new Error(`Missing expected frames:\n${missing.map((item) => `- ${item}`).join("\n")}`);
  }
  if (config.atlas.columns * config.atlas.rows !== config.angles.length) {
    throw new Error("Atlas grid size must match the number of configured angles.");
  }

  const outputPath = resolveProjectPath(config.outputDir);
  await ensureDirExists(outputPath);
  const atlasPath = path.join(outputPath, "atlas.png");
  const manifestPath = path.join(outputPath, "weapon.manifest.json");

  await buildAtlasImage({
    framePaths,
    frameSize: config.frameSize,
    columns: config.atlas.columns,
    rows: config.atlas.rows,
    outputPath: atlasPath
  });

  const manifest = buildWeaponManifest({ config });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  emitLog("log", "atlas", `Wrote atlas to ${path.relative(projectRoot, atlasPath)}`);
  emitLog("log", "atlas", `Wrote manifest to ${path.relative(projectRoot, manifestPath)}`);
  return {
    atlasPath: path.relative(projectRoot, atlasPath),
    manifestPath: path.relative(projectRoot, manifestPath)
  };
}

async function generateWeaponAtlas(config) {
  beginJob("render");
  emitLog("log", "blender", `Rendering mode: ${config.renderMode}`);
  const renderResult = await renderFrames(config);
  endJob("render", "done");

  beginJob("atlas");
  emitLog("log", "atlas", "Building atlas from rendered frames.");
  const atlasResult = await buildAtlas(config);
  endJob("atlas", "done");

  beginJob("validate");
  emitLog("log", "validate", "Validating weapon manifest.");
  const validationResult = await validateManifest(config);
  endJob("validate", "done");

  return {
    ...renderResult,
    ...atlasResult,
    ...validationResult
  };
}

async function validateManifest(config) {
  const manifestPath = resolveProjectPath(config.outputDir, "weapon.manifest.json");
  if (!(await exists(manifestPath))) {
    throw new Error(`Manifest not found: ${path.relative(projectRoot, manifestPath)}`);
  }
  const manifest = await readJson(manifestPath);
  const errors = await validateManifestObject(manifest, { manifestPath });
  if (errors.length > 0) {
    const message = `Manifest validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`;
    throw new Error(message);
  }
  emitLog("log", "validate", `Manifest valid: ${path.relative(projectRoot, manifestPath)}`);
  return {
    valid: true,
    manifestPath: path.relative(projectRoot, manifestPath)
  };
}

async function setConfigFromBody(body) {
  const nextConfig = normalizeUiConfig({
    ...state.config,
    ...body,
    sf3d: {
      ...state.config.sf3d,
      ...(body.sf3d ?? {})
    },
    render: {
      ...state.config.render,
      ...(body.render ?? {})
    },
    materialOverride: {
      ...state.config.materialOverride,
      ...(body.materialOverride ?? {})
    },
    lighting: {
      ...state.config.lighting,
      ...(body.lighting ?? {})
    },
    camera: {
      ...state.config.camera,
      ...(body.camera ?? {})
    },
    pivot: {
      ...state.config.pivot,
      ...(body.pivot ?? {})
    }
  });
  state.config = await saveUiConfig(nextConfig);
  emitLog("log", "config", "Saved UI config.");
  return buildStatus();
}

async function readRequestBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1_000_000) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

function sendJson(res, statusCode, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function mimeTypeFor(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".png":
      return "image/png";
    case ".glb":
      return "model/gltf-binary";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

async function handleStaticAsset(req, res, pathname) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const normalized = path.resolve(uiPublicDir, requestedPath);
  if (!isWithinRoot(uiPublicDir, normalized)) {
    sendText(res, 404, "Not found");
    return;
  }
  if (!(await exists(normalized))) {
    sendText(res, 404, "Not found");
    return;
  }
  try {
    const fileStats = await stat(normalized);
    if (!fileStats.isFile()) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": mimeTypeFor(normalized),
      "Cache-Control": "no-store"
    });
    const fileStream = createReadStream(normalized);
    fileStream.on("error", () => {
      if (!res.headersSent) {
        sendText(res, 404, "Not found");
      } else {
        res.destroy();
      }
    });
    fileStream.pipe(res);
  } catch {
    sendText(res, 404, "Not found");
  }
}

async function handleFileDownload(req, res, url) {
  const relPath = url.searchParams.get("path");

  if (!relPath) {
    sendJson(res, 400, { ok: false, error: "Missing file path." });
    return;
  }

  let absPath;
  try {
    absPath = ensureAllowedRelativePath(relPath);
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    return;
  }

  try {
    const fileStats = await stat(absPath);
    if (!fileStats.isFile()) {
      sendJson(res, 404, { ok: false, error: "File not found." });
      return;
    }

    const data = await readFile(absPath);
    const ext = path.extname(absPath).toLowerCase();

    const contentTypes = {
      ".glb": "model/gltf-binary",
      ".gltf": "model/gltf+json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".json": "application/json; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8"
    };

    const requestedFilename = url.searchParams.get("filename") || path.basename(relPath);
    const safeFilename = String(requestedFilename)
      .replace(/[\r\n"]/g, "")
      .replace(/[\\/:*?<>|]/g, "_")
      .trim() || "download.bin";

    const wantsDownload =
      url.searchParams.get("download") === "1" ||
      url.searchParams.has("filename");

    const headers = {
      "Content-Type": contentTypes[ext] || "application/octet-stream",
      "Content-Length": String(fileStats.size),
      "Cache-Control": "no-store"
    };

    if (wantsDownload) {
      headers["Content-Disposition"] = `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`;
    }

    res.writeHead(200, headers);
    res.end(data);
  } catch (error) {
    sendJson(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}


function deriveWeaponPackageIdFromConfig(config) {
  const sourcePath =
    config?.sourceTexture ??
    config?.sourceImage ??
    config?.inputImage ??
    "input/cursed_sword_source.png";

  const base = path.basename(String(sourcePath), path.extname(String(sourcePath)))
    .replace(/_source_cropped$/i, "")
    .replace(/_source$/i, "")
    .replace(/_cropped$/i, "");

  return sanitizeWeaponPackageId(base || config?.id || "cursed_sword");
}

function makeWeaponPackageZipCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const weaponPackageZipCrcTable = makeWeaponPackageZipCrcTable();

function weaponPackageZipCrc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = weaponPackageZipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function weaponPackageZipDosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function createWeaponPackageZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name.replace(/\\/g, "/"), "utf8");
    const dataBuffer = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const checksum = weaponPackageZipCrc32(dataBuffer);
    const { dosDate, dosTime } = weaponPackageZipDosDateTime(now);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = offset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function buildArenaWeaponPackageZipForDownload(config) {
  const { readFile } = await import("node:fs/promises");
  const weaponId = deriveWeaponPackageIdFromConfig(config);
  const exportConfig = {
    ...config,
    id: weaponId
  };

  const packageInfo = await exportArenaWeaponPackageV1(exportConfig);

  const entries = [
    { name: "weapon.json", data: await readFile(resolveProjectPath(packageInfo.manifestPath)) },
    { name: "model.glb", data: await readFile(resolveProjectPath(packageInfo.modelPath)) },
    { name: "README.md", data: await readFile(resolveProjectPath(packageInfo.readmePath)) }
  ];

  if (packageInfo.texturePath) {
    entries.push({
      name: "texture.png",
      data: await readFile(resolveProjectPath(packageInfo.texturePath))
    });
  }

  return {
    id: packageInfo.id ?? weaponId,
    packageDir: packageInfo.packageDir,
    zip: createWeaponPackageZip(entries)
  };
}


async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    const status = await buildStatus();
    sendJson(res, 200, status);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/list-frames") {
    const config = state.config ?? await loadUiConfig();
    const frames = await listFrameRecords(config);
    sendJson(res, 200, { ok: true, frames });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    await handleFileDownload(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive"
    });
    res.write("\n");
    for (const entry of state.logs.slice(-200)) {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    }
    clients.add(res);
    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = await readRequestBody(req);
    const status = await setConfigFromBody(body ?? {});
    sendJson(res, 200, status);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run-sf3d") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      sf3d: {
        ...state.config.sf3d,
        ...((body ?? {}).sf3d ?? {})
      }
    });
    await saveUiConfig(config);
    state.busy = true;
    beginJob("sf3d");
    emitLog("log", "sf3d", "Starting SF3D generation.");
    try {
      const result = await runSf3d(config);
      endJob("sf3d", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("sf3d", "failed");
      emitLog("error", "sf3d", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      state.busy = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/copy-glb") {
    emitLog("log", "copy-glb", "Copying SF3D GLB to input model path.");
    try {
      beginJob("glb");
      const result = await copySf3dGlbToInput();
      endJob("glb", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("glb", "failed");
      emitLog("error", "copy-glb", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/run-hunyuan-pipeline") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      sf3d: {
        ...state.config.sf3d,
        ...((body ?? {}).sf3d ?? {})
      },
      hunyuan: {
        ...state.config.hunyuan,
        ...((body ?? {}).hunyuan ?? {})
      },
      materialOverride: {
        ...state.config.materialOverride,
        ...((body ?? {}).materialOverride ?? {})
      },
      lighting: {
        ...state.config.lighting,
        ...((body ?? {}).lighting ?? {})
      },
      camera: {
        ...state.config.camera,
        ...((body ?? {}).camera ?? {})
      }
    });
    await saveUiConfig(config);
    state.busy = true;
    beginJob("hunyuanMesh");
    emitLog("log", "hunyuan", "Starting Hunyuan mesh + Blender texture pipeline.");
    try {
      const result = await runHunyuanMeshBlenderTexturePipeline({
        config,
        emitLog
      });
      state.lastHunyuan = {
        status: "done",
        message: "Hunyuan mesh and texture bake completed.",
        generatedAt: new Date().toISOString(),
        ...result
      };
      endJob("hunyuanMesh", "done");
      endJob("textureBake", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("hunyuanMesh", "failed");
      endJob("textureBake", "failed");
      const message = error instanceof Error ? error.message : String(error);
      state.lastHunyuan = {
        status: "failed",
        message,
        generatedAt: new Date().toISOString()
      };
      const status = await buildStatus();
      emitStatus(status);
      emitLog("error", "hunyuan", message);
      sendJson(res, 500, { ok: false, error: message, status });
    } finally {
      state.busy = false;
    }
    return;
  }


  if (req.method === "POST" && url.pathname === "/api/retexture-step2") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      hunyuan: {
        ...state.config.hunyuan,
        ...((body ?? {}).hunyuan ?? {})
      },
      step2PixelGradient: {
        ...(state.config.step2PixelGradient ?? {}),
        ...((body ?? {}).step2PixelGradient ?? {})
      }
    });

    await saveUiConfig(config);
    state.busy = true;
    beginJob("textureBake");
    emitLog("log", "step2", "Starting Step 2 Pixel Gradient retexture.");

    try {
      const result = await runHunyuanStep2TextureOnly({
        config,
        emitLog
      });

      state.lastHunyuan = {
        status: "done",
        message: "Step 2 Pixel Gradient retexture completed.",
        generatedAt: new Date().toISOString(),
        ...result
      };

      endJob("textureBake", "done");

      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("textureBake", "failed");

      const message = error instanceof Error ? error.message : String(error);
      state.lastHunyuan = {
        status: "failed",
        message,
        generatedAt: new Date().toISOString()
      };

      const status = await buildStatus();
      emitStatus(status);
      emitLog("error", "step2", message);
      sendJson(res, 500, { ok: false, error: message, status });
    } finally {
      state.busy = false;
    }
    return;
  }



  if (req.method === "GET" && url.pathname === "/api/download-weapon-package-v1") {
    const config = normalizeUiConfig(state.config);

    state.busy = true;
    beginJob("export");
    emitLog("log", "export", "Downloading Arena Weapon Package v1 ZIP.");

    try {
      const result = await buildArenaWeaponPackageZipForDownload(config);

      endJob("export", "done");

      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.id}.arena-weapon-package.zip"`,
        "Content-Length": result.zip.length,
        "Cache-Control": "no-store"
      });
      res.end(result.zip);

      emitLog("log", "export", `Arena Weapon Package ZIP downloaded: ${result.packageDir}`);
      emitStatus(await buildStatus());
    } catch (error) {
      endJob("export", "failed");
      const message = error instanceof Error ? error.message : String(error);
      emitLog("error", "export", message);
      sendJson(res, 500, { ok: false, error: message });
    } finally {
      state.busy = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/export-weapon-package-v1") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      weaponModel: {
        ...(state.config.weaponModel ?? {}),
        ...((body ?? {}).weaponModel ?? {})
      },
      weaponSockets: {
        ...(state.config.weaponSockets ?? {}),
        ...((body ?? {}).weaponSockets ?? {})
      }
    });

    await saveUiConfig(config);
    state.busy = true;
    beginJob("export");
    emitLog("log", "export", "Exporting Arena Weapon Package v1.");

    try {
      const result = await exportArenaWeaponPackageV1(config);
      endJob("export", "done");
      state.lastExport = {
        ...result,
        exportedAt: new Date().toISOString()
      };
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("export", "failed");
      const message = error instanceof Error ? error.message : String(error);
      emitLog("error", "export", message);
      sendJson(res, 500, { ok: false, error: message });
    } finally {
      state.busy = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/render-frames") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      sf3d: {
        ...state.config.sf3d,
        ...((body ?? {}).sf3d ?? {})
      },
      materialOverride: {
        ...state.config.materialOverride,
        ...((body ?? {}).materialOverride ?? {})
      },
      lighting: {
        ...state.config.lighting,
        ...((body ?? {}).lighting ?? {})
      },
      camera: {
        ...state.config.camera,
        ...((body ?? {}).camera ?? {})
      }
    });
    await saveUiConfig(config);
    state.busy = true;
    beginJob("render");
    emitLog("log", "blender", `Rendering mode: ${config.renderMode}`);
    try {
      const result = await renderFrames(config);
      endJob("render", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("render", "failed");
      emitLog("error", "blender", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      state.busy = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/build-atlas") {
    emitLog("log", "atlas", "Building atlas from rendered frames.");
    try {
      beginJob("atlas");
      const result = await buildAtlas(state.config);
      endJob("atlas", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("atlas", "failed");
      emitLog("error", "atlas", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/generate-weapon-atlas") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      sf3d: {
        ...state.config.sf3d,
        ...((body ?? {}).sf3d ?? {})
      },
      materialOverride: {
        ...state.config.materialOverride,
        ...((body ?? {}).materialOverride ?? {})
      },
      lighting: {
        ...state.config.lighting,
        ...((body ?? {}).lighting ?? {})
      },
      camera: {
        ...state.config.camera,
        ...((body ?? {}).camera ?? {})
      }
    });
    await saveUiConfig(config);
    state.busy = true;
    try {
      const result = await generateWeaponAtlas(config);
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      if (state.activeJob?.stage === "render") {
        endJob("render", "failed");
      } else if (state.activeJob?.stage === "atlas") {
        endJob("atlas", "failed");
      } else if (state.activeJob?.stage === "validate") {
        endJob("validate", "failed");
      }
      emitLog("error", "atlas", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      state.busy = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/export-arena-package") {
    const body = await readRequestBody(req);
    const config = normalizeUiConfig({
      ...state.config,
      ...(body ?? {}),
      sf3d: {
        ...state.config.sf3d,
        ...((body ?? {}).sf3d ?? {})
      },
      render: {
        ...state.config.render,
        ...((body ?? {}).render ?? {})
      },
      materialOverride: {
        ...state.config.materialOverride,
        ...((body ?? {}).materialOverride ?? {})
      },
      lighting: {
        ...state.config.lighting,
        ...((body ?? {}).lighting ?? {})
      },
      camera: {
        ...state.config.camera,
        ...((body ?? {}).camera ?? {})
      },
      pivot: {
        ...state.config.pivot,
        ...((body ?? {}).pivot ?? {})
      }
    });
    await saveUiConfig(config);
    state.busy = true;
    beginJob("export");
    emitLog("log", "export", "Exporting Arena package.");
    try {
      const result = await exportArenaPackage({ config });
      state.lastExport = result;
      endJob("export", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("export", "failed");
      emitLog("error", "export", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      state.busy = false;
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/validate") {
    emitLog("log", "validate", "Validating weapon manifest.");
    try {
      beginJob("validate");
      const result = await validateManifest(state.config);
      endJob("validate", "done");
      const status = await buildStatus();
      emitStatus(status);
      sendJson(res, 200, { ok: true, ...result, status });
    } catch (error) {
      endJob("validate", "failed");
      emitLog("error", "validate", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

async function bootstrap() {
  await ensureUiConfigFile();
  state.config = await loadUiConfig();
  emitLog("log", "server", "UI config loaded.");

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (requestUrl.pathname.startsWith("/api/")) {
        await handleApi(req, res, requestUrl);
        return;
      }
      await handleStaticAsset(req, res, requestUrl.pathname);
    } catch (error) {
      emitLog("error", "server", error instanceof Error ? error.message : String(error));
      sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  const portCandidates = [3000, 3001, 3002, 3003, 3004, 3005];
  for (const port of portCandidates) {
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      state.port = port;
      break;
    } catch {
      continue;
    }
  }

  if (!state.port) {
    throw new Error("Unable to find a free local port for the UI server.");
  }

  console.log(`Arena Object Forge UI is ready at http://127.0.0.1:${state.port}`);
  console.log(`UI config: ${path.relative(projectRoot, uiConfigPath)}`);
  emitLog("log", "server", `Listening on http://127.0.0.1:${state.port}`);

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

await bootstrap();
