const DEFAULT_ANGLES = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];

const PRESETS = {
  gameplay2d: {
    name: "Sword Gameplay 2D",
    renderMode: "gameplay_2d",
    angles: DEFAULT_ANGLES,
    frameSize: { width: 512, height: 512 },
    orthographicScale: 3
  },
  turntable3d: {
    name: "Sword Turntable 3D",
    renderMode: "turntable_3d",
    angles: DEFAULT_ANGLES,
    frameSize: { width: 512, height: 512 },
    orthographicScale: 3
  },
  closeGameplay2d: {
    name: "Sword Close Gameplay 2D",
    renderMode: "gameplay_2d",
    angles: DEFAULT_ANGLES,
    frameSize: { width: 512, height: 512 },
    orthographicScale: 2.2
  }
};

const STEP_META = [
  {
    key: "source",
    short: "Source",
    title: "Source Image"
  },
  {
    key: "model",
    short: "3D Model",
    title: "Generate 3D Model"
  },
  {
    key: "atlas",
    short: "Atlas",
    title: "Generate Weapon Atlas"
  },
  {
    key: "export",
    short: "Export",
    title: "Export Arena Package"
  }
];

const state = {
  status: null,
  formConfig: null,
  logs: [],
  logIds: new Set(),
  currentStepIndex: 0,
  stepTouched: false,
  busy: false
};

const el = {};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) {
    return "missing";
  }
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

function formatTime(iso) {
  if (!iso) {
    return "n/a";
  }
  return new Date(iso).toLocaleString();
}

function displayPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

