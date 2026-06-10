import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 3010;
const ROOT = process.cwd();

const BLENDER_EXE = path.resolve(ROOT, "tools/blender/blender-4.5.1-windows-x64/blender.exe");
const BLENDER_SCRIPT = path.resolve(ROOT, "blender/project_texture_with_side_fill.py");
const MESH_PATH = path.resolve(ROOT, "output/hunyuan_cursed_sword/mesh.glb");
const SOURCE_CROPPED = path.resolve(ROOT, "input/cursed_sword_source_cropped.png");
const SOURCE_FALLBACK = path.resolve(ROOT, "input/cursed_sword_source.png");

const ACTIVE_GLB = path.resolve(ROOT, "input/cursed_sword.glb");
const OUTPUT_DIR = path.resolve(ROOT, "output/hunyuan_cursed_sword");
const FINAL_GLB = path.resolve(OUTPUT_DIR, "textured.glb");
const FINAL_TEXTURE = path.resolve(OUTPUT_DIR, "baked-texture.png");
const FINAL_REPORT = path.resolve(OUTPUT_DIR, "hunyuan-pipeline-report.json");

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8") || "{}";
  return JSON.parse(raw);
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function chooseSourceImage() {
  if (exists(SOURCE_CROPPED)) return SOURCE_CROPPED;
  if (exists(SOURCE_FALLBACK)) return SOURCE_FALLBACK;
  return null;
}

