#!/usr/bin/env python
import os
import sys
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV_DIR = ROOT / "tools" / "hunyuan3d-env"
REPO_DIR = ROOT / "tools" / "Hunyuan3D-2"
REPO_URL = "https://github.com/Tencent-Hunyuan/Hunyuan3D-2.git"

def run(cmd, cwd=None, soft=False):
    print()
    print("[run]", " ".join(str(x) for x in cmd))
    result = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    if result.returncode != 0:
        print("[error] command failed:", result.returncode)
        if not soft:
            return False
    return True

def env_python():
    if os.name == "nt":
        return ENV_DIR / "Scripts" / "python.exe"
    return ENV_DIR / "bin" / "python"

def main():
    print("=== HUNYUAN3D BOOTSTRAP ===")
    print("Root:", ROOT)

    if not ENV_DIR.exists():
        if not run([sys.executable, "-m", "venv", str(ENV_DIR)]):
            return 1
    else:
        print("[skip] env already exists:", ENV_DIR)

    py = env_python()
    if not py.exists():
        print("[fatal] env python missing:", py)
        return 1

    run([str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"], soft=True)

    if not REPO_DIR.exists():
        if not run(["git", "clone", REPO_URL, str(REPO_DIR)]):
            return 1
    else:
        print("[skip] repo already exists:", REPO_DIR)

    run([str(py), "-m", "pip", "install", "--index-url", "https://download.pytorch.org/whl/cu128", "torch", "torchvision", "torchaudio"], soft=True)

    req = REPO_DIR / "requirements.txt"
    if req.exists():
        run([str(py), "-m", "pip", "install", "-r", str(req)], cwd=REPO_DIR, soft=True)

    run([str(py), "-m", "pip", "install", "-e", str(REPO_DIR)], cwd=REPO_DIR, soft=True)

    run([str(py), "-m", "pip", "install", "accelerate", "diffusers", "transformers", "safetensors", "huggingface_hub", "trimesh", "pillow", "opencv-python", "numpy"], soft=True)

    print()
    print("=== VERIFY IMPORTS ===")
    code = "import torch; print('torch', torch.__version__); print('cuda', torch.cuda.is_available()); from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline; print('hy3dgen OK')"
    run([str(py), "-c", code], cwd=REPO_DIR, soft=True)

    print()
    print("Done. Env python:", py)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