function parseAngles(text) {
  return text
    .split(/[\s,]+/)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function currentConfigFromForm() {
  return deepClone(state.formConfig ?? state.status?.config ?? {});
}

function files() {
  return state.status?.files ?? {};
}

function sourceFile() {
  return files().sourceImage;
}

function inputModelFile() {
  return files().inputModel;
}

function sf3dGlbFile() {
  return files().sf3dGlb;
}

function atlasFile() {
  return files().atlas;
}

function manifestFile() {
  return files().manifest;
}

function exportPackage() {
  return files().exportPackage;
}

function sourceReady() {
  return Boolean(sourceFile()?.exists);
}

function modelReady() {
  return Boolean(inputModelFile()?.exists);
}

function manifestValidation() {
  return manifestFile()?.validation ?? "unchecked";
}

function atlasReady() {
  return Boolean(atlasFile()?.exists && manifestValidation() === "valid");
}

function exportReady() {
  return Boolean(exportPackage()?.exists);
}

function stepReady(index) {
  switch (index) {
    case 0:
      return sourceReady();
    case 1:
      return modelReady();
    case 2:
      return atlasReady();
    case 3:
      return exportReady();
    default:
      return false;
  }
}

function highestUnlockedStep() {
  if (!sourceReady()) {
    return 0;
  }
  if (!modelReady()) {
    return 1;
  }
  if (!atlasReady()) {
    return 2;
  }
  return 3;
}

function syncStepFromStatus() {
  const unlocked = highestUnlockedStep();
  if (!state.stepTouched) {
    state.currentStepIndex = unlocked;
    return;
  }
  state.currentStepIndex = Math.min(state.currentStepIndex, unlocked);
}

function setBadge(text, kind = "") {
  el.connectionState.textContent = text;
  el.connectionState.className = `badge ${kind}`.trim();
}

function setSaveState(text) {
  el.saveState.textContent = text;
}

function badgeClassForState(stateName) {
  return String(stateName || "Missing").toLowerCase().replaceAll(" ", "_");
}

function capitalize(value) {
  const text = String(value ?? "");
  return text.length > 0 ? text[0].toUpperCase() + text.slice(1) : text;
}

function sourceSummary() {
  return sourceReady() ? "Source image ready" : "Source image missing";
}

function modelSummary() {
  return modelReady() ? "3D model ready" : "3D model missing";
}

function atlasSummary() {
  const validation = manifestValidation();
  if (validation === "valid") {
    return "Manifest valid";
  }
  if (validation === "invalid") {
    return "Manifest invalid";
  }
  return "Manifest not checked";
}

function exportSummary() {
  return exportReady() ? "Export ready" : "Ready to export";
}

function currentStep() {
  return STEP_META[state.currentStepIndex] ?? STEP_META[0];
}

function currentStepLabel() {
  return `Step ${state.currentStepIndex + 1} of ${STEP_META.length}`;
}

function globalStatusLine() {
  switch (state.currentStepIndex) {
    case 0:
      return sourceSummary();
    case 1:
      return modelSummary();
    case 2:
      return atlasSummary();
    case 3:
      return exportSummary();
    default:
      return "Workflow ready";
  }
}

function fileSummary(file) {
  if (!file || !file.exists) {
    return "Missing";
  }
  return [
    `Path: ${displayPath(file.path)}`,
    `Size: ${formatBytes(file.size)}`,
    `Modified: ${formatTime(file.modifiedTime)}`
  ].join("\n");
}

function formConfigDraft() {
  if (!state.formConfig) {
    state.formConfig = deepClone(state.status?.config ?? {});
  }
  return state.formConfig;
}

function updateDraftFromStepInputs() {
  const draft = formConfigDraft();

  if (state.currentStepIndex === 1) {
    draft.sf3d = {
      ...(draft.sf3d ?? {}),
      foregroundRatio: Number(el.advancedBody.querySelector("#foregroundRatioInput")?.value ?? draft.sf3d?.foregroundRatio ?? 0.85),
      textureResolution: Number(el.advancedBody.querySelector("#textureResolutionInput")?.value ?? draft.sf3d?.textureResolution ?? 2048),
      remeshOption: el.advancedBody.querySelector("#remeshOptionInput")?.value ?? draft.sf3d?.remeshOption ?? "none",
      targetVertexCount: Number(el.advancedBody.querySelector("#targetVertexCountInput")?.value ?? draft.sf3d?.targetVertexCount ?? -1)
    };
  } else if (state.currentStepIndex === 2) {
    draft.renderMode = el.advancedBody.querySelector("#renderModeInput")?.value ?? draft.renderMode ?? "turntable_3d";
    draft.angles = parseAngles(el.advancedBody.querySelector("#anglesInput")?.value ?? (draft.angles ?? DEFAULT_ANGLES).join(", "));
    draft.frameSize = {
      width: Number(el.advancedBody.querySelector("#frameWidthInput")?.value ?? draft.frameSize?.width ?? 512),
      height: Number(el.advancedBody.querySelector("#frameHeightInput")?.value ?? draft.frameSize?.height ?? 512)
    };
    draft.camera = {
      ...(draft.camera ?? {}),
      orthographicScale: Number(el.advancedBody.querySelector("#orthographicScaleInput")?.value ?? draft.camera?.orthographicScale ?? 3.0)
    };
    draft.lighting = {
      ...(draft.lighting ?? {}),
      strength: Number(el.advancedBody.querySelector("#lightingStrengthInput")?.value ?? draft.lighting?.strength ?? 0.8)
    };
    draft.materialOverride = {
      ...(draft.materialOverride ?? {}),
      enabled: Boolean(el.advancedBody.querySelector("#materialOverrideEnabledInput")?.checked ?? draft.materialOverride?.enabled ?? true),
      metallic: Number(el.advancedBody.querySelector("#materialMetallicInput")?.value ?? draft.materialOverride?.metallic ?? 0.15),
      roughness: Number(el.advancedBody.querySelector("#materialRoughnessInput")?.value ?? draft.materialOverride?.roughness ?? 0.82),
      specular: Number(el.advancedBody.querySelector("#materialSpecularInput")?.value ?? draft.materialOverride?.specular ?? 0.25),
      clearcoat: Number(el.advancedBody.querySelector("#materialClearcoatInput")?.value ?? draft.materialOverride?.clearcoat ?? 0)
    };
  }
  return draft;
}

function addLogs(entries) {
  for (const entry of entries) {
    const id = entry.id ?? `${entry.timestamp}-${entry.source}-${entry.message}`;
    if (state.logIds.has(id)) {
      continue;
    }
    state.logIds.add(id);
    state.logs.push({ ...entry, id });
  }
  if (state.logs.length > 500) {
    state.logs.splice(0, state.logs.length - 500);
  }
  renderLogs();
}

function appendLocalLog(level, source, message) {
  addLogs([{
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    level,
    source,
    message
  }]);
}

function setStatus(status) {
  state.status = status;
  state.formConfig = deepClone(status.config ?? {});
  syncStepFromStatus();
  renderAll();
}

function renderTopBar() {
  el.currentStepBadge.textContent = currentStepLabel();
  el.workflowProgress.textContent = currentStepLabel();
  el.globalStatusLine.textContent = `${currentStep().title}: ${globalStatusLine()}`;
  el.currentStepTitle.textContent = currentStep().title;
  el.currentStepMeta.textContent = `Current step: ${currentStepLabel()}`;
  el.stepOptionHint.textContent = `Showing ${currentStep().short.toLowerCase()} options only`;
}

function renderStepRail() {
  const unlocked = highestUnlockedStep();
  el.stepList.innerHTML = STEP_META.map((step, index) => {
    const active = index === state.currentStepIndex ? "active" : "";
    const locked = index > unlocked ? "locked" : "";
    const stateLabel = stepLabelForIndex(index);
    return `
      <button class="step-item ${active} ${locked}" type="button" data-step="${index}" ${state.busy || index > unlocked ? "disabled" : ""}>
        <div class="step-index">${index + 1}</div>
        <div>
          <strong>${escapeHtml(step.short)}</strong>
          <div class="subtle">${escapeHtml(step.title)}</div>
        </div>
        <span class="badge ${badgeClassForState(stateLabel)}">${escapeHtml(stateLabel)}</span>
      </button>
    `;
  }).join("");

  el.stepList.querySelectorAll("button[data-step]").forEach((button) => {
    button.addEventListener("click", () => {
      goToStep(Number(button.dataset.step));
    });
  });
}

function stepLabelForIndex(index) {
  switch (index) {
    case 0:
      return sourceReady() ? "Ready" : "Missing";
    case 1:
      return modelReady() ? "Ready" : "Missing";
    case 2:
      if (manifestValidation() === "valid") {
        return "Done";
      }
      if (manifestValidation() === "invalid") {
        return "Invalid";
      }
      return "Not checked";
    case 3:
      return exportReady() ? "Done" : "Ready";
    default:
      return "Missing";
  }
}

function renderPreview() {
  const source = sourceFile();
  const model = inputModelFile();
  const atlas = atlasFile();
  const exportInfo = exportPackage();
  const step = state.currentStepIndex;
  let html = "";
  let caption = "";

  if (step === 0) {
    if (source?.exists) {
      html = `
        <div class="preview-shell">
          <img class="preview-image" src="${escapeHtml(source.url)}" alt="Source image preview" />
          <div class="preview-card">
            <h3>Source image ready</h3>
            <p>${escapeHtml(source.path)}</p>
            <p>${escapeHtml(formatBytes(source.size))}</p>
          </div>
        </div>
      `;
      caption = "Use this image as the starting point for the pipeline.";
    } else {
      html = `
        <div class="preview-card">
          <h3>Source image missing</h3>
          <p>Expected at input/cursed_sword_source.png.</p>
        </div>
      `;
      caption = "The source image must exist before the workflow can continue.";
    }
  } else if (step === 1) {
    if (model?.exists) {
      html = `
        <div class="preview-card">
          <h3>3D model ready</h3>
          <p><strong>Active model</strong></p>
          <p>${escapeHtml(model.path)}</p>
          <p>${escapeHtml(formatBytes(model.size))}</p>
          <p>The generated SF3D GLB is copied here automatically, so later steps can use it without a manual transfer.</p>
        </div>
      `;
      caption = "After generation, this becomes the active model used by the atlas workflow.";
    } else {
      html = `
        <div class="preview-card">
          <h3>Generate the active model</h3>
          <p>Run SF3D from the source image to create the model used by later steps.</p>
        </div>
      `;
      caption = "SF3D output is auto-copied to input/cursed_sword.glb when generation succeeds.";
    }
  } else if (step === 2) {
    if (atlas?.exists) {
      html = `
        <div class="preview-shell">
          <img class="preview-image" src="${escapeHtml(atlas.url)}" alt="Atlas preview" />
          <div class="preview-card">
            <h3>Weapon atlas ready</h3>
            <p>Manifest: ${escapeHtml(capitalize(manifestValidation()))}</p>
            <p>${escapeHtml((state.status?.counts?.existingFrames ?? 0) + "/" + (state.status?.counts?.expectedAngles ?? 0))} frames rendered</p>
          </div>
        </div>
      `;
      caption = "This step renders frames, builds the atlas, and validates the manifest.";
    } else {
      html = `
        <div class="preview-card">
          <h3>Generate Weapon Atlas</h3>
          <p>Pick a preset, then run the combined frames + atlas + manifest workflow.</p>
        </div>
      `;
      caption = "The combined action keeps the technical render, atlas, and validation steps behind one button.";
    }
  } else {
    if (exportInfo?.atlas?.exists) {
      html = `
        <div class="preview-shell">
          <img class="preview-image" src="${escapeHtml(exportInfo.atlas.url)}" alt="Export atlas preview" />
          <div class="preview-card">
            <h3>Arena export package</h3>
            <p>${escapeHtml(exportInfo.path)}</p>
            <p>Copied files: ${escapeHtml(String(exportInfo.copiedFileCount ?? 0))}</p>
            <p>README: ${escapeHtml(exportInfo.readme?.path ?? "n/a")}</p>
          </div>
        </div>
      `;
      caption = "This package is ready for Arena Bloodline consumption later.";
    } else {
      html = `
        <div class="preview-card">
          <h3>Export Arena Package</h3>
          <p>The export folder will be written to arena-export/cursed_sword/.</p>
        </div>
      `;
      caption = "Export will validate the manifest automatically before copying files.";
    }
  }

  el.stepPreview.innerHTML = html;
  el.stepCaption.textContent = caption;
}

function renderStepOptions() {
  const source = sourceFile();
  const model = inputModelFile();
  const exportInfo = exportPackage();
  const unlocked = highestUnlockedStep();

  if (state.currentStepIndex === 0) {
    el.stepOptions.innerHTML = `
      <div class="status-grid">
        <div>Status</div><div>${escapeHtml(sourceReady() ? "Source image ready" : "Source image missing")}</div>
        <div>Path</div><div>${escapeHtml(displayPath(source?.path ?? "input/cursed_sword_source.png"))}</div>
      </div>
      <div class="advanced-actions">
        <button id="refreshSourceButton" class="secondary" type="button" ${state.busy ? "disabled" : ""}>Refresh</button>
        <button id="useImageButton" type="button" ${state.busy || !sourceReady() ? "disabled" : ""}>Use This Image</button>
      </div>
    `;
  } else if (state.currentStepIndex === 1) {
    const cuda = state.status?.tools?.sf3d?.cuda ?? {};
    const activeModel = model?.exists ? model : null;
    el.stepOptions.innerHTML = `
      <div class="status-grid">
        <div>Source</div><div>${escapeHtml(sourceReady() ? "Ready" : "Missing")}</div>
        <div>Active model</div><div>${escapeHtml(activeModel?.path ?? "n/a")}</div>
        <div>Size</div><div>${escapeHtml(activeModel ? formatBytes(activeModel.size) : "n/a")}</div>
        <div>SF3D env</div><div>${escapeHtml(state.status?.tools?.sf3d?.exists ? "Ready" : "Missing")}</div>
        <div>CUDA</div><div>${escapeHtml(cuda.available === null ? "Unknown" : (cuda.available ? `Available${cuda.deviceName ? ` - ${cuda.deviceName}` : ""}` : "Unavailable"))}</div>
        <div>HF Access</div><div>${escapeHtml(state.status?.tools?.huggingFace?.status ?? "Unknown")}</div>
      </div>
      <button id="runSf3dButton" type="button" ${state.busy || !sourceReady() ? "disabled" : ""}>Generate 3D Model</button>
      <div class="subtle">The generated GLB is copied into the active model automatically.</div>
    `;
  } else if (state.currentStepIndex === 2) {
    const draft = state.formConfig ?? state.status?.config ?? {};
    const presetName = draft.renderMode === "gameplay_2d"
      ? (Math.abs(Number(draft.camera?.orthographicScale ?? 3)) <= 2.4 ? PRESETS.closeGameplay2d.name : PRESETS.gameplay2d.name)
      : PRESETS.turntable3d.name;
    el.stepOptions.innerHTML = `
      <div class="preset-row">
        <button id="presetGameplayButton" class="secondary small" type="button">Sword Gameplay 2D</button>
        <button id="presetTurntableButton" class="secondary small" type="button">Sword Turntable 3D</button>
        <button id="presetCloseGameplayButton" class="secondary small" type="button">Sword Close Gameplay 2D</button>
      </div>
      <div class="status-grid">
        <div>Preset</div><div>${escapeHtml(presetName)}</div>
        <div>Frames</div><div>${escapeHtml(`${state.status?.counts?.expectedAngles ?? 0} angles`)}</div>
        <div>Manifest</div><div>${escapeHtml(capitalize(manifestValidation()))}</div>
      </div>
      <button id="generateAtlasButton" type="button" ${state.busy || !modelReady() ? "disabled" : ""}>Generate Frames &amp; Atlas</button>
      <div class="subtle">This runs render frames, builds the atlas, and validates the manifest in one pass.</div>
    `;
  } else {
    el.stepOptions.innerHTML = `
      <div class="status-grid">
        <div>Export folder</div><div>${escapeHtml(exportInfo?.path ?? "arena-export/cursed_sword")}</div>
        <div>Copied files</div><div>${escapeHtml(String(exportInfo?.copiedFileCount ?? 0))}</div>
        <div>Last export</div><div>${escapeHtml(exportInfo?.lastExportTimestamp ?? state.status?.lastExportTimestamp ?? "n/a")}</div>
        <div>Manifest</div><div>${escapeHtml(capitalize(manifestValidation()))}</div>
        <div>README</div><div>${escapeHtml(exportInfo?.readme?.path ?? "n/a")}</div>
      </div>
      <div class="advanced-actions">
        <button id="copyExportPathButton" class="secondary" type="button">Copy export path</button>
      </div>
      <button id="exportArenaButton" type="button" ${state.busy || !atlasReady() ? "disabled" : ""}>Export Arena Package</button>
      <div class="subtle">Manifest validation runs automatically before export.</div>
    `;
  }

  el.stepOptions.querySelectorAll("button[data-step]").forEach(() => {});
  bindStepOptionActions(unlocked);
}

function renderAdvancedPanels() {
  const source = sourceFile();
  const model = inputModelFile();
  const exportInfo = exportPackage();
  const draft = state.formConfig ?? state.status?.config ?? {};
  const sf3dTool = state.status?.tools?.sf3d ?? {};
  const cuda = sf3dTool.cuda ?? {};
  const sf3d = draft.sf3d ?? {};
  const camera = draft.camera ?? {};
  const lighting = draft.lighting ?? {};
  const materialOverride = draft.materialOverride ?? {};
  const frameSize = draft.frameSize ?? {};
  const sourceSummaryHtml = `
    <section class="advanced-group">
      <div class="panel-heading compact">
        <h3>Source Tools</h3>
      </div>
      <div class="status-grid compact-grid">
        <div>Status</div><div>${escapeHtml(sourceReady() ? "Source image ready" : "Source image missing")}</div>
        <div>Path</div><div>${escapeHtml(displayPath(source?.path ?? "input/cursed_sword_source.png"))}</div>
        <div>Size</div><div>${escapeHtml(source?.exists ? formatBytes(source.size) : "missing")}</div>
        <div>Modified</div><div>${escapeHtml(source?.exists ? formatTime(source.modifiedTime) : "n/a")}</div>
      </div>
      <div class="advanced-actions">
        <button class="secondary" type="button" data-action="refresh-source">Refresh source</button>
        <button class="secondary" type="button" data-action="copy-source-path">Copy source path</button>
      </div>
    </section>
  `;

  const sf3dSummaryHtml = `
    <section class="advanced-group">
      <div class="panel-heading compact">
        <h3>SF3D Settings</h3>
      </div>
      <div class="status-grid compact-grid">
        <div>Env</div><div>${escapeHtml(sf3dTool.exists ? "Ready" : "Missing")}</div>
        <div>CUDA</div><div>${escapeHtml(cuda.available === null ? "Unknown" : (cuda.available ? `Available${cuda.deviceName ? ` - ${cuda.deviceName}` : ""}` : "Unavailable"))}</div>
        <div>HF Access</div><div>${escapeHtml(state.status?.tools?.huggingFace?.status ?? "Unknown")}</div>
        <div>Active model</div><div>${escapeHtml(displayPath(model?.path ?? "input/cursed_sword.glb"))}</div>
        <div>Size</div><div>${escapeHtml(model?.exists ? formatBytes(model.size) : "missing")}</div>
      </div>
      <div class="form-grid">
        <label>
          foregroundRatio
          <input id="foregroundRatioInput" type="number" step="0.01" min="0" max="1" value="${escapeHtml(sf3d.foregroundRatio ?? 0.85)}" />
        </label>
        <label>
          textureResolution
          <input id="textureResolutionInput" type="number" step="1" min="256" value="${escapeHtml(sf3d.textureResolution ?? 2048)}" />
        </label>
        <label>
          remeshOption
          <select id="remeshOptionInput">
            <option value="none" ${sf3d.remeshOption === "none" ? "selected" : ""}>none</option>
            <option value="triangle" ${sf3d.remeshOption === "triangle" ? "selected" : ""}>triangle</option>
            <option value="quad" ${sf3d.remeshOption === "quad" ? "selected" : ""}>quad</option>
          </select>
        </label>
        <label>
          targetVertexCount
          <input id="targetVertexCountInput" type="number" step="1" value="${escapeHtml(sf3d.targetVertexCount ?? -1)}" />
        </label>
      </div>
      <div id="sf3dResult" class="subtle">${escapeHtml(state.status?.lastSf3d?.message ?? "Ready to generate the 3D model.")}</div>
      <div class="advanced-actions">
        <button type="button" data-action="run-sf3d" ${state.busy || !sourceReady() ? "disabled" : ""}>Generate 3D Model</button>
        <button class="secondary" type="button" data-action="copy-glb">Copy GLB manually</button>
      </div>
    </section>
  `;

  const atlasSummaryHtml = `
    <section class="advanced-group">
      <div class="panel-heading compact">
        <h3>Atlas Settings</h3>
      </div>
      <div class="status-grid compact-grid">
        <div>Preset</div><div>${escapeHtml(draft.renderMode === "gameplay_2d" ? (Math.abs(Number(camera.orthographicScale ?? 3)) <= 2.4 ? PRESETS.closeGameplay2d.name : PRESETS.gameplay2d.name) : PRESETS.turntable3d.name)}</div>
        <div>Frames</div><div>${escapeHtml(`${state.status?.counts?.expectedAngles ?? 0} angles`)}</div>
        <div>Manifest</div><div>${escapeHtml(capitalize(manifestValidation()))}</div>
      </div>
      <div class="form-grid">
        <label>
          renderMode
          <select id="renderModeInput">
            <option value="turntable_3d" ${draft.renderMode !== "gameplay_2d" ? "selected" : ""}>turntable_3d</option>
            <option value="gameplay_2d" ${draft.renderMode === "gameplay_2d" ? "selected" : ""}>gameplay_2d</option>
          </select>
        </label>
        <label>
          angles
          <textarea id="anglesInput" rows="4">${escapeHtml((draft.angles ?? DEFAULT_ANGLES).join(", "))}</textarea>
        </label>
        <label>
          frame width
          <input id="frameWidthInput" type="number" min="1" step="1" value="${escapeHtml(frameSize.width ?? 512)}" />
        </label>
        <label>
          frame height
          <input id="frameHeightInput" type="number" min="1" step="1" value="${escapeHtml(frameSize.height ?? 512)}" />
        </label>
        <label>
          orthographicScale
          <input id="orthographicScaleInput" type="number" min="0.1" step="0.1" value="${escapeHtml(camera.orthographicScale ?? 3)}" />
        </label>
        <label>
          lighting strength
          <input id="lightingStrengthInput" type="number" min="0" step="0.05" value="${escapeHtml(lighting.strength ?? 0.8)}" />
        </label>
      </div>
      <label class="checkbox-row">
        <input id="materialOverrideEnabledInput" type="checkbox" ${materialOverride.enabled !== false ? "checked" : ""} />
        <span>materialOverride enabled</span>
      </label>
      <div class="form-grid">
        <label>
          metallic
          <input id="materialMetallicInput" type="number" min="0" max="1" step="0.01" value="${escapeHtml(materialOverride.metallic ?? 0.15)}" />
        </label>
        <label>
          roughness
          <input id="materialRoughnessInput" type="number" min="0" max="1" step="0.01" value="${escapeHtml(materialOverride.roughness ?? 0.82)}" />
        </label>
        <label>
          specular
          <input id="materialSpecularInput" type="number" min="0" max="1" step="0.01" value="${escapeHtml(materialOverride.specular ?? 0.25)}" />
        </label>
        <label>
          clearcoat
          <input id="materialClearcoatInput" type="number" min="0" max="1" step="0.01" value="${escapeHtml(materialOverride.clearcoat ?? 0)}" />
        </label>
      </div>
      <div class="advanced-actions">
        <button class="secondary" type="button" data-action="render-frames">Render Frames only</button>
        <button class="secondary" type="button" data-action="build-atlas">Build Atlas only</button>
        <button class="secondary" type="button" data-action="validate-manifest">Validate Manifest only</button>
      </div>
      <details class="inline-details">
        <summary>Raw manifest JSON</summary>
        <pre id="manifestViewer" class="code-view"></pre>
      </details>
    </section>
  `;

  const exportSummaryHtml = `
    <section class="advanced-group">
      <div class="panel-heading compact">
        <h3>Export Tools</h3>
      </div>
      <div class="status-grid compact-grid">
        <div>Export folder</div><div>${escapeHtml(exportInfo?.path ?? "arena-export/cursed_sword")}</div>
        <div>Copied files</div><div>${escapeHtml(String(exportInfo?.copiedFileCount ?? 0))}</div>
        <div>Last export</div><div>${escapeHtml(exportInfo?.lastExportTimestamp ?? state.status?.lastExportTimestamp ?? "n/a")}</div>
        <div>Manifest</div><div>${escapeHtml(capitalize(manifestValidation()))}</div>
        <div>README</div><div>${escapeHtml(exportInfo?.readme?.path ?? "n/a")}</div>
      </div>
      <div class="path-list">
        <div class="path-row">
          <div class="path-copy">
            <div class="path-label">Atlas</div>
            <div class="path-value">${escapeHtml(displayPath(exportInfo?.atlas?.path ?? "arena-export/cursed_sword/atlas.png"))}</div>
          </div>
          <button class="secondary small" type="button" data-copy-path="${escapeHtml(exportInfo?.atlas?.path ?? "arena-export/cursed_sword/atlas.png")}">Copy</button>
        </div>
        <div class="path-row">
          <div class="path-copy">
            <div class="path-label">Manifest</div>
            <div class="path-value">${escapeHtml(displayPath(exportInfo?.manifest?.path ?? "arena-export/cursed_sword/weapon.manifest.json"))}</div>
          </div>
          <button class="secondary small" type="button" data-copy-path="${escapeHtml(exportInfo?.manifest?.path ?? "arena-export/cursed_sword/weapon.manifest.json")}">Copy</button>
        </div>
        <div class="path-row">
          <div class="path-copy">
            <div class="path-label">README</div>
            <div class="path-value">${escapeHtml(displayPath(exportInfo?.readme?.path ?? "arena-export/cursed_sword/README.md"))}</div>
          </div>
          <button class="secondary small" type="button" data-copy-path="${escapeHtml(exportInfo?.readme?.path ?? "arena-export/cursed_sword/README.md")}">Copy</button>
        </div>
      </div>
      <div class="advanced-actions">
        <button class="secondary" type="button" data-action="copy-export-path">Copy export path</button>
      </div>
      <button type="button" data-action="export-arena" ${state.busy || !atlasReady() ? "disabled" : ""}>Export Arena Package</button>
      <div class="subtle">Manifest validation runs automatically before export.</div>
    </section>
  `;

  let html = "";
  if (state.currentStepIndex === 0) {
    html = sourceSummaryHtml;
  } else if (state.currentStepIndex === 1) {
    html = sf3dSummaryHtml;
  } else if (state.currentStepIndex === 2) {
    html = atlasSummaryHtml;
  } else {
    html = exportSummaryHtml;
  }

  el.advancedBody.innerHTML = html;

  const manifest = exportPackage()?.manifest?.data ?? manifestFile()?.data;
  const manifestViewer = el.advancedBody.querySelector("#manifestViewer");
  if (manifestViewer) {
    manifestViewer.textContent = manifest
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : "Manifest not available yet.\n";
  }
}

function renderLogs() {
  el.logOutput.textContent = state.logs
    .slice(-400)
    .map((entry) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      return `${time} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}`;
    })
    .join("\n");
  el.logOutput.scrollTop = el.logOutput.scrollHeight;
}

