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
    const edgeBandPx = Number(payload.edgeBandPx ?? 20);
    const sourceInsetPx = Number(payload.sourceInsetPx ?? 1);
    const gradientSpanPx = Number(payload.gradientSpanPx ?? 20);

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
      "--gradient-span-px", String(gradientSpanPx)
    ];

    console.log("[STEP2 RETEXTURE]", { edgeBandPx, sourceInsetPx, gradientSpanPx });
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
        requested: { edgeBandPx, sourceInsetPx, gradientSpanPx },
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
      <input id="edgeBandPx" type="number" step="1" value="20">

      <label>Source inset px</label>
      <input id="sourceInsetPx" type="number" step="1" value="1">

      <label>Gradient span px</label>
      <input id="gradientSpanPx" type="number" step="1" value="20">
    </div>

    <h2>Presets</h2>
    <button onclick="preset(12,1,12)">Bord fin</button>
    <button onclick="preset(20,1,20)">Bord moyen</button>
    <button onclick="preset(32,2,32)">Bord large</button>

    <h2>Actions</h2>
    <button id="retextureBtn" onclick="retexture()">Retexture</button>
    <button onclick="refreshAll()">Refresh</button>
    <button onclick="openOutputFolder()">Open output</button>

    <div id="message">Ready.</div>
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
    gradientSpanPx: parseNum("gradientSpanPx")
  };
}

window.preset = function(edge, inset, span) {
  document.getElementById("edgeBandPx").value = edge;
  document.getElementById("sourceInsetPx").value = inset;
  document.getElementById("gradientSpanPx").value = span;
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

  const rim = new THREE.DirectionalLight(0x8a6cff, 1.1);
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
