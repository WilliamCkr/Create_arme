import path from "node:path";
import { access, copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { resolveProjectPath } from "./paths.mjs";
import { resolveBlenderBinary, resolveBlenderScriptPath } from "./blender-paths.mjs";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

function projectRelative(filePath) {
  return path.relative(resolveProjectPath(), filePath).replace(/\\/g, "/");
}

function spawnLoggedProcess({ source, command, args, cwd, env, emitLog }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    emitLog?.("log", source, `Running ${command} ${args.join(" ")}`);

    let settled = false;
    let lastStderrLine = "";
    let preferredStderrLine = "";
    const buffers = [
      { stream: child.stdout, level: "log", text: "" },
      { stream: child.stderr, level: "warn", text: "" }
    ];

    for (const tracker of buffers) {
      tracker.stream.on("data", (chunk) => {
        tracker.text += chunk.toString("utf8");
        const lines = tracker.text.split(/\r?\n/);
        tracker.text = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed) {
            if (tracker.level === "warn") {
              lastStderrLine = trimmed;
              if (!preferredStderrLine && /failed|not available|not found|missing|no python interpreter|could not be started|install the hunyuan3d dependencies/i.test(trimmed)) {
                preferredStderrLine = trimmed;
              }
            }
            emitLog?.(tracker.level, source, trimmed);
          }
        }
      });
    }

    const flush = () => {
      for (const tracker of buffers) {
        const trimmed = tracker.text.trim();
        if (trimmed) {
          emitLog?.(tracker.level, source, trimmed);
        }
        tracker.text = "";
      }
    };

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
        emitLog?.("log", source, "Process finished successfully.");
        resolve({ code, signal });
        return;
      }
      const message = signal ? `Process exited with signal ${signal}` : `Process exited with code ${code}`;
      const stderrLine = preferredStderrLine || lastStderrLine;
      const detail = stderrLine ? `: ${stderrLine}` : "";
      const finalMessage = `${message}${detail}`;
      emitLog?.("error", source, finalMessage);
      reject(new Error(finalMessage));
    });
  });
}

export function resolveHunyuanOutputDir(config) {
  const outputMesh = config?.hunyuan?.outputMesh;
  if (typeof outputMesh === "string" && outputMesh.trim().length > 0) {
    return path.dirname(resolveProjectPath(outputMesh));
  }
  return resolveProjectPath(config?.hunyuan?.outputDir ?? `output/hunyuan_${config?.id ?? "cursed_sword"}`);
}

export function resolveHunyuanOutputMeshPath(config) {
  return resolveProjectPath(config?.hunyuan?.outputMesh ?? path.join(resolveHunyuanOutputDir(config), "mesh.glb"));
}

export function resolveHunyuanMeshPath(config) {
  return resolveHunyuanOutputMeshPath(config);
}

export function resolveHunyuanTexturedGlbPath(config) {
  return path.join(resolveHunyuanOutputDir(config), "textured.glb");
}

export function resolveHunyuanBakedTexturePath(config) {
  return path.join(resolveHunyuanOutputDir(config), "baked-texture.png");
}

export function resolveHunyuanReportPath(config) {
  return path.join(resolveHunyuanOutputDir(config), "hunyuan-pipeline-report.json");
}

