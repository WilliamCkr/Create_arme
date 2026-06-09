const fs = require('fs');

const file = 'src/ui/public/index.html';
let html = fs.readFileSync(file, 'utf8');

const scriptsToRemove = [
  '/model-viewer.js',
  '/step2-model-viewer.js',
  '/step2-iframe-viewer.js',
  '/step2-glb-preview-fixed.js',
  '/step1-source-preview-fixed.js',
  '/wizard-step-previews.js'
];

for (const script of scriptsToRemove) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  html = html.replace(new RegExp(`\\s*<script[^>]+src="${escaped}"[^>]*><\\/script>`, 'g'), '');
}

if (!html.includes('/wizard-step-previews.css')) {
  html = html.replace('</head>', '  <link rel="stylesheet" href="/wizard-step-previews.css">\n</head>');
}

if (!html.includes('/wizard-step-previews.js')) {
  html = html.replace('</body>', '  <script src="/wizard-step-previews.js"></script>\n</body>');
}

fs.writeFileSync(file, html, 'utf8');
console.log('index patched with stable step previews only');
