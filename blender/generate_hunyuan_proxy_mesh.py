"""Generate a clean placeholder sword proxy mesh for the Hunyuan pipeline."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import bpy


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a placeholder mesh for the Hunyuan pipeline.")
    parser.add_argument("--output-mesh", required=True, help="Path for the generated GLB mesh.")
    parser.add_argument("--source-image", required=False, help="Optional source image path for traceability.")
    raw_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(raw_args)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)


def create_material(name: str, color, metallic: float, roughness: float):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    principled = material.node_tree.nodes.get("Principled BSDF")
    if principled:
        principled.inputs["Base Color"].default_value = color
        principled.inputs["Metallic"].default_value = metallic
        principled.inputs["Roughness"].default_value = roughness
    return material


def add_box(name: str, location, dimensions, material):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    return obj


def build_proxy_sword() -> None:
    dark_metal = create_material("proxy_dark_metal", (0.05, 0.05, 0.06, 1.0), 0.25, 0.75)
    grip = create_material("proxy_grip", (0.06, 0.03, 0.02, 1.0), 0.0, 0.85)
    accent = create_material("proxy_accent", (0.45, 0.15, 0.8, 1.0), 0.0, 0.55)

    add_box("blade", (0.0, 0.0, 1.15), (0.14, 0.05, 2.4), dark_metal)
    add_box("blade_tip", (0.0, 0.0, 2.38), (0.08, 0.04, 0.18), dark_metal)
    add_box("guard", (0.0, 0.0, -0.16), (0.95, 0.1, 0.12), dark_metal)
    add_box("handle", (0.0, 0.0, -0.65), (0.18, 0.1, 0.72), grip)
    add_box("pommel", (0.0, 0.0, -1.0), (0.26, 0.14, 0.18), dark_metal)
    add_box("rune", (0.0, -0.03, 0.95), (0.03, 0.01, 1.25), accent)


def export_glb(output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output_path), export_format="GLB")


def main() -> None:
    args = parse_args()
    clear_scene()
    build_proxy_sword()
    export_glb(Path(args.output_mesh).resolve())
    print(f"Placeholder mesh written: {Path(args.output_mesh).resolve()}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Proxy mesh generation failed: {exc}", file=sys.stderr)
        raise
