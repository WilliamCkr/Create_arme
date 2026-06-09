const fs = require('fs');
const path = require('path');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  console.log('[write]', file);
}

function copy(src, dst) {
  if (!fs.existsSync(src)) {
    console.log('[missing]', src);
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  console.log('[copy]', dst);
}

copy(
  'node_modules/three/build/three.module.js',
  'src/ui/public/vendor/three/three.module.js'
);

copy(
  'node_modules/three/examples/jsm/loaders/GLTFLoader.js',
  'src/ui/public/vendor/three/GLTFLoader.js'
);

copy(
  'node_modules/three/examples/jsm/controls/OrbitControls.js',
  'src/ui/public/vendor/three/OrbitControls.js'
);

write('src/ui/public/model-viewer.css', `
.aof-model-viewer {
  width: 100%;
  min-height: 520px;
  border: 1px solid rgba(135, 204, 255, 0.18);
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
  box-shadow: inset 0 0 60px rgba(0,0,0,.32);
}

.aof-model-viewer__toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(135, 204, 255, 0.14);
  background: rgba(8, 13, 22, 0.74);
}

.aof-model-viewer__title {
  font-weight: 800;
  color: #eaf4ff;
  margin-right: auto;
}

.aof-model-viewer__status {
  color: #9aabc0;
  font-size: 12px;
}

.aof-model-viewer__button {
  border: 1px solid rgba(135, 204, 255, 0.22);
  color: #eaf4ff;
  background: rgba(255,255,255,0.06);
  border-radius: 10px;
  padding: 7px 10px;
  cursor: pointer;
}

.aof-model-viewer__button:hover {
  background: rgba(125, 203, 255, 0.14);
}

.aof-model-viewer__canvas {
  width: 100%;
  height: 520px;
  position: relative;
}

.aof-model-viewer__error {
  padding: 20px;
  color: #ffb4b4;
  font-weight: 700;
}
`);

write('src/ui/public/model-viewer.js', `
import * as THREE from 'three';
import { GLTFLoader } from '/vendor/three/GLTFLoader.js';
import { OrbitControls } from '/vendor/three/OrbitControls.js';

const MODEL_PATH = 'input/cursed_sword.glb';

let viewer = null;
let autoRotate = false;
let lastUrl = '';

function isStep2Visible() {
  const text = document.body ? document.body.innerText : '';
  return text.includes('Step 2 of 4') || text.includes('Generate 3D Model');
}

function findStep2Host() {
  const candidates = Array.from(document.querySelectorAll('section, article, main, div'))
    .filter((el) => {
      const text = el.innerText || '';
      const rect = el.getBoundingClientRect();
      return rect.width > 500 &&
        rect.height > 250 &&
        text.includes('Generate 3D Model') &&
        (text.includes('3D model ready') || text.includes('Active model') || text.includes('After generation'));
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });

  return candidates[0] || null;
}

function modelUrl() {
  return '/api/file?path=' + encodeURIComponent(MODEL_PATH) + '&t=' + Date.now();
}

function createShell() {
  const shell = document.createElement('div');
  shell.id = 'aof-step2-model-viewer';
  shell.className = 'aof-model-viewer';
  shell.innerHTML = \`
    <div class="aof-model-viewer__toolbar">
      <div class="aof-model-viewer__title">3D Model Preview</div>
      <div class="aof-model-viewer__status" data-model-status>Loading active GLB...</div>
      <button class="aof-model-viewer__button" data-model-reset>Reset View</button>
      <button class="aof-model-viewer__button" data-model-fit>Fit Model</button>
      <button class="aof-model-viewer__button" data-model-auto>Auto Rotate: Off</button>
    </div>
    <div class="aof-model-viewer__canvas" data-model-canvas></div>
  \`;
  return shell;
}

function clearCanvas(container) {
  while (container.firstChild) container.removeChild(container.firstChild);
}

function showError(container, message) {
  clearCanvas(container);
  const box = document.createElement('div');
  box.className = 'aof-model-viewer__error';
  box.textContent = message;
  container.appendChild(box);
}

function initViewer(shell) {
  const canvasHost = shell.querySelector('[data-model-canvas]');
  const status = shell.querySelector('[data-model-status]');

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  camera.position.set(0, 1.2, 4);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvasHost.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.target.set(0, 0, 0);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x253040, 2.1);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x9bcfff, 1.0);
  rim.position.set(-4, 2, -3);
  scene.add(rim);

  const root = new THREE.Group();
  scene.add(root);

  const state = {
    scene,
    camera,
    renderer,
    controls,
    root,
    model: null,
    shell,
    canvasHost,
    status
  };

  function resize() {
    const rect = canvasHost.getBoundingClientRect();
    const w = Math.max(320, Math.floor(rect.width));
    const h = Math.max(320, Math.floor(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  const ro = new ResizeObserver(resize);
  ro.observe(canvasHost);
  resize();

  function animate() {
    if (!document.body.contains(shell)) return;
    requestAnimationFrame(animate);
    if (autoRotate && state.model) {
      state.model.rotation.y += 0.008;
    }
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  shell.querySelector('[data-model-reset]').addEventListener('click', () => resetView(state));
  shell.querySelector('[data-model-fit]').addEventListener('click', () => fitModel(state));
  shell.querySelector('[data-model-auto]').addEventListener('click', (event) => {
    autoRotate = !autoRotate;
    event.currentTarget.textContent = 'Auto Rotate: ' + (autoRotate ? 'On' : 'Off');
  });

  return state;
}

function fitModel(state) {
  if (!state.model) return;

  const box = new THREE.Box3().setFromObject(state.model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());

  state.model.position.x -= center.x;
  state.model.position.y -= center.y;
  state.model.position.z -= center.z;

  const maxDim = Math.max(size.x, size.y, size.z, 0.1);
  const distance = maxDim * 2.2;

  state.camera.near = Math.max(distance / 100, 0.001);
  state.camera.far = distance * 100;
  state.camera.position.set(distance * 0.55, distance * 0.35, distance);
  state.camera.updateProjectionMatrix();

  state.controls.target.set(0, 0, 0);
  state.controls.update();
}

function resetView(state) {
  if (!state.model) return;
  state.model.rotation.set(0, 0, 0);
  fitModel(state);
}

function loadModel(state) {
  const url = modelUrl();
  lastUrl = url;

  state.status.textContent = 'Loading ' + MODEL_PATH + '...';

  const loader = new GLTFLoader();
  loader.load(
    url,
    (gltf) => {
      while (state.root.children.length) {
        state.root.remove(state.root.children[0]);
      }

      state.model = gltf.scene;
      state.root.add(state.model);

      state.model.traverse((obj) => {
        if (obj.isMesh) {
          obj.frustumCulled = false;
          if (obj.material) {
            obj.material.side = THREE.DoubleSide;
          }
        }
      });

      fitModel(state);
      state.status.textContent = 'Loaded: ' + MODEL_PATH;
    },
    undefined,
    (error) => {
      console.error('[model-viewer] GLB load failed', error);
      state.status.textContent = 'GLB load failed';
      showError(state.canvasHost, 'Could not load GLB preview. Check that input/cursed_sword.glb exists and /api/file can serve it.');
    }
  );
}

function ensureViewer() {
  if (!isStep2Visible()) return;

  const host = findStep2Host();
  if (!host) return;

  let shell = document.getElementById('aof-step2-model-viewer');

  if (!shell) {
    shell = createShell();

    const firstLargePreview = Array.from(host.children).find((child) => {
      const rect = child.getBoundingClientRect();
      return rect.width > 400 && rect.height > 180;
    });

    if (firstLargePreview) {
      host.insertBefore(shell, firstLargePreview);
      firstLargePreview.style.display = 'none';
    } else {
      host.appendChild(shell);
    }

    viewer = initViewer(shell);
    loadModel(viewer);
    return;
  }

  if (!viewer) {
    viewer = initViewer(shell);
    loadModel(viewer);
  }
}

function refreshIfNeeded() {
  const shell = document.getElementById('aof-step2-model-viewer');
  if (!isStep2Visible()) {
    return;
  }

  if (!shell) {
    ensureViewer();
    return;
  }

  const status = shell.querySelector('[data-model-status]');
  if (status && status.textContent.includes('GLB load failed')) {
    return;
  }
}

const observer = new MutationObserver(() => {
  window.clearTimeout(window.__aofModelViewerTimer);
  window.__aofModelViewerTimer = window.setTimeout(refreshIfNeeded, 150);
});

observer.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('aof:model-updated', () => {
  if (viewer) loadModel(viewer);
});

const originalFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const response = await originalFetch(...args);
  try {
    const url = String(args[0] || '');
    if (url.includes('/api/run-sf3d') || url.includes('/api/copy-glb')) {
      setTimeout(() => {
        if (viewer) loadModel(viewer);
        else ensureViewer();
      }, 800);
    }
  } catch {}
  return response;
};

setInterval(refreshIfNeeded, 800);
window.addEventListener('DOMContentLoaded', ensureViewer);
ensureViewer();
`);

const htmlPath = 'src/ui/public/index.html';
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');

  if (!html.includes('/model-viewer.css')) {
    html = html.replace(
      '</head>',
      '  <link rel="stylesheet" href="/model-viewer.css">\\n</head>'
    );
  }

  if (!html.includes('"three": "/vendor/three/three.module.js"')) {
    html = html.replace(
      '</head>',
      '  <script type="importmap">{"imports":{"three":"/vendor/three/three.module.js"}}</script>\\n</head>'
    );
  }

  if (!html.includes('/model-viewer.js')) {
    html = html.replace(
      '</body>',
      '  <script type="module" src="/model-viewer.js"></script>\\n</body>'
    );
  }

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('[patch]', htmlPath);
} else {
  console.log('[missing]', htmlPath);
}

console.log('GLB viewer patch complete.');
