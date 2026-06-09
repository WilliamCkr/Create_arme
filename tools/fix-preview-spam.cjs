const fs = require('fs');
const path = require('path');

const indexPath = 'src/ui/public/index.html';

const oldScripts = [
  '/model-viewer.js',
  '/step2-model-viewer.js',
  '/step2-iframe-viewer.js',
  '/step2-glb-preview-fixed.js',
  '/step1-source-preview-fixed.js',
  '/wizard-step-previews.js'
];

const oldCss = [
  '/model-viewer.css',
  '/step2-model-viewer.css',
  '/step2-glb-preview-fixed.css',
  '/wizard-step-previews.css'
];

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  console.log('[write]', file);
}

if (!fs.existsSync(indexPath)) {
  console.log('Missing index.html');
  process.exit(1);
}

let html = fs.readFileSync(indexPath, 'utf8');

for (const src of oldScripts) {
  const safe = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`\\s*<script[^>]+src=["']${safe}[^"']*["'][^>]*><\\/script>`, 'g'), '');
}

for (const href of oldCss) {
  const safe = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`\\s*<link[^>]+href=["']${safe}[^"']*["'][^>]*>`, 'g'), '');
}

html = html.replace(/\s*<script[^>]+src=["']\/aof-preview-manager\.js[^"']*["'][^>]*><\/script>/g, '');
html = html.replace(/\s*<link[^>]+href=["']\/aof-preview-manager\.css[^"']*["'][^>]*>/g, '');

if (!html.includes('/aof-preview-manager.css')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/aof-preview-manager.css">\\n</head>');
}

html = html.replace('</body>', '  <script src="/aof-preview-manager.js?v=stable-preview-1"></script>\\n</body>');

fs.writeFileSync(indexPath, html, 'utf8');
console.log('[patch] index.html cleaned');

for (const file of [
  'src/ui/public/model-viewer.js',
  'src/ui/public/step2-model-viewer.js',
  'src/ui/public/step2-iframe-viewer.js',
  'src/ui/public/step2-glb-preview-fixed.js',
  'src/ui/public/step1-source-preview-fixed.js',
  'src/ui/public/wizard-step-previews.js'
]) {
  if (fs.existsSync(file)) {
    fs.writeFileSync(file, '// disabled by stable preview manager\\n', 'utf8');
    console.log('[disabled]', file);
  }
}

write('src/ui/public/aof-preview-manager.css', `
.aof-clean-preview {
  width: 100%;
}

.aof-clean-preview__header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.aof-clean-preview__title {
  font-weight: 900;
  color: #eaf4ff;
  font-size: 18px;
  margin-right: auto;
}

.aof-clean-preview__meta {
  color: #9aabc0;
  font-size: 13px;
}

.aof-clean-preview__box {
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

.aof-clean-preview__img {
  max-width: 100%;
  max-height: 560px;
  object-fit: contain;
  filter: drop-shadow(0 18px 35px rgba(0,0,0,.55));
}

.aof-clean-preview__iframe {
  width: 100%;
  height: 590px;
  border: 0;
  display: block;
}

.aof-clean-preview__button {
  border: 1px solid rgba(135,204,255,.24);
  color: #eaf4ff;
  background: rgba(255,255,255,.08);
  border-radius: 10px;
  padding: 8px 10px;
  cursor: pointer;
}

.aof-clean-preview__button:hover {
  background: rgba(125,203,255,.16);
}

.aof-clean-preview__empty {
  color: #9aabc0;
  font-weight: 700;
  padding: 24px;
}
`);

