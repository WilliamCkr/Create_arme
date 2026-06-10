import http from "http";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const PORT = Number(process.env.PORT || 3011);
const ROOT = process.cwd();

const BLENDER = path.resolve("tools/blender/blender-4.5.1-windows-x64/blender.exe");
const SCRIPT = path.resolve("blender/project_texture_with_side_fill.py");

const OUT_DIR = path.resolve("output/hunyuan_cursed_sword");

const MESH = path.resolve("output/hunyuan_cursed_sword/mesh.glb");
const SOURCE_CROPPED = path.resolve("input/cursed_sword_source_cropped.png");
const SOURCE_FALLBACK = path.resolve("input/cursed_sword_source.png");

const STEP2_GLB = path.resolve("output/hunyuan_cursed_sword/textured.pixel-gradient-step2.glb");
const STEP2_COMPOSITE = path.resolve("output/hunyuan_cursed_sword/baked-texture.pixel-gradient-step2.png");
const STEP2_LAYER1 = path.resolve("output/hunyuan_cursed_sword/layer1.pixel-gradient-step2.png");
const STEP2_REPORT = path.resolve("output/hunyuan_cursed_sword/report.pixel-gradient-step2.json");

const SOURCE_LOCK = path.resolve("output/hunyuan_cursed_sword/source-lock.png");

const ACTIVE_INPUT_GLB = path.resolve("input/cursed_sword.glb");
const ACTIVE_OUTPUT_GLB = path.resolve("output/hunyuan_cursed_sword/textured.glb");
const ACTIVE_TEXTURE = path.resolve("output/hunyuan_cursed_sword/baked-texture.png");
const ACTIVE_REPORT = path.resolve("output/hunyuan_cursed_sword/hunyuan-pipeline-report.json");

const LEGACY_LAYER1 = path.resolve("output/hunyuan_cursed_sword/algorithmic-side-fill.layeredwarp.ui.test.png");
const LEGACY_COMPOSITE = path.resolve("output/hunyuan_cursed_sword/baked-texture.layeredwarp.ui.test.png");

const THREE = path.resolve("node_modules/three/build/three.module.js");
const THREE_CORE = path.resolve("node_modules/three/build/three.core.js");
const GLTF_LOADER = path.resolve("node_modules/three/examples/jsm/loaders/GLTFLoader.js");
const ORBIT = path.resolve("node_modules/three/examples/jsm/controls/OrbitControls.js");
const BUFFER_GEOMETRY_UTILS = path.resolve("node_modules/three/examples/jsm/utils/BufferGeometryUtils.js");
const SKELETON_UTILS = path.resolve("node_modules/three/examples/jsm/utils/SkeletonUtils.js");

function exists(file) {
  return fs.existsSync(file);
}

function pickModel() {
  if (exists(STEP2_GLB)) return STEP2_GLB;
  if (exists(ACTIVE_OUTPUT_GLB)) return ACTIVE_OUTPUT_GLB;
  return ACTIVE_INPUT_GLB;
}

function sendJson(res, data, code = 200) {
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function sendText(res, text, code = 200) {
  res.writeHead(code, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(text);
}

function sendFile(res, file, type) {
  if (!exists(file)) {
    return sendText(res, "missing " + file, 404);
  }

  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    "pragma": "no-cache",
    "expires": "0",
    "x-served-file": file
  });

  fs.createReadStream(file).pipe(res);
}

function sendImage(res, file, fallbacks = []) {
  let selected = file;

  if (!exists(selected)) {
    for (const fallback of fallbacks) {
      if (exists(fallback)) {
        selected = fallback;
        break;
      }
    }
  }

  if (!exists(selected)) {
    return sendText(res, "missing " + file + "\nFallbacks:\n" + fallbacks.join("\n"), 404);
  }

  sendFile(res, selected, "image/png");
}

