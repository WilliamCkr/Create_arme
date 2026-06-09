import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();

function findPython() {
  const candidates = [
    process.env.HUNYUAN3D_PYTHON,
    path.join(projectRoot, 'tools', 'hunyuan3d-env', 'Scripts', 'python.exe'),
    path.join(projectRoot, 'tools', 'hunyuan3d-env', 'bin', 'python')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return 'python';
}

const python = findPython();
const runner = path.join(projectRoot, 'tools', 'hunyuan3d', 'hunyuan_mesh_runner.py');

const passthroughArgs = process.argv.slice(2);

const env = {
  ...process.env,
  PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || 'expandable_segments:True'
};

// Git Bash / Conda can leak stale certificate env vars.
// If they point to missing files, Hugging Face download fails through httpx.
for (const key of ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) {
  if (env[key] && !fs.existsSync(env[key])) {
    console.log('[hunyuan-launcher] removing broken env', key + '=' + env[key]);
    delete env[key];
  }
}

console.log('[hunyuan-launcher] python:', python);
console.log('[hunyuan-launcher] runner:', runner);
console.log('[hunyuan-launcher] args:', passthroughArgs.join(' '));

const child = spawn(python, [runner, ...passthroughArgs], {
  cwd: projectRoot,
  env,
  stdio: 'inherit',
  shell: false
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
