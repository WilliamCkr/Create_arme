const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyIfExists(src, dst) {
  if (!fs.existsSync(src)) {
    console.log("[missing]", src);
    return false;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  console.log("[copy]", dst);
  return true;
}

function write(file, content) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content, "utf8");
  console.log("[write]", file);
}

copyIfExists(
  "node_modules/@google/model-viewer/dist/model-viewer.min.js",
  "src/ui/public/vendor/model-viewer.min.js"
);

write("src/ui/public/step2-model-viewer.css", `
.aof-step2-glb-viewer {
  width: 100%;
  min-height: 560px;
  border: 1px solid rgba(125, 203, 255, 0.22);
  border-radius: 18px;
  overflow: hidden;
  background:
    linear-gradient(45deg, rgba(255,255,255,.035) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(255,255,255,.035) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(255,255,255,.035) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.035) 75%),
    #101722;
  background-size: 28px 28px;
  background-position: 0 0, 0 14px, 14px -14px, -14px 0px;
  box-shadow: inset 0 0 60px rgba(0,0,0,.35);
}

.aof-step2-glb-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(125, 203, 255, 0.16);
  background: rgba(8, 13, 22, 0.86);
}

.aof-step2-glb-title {
  font-weight: 800;
  color: #eaf4ff;
  margin-right: auto;
}

.aof-step2-glb-status {
  color: #9aabc0;
  font-size: 12px;
}

.aof-step2-glb-button {
  border: 1px solid rgba(135, 204, 255, 0.22);
  color: #eaf4ff;
  background: rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 7px 10px;
  cursor: pointer;
}

.aof-step2-glb-button:hover {
  background: rgba(125, 203, 255, 0.14);
}

.aof-step2-glb-model {
  display: block;
  width: 100%;
  height: 540px;
  background: transparent;
}

.aof-step2-glb-fallback {
  padding: 28px;
  color: #ffb4b4;
  font-weight: 800;
}
`);

