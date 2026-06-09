const fs = require('fs');
const path = require('path');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  console.log('[write]', file);
}

const indexPath = 'src/ui/public/index.html';

if (!fs.existsSync(indexPath)) {
  console.log('Missing index.html');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');

const removeScriptPaths = [
  '/model-viewer.js',
  '/step2-model-viewer.js',
  '/step2-iframe-viewer.js',
  '/step2-glb-preview-fixed.js',
  '/step1-source-preview-fixed.js',
  '/wizard-step-previews.js',
  '/aof-preview-manager.js',
  '/aof-preview-manager-v2.js'
];

const removeCssPaths = [
  '/model-viewer.css',
  '/step2-model-viewer.css',
  '/wizard-step-previews.css',
  '/aof-preview-manager.css',
  '/aof-preview-manager-v2.css'
];

for (const src of removeScriptPaths) {
  const safe = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`\\s*<script[^>]+src=["']${safe}(\\?[^"']*)?["'][^>]*><\\/script>`, 'g'), '');
}

for (const href of removeCssPaths) {
  const safe = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`\\s*<link[^>]+href=["']${safe}(\\?[^"']*)?["'][^>]*>`, 'g'), '');
}

if (!html.includes('/aof-preview-manager-v2.css')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/aof-preview-manager-v2.css?v=2">\\n</head>');
}

html = html.replace('</body>', '  <script src="/aof-preview-manager-v2.js?v=2"></script>\\n</body>');

fs.writeFileSync(indexPath, html, 'utf8');
console.log('[patch] index.html now uses preview manager v2 only');

for (const file of [
  'src/ui/public/model-viewer.js',
  'src/ui/public/step2-model-viewer.js',
  'src/ui/public/step2-iframe-viewer.js',
  'src/ui/public/step2-glb-preview-fixed.js',
  'src/ui/public/step1-source-preview-fixed.js',
  'src/ui/public/wizard-step-previews.js',
  'src/ui/public/aof-preview-manager.js'
]) {
  if (fs.existsSync(file)) {
    fs.writeFileSync(file, '// disabled by aof-preview-manager-v2\\n', 'utf8');
    console.log('[disabled]', file);
  }
}

write('src/ui/public/aof-preview-manager-v2.css', `
.aof-preview-v2 {
  width: 100%;
}

.aof-preview-v2__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.aof-preview-v2__title {
  font-size: 18px;
  font-weight: 900;
  color: #eaf4ff;
  margin-right: auto;
}

.aof-preview-v2__meta {
  color: #9aabc0;
  font-size: 13px;
}

.aof-preview-v2__button {
  border: 1px solid rgba(135,204,255,.24);
  color: #eaf4ff;
  background: rgba(255,255,255,.08);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
}

.aof-preview-v2__button:hover {
  background: rgba(125,203,255,.16);
}

.aof-preview-v2__box {
  width: 100%;
  min-height: 590px;
  border: 1px solid rgba(125,203,255,.22);
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
  display: flex;
  align-items: center;
  justify-content: center;
}

.aof-preview-v2__img {
  max-width: 100%;
  max-height: 560px;
  object-fit: contain;
  image-rendering: auto;
  filter: drop-shadow(0 18px 35px rgba(0,0,0,.55));
}

.aof-preview-v2__iframe {
  width: 100%;
  height: 590px;
  border: 0;
  display: block;
}

.aof-preview-v2__text {
  margin-top: 10px;
  color: #9aabc0;
  font-size: 13px;
  line-height: 1.5;
}
`);

