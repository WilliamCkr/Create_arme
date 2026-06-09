const fs = require('fs');

const indexPath = 'src/ui/public/index.html';

if (!fs.existsSync(indexPath)) {
  console.log('Missing index.html');
  process.exit(0);
}

let html = fs.readFileSync(indexPath, 'utf8');

if (!html.includes('/step1-source-preview-fixed.js')) {
  html = html.replace(
    '</body>',
    '  <script src="/step1-source-preview-fixed.js"></script>\n</body>'
  );
  fs.writeFileSync(indexPath, html, 'utf8');
  console.log('[patch] added step1 source preview script');
} else {
  console.log('[skip] step1 source preview script already linked');
}

fs.writeFileSync('src/ui/public/step1-source-preview-fixed.js', `
(function () {
  const VIEWER_ID = 'aof-step1-source-preview-fixed';
  const SOURCE_PATH = 'input/cursed_sword_source.png';

  function bodyText() {
    return document.body ? document.body.innerText || '' : '';
  }

  function isCurrentStep1() {
    const text = bodyText();
    return text.includes('Current step: Step 1 of 4') &&
      text.includes('Source Image');
  }

  function removeIfWrongStep() {
    if (isCurrentStep1()) return;
    const existing = document.getElementById(VIEWER_ID);
    if (existing) existing.remove();
  }

  function sourceUrl() {
    return '/api/file?path=' + encodeURIComponent(SOURCE_PATH) + '&t=' + Date.now();
  }

  function findStep1Panel() {
    if (!isCurrentStep1()) return null;

    const titleCandidates = Array.from(document.querySelectorAll('h1,h2,h3,h4,div,span,strong'))
      .filter((el) => (el.textContent || '').trim() === 'Source Image');

    for (const title of titleCandidates) {
      let node = title;
      for (let depth = 0; depth < 8 && node; depth++) {
        const rect = node.getBoundingClientRect();
        const text = node.innerText || '';

        if (
          rect.width > 600 &&
          rect.height > 80 &&
          text.includes('Current step: Step 1 of 4') &&
          text.includes('Source Image')
        ) {
          return node;
        }

        node = node.parentElement;
      }
    }

    return null;
  }

  function createSourcePreview() {
    const wrap = document.createElement('div');
    wrap.id = VIEWER_ID;
    wrap.style.width = '100%';
    wrap.style.minHeight = '560px';
    wrap.style.border = '1px solid rgba(125,203,255,.22)';
    wrap.style.borderRadius = '18px';
    wrap.style.overflow = 'hidden';
    wrap.style.background = [
      'linear-gradient(45deg, rgba(255,255,255,.035) 25%, transparent 25%)',
      'linear-gradient(-45deg, rgba(255,255,255,.035) 25%, transparent 25%)',
      'linear-gradient(45deg, transparent 75%, rgba(255,255,255,.035) 75%)',
      'linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.035) 75%)',
      '#101722'
    ].join(',');
    wrap.style.backgroundSize = '28px 28px';
    wrap.style.backgroundPosition = '0 0, 0 14px, 14px -14px, -14px 0px';
    wrap.style.display = 'flex';
    wrap.style.flexDirection = 'column';

    wrap.innerHTML = \`
      <div style="
        display:flex;
        align-items:center;
        gap:10px;
        padding:10px 12px;
        border-bottom:1px solid rgba(125,203,255,.16);
        background:rgba(8,13,22,.86);
      ">
        <div style="font-weight:800;color:#eaf4ff;margin-right:auto;">Source Image Preview</div>
        <div data-source-status style="color:#9aabc0;font-size:12px;">Loading source image...</div>
        <button type="button" data-source-reload style="
          border:1px solid rgba(135,204,255,.24);
          color:#eaf4ff;
          background:rgba(255,255,255,.08);
          border-radius:10px;
          padding:8px 10px;
          cursor:pointer;
        ">Reload</button>
      </div>
      <div style="
        flex:1;
        min-height:520px;
        display:flex;
        align-items:center;
        justify-content:center;
        padding:24px;
      ">
        <img data-source-image alt="Source weapon image" style="
          max-width:100%;
          max-height:520px;
          object-fit:contain;
          image-rendering:auto;
          filter: drop-shadow(0 18px 35px rgba(0,0,0,.55));
        ">
      </div>
    \`;

    const img = wrap.querySelector('[data-source-image]');
    const status = wrap.querySelector('[data-source-status]');

    function load() {
      status.textContent = 'Loading ' + SOURCE_PATH + '...';
      img.src = sourceUrl();
    }

    img.addEventListener('load', () => {
      status.textContent = 'Loaded: ' + SOURCE_PATH;
    });

    img.addEventListener('error', () => {
      status.textContent = 'Source image failed to load';
    });

    wrap.querySelector('[data-source-reload]').addEventListener('click', load);

    load();

    return wrap;
  }

  function findInsertTarget(panel) {
    const candidates = Array.from(panel.children).filter((el) => {
      if (el.id === VIEWER_ID) return false;
      const rect = el.getBoundingClientRect();
      const text = el.innerText || '';

      return rect.width > 400 &&
        rect.height < 220 &&
        text.includes('Use this image as the starting point');
    });

    return candidates[0] || null;
  }

  function install() {
    removeIfWrongStep();

    if (!isCurrentStep1()) return;
    if (document.getElementById(VIEWER_ID)) return;

    const panel = findStep1Panel();
    if (!panel) return;

    const preview = createSourcePreview();
    const target = findInsertTarget(panel);

    if (target) {
      panel.insertBefore(preview, target);
    } else {
      panel.appendChild(preview);
    }
  }

  const observer = new MutationObserver(() => {
    clearTimeout(window.__aofStep1SourcePreviewTimer);
    window.__aofStep1SourcePreviewTimer = setTimeout(install, 150);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('DOMContentLoaded', install);
  window.addEventListener('load', install);
  setInterval(install, 1000);
})();
`, 'utf8');

console.log('[write] src/ui/public/step1-source-preview-fixed.js');
console.log('Done.');
