import * as THREE from "./vendor/three/three.module.js";
import { GLTFLoader } from "./vendor/three/GLTFLoader.js";
import { OrbitControls } from "./vendor/three/OrbitControls.js";

const el = {
  status: document.getElementById("status"),
  overlay: document.getElementById("viewerOverlay"),
  canvas: document.getElementById("viewerCanvas"),
  modelSelect: document.getElementById("modelSelect"),
  weaponJson: document.getElementById("weaponJson"),
  refreshButton: document.getElementById("refreshButton"),
  captureButton: document.getElementById("captureButton"),
  bakeSpriteButton: document.getElementById("bakeSpriteButton"),
  autoRotateInput: document.getElementById("autoRotateInput"),
  exposureInput: document.getElementById("exposureInput"),
  lightInput: document.getElementById("lightInput"),
  distanceInput: document.getElementById("distanceInput"),
  modelYawInput: document.getElementById("modelYawInput"),
  capturePreview: document.getElementById("capturePreview"),
  bakeResult: document.getElementById("bakeResult")
};

let sources = [];
let currentModel = null;
let currentModelBaseRotationY = 0;
let animationHandle = 0;
let activeSourcePath = null;

const renderer = new THREE.WebGLRenderer({
  canvas: el.canvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
camera.position.set(0, 0, 3);

const controls = new OrbitControls(camera, el.canvas);
controls.enableDamping = true;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.2;

let aofRightPanActive = false;

function installAofRightClickPanOnly() {
  // AOF_RIGHT_CLICK_PAN_ONLY_V3
  // Left click rotates. Right click only pans. No auto-rotate or damping while right-dragging.
  let lastX = 0;
  let lastY = 0;
  let previousAutoRotate = false;
  let previousEnableDamping = true;
  let previousControlsEnabled = true;
  let previousEnableRotate = true;

  const panRight = new THREE.Vector3();
  const panUp = new THREE.Vector3();
  const panVector = new THREE.Vector3();

  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: null
  };

  function blockEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function panCameraByPixels(dx, dy) {
    const rect = el.canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const distance = Math.max(0.001, camera.position.distanceTo(controls.target));
    const fov = THREE.MathUtils.degToRad(camera.fov || 35);
    const viewportHeight = 2 * Math.tan(fov / 2) * distance;
    const viewportWidth = viewportHeight * (camera.aspect || width / height);

    panRight.setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * viewportWidth / width);
    panUp.setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * viewportHeight / height);
    panVector.copy(panRight).add(panUp);

    camera.position.add(panVector);
    controls.target.add(panVector);
    camera.lookAt(controls.target);
    camera.updateMatrixWorld();
  }

  function startRightPan(event) {
    if (event.button !== 2) {
      return;
    }

    blockEvent(event);

    aofRightPanActive = true;
    lastX = event.clientX;
    lastY = event.clientY;

    previousAutoRotate = Boolean(controls.autoRotate);
    previousEnableDamping = Boolean(controls.enableDamping);
    previousControlsEnabled = Boolean(controls.enabled);
    previousEnableRotate = Boolean(controls.enableRotate);

    controls.autoRotate = false;
    controls.enableDamping = false;
    controls.enabled = false;
    controls.enableRotate = false;
    controls.update();

    el.canvas.setPointerCapture?.(event.pointerId);
  }

  function moveRightPan(event) {
    if (!aofRightPanActive) {
      return;
    }

    blockEvent(event);

    const dx = event.clientX - lastX;
    const dy = event.clientY - lastY;
    lastX = event.clientX;
    lastY = event.clientY;

    panCameraByPixels(dx, dy);
  }

  function stopRightPan(event) {
    if (!aofRightPanActive) {
      return;
    }

    blockEvent(event);

    aofRightPanActive = false;
    controls.enabled = previousControlsEnabled;
    controls.enableRotate = previousEnableRotate;
    controls.enableDamping = previousEnableDamping;
    controls.autoRotate = previousAutoRotate;
    controls.update();
    el.canvas.releasePointerCapture?.(event.pointerId);
  }

  el.canvas.addEventListener("contextmenu", blockEvent, true);
  el.canvas.addEventListener("pointerdown", startRightPan, true);
  window.addEventListener("pointermove", moveRightPan, true);
  window.addEventListener("pointerup", stopRightPan, true);
  window.addEventListener("pointercancel", stopRightPan, true);
  el.canvas.addEventListener("mousedown", (event) => {
    if (event.button === 2) {
      blockEvent(event);
    }
  }, true);
}