write('src/ui/public/aof-preview-manager-v2.js', `
(function () {
  const paths = {
    source: 'input/cursed_sword_source.png',
    model: 'input/cursed_sword.glb',
    atlas: 'output/cursed_sword/atlas.png',
    exportAtlas: 'arena-export/cursed_sword/atlas.png'
  };

  let lastStep = null;
  let lastPanel = null;
  let lastTick = 0;

  function fileUrl(filePath) {
    return '/api/file?path=' + encodeURIComponent(filePath) + '&t=' + Date.now();
  }

  function isInsidePreviewManager(el) {
    return Boolean(el.closest && el.closest('[data-aof-preview-v2="true"]'));
  }

  function detectStepFromHeaderOnly() {
    const candidates = Array.from(document.querySelectorAll('body *'))
      .filter((el) => {
        if (isInsidePreviewManager(el)) return false;

        const text = (el.textContent || '').trim();
        if (!/^Step\\s+[1-4]\\s+of\\s+4$/i.test(text)) return false;

        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;

        // Prefer the top header pill, not sidebar text and never injected preview text.
        return rect.top >= 0 && rect.top < 140;
      })
      .map((el) => {
        const match = (el.textContent || '').trim().match(/Step\\s+([1-4])\\s+of\\s+4/i);
        const rect = el.getBoundingClientRect();
        return {
          step: match ? Number(match[1]) : 1,
          top: rect.top,
          right: rect.right,
          el
        };
      })
      .sort((a, b) => {
        if (Math.abs(a.top - b.top) > 8) return a.top - b.top;
        return b.right - a.right;
      });

    if (candidates.length) {
      return candidates[0].step;
    }

    return 1;
  }

  function findCentralPanel() {
    const candidates = Array.from(document.querySelectorAll('section, article, main, div'))
      .filter((el) => {
        if (isInsidePreviewManager(el)) return false;

        const rect = el.getBoundingClientRect();
        if (rect.width < 700) return false;
        if (rect.height < 70) return false;
        if (rect.top < 100 || rect.top > 650) return false;
        if (rect.left < 180) return false;

        // Avoid the right option panel.
        if (rect.left > window.innerWidth * 0.78) return false;

        return true;
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();

        // Prefer the upper big central card.
        const aScore = Math.abs(ar.top - 120) * 10 - ar.width * 0.01;
        const bScore = Math.abs(br.top - 120) * 10 - br.width * 0.01;
        return aScore - bScore;
      });

    return candidates[0] || null;
  }

  function titleFor(step) {
    if (step === 1) return 'Source Image Preview';
    if (step === 2) return '3D Model Preview';
    if (step === 3) return 'Weapon Atlas Preview';
    if (step === 4) return 'Arena Export Preview';
    return 'Preview';
  }

  function bodyFor(step) {
    if (step === 1) {
      return '' +
        '<div class="aof-preview-v2__box">' +
          '<img class="aof-preview-v2__img" src="' + fileUrl(paths.source) + '" alt="Source image">' +
        '</div>' +
        '<div class="aof-preview-v2__text">Source: ' + paths.source + '</div>';
    }

    if (step === 2) {
      return '' +
        '<div class="aof-preview-v2__box">' +
          '<iframe class="aof-preview-v2__iframe" title="3D Model Preview" src="/glb-preview.html?path=' + encodeURIComponent(paths.model) + '&t=' + Date.now() + '"></iframe>' +
        '</div>' +
        '<div class="aof-preview-v2__text">Active model: ' + paths.model + '</div>';
    }

    if (step === 3) {
      return '' +
        '<div class="aof-preview-v2__box">' +
          '<img class="aof-preview-v2__img" src="' + fileUrl(paths.atlas) + '" alt="Atlas preview">' +
        '</div>' +
        '<div class="aof-preview-v2__text">Atlas: ' + paths.atlas + '</div>';
    }

    if (step === 4) {
      return '' +
        '<div class="aof-preview-v2__box">' +
          '<img class="aof-preview-v2__img" src="' + fileUrl(paths.exportAtlas) + '" alt="Arena export atlas preview">' +
        '</div>' +
        '<div class="aof-preview-v2__text">Export folder: arena-export/cursed_sword</div>' +
        '<div class="aof-preview-v2__text">Export atlas: ' + paths.exportAtlas + '</div>';
    }

    return '<div class="aof-preview-v2__box"><div class="aof-preview-v2__text">No preview.</div></div>';
  }

  function render(panel, step) {
    panel.dataset.aofPreviewV2Panel = 'true';
    panel.dataset.aofPreviewV2Step = String(step);

    panel.innerHTML = '' +
      '<div class="aof-preview-v2" data-aof-preview-v2="true">' +
        '<div class="aof-preview-v2__header">' +
          '<div class="aof-preview-v2__title">' + titleFor(step) + '</div>' +
          '<div class="aof-preview-v2__meta">Step ' + step + ' of 4</div>' +
          '<button class="aof-preview-v2__button" type="button" data-aof-preview-v2-reload>Reload Preview</button>' +
        '</div>' +
        bodyFor(step) +
      '</div>';

    const button = panel.querySelector('[data-aof-preview-v2-reload]');
    if (button) {
      button.addEventListener('click', () => {
        lastStep = null;
        tick(true);
      });
    }
  }

  function removeForeignPreviewNodes() {
    for (const id of [
      'aof-step2-glb-viewer',
      'aof-step2-model-viewer',
      'aof-step2-iframe-viewer',
      'aof-step2-iframe-viewer-fixed',
      'aof-step1-source-preview-fixed',
      'aof-stable-preview-root'
    ]) {
      const node = document.getElementById(id);
      if (node) node.remove();
    }
  }

  function tick(force) {
    const now = Date.now();
    if (!force && now - lastTick < 300) return;
    lastTick = now;

    removeForeignPreviewNodes();

    const step = detectStepFromHeaderOnly();
    const panel = findCentralPanel() || lastPanel;

    if (!panel) return;

    const currentStepOnPanel = Number(panel.dataset.aofPreviewV2Step || 0);

    if (force || panel !== lastPanel || step !== lastStep || currentStepOnPanel !== step) {
      lastPanel = panel;
      lastStep = step;
      render(panel, step);
    }
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await originalFetch(...args);

    try {
      const url = String(args[0] || '');
      if (
        url.includes('/api/run-sf3d') ||
        url.includes('/api/copy-glb') ||
        url.includes('/api/render') ||
        url.includes('/api/build-atlas') ||
        url.includes('/api/generate-atlas') ||
        url.includes('/api/export-arena-package')
      ) {
        setTimeout(() => tick(true), 900);
      }
    } catch {}

    return response;
  };

  window.addEventListener('DOMContentLoaded', () => tick(true));
  window.addEventListener('load', () => tick(true));
  document.addEventListener('click', () => setTimeout(() => tick(true), 180));
  setInterval(() => tick(false), 900);
})();
`);

console.log('Preview manager v2 installed.');
