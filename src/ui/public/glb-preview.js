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
  model.rotation.set(0, 0, 0);
  fitModel();
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

function animate() {
  requestAnimationFrame(animate);
  if (model && autoRotate) {
    model.rotation.y += 0.008;
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

loadModel();
