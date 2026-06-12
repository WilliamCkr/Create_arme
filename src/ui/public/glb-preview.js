import * as THREE from 'three';
import { GLTFLoader } from '/vendor/three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/examples/jsm/controls/OrbitControls.js';

const params = new URLSearchParams(location.search);
const modelPath = params.get('path') || 'input/cursed_sword.glb';
const statusEl = document.getElementById('status');
const errorEl = document.getElementById('error');
const canvas = document.getElementById('canvas');

function setStatus(text) {
  statusEl.textContent = text;
}

function showError(message) {
  errorEl.style.display = 'block';
  errorEl.textContent = message;
  console.error(message);
}

function modelUrl() {
  return '/api/file?path=' + encodeURIComponent(modelPath) + '&t=' + Date.now();
}

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
camera.position.set(0, 0.8, 6);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enableRotate = false;
controls.dampingFactor = 0.06;
controls.target.set(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x1c2530, 1.65));

const key = new THREE.DirectionalLight(0xffffff, 1.85);
key.position.set(3, 5, 4);
scene.add(key);

const fill = new THREE.DirectionalLight(0x88bbff, 0.85);
fill.position.set(-4, 2, -3);
scene.add(fill);

const root = new THREE.Group();
scene.add(root);

let model = null;
let autoRotate = false;