installAofRightClickPanOnly();






const ambientLight = new THREE.AmbientLight(0xffffff, 1.2);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.5);
keyLight.position.set(3, 4, 5);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0x8fb7ff, 1.2);
fillLight.position.set(-4, 2, -3);
scene.add(fillLight);

const loader = new GLTFLoader();

function fileUrl(path) {
  return `/api/file?path=${encodeURIComponent(path)}&v=${Date.now()}`;
}

function normalizePath(path) {
  return String(path ?? "").replaceAll("\\", "/");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function deriveWeaponId(status) {
  const sourcePath =
    status?.config?.sourceTexture ??
    status?.config?.sourceImage ??
    status?.config?.inputImage ??
    "input/cursed_sword_source.png";

  return String(sourcePath)
    .split(/[\\/]/g)
    .pop()
    .replace(/\.[^.]+$/u, "")
    .replace(/_source_cropped$/iu, "")
    .replace(/_source$/iu, "")
    .replace(/_cropped$/iu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "cursed_sword";
}

function addSource(label, file) {
  if (file?.exists && file.path) {
    sources.push({ label, path: normalizePath(file.path) });
  }
}

async function loadJson(path) {
  const response = await fetch(fileUrl(path));
  if (!response.ok) throw new Error(`Missing ${path}`);
  return response.json();
}

async function loadStatus() {
  el.status.textContent = "Loading /api/status...";
  const response = await fetch("/api/status");
  if (!response.ok) {
    throw new Error(`Status failed: ${response.status}`);
  }

  const status = await response.json();
  const weaponId = deriveWeaponId(status);

  sources = [];
  addSource("Arena package model", { exists: true, path: `arena-export/weapons/${weaponId}/model.glb` });
  addSource("Active input model", status.files?.inputModel);
  addSource("Hunyuan textured model", status.files?.hunyuanTexturedModel);
  addSource("SF3D mesh", status.files?.sf3dGlb);

  el.modelSelect.innerHTML = sources.map((source, index) => (
    `<option value="${index}">${escapeHtml(source.label)} - ${escapeHtml(source.path)}</option>`
  )).join("");

  try {
    const weaponJson = await loadJson(`arena-export/weapons/${weaponId}/weapon.json`);
    el.weaponJson.textContent = JSON.stringify(weaponJson, null, 2);
  } catch {
    el.weaponJson.textContent = `No weapon.json found at arena-export/weapons/${weaponId}/weapon.json`;
  }

  el.status.textContent = sources.length ? `Loaded ${weaponId}.` : `No GLB found for ${weaponId}.`;

  if (sources[0]) {
    await loadModelSource(sources[0]);
  }
}

function disposeCurrentModel() {
  if (!currentModel) {
    return;
  }

  scene.remove(currentModel);
  currentModel.traverse((object) => {
    if (object.isMesh) {
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const value of Object.values(material)) {
          if (value?.isTexture) {
            value.dispose();
          }
        }
        material.dispose?.();
      }
    }
  });
  currentModel = null;
}

async function loadModelSource(source) {
  activeSourcePath = source.path;
  el.overlay.textContent = `Loading ${source.path}...`;
  disposeCurrentModel();

  await new Promise((resolve, reject) => {
    loader.load(
      fileUrl(source.path),
      (gltf) => {
        currentModel = gltf.scene;
        scene.add(currentModel);
        normalizeModel(currentModel);
        frameModel(currentModel);
        applyControls();
        el.overlay.textContent = `Model loaded: ${source.path}`;
        resolve();
      },
      undefined,
      (error) => {
        el.overlay.textContent = `GLB load error: ${error?.message ?? error}`;
        reject(error);
      }
    );
  });
}

function normalizeModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  model.position.sub(center);

  const maxAxis = Math.max(size.x, size.y, size.z);
  if (maxAxis > 0) {
    model.scale.setScalar(1 / maxAxis);
  }

  const normalizedBox = new THREE.Box3().setFromObject(model);
  const normalizedSize = new THREE.Vector3();
  normalizedBox.getSize(normalizedSize);

  if (normalizedSize.y > normalizedSize.x) {
    currentModelBaseRotationY = Math.PI / 2;
  } else {
    currentModelBaseRotationY = 0;
  }
}

