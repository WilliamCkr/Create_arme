const fs = require('fs');

const indexPath = 'src/ui/public/index.html';

if (!fs.existsSync(indexPath)) {
  console.log('Missing index.html');
} else {
  let html = fs.readFileSync(indexPath, 'utf8');

  const removePatterns = [
    /[ \t]*<script[^>]+src="\/model-viewer\.js"[^>]*><\/script>\s*/g,
    /[ \t]*<script[^>]+src="\/step2-model-viewer\.js"[^>]*><\/script>\s*/g,
    /[ \t]*<script[^>]+src="\/step2-iframe-viewer\.js"[^>]*><\/script>\s*/g,
    /[ \t]*<script[^>]+src="\/step2-glb-preview-fixed\.js"[^>]*><\/script>\s*/g
  ];

  for (const pattern of removePatterns) {
    html = html.replace(pattern, '');
  }

  if (!html.includes('/step2-glb-preview-fixed.js')) {
    html = html.replace(
      '</body>',
      '  <script src="/step2-glb-preview-fixed.js"></script>\n</body>'
    );
  }

  fs.writeFileSync(indexPath, html, 'utf8');
  console.log('[patch] cleaned old viewer scripts and added fixed script');
}

fs.writeFileSync('src/ui/public/step2-glb-preview-fixed.js', `
(function () {
  const VIEWER_ID = 'aof-step2-iframe-viewer-fixed';
  const MODEL_PATH = 'input/cursed_sword.glb';

  function getBodyText() {
    return document.body ? document.body.innerText || '' : '';
  }

  function isCurrentStep2() {
    const text = getBodyText();

    // This exact text is shown by the wizard's active central panel.
    // It prevents the GLB viewer from being injected on Source / Atlas / Export.
    return text.includes('Current step: Step 2 of 4') &&
      text.includes('Generate 3D Model');
  }

  function removeViewerIfWrongStep() {
    if (isCurrentStep2()) return;

    const existing = document.getElementById(VIEWER_ID);
    if (existing) {
      existing.remove();
    }

    // Remove old injected viewers if they are still present from previous patches.
    const oldA = document.getElementById('aof-step2-glb-viewer');
    if (oldA) oldA.remove();

    const oldB = document.getElementById('aof-step2-model-viewer');
    if (oldB) oldB.remove();
  }

  function findStep2Panel() {
    if (!isCurrentStep2()) return null;

    const titleCandidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span,strong'))
      .filter((el) => (el.textContent || '').trim() === 'Generate 3D Model');

    for (const title of titleCandidates) {
      let node = title;
      for (let depth = 0; depth < 8 && node; depth++) {
        const rect = node.getBoundingClientRect();
        const text = node.innerText || '';

        if (
          rect.width > 600 &&
          rect.height > 250 &&
          text.includes('Current step: Step 2 of 4') &&
          text.includes('Generate 3D Model')
        ) {
          return node;
        }

        node = node.parentElement;
      }
    }

    return null;
  }

  function findPreviewBox(panel) {
    if (!panel) return null;

    const candidates = Array.from(panel.querySelectorAll('div'))
      .filter((el) => {
        if (el.id === VIEWER_ID) return false;

        const rect = el.getBoundingClientRect();
        const text = el.innerText || '';

        return rect.width > 500 &&
          rect.height > 180 &&
          text.includes('3D model ready') &&
          text.includes('Active model');
      })
      .sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return (br.width * br.height) - (ar.width * ar.height);
      });

    return candidates[0] || null;
  }

  function createViewer() {
    const wrap = document.createElement('div');
    wrap.id = VIEWER_ID;
    wrap.style.width = '100%';
    wrap.style.height = '580px';
    wrap.style.border = '1px solid rgba(125,203,255,.22)';
    wrap.style.borderRadius = '18px';
    wrap.style.overflow = 'hidden';
    wrap.style.background = '#101722';

    const iframe = document.createElement('iframe');
    iframe.src = '/glb-preview.html?path=' + encodeURIComponent(MODEL_PATH) + '&t=' + Date.now();
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.setAttribute('title', '3D Model Preview');

    wrap.appendChild(iframe);
    return wrap;
  }

  function installViewerIfStep2() {
    removeViewerIfWrongStep();

    if (!isCurrentStep2()) return;

    if (document.getElementById(VIEWER_ID)) return;

    const panel = findStep2Panel();
    if (!panel) return;

    const previewBox = findPreviewBox(panel);
    const viewer = createViewer();

    if (previewBox) {
      previewBox.replaceWith(viewer);
    } else {
      panel.appendChild(viewer);
    }
  }

  function reloadViewer() {
    const iframe = document.querySelector('#' + VIEWER_ID + ' iframe');

    if (iframe && isCurrentStep2()) {
      iframe.src = '/glb-preview.html?path=' + encodeURIComponent(MODEL_PATH) + '&t=' + Date.now();
    } else {
      installViewerIfStep2();
    }
  }

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function (...args) {
    const response = await originalFetch(...args);

    try {
      const url = String(args[0] || '');
      if (url.includes('/api/run-sf3d') || url.includes('/api/copy-glb')) {
        setTimeout(reloadViewer, 1000);
      }
    } catch {}

    return response;
  };

  const observer = new MutationObserver(() => {
    clearTimeout(window.__aofStep2ViewerOnlyTimer);
    window.__aofStep2ViewerOnlyTimer = setTimeout(installViewerIfStep2, 150);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('DOMContentLoaded', installViewerIfStep2);
  window.addEventListener('load', installViewerIfStep2);
  setInterval(installViewerIfStep2, 1000);
})();
`, 'utf8');

console.log('[write] src/ui/public/step2-glb-preview-fixed.js');
console.log('Done.');