async function runExternalMeshProvider({ config, meshPath, outputDir, emitLog }) {
  const runnerCommand = config?.hunyuan?.runnerCommand;
  if (!runnerCommand || !String(runnerCommand).trim()) {
    throw new Error("Hunyuan external mesh provider is selected, but hunyuan.runnerCommand is not configured.");
  }

  const outputMeshPath = resolveHunyuanOutputMeshPath(config);
  const sourceImagePath = resolveProjectPath(config.sourceImage ?? config.sourceTexture ?? "input/cursed_sword_source.png");
  const runnerArgs = [
    ...(Array.isArray(config?.hunyuan?.runnerArgs) ? config.hunyuan.runnerArgs : []),
    "--source-image",
    sourceImagePath,
    "--output-mesh",
    outputMeshPath,
    "--output-dir",
    outputDir,
    "--weapon-id",
    config.id ?? "cursed_sword",
    "--project-root",
    resolveProjectPath()
  ];

  emitLog?.("log", "hunyuan", "Mesh provider: external");
  emitLog?.("log", "hunyuan", `Runner command: ${runnerCommand}`);
  emitLog?.("log", "hunyuan", `Input image: ${projectRelative(sourceImagePath)}`);
  emitLog?.("log", "hunyuan", `Output mesh: ${projectRelative(outputMeshPath)}`);

  try {
    await spawnLoggedProcess({
      source: "hunyuan",
      command: runnerCommand,
      args: runnerArgs,
      cwd: resolveProjectPath(),
      env: config?.hunyuan?.runnerEnv ?? {},
      emitLog
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/enoent|not found|cannot find/i.test(message)) {
      throw new Error(
        `Hunyuan runner command could not be started: ${runnerCommand}. ` +
        "Install the Hunyuan launcher or point hunyuan.runnerCommand to a valid local executable."
      );
    }
    throw error;
  }

  if (!(await exists(outputMeshPath))) {
    throw new Error(`Hunyuan runner completed but did not produce a mesh: ${projectRelative(outputMeshPath)}`);
  }

  return {
    meshProvider: "external",
    runnerCommand,
    runnerArgs,
    outputMeshPath: projectRelative(outputMeshPath),
    sourceImagePath: projectRelative(sourceImagePath)
  };
}

async function runPlaceholderMeshProvider({ meshPath, sourceImagePath, emitLog }) {
  const blenderBinary = resolveBlenderBinary();
  if (!(await exists(blenderBinary))) {
    throw new Error(`Blender is required for the placeholder mesh provider but was not found: ${blenderBinary}`);
  }

  const scriptPath = resolveBlenderScriptPath("generate_hunyuan_proxy_mesh.py");
  await spawnLoggedProcess({
    source: "blender",
    command: blenderBinary,
    args: [
      "-b",
      "--python",
      scriptPath,
      "--",
      "--output-mesh",
      meshPath,
      "--source-image",
      sourceImagePath
    ],
    cwd: resolveProjectPath(),
    emitLog
  });

  if (!(await exists(meshPath))) {
    throw new Error(`Placeholder mesh generation did not produce a mesh: ${projectRelative(meshPath)}`);
  }

  return {
    meshProvider: "placeholder",
    outputMeshPath: projectRelative(meshPath),
    sourceImagePath: projectRelative(sourceImagePath)
  };
}


async function runTextureBake({ meshPath, sourceImagePath, config, emitLog }) {
  const blenderBinary = resolveBlenderBinary();
  if (!(await exists(blenderBinary))) {
    throw new Error(`Blender is required for Step 2 Pixel Gradient bake but was not found: ${blenderBinary}`);
  }

  const outputDir = resolveHunyuanOutputDir(config);
  await ensureDir(outputDir);

  const scriptPath = resolveBlenderScriptPath("project_texture_with_side_fill.py");

  const sourceCroppedPath = resolveProjectPath("input", "cursed_sword_source_cropped.png");
  const selectedSourceImagePath = (await exists(sourceCroppedPath)) ? sourceCroppedPath : sourceImagePath;

  const outputGlbPath = resolveHunyuanTexturedGlbPath(config);
  const outputTexturePath = resolveHunyuanBakedTexturePath(config);
  const reportPath = resolveHunyuanReportPath(config);

  const step2GlbPath = path.join(outputDir, "textured.pixel-gradient-step2.glb");
  const step2TexturePath = path.join(outputDir, "baked-texture.pixel-gradient-step2.png");
  const step2LayerPath = path.join(outputDir, "layer1.pixel-gradient-step2.png");

  const step2 = config?.step2PixelGradient ?? {};

  const edgeBandPx = Number(step2.edgeBandPx ?? 15);
  const sourceInsetPx = Number(step2.sourceInsetPx ?? 10);
  const sourceEdgePx = Number(step2.sourceEdgePx ?? 10);
  const gradientSpanPx = Number(step2.gradientSpanPx ?? 15);

  const materialRoughness = Number(step2.materialRoughness ?? 0.88);
  const materialMetallic = Number(step2.materialMetallic ?? 0.35);
  const materialSpecular = Number(step2.materialSpecular ?? 0.12);
  const textureContrast = Number(step2.textureContrast ?? 1.0);

  emitLog?.("log", "step2", "Running final Pixel Gradient Step 2 texture bake.");
  emitLog?.("log", "step2", `Source image: ${projectRelative(selectedSourceImagePath)}`);
  emitLog?.("log", "step2", `Mesh: ${projectRelative(meshPath)}`);
  emitLog?.("log", "step2", `Edge band=${edgeBandPx}, source inset=${sourceInsetPx}, source edge=${sourceEdgePx}, gradient=${gradientSpanPx}`);
  emitLog?.("log", "step2", `Material roughness=${materialRoughness}, metallic=${materialMetallic}, specular=${materialSpecular}, texture contrast=${textureContrast}`);

  await spawnLoggedProcess({
    source: "blender",
    command: blenderBinary,
    args: [
      "-b",
      "--python",
      scriptPath,
      "--",
      "--mesh",
      meshPath,
      "--source-image",
      selectedSourceImagePath,
      "--output-glb",
      step2GlbPath,
      "--output-texture",
      step2TexturePath,
      "--side-texture",
      step2LayerPath,
      "--output-report",
      reportPath,

      "--source-face-threshold",
      "0.30",
      "--source-face-sign",
      "1",
      "--use-source-both-faces",

      "--warp-upscale",
      "1.00",
      "--warp-stretch-x",
      "1.00",
      "--warp-stretch-y",
      "1.00",
      "--warp-contrast",
      "1.00",
      "--warp-brightness",
      "1.00",
      "--warp-expand-passes",
      "1",
      "--warp-alpha-threshold",
      "0.02",
      "--lock-alpha-threshold",
      "0.02",

      "--edge-band-px",
      String(edgeBandPx),
      "--source-inset-px",
      String(sourceInsetPx),
      "--source-edge-px",
      String(sourceEdgePx),
      "--gradient-span-px",
      String(gradientSpanPx),

      "--material-roughness",
      String(materialRoughness),
      "--material-metallic",
      String(materialMetallic),
      "--material-specular",
      String(materialSpecular),
      "--texture-contrast",
      String(textureContrast)
    ],
    cwd: resolveProjectPath(),
    emitLog
  });

  if (!(await exists(step2GlbPath))) {
    throw new Error(`Step 2 bake did not produce a textured GLB: ${projectRelative(step2GlbPath)}`);
  }

  await copyFile(step2GlbPath, outputGlbPath);

  if (await exists(step2TexturePath)) {
    await copyFile(step2TexturePath, outputTexturePath);
  }

  return {
    texturedGlbPath: outputGlbPath,
    bakedTexturePath: outputTexturePath,
    reportPath,
    step2GlbPath,
    step2TexturePath,
    step2LayerPath,
    selectedSourceImagePath,
    step2Settings: {
      edgeBandPx,
      sourceInsetPx,
      sourceEdgePx,
      gradientSpanPx,
      materialRoughness,
      materialMetallic,
      materialSpecular,
      textureContrast
    }
  };
}


export async function runHunyuanMeshBlenderTexturePipeline({ config, emitLog }) {
  const outputDir = resolveHunyuanOutputDir(config);
  const meshPath = resolveHunyuanMeshPath(config);
  const sourceImagePath = resolveProjectPath(config.sourceImage ?? config.sourceTexture ?? "input/cursed_sword_source.png");
  const inputModelPath = resolveProjectPath(config.inputModel ?? "input/cursed_sword.glb");
  await ensureDir(outputDir);

  if (!(await exists(sourceImagePath))) {
    throw new Error(`Source image is missing: ${projectRelative(sourceImagePath)}`);
  }

  if (config?.hunyuan?.meshProvider === "external") {
    await runExternalMeshProvider({ config, meshPath, outputDir, emitLog });
  } else {
    emitLog?.("log", "hunyuan", "Mesh provider: placeholder fallback");
    emitLog?.("log", "hunyuan", `Input image: ${projectRelative(sourceImagePath)}`);
    emitLog?.("log", "hunyuan", `Output mesh: ${projectRelative(meshPath)}`);
    await runPlaceholderMeshProvider({ meshPath, sourceImagePath, emitLog });
  }

  const bakeResult = await runTextureBake({ meshPath, sourceImagePath, outputDir, config, emitLog });

  await ensureDir(path.dirname(inputModelPath));
  await copyFile(bakeResult.texturedGlbPath, inputModelPath);
  const activeModelStats = await stat(inputModelPath);

  const report = {
    pipelineMode: "hunyuan_mesh_blender_texture",
    meshProvider: config?.hunyuan?.meshProvider === "external" ? "external" : "placeholder",
    runnerCommand: config?.hunyuan?.runnerCommand ?? null,
    runnerArgs: Array.isArray(config?.hunyuan?.runnerArgs) ? config.hunyuan.runnerArgs : [],
    sourceImage: projectRelative(sourceImagePath),
    meshPath: projectRelative(meshPath),
    outputMeshPath: projectRelative(meshPath),
    texturedGlbPath: projectRelative(bakeResult.texturedGlbPath),
    bakedTexturePath: projectRelative(bakeResult.bakedTexturePath),
    activeModelPath: projectRelative(inputModelPath),
    activeModelSize: activeModelStats.size,
    bakeResolution: config?.hunyuan?.textureBakeResolution ?? 2048,
    projectionMode: config?.hunyuan?.projectionMode ?? "smart_uv",
    outputDir: projectRelative(outputDir),
    generatedAt: new Date().toISOString()
  };

  await writeFile(resolveHunyuanReportPath(config), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  emitLog?.("log", "hunyuan", `Generated textured model: ${report.activeModelPath}`);

  return {
    ...report,
    runnerConfigured: Boolean(config?.hunyuan?.runnerCommand?.trim()),
    meshExists: true,
    texturedGlbExists: true,
    activeModelPath: projectRelative(inputModelPath)
  };
}


export async function runHunyuanStep2TextureOnly({ config, emitLog }) {
  const outputDir = resolveHunyuanOutputDir(config);
  const meshPath = resolveHunyuanMeshPath(config);
  const sourceImagePath = resolveProjectPath(config.sourceImage ?? config.sourceTexture ?? "input/cursed_sword_source.png");
  const inputModelPath = resolveProjectPath(config.inputModel ?? "input/cursed_sword.glb");

  await ensureDir(outputDir);

  if (!(await exists(meshPath))) {
    throw new Error(`Step 2 needs a generated mesh first: ${projectRelative(meshPath)}`);
  }

  const bakeResult = await runTextureBake({
    meshPath,
    sourceImagePath,
    config,
    emitLog
  });

  await ensureDir(path.dirname(inputModelPath));
  await copyFile(bakeResult.texturedGlbPath, inputModelPath);

  const activeModelStats = await stat(inputModelPath);

  emitLog?.("log", "step2", `Retextured active model: ${projectRelative(inputModelPath)}`);

  return {
    pipelineMode: "step2_pixel_gradient_retexture",
    meshPath: projectRelative(meshPath),
    texturedGlbPath: projectRelative(bakeResult.texturedGlbPath),
    bakedTexturePath: projectRelative(bakeResult.bakedTexturePath),
    step2GlbPath: projectRelative(bakeResult.step2GlbPath),
    step2TexturePath: projectRelative(bakeResult.step2TexturePath),
    step2LayerPath: projectRelative(bakeResult.step2LayerPath),
    reportPath: projectRelative(bakeResult.reportPath),
    activeModelPath: projectRelative(inputModelPath),
    activeModelSize: activeModelStats.size,
    sourceImage: projectRelative(bakeResult.selectedSourceImagePath),
    step2Settings: bakeResult.step2Settings,
    generatedAt: new Date().toISOString()
  };
}