function frameModel(model) {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);

  const maxAxis = Math.max(size.x, size.y, size.z, 1);
  const distance = maxAxis * Number(el.distanceInput.value || 1.35) * 2.2;

  camera.position.set(0, 0.15, distance);
  camera.near = 0.01;
  camera.far = 100;
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}

function applyControls() {
  controls.autoRotate = Boolean(el.autoRotateInput.checked);
  renderer.toneMappingExposure = Number(el.exposureInput.value || 1);

  const lightIntensity = Number(el.lightInput.value || 2.5);
  keyLight.intensity = lightIntensity;
  fillLight.intensity = lightIntensity * 0.45;
  ambientLight.intensity = Math.max(0.35, lightIntensity * 0.4);

  if (currentModel) {
    currentModel.rotation.y = currentModelBaseRotationY + (Number(el.modelYawInput.value || 0) * Math.PI) / 180;
    frameModel(currentModel);
  }
}

function resizeRenderer() {
  const rect = el.canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));

  if (el.canvas.width !== width || el.canvas.height !== height) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }
}

function animate() {
  resizeRenderer();
  if (!aofRightPanActive) {
    controls.update();
  }
  renderer.render(scene, camera);
  animationHandle = requestAnimationFrame(animate);
}

el.modelSelect.addEventListener("change", () => {
  const source = sources[Number(el.modelSelect.value)];
  if (source) {
    loadModelSource(source).catch((error) => {
      el.status.textContent = error instanceof Error ? error.message : String(error);
    });
  }
});

[
  el.autoRotateInput,
  el.exposureInput,
  el.lightInput,
  el.distanceInput,
  el.modelYawInput
].forEach((input) => {
  input.addEventListener("input", applyControls);
  input.addEventListener("change", applyControls);
});

el.refreshButton.addEventListener("click", () => {
  loadStatus().catch((error) => {
    el.status.textContent = error instanceof Error ? error.message : String(error);
  });
});

el.captureButton.addEventListener("click", () => {
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");
  el.capturePreview.innerHTML = `<img src="${dataUrl}" alt="Captured weapon preview" />`;

  const link = document.createElement("a");
  link.href = dataUrl;
  link.download = "weapon-viewer-capture.png";
  link.click();
});


async function bakeSpriteToPackage() {
  renderer.render(scene, camera);
  const dataUrl = renderer.domElement.toDataURL("image/png");

  el.bakeResult.textContent = "Baking sprite to package...";

  const body = {
    dataUrl,
    modelSourcePath: activeSourcePath,
    camera: {
      position: camera.position.toArray(),
      target: controls.target.toArray(),
      fov: camera.fov,
      aspect: camera.aspect
    },
    controls: {
      autoRotate: Boolean(el.autoRotateInput.checked),
      exposure: Number(el.exposureInput.value || 1),
      lightIntensity: Number(el.lightInput.value || 2.5),
      distanceMultiplier: Number(el.distanceInput.value || 1.35),
      modelYawDeg: Number(el.modelYawInput.value || 0)
    }
  };

  const response = await fetch("/api/weapon-viewer/bake-sprite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();
  if (!response.ok || result.ok === false) {
    throw new Error(result.error || "Bake failed with HTTP " + response.status);
  }

  el.bakeResult.innerHTML = [
    "<h2>Baked Sprite</h2>",
    "<pre>" + escapeHtml(JSON.stringify({
      spritePath: result.spritePath,
      renderManifestPath: result.renderManifestPath
    }, null, 2)) + "</pre>",
    '<img src="/api/file?path=' + encodeURIComponent(result.spritePath) + '&v=' + Date.now() + '" alt="Baked weapon sprite" style="max-width:100%; border:1px solid #a56a22; border-radius:8px;" />'
  ].join("");
}

el.bakeSpriteButton.addEventListener("click", () => {
  bakeSpriteToPackage().catch((error) => {
    el.bakeResult.textContent = error instanceof Error ? error.message : String(error);
  });
});

window.addEventListener("beforeunload", () => {
  cancelAnimationFrame(animationHandle);
  disposeCurrentModel();
});

animate();

loadStatus().catch((error) => {
  el.status.textContent = error instanceof Error ? error.message : String(error);
  el.overlay.textContent = error instanceof Error ? error.message : String(error);
});