function resize() {
  const w = Math.max(320, window.innerWidth);
  const h = Math.max(320, window.innerHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function fitModel() {
  if (!model) return;

  model.position.set(0, 0, 0);

  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  model.position.x -= center.x;
  model.position.y -= center.y;
  model.position.z -= center.z;

  const maxDim = Math.max(size.x, size.y, size.z, 0.1);
  const fov = camera.fov * Math.PI / 180;
  const fitHeightDistance = maxDim / (2 * Math.tan(fov / 2));
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = Math.max(fitHeightDistance, fitWidthDistance) * 1.65;

  camera.near = Math.max(distance / 100, 0.001);
  camera.far = distance * 100;
  camera.position.set(distance * 0.35, distance * 0.18, distance);
  camera.updateProjectionMatrix();

  controls.target.set(0, 0, 0);
  controls.update();
}

function resetView() {
  if (!model) return;
  fitModel();
  aofApplyModelRotation();
  aofEnsureGripMarker();
  aofApplyGripMarkerTransform();
}

async function checkFile(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error('GLB file request failed: HTTP ' + res.status + '\nURL: ' + url);
  }
  const contentType = res.headers.get('content-type') || 'unknown';
  const length = res.headers.get('content-length') || 'unknown';
  setStatus('GLB reachable, loading viewer... type=' + contentType + ', size=' + length);
}

async function loadModel() {
  const url = modelUrl();

  try {
    setStatus('Checking ' + modelPath + '...');
    await checkFile(url);
  } catch (err) {
    showError(String(err && err.message ? err.message : err));
    setStatus('GLB request failed');
    return;
  }

  const loader = new GLTFLoader();

  loader.load(
    url,
    (gltf) => {
      while (root.children.length) {
        root.remove(root.children[0]);
      }

      model = gltf.scene;
      root.add(model);

      model.traverse((obj) => {
        if (obj.isMesh) {
          obj.frustumCulled = false;
          if (obj.material) {
            obj.material.side = THREE.DoubleSide;
            obj.material.needsUpdate = true;
          }
        }
      });

      fitModel();
      aofApplyModelRotation();
      aofEnsureGripMarker();
      void aofLoadGripFromConfig();
      setStatus('Loaded: ' + modelPath);
    },
    undefined,
    (err) => {
      showError('GLTFLoader failed:\n' + (err && err.message ? err.message : String(err)));
      setStatus('GLB parse failed');
    }
  );
}

document.getElementById('reset').addEventListener('click', resetView);
document.getElementById('fit').addEventListener('click', fitModel);
document.getElementById('auto').addEventListener('click', (event) => {
  autoRotate = !autoRotate;
  event.currentTarget.textContent = 'Auto Rotate: ' + (autoRotate ? 'On' : 'Off');
});

window.addEventListener('resize', resize);
resize();
canvas.tabIndex = 0;

let aofGlbRightPanActive = false;

function installAofGlbPreviewRightClickPanOnly() {
  // AOF_GLB_PREVIEW_RIGHT_CLICK_PAN_ONLY_V1
  // This page has its own pointer rotation logic, separate from weapon-viewer.js.
  // Right click is captured before that logic and used only for camera pan.
  let lastX = 0;
  let lastY = 0;
  let previousAutoRotate = false;
  let previousEnableDamping = true;

  const panRight = new THREE.Vector3();
  const panUp = new THREE.Vector3();
  const panVector = new THREE.Vector3();

  function blockEvent(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function panCameraByPixels(dx, dy) {
    const rect = canvas.getBoundingClientRect();
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

    aofGlbRightPanActive = true;
    lastX = event.clientX;
    lastY = event.clientY;

    previousAutoRotate = Boolean(autoRotate);
    previousEnableDamping = Boolean(controls.enableDamping);
    autoRotate = false;
    controls.enableDamping = false;
    controls.update();

    canvas.setPointerCapture?.(event.pointerId);
  }

  function moveRightPan(event) {
    if (!aofGlbRightPanActive) {
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
    if (!aofGlbRightPanActive) {
      return;
    }

    blockEvent(event);

    aofGlbRightPanActive = false;
    autoRotate = previousAutoRotate;
    controls.enableDamping = previousEnableDamping;
    controls.update();
    canvas.releasePointerCapture?.(event.pointerId);
  }

  canvas.addEventListener("contextmenu", blockEvent, true);
  canvas.addEventListener("pointerdown", startRightPan, true);
  window.addEventListener("pointermove", moveRightPan, true);
  window.addEventListener("pointerup", stopRightPan, true);
  window.addEventListener("pointercancel", stopRightPan, true);
  canvas.addEventListener("mousedown", (event) => {
    if (event.button === 2) {
      blockEvent(event);
    }
  }, true);
}

installAofGlbPreviewRightClickPanOnly();



/* AOF_MODEL_DRAG_ROTATION_MINIMAL_START */
const AOF_MODEL_ROTATION_STORAGE_KEY = `arena-object-forge:glb-preview:minimal-model-rotation:${modelPath}`;
const AOF_MODEL_ROTATION_DRAG = 0.45;
const AOF_MODEL_ROTATION_ROLL = 0.55;

let aofModelDragState = null;
let aofModelRotationDeg = aofLoadModelRotation();

function aofFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function aofWrapDeg(value) {
  let v = aofFiniteNumber(value, 0);
  while (v > 360) v -= 720;
  while (v < -360) v += 720;
  return Math.round(v * 1000) / 1000;
}

function aofLoadModelRotation() {
  try {
    const raw = window.localStorage.getItem(AOF_MODEL_ROTATION_STORAGE_KEY);
    if (!raw) return { x: 0, y: 0, z: 0 };
    const parsed = JSON.parse(raw);
    return {
      x: aofWrapDeg(parsed.x),
      y: aofWrapDeg(parsed.y),
      z: aofWrapDeg(parsed.z)
    };
  } catch {
    return { x: 0, y: 0, z: 0 };
  }
}

function aofSaveModelRotation() {
  window.localStorage.setItem(AOF_MODEL_ROTATION_STORAGE_KEY, JSON.stringify(aofModelRotationDeg));
}

function aofApplyModelRotation() {
  if (!model) return;

  model.rotation.set(
    THREE.MathUtils.degToRad(aofModelRotationDeg.x),
    THREE.MathUtils.degToRad(aofModelRotationDeg.y),
    THREE.MathUtils.degToRad(aofModelRotationDeg.z),
    "XYZ"
  );

  aofSaveModelRotation();
}

function aofResetModelRotation() {
  aofModelRotationDeg = { x: 0, y: 0, z: 0 };
  aofApplyModelRotation();
}

function aofFlipModelX() {
  aofModelRotationDeg.x = aofWrapDeg(aofModelRotationDeg.x + 180);
  aofApplyModelRotation();
}

function aofFlipModelY() {
  aofModelRotationDeg.y = aofWrapDeg(aofModelRotationDeg.y + 180);
  aofApplyModelRotation();
}

function aofRollModel(delta) {
  aofModelRotationDeg.z = aofWrapDeg(aofModelRotationDeg.z + delta);
  aofApplyModelRotation();
}

function aofPointerDown(event) {
  if (event.button === 2 || aofGlbRightPanActive) {
    return;
  }
  if (!model) return;
  if (event.target !== canvas) return;
  if (aofGripHandlePointerDown(event)) return;

  aofModelDragState = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
    mode: event.shiftKey || event.button === 1 ? "roll" : "turn"
  };

  canvas.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function aofPointerMove(event) {
  if (aofGlbRightPanActive) {
    return;
  }
  if (!aofModelDragState) return;
  if (event.pointerId !== aofModelDragState.pointerId) return;

  const dx = event.clientX - aofModelDragState.lastX;
  const dy = event.clientY - aofModelDragState.lastY;

  aofModelDragState.lastX = event.clientX;
  aofModelDragState.lastY = event.clientY;

  if (aofModelDragState.mode === "roll" || event.shiftKey) {
    aofModelRotationDeg.z = aofWrapDeg(aofModelRotationDeg.z + dx * AOF_MODEL_ROTATION_ROLL);
  } else {
    aofModelRotationDeg.y = aofWrapDeg(aofModelRotationDeg.y + dx * AOF_MODEL_ROTATION_DRAG);
    aofModelRotationDeg.x = aofWrapDeg(aofModelRotationDeg.x + dy * AOF_MODEL_ROTATION_DRAG);
  }

  aofApplyModelRotation();
  event.preventDefault();
}

function aofPointerUp(event) {
  if (!aofModelDragState) return;
  if (event.pointerId !== aofModelDragState.pointerId) return;

  canvas.releasePointerCapture?.(event.pointerId);
  aofModelDragState = null;
  event.preventDefault();
}

function aofKeyDown(event) {
  if (event.target?.matches?.("input, textarea, select")) return;

  const key = event.key.toLowerCase();

  if (aofGripHandleKeyDown(event, key)) return;

  if (key === "r") {
    aofResetModelRotation();
  }

  if (key === "f") {
    aofFlipModelX();
  }

  if (key === "g") {
    aofFlipModelY();
  }

  if (key === "q") {
    aofRollModel(-15);
  }

  if (key === "e") {
    aofRollModel(15);
  }
}


/* AOF_GRIP_JOINT_EDITOR_V1_START */
const AOF_GRIP_STORAGE_KEY = `arena-object-forge:glb-preview:weapon-grip:${modelPath}`;
const AOF_GRIP_SPACE = "model-local-v1";

let aofGripEditMode = false;
let aofGripMarker = null;
let aofGripSaveTimer = null;

const aofGripRaycaster = new THREE.Raycaster();
const aofGripPointer = new THREE.Vector2();

function aofSanitizeVector(value, fallback = { x: 0, y: 0, z: 0 }) {
  return {
    x: Math.round(aofFiniteNumber(value?.x, fallback.x) * 1000000) / 1000000,
    y: Math.round(aofFiniteNumber(value?.y, fallback.y) * 1000000) / 1000000,
    z: Math.round(aofFiniteNumber(value?.z, fallback.z) * 1000000) / 1000000
  };
}

function aofCloneModelRotationDeg() {
  return {
    x: aofWrapDeg(aofModelRotationDeg.x),
    y: aofWrapDeg(aofModelRotationDeg.y),
    z: aofWrapDeg(aofModelRotationDeg.z)
  };
}

function aofDefaultGripData() {
  return {
    version: 1,
    kind: "weaponGripJoint",
    name: "grip",
    label: "Grip / hand connection joint",
    space: AOF_GRIP_SPACE,
    modelPath,
    visible: true,
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 }
  };
}

function aofLoadGripLocal() {
  try {
    const raw = window.localStorage.getItem(AOF_GRIP_STORAGE_KEY);
    if (!raw) return aofDefaultGripData();

    const parsed = JSON.parse(raw);
    return {
      ...aofDefaultGripData(),
      ...parsed,
      position: aofSanitizeVector(parsed.position),
      rotationDeg: aofSanitizeVector(parsed.rotationDeg)
    };
  } catch {
    return aofDefaultGripData();
  }
}

let aofGripData = aofLoadGripLocal();

function aofBuildGripPayload() {
  return {
    ...aofDefaultGripData(),
    ...aofGripData,
    position: aofSanitizeVector(aofGripData.position),
    rotationDeg: aofSanitizeVector(aofGripData.rotationDeg),
    previewModelRotationDeg: aofCloneModelRotationDeg(),
    updatedAt: new Date().toISOString()
  };
}

function aofSaveGripLocal() {
  window.localStorage.setItem(AOF_GRIP_STORAGE_KEY, JSON.stringify(aofBuildGripPayload()));
}

function aofGripVectorText(vector) {
  const v = aofSanitizeVector(vector);
  return `x=${v.x.toFixed(4)} y=${v.y.toFixed(4)} z=${v.z.toFixed(4)}`;
}

function aofUpdateGripInfo(extra = "") {
  const button = document.getElementById("grip");
  const info = document.getElementById("gripInfo");

  if (button) {
    button.textContent = "Place Grip: " + (aofGripEditMode ? "On" : "Off");
    button.classList.toggle("on", aofGripEditMode);
  }

  if (info) {
    const prefix = aofGripEditMode
      ? "Grip edit ON"
      : "Grip edit OFF";
    const suffix = extra ? ` | ${extra}` : "";
    info.textContent = `${prefix} | ${aofGripVectorText(aofGripData.position)}${suffix}`;
  }
}

function aofModelMaxDimension() {
  if (!model) return 1;
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  return Math.max(size.x, size.y, size.z, 0.001);
}

function aofCreateGripAxisLine(color, end) {
  const geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    end
  ]);
  const material = new THREE.LineBasicMaterial({
    color,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95
  });
  const line = new THREE.Line(geometry, material);
  line.renderOrder = 999;
  line.userData.aofGripMarker = true;
  return line;
}