function readBody(req) {
  return new Promise(resolve => {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => {
      try {
        resolve(body.trim() ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function chooseSourceImage() {
  return exists(SOURCE_CROPPED) ? SOURCE_CROPPED : SOURCE_FALLBACK;
}

function promoteOutputs() {
  if (exists(STEP2_GLB)) {
    fs.copyFileSync(STEP2_GLB, ACTIVE_OUTPUT_GLB);
    fs.copyFileSync(STEP2_GLB, ACTIVE_INPUT_GLB);
  }

  if (exists(STEP2_COMPOSITE)) {
    fs.copyFileSync(STEP2_COMPOSITE, ACTIVE_TEXTURE);
  }

  if (exists(STEP2_REPORT)) {
    fs.copyFileSync(STEP2_REPORT, ACTIVE_REPORT);
  }
}

function runRetexture(payload) {
  return new Promise(resolve => {
    const edgeBandPx = Number(payload.edgeBandPx ?? 15);
    const sourceInsetPx = Number(payload.sourceInsetPx ?? 10);
    const sourceEdgePx = Number(payload.sourceEdgePx ?? 10);
    const gradientSpanPx = Number(payload.gradientSpanPx ?? 15);
    const materialBrightness = Number(payload.materialBrightness ?? 0.85);
    const materialRoughness = Number(payload.materialRoughness ?? 0.88);
    const materialMetallic = Number(payload.materialMetallic ?? 0.35);
    const materialSpecular = Number(payload.materialSpecular ?? 0.12);
    const textureContrast = Number(payload.textureContrast ?? 1.0);

    const args = [
      "-b",
      "--python", SCRIPT,
      "--",
      "--mesh", MESH,
      "--source-image", chooseSourceImage(),
      "--output-glb", STEP2_GLB,
      "--output-texture", STEP2_COMPOSITE,
      "--side-texture", STEP2_LAYER1,
      "--output-report", STEP2_REPORT,

      "--source-face-threshold", "0.30",
      "--source-face-sign", "1",
      "--use-source-both-faces",

      "--warp-upscale", "1.00",
      "--warp-stretch-x", "1.00",
      "--warp-stretch-y", "1.00",
      "--warp-contrast", "1.00",
      "--warp-brightness", "1.00",
      "--warp-expand-passes", "1",
      "--warp-alpha-threshold", "0.02",
      "--lock-alpha-threshold", "0.02",

      "--edge-band-px", String(edgeBandPx),
      "--source-inset-px", String(sourceInsetPx),
      "--source-edge-px", String(sourceEdgePx),
      "--gradient-span-px", String(gradientSpanPx),
      "--material-roughness", String(materialRoughness),
      "--material-metallic", String(materialMetallic),
      "--material-specular", String(materialSpecular),
      "--texture-contrast", String(textureContrast)
    ];

    console.log("[STEP2 RETEXTURE]", {edgeBandPx, sourceInsetPx, sourceEdgePx, gradientSpanPx, materialBrightness, materialRoughness, materialMetallic, materialSpecular, textureContrast});
    console.log(args.join(" "));

    const started = Date.now();
    const child = spawn(BLENDER, args, { cwd: ROOT, windowsHide: false });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", chunk => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", code => {
      let promoted = false;
      let promoteError = null;

      if (code === 0 && exists(STEP2_GLB)) {
        try {
          promoteOutputs();
          promoted = true;
        } catch (err) {
          promoteError = String(err);
        }
      }

      resolve({
        ok: code === 0 && promoted,
        code,
        promoted,
        promoteError,
        durationMs: Date.now() - started,
        requested: {edgeBandPx, sourceInsetPx, sourceEdgePx, gradientSpanPx, materialBrightness, materialRoughness, materialMetallic, materialSpecular, textureContrast},
        model: pickModel(),
        stdout,
        stderr
      });
    });
  });
}

function page() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Pixel Gradient Step 2</title>

<script type="importmap">
{
  "imports": {
    "three": "/vendor/three.module.js"
  }
}
</script>

<style>
* { box-sizing: border-box; }

html, body {
  margin: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #06111d;
  color: #e5eefb;
  font-family: Arial, sans-serif;
}

.layout {
  width: 100vw;
  height: 100vh;
  display: grid;
  grid-template-columns: 285px 1fr;
}

.panel {
  border-right: 1px solid #24435f;
  background: #081522;
  padding: 10px;
  overflow: hidden;
}

h1 {
  font-size: 20px;
  margin: 0 0 10px;
}

h2 {
  font-size: 14px;
  margin: 12px 0 8px;
}

.hint {
  border: 1px solid #24435f;
  border-radius: 8px;
  background: #0b1a2a;
  padding: 8px;
  font-size: 12px;
  line-height: 1.35;
  color: #c7d7ea;
}

.grid {
  display: grid;
  grid-template-columns: 1fr 86px;
  gap: 7px;
  align-items: center;
}

label {
  font-size: 12px;
}

input {
  background: #06111d;
  color: #e5eefb;
  border: 1px solid #38658c;
  border-radius: 7px;
  padding: 6px;
}

button {
  border: 1px solid #4d83ad;
  border-radius: 8px;
  background: #10243a;
  color: #f2f7ff;
  padding: 7px 8px;
  margin: 3px 3px 3px 0;
  font-size: 12px;
  cursor: pointer;
}

button:disabled {
  opacity: 0.5;
  cursor: wait;
}

#message {
  margin-top: 12px;
  min-height: 56px;
  border: 1px solid #24435f;
  border-radius: 8px;
  background: #050b12;
  padding: 8px;
  font-size: 12px;
  white-space: pre-wrap;
}

.workspace {
  height: 100vh;
  min-width: 0;
  display: grid;
  grid-template-rows: minmax(310px, 58%) minmax(220px, 42%);
  gap: 8px;
  padding: 8px;
  overflow: hidden;
}

.previewGrid {
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.card {
  min-height: 0;
  border: 1px solid #24435f;
  border-radius: 10px;
  background: #081522;
  padding: 8px;
  display: grid;
  grid-template-rows: auto 1fr;
}

.title {
  font-size: 13px;
  font-weight: 700;
  margin-bottom: 6px;
}

img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  min-height: 0;
  background: #05070a;
  border-radius: 8px;
  border: 1px solid #16283a;
}

.viewerCard {
  min-height: 0;
  border: 1px solid #24435f;
  border-radius: 10px;
  background: #050b12;
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
}

.viewerHeader {
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #24435f;
  background: #081522;
}

.viewerHeader .title {
  margin: 0;
  flex: 1;
}

#viewerInfo {
  font-size: 12px;
  color: #bfd2e8;
}

#viewer {
  min-height: 0;
  position: relative;
  overflow: hidden;
}

#viewer canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
</head>

<body>
<div class="layout">
  <aside class="panel">
    <h1>Pixel Gradient Step 2</h1>
    <div class="hint">
      Source lock + Layer 1 fill + Final composite + résultat 3D sur l'épée dans la même UI.
    </div>

    <h2>Réglages</h2>
    <div class="grid">
      <label>Edge band px</label>
      <input id="edgeBandPx" type="number" step="1" value="15">

      <label>Source inset px</label>
      <input id="sourceInsetPx" type="number" step="1" value="10">

      <label>Source edge px</label>
      <input id="sourceEdgePx" type="number" step="1" value="10">

      <label>Gradient span px</label>
      <input id="gradientSpanPx" type="number" step="1" value="15">
    </div>

    <h2>Presets</h2>
    <button onclick="preset(10,5)">Bord fin</button>
    <button onclick="preset(15,10)">Bord moyen</button>
    <button onclick="preset(20,15)">Bord large</button>

    <h2>Actions</h2>
    <button id="retextureBtn" onclick="retexture()">Retexture</button>
    <button onclick="refreshAll()">Refresh</button>
    <button onclick="openOutputFolder()">Open output</button>

    <div id="message">Ready.</div>
  
    <!-- STEP2_SAFE_MATERIAL_PANEL_V1 -->
    <h2>Matiere / Lumiere</h2>
    <div class="grid">
      <label>Brightness</label>
      <input id="materialBrightness" type="number" min="0.30" max="2.00" step="0.01" value="0.85">

      <label>Roughness</label>
      <input id="materialRoughness" type="number" min="0.00" max="1.00" step="0.01" value="0.88">

      <label>Metallic</label>
      <input id="materialMetallic" type="number" min="0.00" max="1.00" step="0.01" value="0.35">

      <label>Specular</label>
      <input id="materialSpecular" type="number" min="0.00" max="1.00" step="0.01" value="0.12">

      <label>Texture contrast</label>
      <input id="textureContrast" type="number" min="0.50" max="2.50" step="0.05" value="1.00">
    </div>
    <div class="presets">
      <button onclick="materialPreset(0.80,0.94,0.20,0.08,1.10)">Mat</button>
      <button onclick="materialPreset(0.85,0.88,0.35,0.12,1.15)">Equilibre</button>
      <button onclick="materialPreset(0.90,0.78,0.50,0.18,1.20)">Metal doux</button>
    </div>

    <h2>Lumiere viewer</h2>
    <div class="grid">
      <label>Ambient</label>
      <input id="lightAmbient" type="number" min="0.00" max="3.00" step="0.05" value="0.85">

      <label>Front</label>
      <input id="lightFront" type="number" min="0.00" max="5.00" step="0.05" value="1.10">

      <label>Back</label>
      <input id="lightBack" type="number" min="0.00" max="5.00" step="0.05" value="1.00">

      <label>Top</label>
      <input id="lightTop" type="number" min="0.00" max="5.00" step="0.05" value="0.50">
    </div>
    <div class="presets">
      <button onclick="lightPreset(0.55,0.75,0.55,0.25,0.75)">Soft</button>
      <button onclick="lightPreset(0.85,1.10,1.00,0.50,0.85)">Neutre</button>
      <button onclick="lightPreset(0.65,1.45,1.20,0.65,0.90)">Studio</button>
      <button onclick="lightPreset(0.35,1.80,0.80,0.35,0.90)">Contraste</button>
    </div>

</aside>

  <main class="workspace">
    <section class="previewGrid">
      <div class="card">
        <div class="title">Source lock</div>
        <img id="sourceLockPreview" src="/img/source-lock?bust=0">
      </div>

      <div class="card">
        <div class="title">Layer 1 fill</div>
        <img id="layer1Preview" src="/img/layer1?bust=0">
      </div>

      <div class="card">
        <div class="title">Final composite</div>
        <img id="compositePreview" src="/img/composite?bust=0">
      </div>
    </section>

    <section class="viewerCard">
      <div class="viewerHeader">
        <div class="title">Resultat 3D sur l'objet epee</div>
        <button onclick="loadSword()">Reload 3D</button>
        <span id="viewerInfo">Loading...</span>
      </div>
      <div id="viewer"></div>
    </section>
  </main>
</div>

<script type="module">
import * as THREE from "/vendor/three.module.js";
import { GLTFLoader } from "/vendor/GLTFLoader.js";
import { OrbitControls } from "/vendor/OrbitControls.js";

let renderer;
let scene;
let camera;
let controls;
let currentSword;

const viewer = document.getElementById("viewer");
const viewerInfo = document.getElementById("viewerInfo");

function parseNum(id) {
  const v = Number(document.getElementById(id).value);
  return Number.isFinite(v) ? v : 0;
}

function payloadFromUI() {
  return {
    edgeBandPx: parseNum("edgeBandPx"),
    sourceInsetPx: parseNum("sourceInsetPx"),
    sourceEdgePx: parseNum("sourceEdgePx"),
    gradientSpanPx: parseNum("gradientSpanPx"),
    materialBrightness: parseNum("materialBrightness"),
    materialRoughness: parseNum("materialRoughness"),
    materialMetallic: parseNum("materialMetallic"),
    materialSpecular: parseNum("materialSpecular"),
    textureContrast: parseNum("textureContrast")
  };
}

window.preset = function(edgeAndGradient, sourceAndSourceEdge) {
  document.getElementById("edgeBandPx").value = edgeAndGradient;
  document.getElementById("gradientSpanPx").value = edgeAndGradient;
  document.getElementById("sourceInsetPx").value = sourceAndSourceEdge;
  document.getElementById("sourceEdgePx").value = sourceAndSourceEdge;
};

function msg(text) {
  document.getElementById("message").textContent = text;
}

function refreshImages() {
  const b = Date.now();
  document.getElementById("sourceLockPreview").src = "/img/source-lock?bust=" + b;
  document.getElementById("layer1Preview").src = "/img/layer1?bust=" + b;
  document.getElementById("compositePreview").src = "/img/composite?bust=" + b;
}

window.refreshAll = function() {
  refreshImages();
  loadSword();
};

window.openOutputFolder = async function() {
  await fetch("/api/open-output", { method: "POST" });
};

window.retexture = async function() {
  const btn = document.getElementById("retextureBtn");
  const payload = payloadFromUI();

  btn.disabled = true;
  msg("Retexture en cours...\\n" + JSON.stringify(payload));

  try {
    const res = await fetch("/api/retexture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!data.ok) {
      msg("Retexture failed. Regarde le terminal.");
      console.error(data);
    } else {
      msg(
        "Retexture OK en " + Math.round(data.durationMs / 1000) + "s\\n" +
        "edge=" + data.requested.edgeBandPx +
        " inset=" + data.requested.sourceInsetPx +
        " sourceEdge=" + data.requested.sourceEdgePx +
        " span=" + data.requested.gradientSpanPx
      );

      refreshImages();
      setTimeout(() => loadSword(), 250);
    }
  } catch (e) {
    msg("Erreur: " + e);
    console.error(e);
  } finally {
    btn.disabled = false;
  }
};

function init3D() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05070b);

  camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
  camera.position.set(0, 0.5, 4.2);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  viewer.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const hemi = new THREE.HemisphereLight(0xffffff, 0x223344, 1.5);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 4);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xffffff, 1.1);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  window.addEventListener("resize", resize3D);

  resize3D();
  loadSword();
  animate();
}