function loadJsonIfExists(p) {
  try {
    if (!exists(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function viewerHtml() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>Side Fill Debug UI</title>
<style>
  body {
    margin: 0;
    font-family: Arial, sans-serif;
    background: #08111d;
    color: #e8eef7;
  }
  .wrap {
    display: grid;
    grid-template-columns: 420px 1fr;
    gap: 16px;
    min-height: 100vh;
    padding: 16px;
    box-sizing: border-box;
  }
  .panel {
    background: rgba(10, 18, 32, 0.95);
    border: 1px solid #22354f;
    border-radius: 12px;
    padding: 14px;
  }
  h1, h2 {
    margin-top: 0;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 110px;
    gap: 8px;
    align-items: center;
  }
  label {
    font-size: 13px;
  }
  input[type="number"], input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    padding: 6px 8px;
    border-radius: 8px;
    border: 1px solid #3a4b66;
    background: #0b1524;
    color: #fff;
  }
  input[type="checkbox"] {
    transform: scale(1.15);
  }
  button {
    padding: 10px 12px;
    border-radius: 10px;
    border: 1px solid #4c6384;
    background: #1a2d47;
    color: #fff;
    cursor: pointer;
    margin-right: 8px;
    margin-bottom: 8px;
  }
  button:hover {
    background: #234063;
  }
  .viewer {
    width: 100%;
    height: calc(100vh - 32px);
    border: 1px solid #22354f;
    border-radius: 12px;
    background: #000;
  }
  pre {
    white-space: pre-wrap;
    word-break: break-word;
    background: #07101b;
    padding: 10px;
    border-radius: 10px;
    border: 1px solid #1c2d44;
    max-height: 280px;
    overflow: auto;
  }
  .small {
    font-size: 12px;
    opacity: 0.85;
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="panel">
    <h1>Side Fill Debug</h1>
    <p class="small">
      Cette UI retexture le mesh existant sans regénérer par IA.
      Le résultat est promu vers <code>output/hunyuan_cursed_sword/textured.glb</code> puis <code>input/cursed_sword.glb</code>.
    </p>

    <h2>Source / faces</h2>
    <div class="grid">
      <label>Threshold faces source</label>
      <input id="sourceFaceThreshold" type="number" step="0.01" value="0.30" />
      <label>Signe source (si 1 face seulement)</label>
      <input id="sourceFaceSign" type="number" step="1" value="1" />
      <label>Texture source sur les 2 faces</label>
      <input id="useSourceBothFaces" type="checkbox" checked />
      <label>Flip source U</label>
      <input id="sourceFlipU" type="checkbox" />
      <label>Flip source V</label>
      <input id="sourceFlipV" type="checkbox" />
      <label>Swap source U/V</label>
      <input id="sourceSwapUV" type="checkbox" />
    </div>

    <h2>Nettoyage blanc</h2>
    <div class="grid">
      <label>White hard clip</label>
      <input id="whiteHardClip" type="number" step="0.005" value="0.965" />
      <label>White soft clip</label>
      <input id="whiteSoftClip" type="number" step="0.005" value="0.920" />
      <label>White hard spread</label>
      <input id="whiteHardSpread" type="number" step="0.005" value="0.060" />
      <label>White soft spread</label>
      <input id="whiteSoftSpread" type="number" step="0.005" value="0.090" />
    </div>

    <h2>Algorithme côtés</h2>
    <div class="grid">
      <label>Side base</label>
      <input id="sideBase" type="number" step="0.01" value="0.115" />
      <label>Side noise</label>
      <input id="sideNoise" type="number" step="0.01" value="0.115" />
      <label>Side highlight</label>
      <input id="sideHighlight" type="number" step="0.01" value="0.120" />
      <label>Side crack</label>
      <input id="sideCrack" type="number" step="0.01" value="0.180" />
      <label>Side purple</label>
      <input id="sidePurple" type="number" step="0.01" value="0.220" />
      <label>Side edge darkness</label>
      <input id="sideEdgeDarkness" type="number" step="0.01" value="0.200" />
      <label>Side texture width</label>
      <input id="sideWidth" type="number" step="1" value="1024" />
      <label>Side texture height</label>
      <input id="sideHeight" type="number" step="1" value="2048" />
    </div>

    <h2>Actions</h2>
    <button id="runBtn">Retexture</button>
    <button id="reloadBtn">Reload viewer</button>
    <button id="statusBtn">Refresh status</button>

    <h2>Status</h2>
    <pre id="statusBox">Idle.</pre>

    <h2>Dernier rapport</h2>
    <pre id="reportBox">Aucun rapport chargé.</pre>
  </div>

  <div class="panel">
    <h2>Viewer embarqué</h2>
    <p class="small">Ce panneau recharge simplement ton viewer principal sur <code>http://127.0.0.1:3000/</code>.</p>
    <iframe id="viewerFrame" class="viewer" src="http://127.0.0.1:3000/"></iframe>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);

function payloadFromUI() {
  return {
    sourceFaceThreshold: Number($("sourceFaceThreshold").value),
    sourceFaceSign: Number($("sourceFaceSign").value),
    useSourceBothFaces: $("useSourceBothFaces").checked,
    sourceFlipU: $("sourceFlipU").checked,
    sourceFlipV: $("sourceFlipV").checked,
    sourceSwapUV: $("sourceSwapUV").checked,
    whiteHardClip: Number($("whiteHardClip").value),
    whiteSoftClip: Number($("whiteSoftClip").value),
    whiteHardSpread: Number($("whiteHardSpread").value),
    whiteSoftSpread: Number($("whiteSoftSpread").value),
    sideBase: Number($("sideBase").value),
    sideNoise: Number($("sideNoise").value),
    sideHighlight: Number($("sideHighlight").value),
    sideCrack: Number($("sideCrack").value),
    sidePurple: Number($("sidePurple").value),
    sideEdgeDarkness: Number($("sideEdgeDarkness").value),
    sideWidth: Number($("sideWidth").value),
    sideHeight: Number($("sideHeight").value)
  };
}

async function refreshStatus() {
  const res = await fetch("/api/status");
  const data = await res.json();
  $("statusBox").textContent = JSON.stringify(data, null, 2);
  $("reportBox").textContent = data.report ? JSON.stringify(data.report, null, 2) : "Aucun rapport.";
}

$("reloadBtn").addEventListener("click", () => {
  const f = $("viewerFrame");
  f.src = f.src;
});

$("statusBtn").addEventListener("click", refreshStatus);

$("runBtn").addEventListener("click", async () => {
  $("statusBox").textContent = "Retexture en cours...";
  $("runBtn").disabled = true;

  try {
    const res = await fetch("/api/retexture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadFromUI())
    });

    const data = await res.json();
    $("statusBox").textContent = JSON.stringify(data, null, 2);
    if (data.report) {
      $("reportBox").textContent = JSON.stringify(data.report, null, 2);
    }
    if (data.ok) {
      const f = $("viewerFrame");
      f.src = f.src;
    }
  } catch (err) {
    $("statusBox").textContent = String(err && err.stack ? err.stack : err);
  } finally {
    $("runBtn").disabled = false;
  }
});

refreshStatus().catch(() => {});
</script>
</body>
</html>`;
}

function runBlenderRetexture(payload) {
  return new Promise((resolve) => {
    if (!exists(BLENDER_EXE)) {
      resolve({ ok: false, error: `Blender portable missing: ${BLENDER_EXE}` });
      return;
    }
    if (!exists(BLENDER_SCRIPT)) {
      resolve({ ok: false, error: `Script missing: ${BLENDER_SCRIPT}` });
      return;
    }
    if (!exists(MESH_PATH)) {
      resolve({ ok: false, error: `Mesh missing: ${MESH_PATH}` });
      return;
    }

    const sourceImage = chooseSourceImage();
    if (!sourceImage) {
      resolve({ ok: false, error: "Missing source image input/cursed_sword_source_cropped.png or input/cursed_sword_source.png" });
      return;
    }

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const testGlb = path.resolve(OUTPUT_DIR, "textured.sidefill.ui.test.glb");
    const testTexture = path.resolve(OUTPUT_DIR, "baked-texture.sidefill.ui.test.png");
    const testSide = path.resolve(OUTPUT_DIR, "algorithmic-side-fill.ui.test.png");
    const testReport = path.resolve(OUTPUT_DIR, "hunyuan-pipeline-report.sidefill.ui.test.json");

    [testGlb, testTexture, testSide, testReport].forEach((p) => {
      try { fs.rmSync(p, { force: true }); } catch {}
    });

    const args = [
      "-b",
      "--python",
      BLENDER_SCRIPT,
      "--",
      "--mesh", MESH_PATH,
      "--source-image", sourceImage,
      "--output-glb", testGlb,
      "--output-texture", testTexture,
      "--side-texture", testSide,
      "--output-report", testReport,
      "--source-face-threshold", String(payload.sourceFaceThreshold ?? 0.30),
      "--source-face-sign", String(payload.sourceFaceSign ?? 1),
      "--use-source-both-faces", String(payload.useSourceBothFaces ? 1 : 0),
      "--source-flip-u", String(payload.sourceFlipU ? 1 : 0),
      "--source-flip-v", String(payload.sourceFlipV ? 1 : 0),
      "--source-swap-uv", String(payload.sourceSwapUV ? 1 : 0),
      "--white-hard-clip", String(payload.whiteHardClip ?? 0.965),
      "--white-soft-clip", String(payload.whiteSoftClip ?? 0.920),
      "--white-hard-spread", String(payload.whiteHardSpread ?? 0.060),
      "--white-soft-spread", String(payload.whiteSoftSpread ?? 0.090),
      "--side-base", String(payload.sideBase ?? 0.115),
      "--side-noise", String(payload.sideNoise ?? 0.115),
      "--side-highlight", String(payload.sideHighlight ?? 0.120),
      "--side-crack", String(payload.sideCrack ?? 0.180),
      "--side-purple", String(payload.sidePurple ?? 0.220),
      "--side-edge-darkness", String(payload.sideEdgeDarkness ?? 0.200),
      "--side-width", String(payload.sideWidth ?? 1024),
      "--side-height", String(payload.sideHeight ?? 2048),
    ];

    const child = spawn(BLENDER_EXE, args, { cwd: ROOT });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      const report = loadJsonIfExists(testReport);

      if (code === 0 && exists(testGlb)) {
        fs.copyFileSync(testGlb, FINAL_GLB);
        fs.copyFileSync(testGlb, ACTIVE_GLB);
        if (exists(testTexture)) fs.copyFileSync(testTexture, FINAL_TEXTURE);
        if (exists(testReport)) fs.copyFileSync(testReport, FINAL_REPORT);

        resolve({
          ok: true,
          code,
          promoted: true,
          activeModel: ACTIVE_GLB,
          outputGlb: FINAL_GLB,
          outputTexture: FINAL_TEXTURE,
          sideTexture: testSide,
          report,
          stdout,
          stderr,
        });
      } else {
        resolve({
          ok: false,
          code,
          promoted: false,
          error: "Blender side-fill run failed. Active model preserved.",
          report,
          stdout,
          stderr,
        });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, viewerHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, {
      ok: true,
      cwd: ROOT,
      blender: exists(BLENDER_EXE),
      blenderExe: BLENDER_EXE,
      sourceImage: chooseSourceImage(),
      mesh: exists(MESH_PATH) ? MESH_PATH : null,
      activeModel: exists(ACTIVE_GLB) ? ACTIVE_GLB : null,
      texturedGlb: exists(FINAL_GLB) ? FINAL_GLB : null,
      bakedTexture: exists(FINAL_TEXTURE) ? FINAL_TEXTURE : null,
      report: loadJsonIfExists(FINAL_REPORT),
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/retexture") {
    try {
      const payload = await readJsonBody(req);
      const result = await runBlenderRetexture(payload);
      sendJson(res, result.ok ? 200 : 500, result);
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: String(error && error.stack ? error.stack : error),
      });
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found");
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Side Fill Debug UI: http://127.0.0.1:${PORT}/`);
});