function aofEnsureGripMarker() {
  if (!model) return;

  if (aofGripMarker && aofGripMarker.parent === model) {
    return;
  }

  if (aofGripMarker?.parent) {
    aofGripMarker.parent.remove(aofGripMarker);
  }

  const group = new THREE.Group();
  group.name = "AOF_weapon_grip_joint";
  group.userData.aofGripMarker = true;

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 24, 16),
    new THREE.MeshBasicMaterial({
      color: 0x00ff99,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.95
    })
  );
  sphere.name = "AOF_weapon_grip_joint_center";
  sphere.renderOrder = 1000;
  sphere.userData.aofGripMarker = true;
  group.add(sphere);

  group.add(aofCreateGripAxisLine(0xff5555, new THREE.Vector3(0.22, 0, 0)));
  group.add(aofCreateGripAxisLine(0x55ff88, new THREE.Vector3(0, 0.22, 0)));
  group.add(aofCreateGripAxisLine(0x55aaff, new THREE.Vector3(0, 0, 0.22)));

  model.add(group);
  aofGripMarker = group;
  aofApplyGripMarkerTransform();
}

function aofApplyGripMarkerTransform() {
  if (!model || !aofGripMarker) return;

  const position = aofSanitizeVector(aofGripData.position);
  aofGripMarker.position.set(position.x, position.y, position.z);

  const scale = Math.max(aofModelMaxDimension() * 0.12, 0.001);
  aofGripMarker.scale.setScalar(scale);

  aofGripMarker.visible = Boolean(aofGripData.visible) || aofGripEditMode;
  aofUpdateGripInfo();
}