write('src/ui/public/aof-preview-manager.js', `
(function () {
  const paths = {
    source: 'input/cursed_sword_source.png',
    model: 'input/cursed_sword.glb',
    atlas: 'output/cursed_sword/atlas.png',
    exportAtlas: 'arena-export/cursed_sword/atlas.png'
  };

  let lastStep = null;
  let lastPanel = null;
  let lastRenderAt = 0;

  function fileUrl(filePath) {
    return '/api/file?path=' + encodeURIComponent(filePath) + '&t=' + Date.now();
  }

  function getText() {
    return document.body ? document.body.innerText || '' : '';
  }

  function detectStep() {
    const text = getText();

    const current = text.match(/Current step:\\s*Step\\s*(\\d)\\s*of\\s*4/i);
    if (current) return Number(current[1]);

    const top = text.match(/Step\\s*(\\d)\\s*of\\s*4/i);
    if (top) return Number(top[1]);

    return 1;
  }

  function findMainPanel() {
    const step = detectStep();
    const marker = 'Current step: Step ' + step + ' of 4';

    const candidates = Array.from(document.querySelectorAll('section, article, main, div'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        const text = el.innerText || '';
        return rect.width > 700 &&
          rect.height > 80 &&
          text.includes(marker);
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (ar.width * ar.height) - (br.width * br.height);
      });

    return candidates[0] || null;
  }

  function titleForStep(step) {
    if (step === 1) return 'Source Image';
    if (step === 2) return '3D Model Preview';
    if (step === 3) return 'Weapon Atlas Preview';
    if (step === 4) return 'Arena Export Preview';
    return 'Preview';
  }

  function bodyForStep(step) {
    if (step === 1) {
      return '<div class="aof-clean-preview__box">' +
        '<img class="aof-clean-preview__img" src="' + fileUrl(paths.source) + '" alt="Source image">' +
        '</div>' +
        '<div class="aof-clean-preview__meta">Source: ' + paths.source + '</div>';
    }

    if (step === 2) {
      return '<div class="aof-clean-preview__box">' +
        '<iframe class="aof-clean-preview__iframe" title="3D Model Preview" src="/glb-preview.html?path=' + encodeURIComponent(paths.model) + '&t=' + Date.now() + '"></iframe>' +
        '</div>' +
        '<div class="aof-clean-preview__meta">Active model: ' + paths.model + '</div>';
    }

    if (step === 3) {
      return '<div class="aof-clean-preview__box">' +
        '<img class="aof-clean-preview__img" src="' + fileUrl(paths.atlas) + '" alt="Atlas preview">' +
        '</div>' +
        '<div class="aof-clean-preview__meta">Atlas: ' + paths.atlas + '</div>';
    }

    if (step === 4) {
      return '<div class="aof-clean-preview__box">' +
        '<img class="aof-clean-preview__img" src="' + fileUrl(paths.exportAtlas) + '" alt="Export atlas preview">' +
        '</div>' +
        '<div class="aof-clean-preview__meta">Export folder: arena-export/cursed_sword</div>' +
        '<div class="aof-clean-preview__meta">Export atlas: ' + paths.exportAtlas + '</div>';
    }

    return '<div class="aof-clean-preview__box"><div class="aof-clean-preview__empty">No preview.</div></div>';
  }

  function renderInto(panel, step) {
    panel.dataset.aofCleanPreview = 'true';
    panel.dataset.aofCleanStep = String(step);

    panel.innerHTML =
      '<div class="aof-clean-preview">' +
        '<div class="aof-clean-preview__header">' +
          '<div class="aof-clean-preview__title">' + titleForStep(step) + '</div>' +
          '<div class="aof-clean-preview__meta">Current step: Step ' + step + ' of 4</div>' +
          '<button class="aof-clean-preview__button" type="button" data-aof-preview-reload>Reload Preview</button>' +
        '</div>' +
        bodyForStep(step) +
      '</div>';

    const button = panel.querySelector('[data-aof-preview-reload]');
    if (button) {
      button.addEventListener('click', () => {
        lastStep = null;
        tick(true);
      });
    }
  }

  function cleanupForeignPreviewNodes() {
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
    if (!force && now - lastRenderAt < 350) return;
    lastRenderAt = now;

    cleanupForeignPreviewNodes();

    const step = detectStep();
    const panel = findMainPanel() || lastPanel;

    if (!panel) return;

    if (force || panel !== lastPanel || step !== lastStep || panel.dataset.aofCleanPreview !== 'true') {
      lastPanel = panel;
      lastStep = step;
      renderInto(panel, step);
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
  document.addEventListener('click', () => setTimeout(() => tick(false), 120));
  setInterval(() => tick(false), 700);
})();
`);

console.log('Preview spam fix complete.');