function disposeObject(object) {
  object.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();

    if (obj.material) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const material of materials) {
        for (const key in material) {
          const value = material[key];
          if (value && value.isTexture) value.dispose();
        }
        material.dispose();
      }
    }
  });
}

function fitObject(object) {
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();

  box.getSize(size);
  box.getCenter(center);

  object.position.sub(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const scale = maxDim > 0 ? 2.65 / maxDim : 1.0;
  object.scale.setScalar(scale);

  camera.position.set(0, 0.35, 4.0);
  controls.target.set(0, 0, 0);
  camera.lookAt(0, 0, 0);
  controls.update();
}

window.loadSword = function() {
  if (!renderer) return;

  viewerInfo.textContent = "Loading...";

  if (currentSword) {
    scene.remove(currentSword);
    disposeObject(currentSword);
    currentSword = null;
  }

  const loader = new GLTFLoader();
  const url = "/model/sword.glb?bust=" + Date.now();

  loader.load(
    url,
    (gltf) => {
      currentSword = gltf.scene;
      scene.add(currentSword);
      fitObject(currentSword);
      viewerInfo.textContent = "3D loaded";
    },
    undefined,
    (err) => {
      viewerInfo.textContent = "3D load failed";
      console.error(err);
    }
  );
};

function resize3D() {
  if (!renderer || !camera) return;

  const rect = viewer.getBoundingClientRect();
  const w = Math.max(1, Math.floor(rect.width));
  const h = Math.max(1, Math.floor(rect.height));

  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
}

function animate() {
  requestAnimationFrame(animate);
  resize3D();
  controls.update();
  renderer.render(scene, camera);
}

refreshImages();
init3D();

/* STEP2_SAFE_MATERIAL_LIGHT_VIEWER_V1 */
function step2SafeNum(id, fallback) {
  const el = document.getElementById(id);
  if (!el) return fallback;
  const v = Number(el.value);
  return Number.isFinite(v) ? v : fallback;
}

function step2SafeClamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function step2SafeMaterialState() {
  return {
    brightness: step2SafeClamp(step2SafeNum("materialBrightness", 0.85), 0.30, 2.00),
    roughness: step2SafeClamp(step2SafeNum("materialRoughness", 0.88), 0.00, 1.00),
    metallic: step2SafeClamp(step2SafeNum("materialMetallic", 0.35), 0.00, 1.00),
    specular: step2SafeClamp(step2SafeNum("materialSpecular", 0.12), 0.00, 1.00)
  };
}

function step2SafeRemoveLights() {
  if (typeof scene === "undefined" || !scene) return;
  const lights = [];
  scene.traverse((obj) => {
    if (obj && obj.isLight) lights.push(obj);
  });
  for (const light of lights) {
    if (light.parent) light.parent.remove(light);
  }
}


function step2SafeInstallNeutralLights() {
  if (typeof scene === "undefined" || !scene || typeof THREE === "undefined") return;

  step2SafeRemoveLights();

  const brightness = step2SafeClamp(step2SafeNum("materialBrightness", 0.85), 0.30, 2.00);
  const ambientValue = step2SafeClamp(step2SafeNum("lightAmbient", 0.85), 0.00, 3.00);
  const frontValue = step2SafeClamp(step2SafeNum("lightFront", 1.10), 0.00, 5.00);
  const backValue = step2SafeClamp(step2SafeNum("lightBack", 1.00), 0.00, 5.00);
  const topValue = step2SafeClamp(step2SafeNum("lightTop", 0.50), 0.00, 5.00);

  const ambient = new THREE.AmbientLight(0xffffff, ambientValue);
  scene.add(ambient);

  const front = new THREE.DirectionalLight(0xffffff, frontValue);
  front.position.set(2.2, 2.0, 3.0);
  scene.add(front);

  const back = new THREE.DirectionalLight(0xffffff, backValue);
  back.position.set(-2.2, 1.7, -3.0);
  scene.add(back);

  const top = new THREE.DirectionalLight(0xffffff, topValue);
  top.position.set(0.0, 3.5, 0.0);
  scene.add(top);

  if (typeof renderer !== "undefined" && renderer && "toneMappingExposure" in renderer) {
    renderer.toneMappingExposure = brightness;
  }
}


function step2SafeApplyMaterial(root) {
  if (typeof THREE === "undefined") return;

  const state = step2SafeMaterialState();
  const host = root || (
    typeof currentSword !== "undefined" && currentSword
      ? currentSword
      : typeof scene !== "undefined"
        ? scene
        : null
  );

  if (!host) return;

  host.traverse((obj) => {
    if (!obj || !obj.isMesh || !obj.material) return;

    const materials = Array.isArray(obj.material) ? obj.material : [obj.material];

    for (const mat of materials) {
      if (!mat) continue;

      if ("roughness" in mat) mat.roughness = state.roughness;
      if ("metalness" in mat) mat.metalness = state.metallic;
      if ("specularIntensity" in mat) mat.specularIntensity = state.specular;
      if ("envMapIntensity" in mat) mat.envMapIntensity = 0.08;

      if (mat.emissive) mat.emissive.setRGB(0, 0, 0);
      if ("emissiveIntensity" in mat) mat.emissiveIntensity = 0;

      mat.needsUpdate = true;
    }
  });
}

function step2SafeApplyViewerTuning() {
  try {
    step2SafeInstallNeutralLights();
    step2SafeApplyMaterial();
  } catch (err) {
    console.warn("step2SafeApplyViewerTuning failed", err);
  }
}

function materialPreset(brightness, roughness, metallic, specular, contrast = 1.0) {
  const values = {
    materialBrightness: brightness,
    materialRoughness: roughness,
    materialMetallic: metallic,
    materialSpecular: specular,
    textureContrast: contrast
  };

  for (const id of Object.keys(values)) {
    const el = document.getElementById(id);
    if (el) el.value = values[id];
  }

  step2SafeApplyViewerTuning();
}
window.materialPreset = materialPreset;


function lightPreset(ambient, front, back, top, brightness) {
  const values = {
    lightAmbient: ambient,
    lightFront: front,
    lightBack: back,
    lightTop: top,
    materialBrightness: brightness
  };

  for (const id of Object.keys(values)) {
    const el = document.getElementById(id);
    if (el) el.value = values[id];
  }

  step2SafeApplyViewerTuning();
}
window.lightPreset = lightPreset;

function step2SafeBindMaterialControls() {
  const ids = ["materialBrightness", "materialRoughness", "materialMetallic", "materialSpecular", "textureContrast", "lightAmbient", "lightFront", "lightBack", "lightTop"];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el || el.dataset.step2SafeMaterialBound === "1") continue;
    el.dataset.step2SafeMaterialBound = "1";
    el.addEventListener("input", step2SafeApplyViewerTuning);
    el.addEventListener("change", step2SafeApplyViewerTuning);
  }
}