function aofSetGripPosition(position, source = "manual") {
  aofGripData = {
    ...aofGripData,
    visible: true,
    position: aofSanitizeVector(position)
  };

  aofSaveGripLocal();
  aofEnsureGripMarker();
  aofApplyGripMarkerTransform();
  aofUpdateGripInfo(source);
  aofScheduleGripConfigSave();
}

async function aofLoadGripFromConfig() {
  try {
    const res = await fetch("/api/status", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const status = await res.json();
    const grip = status?.config?.weaponSockets?.grip;
    const modelMeta = status?.config?.weaponModel;

    if (grip?.position) {
      aofGripData = {
        ...aofGripData,
        ...grip,
        position: aofSanitizeVector(grip.position),
        rotationDeg: aofSanitizeVector(grip.rotationDeg)
      };
      aofSaveGripLocal();
    }

    if (modelMeta?.rotationDeg) {
      aofModelRotationDeg = {
        x: aofWrapDeg(modelMeta.rotationDeg.x),
        y: aofWrapDeg(modelMeta.rotationDeg.y),
        z: aofWrapDeg(modelMeta.rotationDeg.z)
      };
      aofApplyModelRotation();
    }

    aofEnsureGripMarker();
    aofApplyGripMarkerTransform();
    aofUpdateGripInfo("loaded");
  } catch (error) {
    console.warn("Could not load grip config", error);
    aofEnsureGripMarker();
    aofApplyGripMarkerTransform();
    aofUpdateGripInfo("local only");
  }
}

async function aofSaveGripToConfig(reason = "manual") {
  try {
    const statusRes = await fetch("/api/status", { cache: "no-store" });
    const status = statusRes.ok ? await statusRes.json() : {};
    const currentConfig = status?.config ?? {};

    const payload = aofBuildGripPayload();

    const nextConfig = {
      ...currentConfig,
      weaponModel: {
        ...(currentConfig.weaponModel ?? {}),
        modelPath,
        coordinateSpace: AOF_GRIP_SPACE,
        rotationDeg: aofCloneModelRotationDeg(),
        updatedAt: new Date().toISOString()
      },
      weaponSockets: {
        ...(currentConfig.weaponSockets ?? {}),
        grip: payload
      }
    };

    const saveRes = await fetch("/api/config", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(nextConfig)
    });

    if (!saveRes.ok) {
      throw new Error(`HTTP ${saveRes.status}`);
    }

    aofUpdateGripInfo(`saved ${reason}`);
  } catch (error) {
    console.error("Could not save grip config", error);
    aofUpdateGripInfo("save failed");
  }
}