function renderStaticControls() {
  const busy = state.busy;
  const backEnabled = !busy && state.currentStepIndex > 0;
  const nextEnabled = !busy && state.currentStepIndex < STEP_META.length - 1 && stepReady(state.currentStepIndex);
  el.backButton.disabled = !backEnabled;
  el.nextButton.disabled = !nextEnabled;
  el.refreshButton.disabled = busy;
}

function renderAll() {
  renderTopBar();
  renderStepRail();
  renderPreview();
  renderStepOptions();
  renderAdvancedPanels();
  renderStaticControls();
  renderLogs();
}

function goToStep(index) {
  const clamped = Math.max(0, Math.min(index, STEP_META.length - 1));
  if (clamped > highestUnlockedStep()) {
    return;
  }
  state.currentStepIndex = clamped;
  state.stepTouched = true;
  renderAll();
}

function setBusy(busy) {
  state.busy = busy;
  renderAll();
  if (busy) {
    el.saveState.textContent = "Running...";
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed (${response.status})`);
  }
  return payload;
}

async function refreshStatus() {
  const status = await fetchJson("/api/status");
  setStatus(status);
  addLogs(status.recentLogs ?? []);
  setSaveState("Loaded");
}

let saveTimer = null;
function queueSaveConfig() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      setSaveState("Saving...");
      const response = await fetchJson("/api/config", {
        method: "POST",
        body: JSON.stringify(currentConfigFromForm())
      });
      setStatus(response);
      addLogs(response.recentLogs ?? []);
      setSaveState("Saved");
    } catch (error) {
      setSaveState(`Save failed: ${error.message}`);
      appendLocalLog("error", "ui", error.message);
    }
  }, 350);
}

async function runAction(endpoint, body, label, onSuccess) {
  let succeeded = false;
  try {
    setBusy(true);
    const response = await fetchJson(endpoint, {
      method: "POST",
      body: body ? JSON.stringify(body) : "{}"
    });
    if (response.status) {
      setStatus(response.status);
    }
    if (typeof onSuccess === "function") {
      onSuccess(response);
    }
    await refreshStatus();
    succeeded = true;
    return response;
  } catch (error) {
    appendLocalLog("error", "ui", `${label} failed: ${error.message}`);
    setSaveState(`${label} failed`);
    throw error;
  } finally {
    setBusy(false);
    if (succeeded) {
      setSaveState(`${label} complete`);
    }
  }
}

function applyPreset(preset) {
  const draft = formConfigDraft();
  draft.renderMode = preset.renderMode;
  draft.angles = [...preset.angles];
  draft.frameSize = {
    ...(draft.frameSize ?? {}),
    width: preset.frameSize.width,
    height: preset.frameSize.height
  };
  draft.camera = {
    ...(draft.camera ?? {}),
    orthographicScale: preset.orthographicScale
  };
  queueSaveConfig();
}

function bindStepOptionActions(unlockedStep) {
  const refreshSourceButton = el.stepOptions.querySelector("#refreshSourceButton");
  if (refreshSourceButton) {
    refreshSourceButton.addEventListener("click", refreshStatus);
  }

  const useImageButton = el.stepOptions.querySelector("#useImageButton");
  if (useImageButton) {
    useImageButton.addEventListener("click", () => goToStep(1));
  }

  const runSf3dButton = el.stepOptions.querySelector("#runSf3dButton");
  if (runSf3dButton) {
    runSf3dButton.addEventListener("click", () => runAction("/api/run-sf3d", currentConfigFromForm(), "Generate 3D Model", (response) => {
      if (response.activeModelPath) {
        const result = el.advancedBody.querySelector("#sf3dResult");
        if (result) {
          result.textContent = `Active model: ${response.activeModelPath}`;
        }
      }
      goToStep(2);
    }));
  }

  const generateAtlasButton = el.stepOptions.querySelector("#generateAtlasButton");
  if (generateAtlasButton) {
    generateAtlasButton.addEventListener("click", () => runAction("/api/generate-weapon-atlas", currentConfigFromForm(), "Generate Weapon Atlas", () => {
      goToStep(3);
    }));
  }

  const presetGameplayButton = el.stepOptions.querySelector("#presetGameplayButton");
  if (presetGameplayButton) {
    presetGameplayButton.addEventListener("click", () => applyPreset(PRESETS.gameplay2d));
  }

  const presetTurntableButton = el.stepOptions.querySelector("#presetTurntableButton");
  if (presetTurntableButton) {
    presetTurntableButton.addEventListener("click", () => applyPreset(PRESETS.turntable3d));
  }

  const presetCloseGameplayButton = el.stepOptions.querySelector("#presetCloseGameplayButton");
  if (presetCloseGameplayButton) {
    presetCloseGameplayButton.addEventListener("click", () => applyPreset(PRESETS.closeGameplay2d));
  }

  const exportArenaButton = el.stepOptions.querySelector("#exportArenaButton");
  if (exportArenaButton) {
    exportArenaButton.addEventListener("click", () => runAction("/api/export-arena-package", currentConfigFromForm(), "Export Arena Package", () => {
      goToStep(3);
    }));
  }

  const copyExportPathButton = el.stepOptions.querySelector("#copyExportPathButton");
  if (copyExportPathButton) {
    copyExportPathButton.addEventListener("click", async () => {
      const pathValue = state.status?.paths?.exportDir ?? "arena-export/cursed_sword";
      try {
        await navigator.clipboard.writeText(pathValue);
        setSaveState(`Copied ${pathValue}`);
      } catch {
        appendLocalLog("warn", "ui", `Could not copy path: ${pathValue}`);
      }
    });
  }
}

function wireStaticActions() {
  el.refreshButton.addEventListener("click", refreshStatus);
  el.backButton.addEventListener("click", () => goToStep(state.currentStepIndex - 1));
  el.nextButton.addEventListener("click", () => goToStep(state.currentStepIndex + 1));
}

function wireAdvancedInteractions() {
  el.advancedBody.addEventListener("input", () => {
    updateDraftFromStepInputs();
    queueSaveConfig();
  });

  el.advancedBody.addEventListener("change", () => {
    updateDraftFromStepInputs();
    queueSaveConfig();
  });

  el.advancedBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) {
      return;
    }

    if (button.dataset.copyPath) {
      const pathValue = button.dataset.copyPath;
      try {
        await navigator.clipboard.writeText(pathValue);
        setSaveState(`Copied ${pathValue}`);
      } catch {
        appendLocalLog("warn", "ui", `Could not copy path: ${pathValue}`);
      }
      return;
    }

    const action = button.dataset.action;
    if (!action) {
      return;
    }

    if (action === "refresh-source") {
      await refreshStatus();
      return;
    }

    if (action === "copy-source-path") {
      const pathValue = sourceFile()?.path ?? "input/cursed_sword_source.png";
      try {
        await navigator.clipboard.writeText(pathValue);
        setSaveState(`Copied ${pathValue}`);
      } catch {
        appendLocalLog("warn", "ui", `Could not copy path: ${pathValue}`);
      }
      return;
    }

    if (action === "copy-glb") {
      await runAction("/api/copy-glb", null, "Copy GLB manually");
      return;
    }

    if (action === "run-sf3d") {
      await runAction("/api/run-sf3d", currentConfigFromForm(), "Generate 3D Model", (response) => {
        if (response.activeModelPath) {
          const result = el.advancedBody.querySelector("#sf3dResult");
          if (result) {
            result.textContent = `Active model: ${response.activeModelPath}`;
          }
        }
        goToStep(2);
      });
      return;
    }

    if (action === "render-frames") {
      await runAction("/api/render-frames", currentConfigFromForm(), "Render Frames only");
      return;
    }

    if (action === "build-atlas") {
      await runAction("/api/build-atlas", null, "Build Atlas only");
      return;
    }

    if (action === "validate-manifest") {
      await runAction("/api/validate", null, "Validate Manifest only");
      return;
    }

    if (action === "copy-export-path") {
      const pathValue = state.status?.paths?.exportDir ?? "arena-export/cursed_sword";
      try {
        await navigator.clipboard.writeText(pathValue);
        setSaveState(`Copied ${pathValue}`);
      } catch {
        appendLocalLog("warn", "ui", `Could not copy path: ${pathValue}`);
      }
      return;
    }

    if (action === "export-arena") {
      await runAction("/api/export-arena-package", currentConfigFromForm(), "Export Arena Package", () => {
        goToStep(3);
      });
    }
  });
}

function connectEventStream() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => setBadge("Live", "good"));
  source.addEventListener("error", () => setBadge("Reconnecting", "warn"));
  source.addEventListener("log", (event) => addLogs([JSON.parse(event.data)]));
  source.addEventListener("status", (event) => {
    setStatus(JSON.parse(event.data));
  });
}

async function main() {
  el.currentStepBadge = $("currentStepBadge");
  el.workflowProgress = $("workflowProgress");
  el.globalStatusLine = $("globalStatusLine");
  el.connectionState = $("connectionState");
  el.refreshButton = $("refreshButton");
  el.currentStepTitle = $("currentStepTitle");
  el.currentStepMeta = $("currentStepMeta");
  el.stepOptionHint = $("stepOptionHint");
  el.stepList = $("stepList");
  el.stepPreview = $("stepPreview");
  el.stepCaption = $("stepCaption");
  el.stepOptions = $("stepOptions");
  el.advancedBody = $("advancedToolsBody");
  el.backButton = $("backButton");
  el.nextButton = $("nextButton");
  el.saveState = $("saveState");
  el.logOutput = $("logOutput");

  wireStaticActions();
  wireAdvancedInteractions();

  await refreshStatus();
  connectEventStream();
  setBadge("Connected", "good");
}

main().catch((error) => {
  setBadge("Offline", "bad");
  appendLocalLog("error", "ui", error.message);
});
