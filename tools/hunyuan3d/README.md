# Hunyuan3D Local Runner

This folder contains the local adapter used by the experimental `hunyuan_mesh_blender_texture` pipeline.

The expected local setup is:

1. create a dedicated Python environment at `tools/hunyuan3d-env/`
2. install the Hunyuan3D Python dependencies there
3. keep the project launcher at `tools/hunyuan3d/launch-hunyuan3d.mjs`
4. keep the mesh generation entrypoint at `tools/hunyuan3d/hunyuan_mesh_runner.py`

Recommended environment commands:

```powershell
py -3 -m venv tools/hunyuan3d-env
tools\hunyuan3d-env\Scripts\Activate.ps1
pip install hy3dgen
```

If your environment needs extra Hunyuan packages or model extras, install them into the same env before running the pipeline.

The launcher automatically looks for:

- `HUNYUAN3D_PYTHON`
- `tools/hunyuan3d-env/Scripts/python.exe`
- `tools/hunyuan3d-env/Scripts/python`
- `tools/hunyuan3d-env/bin/python`
- `python`

Exact runner-only test command:

```bash
node tools/hunyuan3d/launch-hunyuan3d.mjs --source-image input/cursed_sword_source.png --output-mesh output/hunyuan_cursed_sword/mesh.glb --output-dir output/hunyuan_cursed_sword --weapon-id cursed_sword --project-root .
```

This wrapper intentionally fails with a clear error if the Python environment or `hy3dgen` package is missing.
