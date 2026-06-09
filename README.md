# Arena Object Forge

Arena Object Forge is a standalone external weapon asset pipeline for Arena Bloodline.

It takes a weapon model, usually `GLB` or `OBJ`, and produces:

- transparent PNG angle frames
- an atlas image
- a manifest JSON file
- validation reports

The project is intentionally separate from the Arena Bloodline game repo. It does not require Blender UI, and Blender is only used as a headless command-line renderer.

## Why Blender Is Headless

Blender is used in background mode so the pipeline can run locally, repeatably, and without manual interaction:

```bash
blender -b --python blender/render_weapon_angles.py -- --config configs/cursed_sword.example.json
```

That keeps the workflow scriptable on Windows with Git Bash and makes it easier to integrate later into automated asset production.

## v1 Workflow

This first version focuses on the external tooling foundation:

1. Load config
2. Check the environment
3. Generate placeholder frames if Blender is not being used yet
4. Build the atlas
5. Validate the manifest

The placeholder path lets you test the atlas and manifest pipeline without a real 3D model.

## Pipeline Modes

The project now supports two explicit 3D generation modes:

1. `sf3d_full`
2. `hunyuan_mesh_blender_texture`

`sf3d_full` keeps the original SF3D-based flow in place.

`hunyuan_mesh_blender_texture` is the experimental path for the newer workflow:

1. generate a mesh with Hunyuan3D
2. import that mesh into Blender
3. project the source image texture onto the mesh
4. export a textured intermediate GLB
5. continue with the existing multi-angle render, atlas, and manifest pipeline

When a local Hunyuan runner is not yet connected, the pipeline uses a clean Blender placeholder mesh so the rest of the workflow can still be tested end to end.

## Quick Start

```bash
npm install
npm run check
npm run placeholder
npm run atlas
npm run validate
```

You can also run the full example flow in one step:

```bash
npm run forge:example
```

## Local UI

Start the dashboard with:

```bash
npm run ui
```

Useful variants:

```bash
npm run ui:server
npm run ui:dev
```

The UI is local-only and uses the existing project files directly. It can:

- inspect the source image and GLB status
- choose between SF3D and Hunyuan pipeline modes
- run SF3D from the local Python environment
- run the experimental Hunyuan mesh + Blender texture pipeline
- copy the generated GLB into `input/cursed_sword.glb`
- render frames in either `turntable_3d` or `gameplay_2d` mode
- build the atlas
- validate the manifest
- show live logs while each button runs

The dashboard uses `configs/cursed_sword.ui.json` so the example config stays available as a clean reference.

## Blender Render Flow

When you have a real `GLB` or `OBJ` model, run:

```bash
blender -b --python blender/render_weapon_angles.py -- --config configs/cursed_sword.example.json
```

The script will:

- load the config
- import the model
- center and normalize it
- set up orthographic rendering
- apply a stable studio lighting setup
- render one frame per configured angle
- write a render report

## Hunyuan Texture Projection

The experimental Hunyuan branch uses dedicated Blender scripts:

- `blender/generate_hunyuan_proxy_mesh.py`
- `blender/project_texture_to_mesh.py`

The mesh runner can be connected later through the dedicated CLI/config fields:

- `hunyuan.meshProvider = "external"`
- `hunyuan.runnerCommand`
- `hunyuan.runnerArgs`

If no external runner is available, the placeholder mesh keeps the pipeline usable.

Run the experimental flow with:

```bash
npm run hunyuan:pipeline
```

## Expected Outputs

For the example config, the main outputs are written under:

- `output/cursed_sword/frames/`
- `output/cursed_sword/atlas.png`
- `output/cursed_sword/weapon.manifest.json`
- `output/cursed_sword/render-report.json`

The SF3D stage writes its intermediate GLB to:

- `output/sf3d_cursed_sword/0/mesh.glb`

The Hunyuan experimental stage writes its intermediate files to:

- `output/hunyuan_cursed_sword/mesh.glb`
- `output/hunyuan_cursed_sword/textured.glb`
- `output/hunyuan_cursed_sword/baked-texture.png`
- `output/hunyuan_cursed_sword/hunyuan-pipeline-report.json`

## Future Roadmap

1. Hunyuan local runner integration
2. texture projection / baking tuning
3. material and HDR correction
4. automatic angle atlas generation
5. Arena Bloodline importer

## Notes

- The project does not require cloud services.
- The project does not modify Arena Bloodline files.
- The project avoids Blender UI dependencies by design.
- The render pipeline supports both `turntable_3d` and `gameplay_2d` modes.
