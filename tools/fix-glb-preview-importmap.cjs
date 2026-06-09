const fs = require('fs');

const file = 'src/ui/public/glb-preview.html';

if (!fs.existsSync(file)) {
  console.log('Missing ' + file);
  process.exit(0);
}

let html = fs.readFileSync(file, 'utf8');

const importMap = `<script type="importmap">
    {
      "imports": {
        "three": "/vendor/three/three.module.js"
      }
    }
  </script>`;

if (html.includes('<script type="importmap">')) {
  html = html.replace(/<script type="importmap">[\\s\\S]*?<\\/script>/, importMap);
} else {
  html = html.replace('</head>', importMap + '\\n</head>');
}

fs.writeFileSync(file, html, 'utf8');
console.log('patched glb-preview.html');