function aofScheduleGripConfigSave() {
  if (aofGripSaveTimer) {
    window.clearTimeout(aofGripSaveTimer);
  }

  aofGripSaveTimer = window.setTimeout(() => {
    aofGripSaveTimer = null;
    void aofSaveGripToConfig("auto");
  }, 450);
}

function aofToggleGripEditMode() {
  aofGripEditMode = !aofGripEditMode;
  aofGripData = {
    ...aofGripData,
    visible: true
  };
  aofSaveGripLocal();
  aofEnsureGripMarker();
  aofApplyGripMarkerTransform();
  aofUpdateGripInfo(aofGripEditMode ? "click weapon to place" : "locked");
}

function aofGripHandlePointerDown(event) {
  if (!aofGripEditMode || !model) return false;
  if (event.button !== 0) return false;

  const rect = canvas.getBoundingClientRect();
  aofGripPointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  aofGripPointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

  aofGripRaycaster.setFromCamera(aofGripPointer, camera);
  const hits = aofGripRaycaster
    .intersectObject(model, true)
    .filter((hit) => !hit.object?.userData?.aofGripMarker);

  if (hits.length > 0) {
    const localPoint = model.worldToLocal(hits[0].point.clone());
    aofSetGripPosition(localPoint, "placed on mesh");
  } else {
    aofUpdateGripInfo("no mesh hit");
  }

  event.preventDefault();
  return true;
}

function aofGripMoveStep(event) {
  const base = Math.max(aofModelMaxDimension() * 0.01, 0.001);
  if (event.shiftKey) return base * 5;
  if (event.altKey) return base * 0.2;
  return base;
}

function aofGripHandleKeyDown(event, key) {
  if (key === "h") {
    aofToggleGripEditMode();
    event.preventDefault();
    return true;
  }

  if (key === "s" && aofGripEditMode) {
    void aofSaveGripToConfig("manual");
    event.preventDefault();
    return true;
  }

  if (key === "c" && aofGripEditMode) {
    const json = JSON.stringify(aofBuildGripPayload(), null, 2);
    void navigator.clipboard?.writeText(json);
    aofUpdateGripInfo("copied JSON");
    event.preventDefault();
    return true;
  }

  if (!aofGripEditMode) {
    return false;
  }

  const position = aofSanitizeVector(aofGripData.position);
  const step = aofGripMoveStep(event);
  let handled = true;

  if (key === "arrowleft") {
    position.x -= step;
  } else if (key === "arrowright") {
    position.x += step;
  } else if (key === "arrowup") {
    position.y += step;
  } else if (key === "arrowdown") {
    position.y -= step;
  } else if (key === "pageup") {
    position.z += step;
  } else if (key === "pagedown") {
    position.z -= step;
  } else if (key === "delete" || key === "backspace") {
    position.x = 0;
    position.y = 0;
    position.z = 0;
  } else {
    handled = false;
  }

  if (!handled) {
    return false;
  }

  aofSetGripPosition(position, "keyboard");
  event.preventDefault();
  return true;
}

document.getElementById("grip")?.addEventListener("click", () => {
  aofToggleGripEditMode();
  canvas.focus?.();
  aofUpdateGripInfo(aofGripEditMode ? "click weapon to place grip" : "placement off");
});

document.getElementById("saveGrip")?.addEventListener("click", () => {
  void aofSaveGripToConfig("manual");
});

aofUpdateGripInfo();
/* AOF_GRIP_JOINT_EDITOR_V1_END */


canvas.addEventListener("pointerdown", aofPointerDown);
canvas.addEventListener("pointermove", aofPointerMove);
canvas.addEventListener("pointerup", aofPointerUp);
canvas.addEventListener("pointercancel", aofPointerUp);
window.addEventListener("keydown", aofKeyDown);

document.getElementById("reset")?.addEventListener("click", () => {
  aofResetModelRotation();
});
/* AOF_MODEL_DRAG_ROTATION_MINIMAL_END */

function animate() {
  requestAnimationFrame(animate);
  if (!aofGlbRightPanActive && model && autoRotate) {
    aofModelRotationDeg.y = aofWrapDeg(aofModelRotationDeg.y + 0.45);
    aofApplyModelRotation();
  }
  if (!aofGlbRightPanActive) {
    controls.update();
  }
  renderer.render(scene, camera);
}
animate();

loadModel();