step2SafeBindMaterialControls();
setTimeout(step2SafeApplyViewerTuning, 50);
setTimeout(step2SafeApplyViewerTuning, 250);
setTimeout(step2SafeApplyViewerTuning, 800);


</script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:" + PORT);

  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(page());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/retexture") {
      const payload = await readBody(req);
      const result = await runRetexture(payload);
      sendJson(res, result, result.ok ? 200 : 500);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/open-output") {
      spawn("explorer.exe", [OUT_DIR], { detached: true, stdio: "ignore" }).unref();
      sendJson(res, { ok: true, path: OUT_DIR });
      return;
    }

    if (req.method === "GET" && url.pathname === "/img/source-lock") {
      sendImage(res, SOURCE_LOCK);
      return;
    }

    if (req.method === "GET" && url.pathname === "/img/layer1") {
      sendImage(res, STEP2_LAYER1, [LEGACY_LAYER1]);
      return;
    }

    if (req.method === "GET" && url.pathname === "/img/composite") {
      sendImage(res, STEP2_COMPOSITE, [LEGACY_COMPOSITE, ACTIVE_TEXTURE]);
      return;
    }

    if (req.method === "GET" && url.pathname === "/model/sword.glb") {
      sendFile(res, pickModel(), "model/gltf-binary");
      return;
    }

    if (req.method === "GET" && url.pathname === "/vendor/three.module.js") {
      sendFile(res, THREE, "text/javascript");
      return;
    }

    if (req.method === "GET" && url.pathname === "/vendor/three.core.js") {
      sendFile(res, THREE_CORE, "text/javascript");
      return;
    }

    if (req.method === "GET" && url.pathname === "/vendor/GLTFLoader.js") {
      sendFile(res, GLTF_LOADER, "text/javascript");
      return;
    }

    if (req.method === "GET" && url.pathname === "/vendor/OrbitControls.js") {
      sendFile(res, ORBIT, "text/javascript");
      return;
    }

    if (req.method === "GET" && url.pathname === "/utils/BufferGeometryUtils.js") {
      sendFile(res, BUFFER_GEOMETRY_UTILS, "text/javascript");
      return;
    }

    if (req.method === "GET" && url.pathname === "/utils/SkeletonUtils.js") {
      sendFile(res, SKELETON_UTILS, "text/javascript");
      return;
    }

    sendText(res, "not found", 404);
  } catch (err) {
    sendJson(res, { ok: false, error: String(err), stack: err?.stack }, 500);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Pixel Gradient Step 2 UI with embedded sword viewer: http://127.0.0.1:" + PORT + "/");
  console.log("Serving model:", pickModel());
});