write("src/ui/public/step2-model-viewer.js", `
(function () {
  const MODEL_PATH = "input/cursed_sword.glb";
  const VIEWER_ID = "aof-step2-glb-viewer";

  function log(...args) {
    console.log("[step2-model-viewer]", ...args);
  }

  function isStep2() {
    const body = document.body ? document.body.innerText : "";
    return body.includes("Step 2 of 4") || body.includes("Generate 3D Model");
  }

  function modelUrl() {
    return "/api/file?path=" + encodeURIComponent(MODEL_PATH) + "&t=" + Date.now();
  }

  function findStep2Panel() {
    const all = Array.from(document.querySelectorAll("div, section, main, article"));

    const titleNodes = Array.from(document.querySelectorAll("h1,h2,h3,h4,strong,div,span"))
      .filter((el) => (el.textContent || "").trim() === "Generate 3D Model");

    for (const title of titleNodes) {
      let node = title;
      for (let i = 0; i < 8 && node; i++) {
        const rect = node.getBoundingClientRect();
        const text = node.innerText || "";
        if (
          rect.width > 600 &&
          rect.height > 250 &&
          text.includes("Generate 3D Model") &&
          text.includes("3D model ready")
        ) {
          return node;
        }
        node = node.parentElement;
      }
    }

    const candidates = all
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const text = el.innerText || "";
        return rect.width > 600 &&
          rect.height > 250 &&
          text.includes("Generate 3D Model") &&
          text.includes("3D model ready");
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });

    return candidates[0] || null;
  }

  function findPreviewBox(panel) {
    if (!panel) return null;

    const children = Array.from(panel.querySelectorAll("div"))
      .filter((el) => {
        if (el.id === VIEWER_ID) return false;
        const rect = el.getBoundingClientRect();
        const text = el.innerText || "";
        return rect.width > 500 &&
          rect.height > 220 &&
          text.includes("3D model ready") &&
          text.includes("Active model");
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });

    return children[0] || panel;
  }

  function makeViewer() {
    const wrap = document.createElement("div");
    wrap.id = VIEWER_ID;
    wrap.className = "aof-step2-glb-viewer";

    wrap.innerHTML = \`
      <div class="aof-step2-glb-toolbar">
        <div class="aof-step2-glb-title">3D Model Preview</div>
        <div class="aof-step2-glb-status" data-glb-status>Loading active model...</div>
        <button class="aof-step2-glb-button" type="button" data-reset-camera>Reset View</button>
        <button class="aof-step2-glb-button" type="button" data-auto-rotate>Auto Rotate: Off</button>
        <button class="aof-step2-glb-button" type="button" data-reload-model>Reload</button>
      </div>
      <model-viewer
        class="aof-step2-glb-model"
        data-glb-model
        src="\${modelUrl()}"
        camera-controls
        shadow-intensity="0.6"
        exposure="1.05"
        environment-image="neutral"
        interaction-prompt="auto"
        camera-orbit="35deg 70deg auto"
        field-of-view="30deg"
      >
        <div class="aof-step2-glb-fallback" slot="poster">
          Loading GLB preview...
        </div>
      </model-viewer>
    \`;

    const mv = wrap.querySelector("[data-glb-model]");
    const status = wrap.querySelector("[data-glb-status]");

    mv.addEventListener("load", () => {
      status.textContent = "Loaded: " + MODEL_PATH;
      if (typeof mv.updateFraming === "function") {
        mv.updateFraming();
      }
    });

    mv.addEventListener("error", (event) => {
      status.textContent = "GLB preview failed";
      console.error("[step2-model-viewer] model-viewer error", event);
    });

    wrap.querySelector("[data-reset-camera]").addEventListener("click", () => {
      mv.cameraOrbit = "35deg 70deg auto";
      mv.fieldOfView = "30deg";
      if (typeof mv.updateFraming === "function") {
        mv.updateFraming();
      }
    });

    wrap.querySelector("[data-auto-rotate]").addEventListener("click", (event) => {
      mv.autoRotate = !mv.autoRotate;
      event.currentTarget.textContent = "Auto Rotate: " + (mv.autoRotate ? "On" : "Off");
    });

    wrap.querySelector("[data-reload-model]").addEventListener("click", () => {
      mv.src = modelUrl();
      status.textContent = "Reloading active model...";
    });

    return wrap;
  }

  function installViewer() {
    if (!isStep2()) return;

    const existing = document.getElementById(VIEWER_ID);
    if (existing) return;

    const panel = findStep2Panel();
    if (!panel) {
      log("Step 2 panel not found yet.");
      return;
    }

    const preview = findPreviewBox(panel);
    const viewer = makeViewer();

    if (preview && preview !== panel) {
      preview.replaceWith(viewer);
      log("Viewer replaced Step 2 preview box.");
    } else {
      panel.appendChild(viewer);
      log("Viewer appended to Step 2 panel.");
    }
  }

  function reloadViewerAfterModelChange() {
    const mv = document.querySelector("#" + VIEWER_ID + " [data-glb-model]");
    const status = document.querySelector("#" + VIEWER_ID + " [data-glb-status]");
    if (mv) {
      mv.src = modelUrl();
      if (status) status.textContent = "Reloading active model...";
    } else {
      installViewer();
    }
  }

  const originalFetch = window.fetch.bind(window);
  window.fetch = async function (...args) {
    const response = await originalFetch(...args);

    try {
      const url = String(args[0] || "");
      if (url.includes("/api/run-sf3d") || url.includes("/api/copy-glb")) {
        setTimeout(reloadViewerAfterModelChange, 1000);
      }
    } catch {}

    return response;
  };

  const observer = new MutationObserver(() => {
    clearTimeout(window.__aofStep2GlbTimer);
    window.__aofStep2GlbTimer = setTimeout(installViewer, 150);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener("DOMContentLoaded", installViewer);
  window.addEventListener("load", installViewer);
  setInterval(installViewer, 1000);
  installViewer();
})();
`);

const htmlPath = "src/ui/public/index.html";
let html = fs.readFileSync(htmlPath, "utf8");

if (!html.includes("/vendor/model-viewer.min.js")) {
  html = html.replace(
    "</head>",
    '  <script type="module" src="/vendor/model-viewer.min.js"></script>\\n</head>'
  );
}

if (!html.includes("/step2-model-viewer.css")) {
  html = html.replace(
    "</head>",
    '  <link rel="stylesheet" href="/step2-model-viewer.css">\\n</head>'
  );
}

if (!html.includes("/step2-model-viewer.js")) {
  html = html.replace(
    "</body>",
    '  <script src="/step2-model-viewer.js"></script>\\n</body>'
  );
}

fs.writeFileSync(htmlPath, html, "utf8");
console.log("[patch] src/ui/public/index.html");
console.log("Done.");
