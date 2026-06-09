const fs = require('fs');

const managerPath = 'src/ui/public/aof-preview-manager-v2.js';

if (fs.existsSync(managerPath)) {
  let js = fs.readFileSync(managerPath, 'utf8');

  js = js.replace(
    "  document.addEventListener('click', () => setTimeout(() => tick(true), 180));",
    `  document.addEventListener('click', () => {
    const step = detectStepFromHeaderOnly();
    if (step !== lastStep) {
      setTimeout(() => tick(true), 180);
    }
  });`
  );

  js = js.replace(
    /setInterval\(\(\) => tick\(false\), 900\);/g,
    `setInterval(() => {
    const step = detectStepFromHeaderOnly();
    if (step !== lastStep) {
      tick(true);
    }
  }, 900);`
  );

  fs.writeFileSync(managerPath, js, 'utf8');
  console.log('[patch] preview manager no longer resets on normal clicks');
} else {
  console.log('[missing] ' + managerPath);
}

const configCandidates = [
  'configs/cursed_sword.ui.json',
  'configs/cursed_sword.json',
  'config/cursed_sword.ui.json',
  'config/cursed_sword.json'
];

for (const file of configCandidates) {
  if (!fs.existsSync(file)) continue;

  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));

    data.textureResolution = 4096;

    if (data.sf3d && typeof data.sf3d === 'object') {
      data.sf3d.textureResolution = 4096;
    }

    if (data.options && typeof data.options === 'object') {
      data.options.textureResolution = 4096;
    }

    if (data.steps && data.steps.sf3d && typeof data.steps.sf3d === 'object') {
      data.steps.sf3d.textureResolution = 4096;
    }

    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    console.log('[patch] textureResolution = 4096 in ' + file);
  } catch (err) {
    console.log('[skip] could not parse ' + file + ': ' + err.message);
  }
}

const htmlPath = 'src/ui/public/index.html';
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, 'utf8');

  html = html.replace(
    /\/aof-preview-manager-v2\.js\?v=[^"']+/g,
    '/aof-preview-manager-v2.js?v=3-no-reset'
  );

  html = html.replace(
    /\/aof-preview-manager-v2\.css\?v=[^"']+/g,
    '/aof-preview-manager-v2.css?v=3-no-reset'
  );

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log('[patch] cache bust preview manager v3');
}

console.log('Done.');
