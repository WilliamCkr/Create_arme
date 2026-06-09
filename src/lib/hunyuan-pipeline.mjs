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
    throw new Error(`Blender is required for texture projection/bake but was not found: ${blenderBinary}`);
  }

  const scriptPath = resolveBlenderScriptPath("project_texture_to_mesh.py");
  const outputGlbPath = resolveHunyuanTexturedGlbPath(config);
  const outputTexturePath = resolveHunyuanBakedTexturePath(config);
  const reportPath = resolveHunyuanReportPath(config);

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
      sourceImagePath,
      "--output-glb",
      outputGlbPath,
      "--output-texture",
      outputTexturePath,
      "--output-report",
      reportPath,
      "--bake-resolution",
      String(config?.hunyuan?.textureBakeResolution ?? 2048),
      "--projection-mode",
      config?.hunyuan?.projectionMode ?? "smart_uv"
    ],
    cwd: resolveProjectPath(),
    emitLog
  });

  if (!(await exists(outputGlbPath))) {
    throw new Error(`Texture bake did not produce a textured GLB: ${projectRelative(outputGlbPath)}`);
  }

  return {
    texturedGlbPath: outputGlbPath,
    bakedTexturePath: outputTexturePath,
    reportPath
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
