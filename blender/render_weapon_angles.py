"""Headless Blender renderer for Arena Object Forge."""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from pathlib import Path

import bpy
import mathutils

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from fix_materials import reduce_reflective_materials  # noqa: E402


def parse_args():
    parser = argparse.ArgumentParser(description="Render weapon angles in headless Blender.")
    parser.add_argument("--config", required=True, help="Path to the JSON config file.")
    return parser.parse_args(sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else [])


def fail(message: str) -> None:
    raise RuntimeError(message)


def load_config(config_path: str) -> dict:
    config_file = Path(config_path)
    if not config_file.exists():
        fail(f"Config file not found: {config_file}")
    try:
        return json.loads(config_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        fail(f"Config file is not valid JSON: {config_file}\n{exc}")


def path_from_project_root(project_path: str) -> Path:
    return Path(project_path).resolve()


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in list(bpy.data.lights):
        if block.users == 0:
            bpy.data.lights.remove(block)


def import_model(model_path: Path) -> list[bpy.types.Object]:
    extension = model_path.suffix.lower()
    before = set(bpy.data.objects)

    if extension in {".glb", ".gltf"}:
        bpy.ops.import_scene.gltf(filepath=str(model_path))
    elif extension == ".obj":
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=str(model_path))
        else:
            bpy.ops.import_scene.obj(filepath=str(model_path))
    else:
        fail(f"Unsupported model format: {model_path.suffix}")

    imported = [obj for obj in bpy.data.objects if obj not in before]
    mesh_objects = [obj for obj in imported if obj.type == "MESH"]
    if not mesh_objects:
        fail("No mesh objects were imported.")
    return mesh_objects


def world_bounds(objects: list[bpy.types.Object]):
    corners = []
    for obj in objects:
        for corner in obj.bound_box:
            world_corner = obj.matrix_world @ mathutils.Vector(corner)
            corners.append(world_corner)
    min_corner = mathutils.Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
    max_corner = mathutils.Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
    return min_corner, max_corner


def center_and_normalize(objects: list[bpy.types.Object], target_size: float = 2.0) -> bpy.types.Object:
    min_corner, max_corner = world_bounds(objects)
    center = (min_corner + max_corner) / 2.0
    dimensions = max_corner - min_corner
    largest_dimension = max(dimensions.x, dimensions.y, dimensions.z, 0.0001)
    scale = target_size / largest_dimension

    root = bpy.data.objects.new("WeaponRoot", None)
    bpy.context.collection.objects.link(root)

    for obj in objects:
        obj.parent = root
        obj.matrix_parent_inverse = root.matrix_world.inverted()

    root.location = (-center.x, -center.y, -center.z)
    root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    return root


def create_camera(config: dict) -> bpy.types.Object:
    render_mode = config.get("renderMode", "turntable_3d")
    camera_data = bpy.data.cameras.new("ForgeCamera")
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = float(config["camera"]["orthographicScale"])
    camera_object = bpy.data.objects.new("ForgeCamera", camera_data)
    bpy.context.collection.objects.link(camera_object)
    if render_mode == "gameplay_2d":
        camera_object.location = (0.0, -6.0, 0.0)
    else:
        camera_object.location = (0.0, -6.0, 1.8)

    target = bpy.data.objects.new("CameraTarget", None)
    bpy.context.collection.objects.link(target)
    target.location = (0.0, 0.0, 0.0)

    constraint = camera_object.constraints.new(type="TRACK_TO")
    constraint.target = target
    constraint.track_axis = "TRACK_NEGATIVE_Z"
    constraint.up_axis = "UP_Y"
    bpy.context.scene.camera = camera_object
    return camera_object


def create_studio_lighting(strength: float) -> list[str]:
    warnings = []
    bpy.context.scene.world = bpy.data.worlds.new("ForgeWorld")
    world = bpy.context.scene.world
    world.use_nodes = True
    nodes = world.node_tree.nodes
    links = world.node_tree.links
    for node in list(nodes):
        nodes.remove(node)

    bg = nodes.new(type="ShaderNodeBackground")
    bg.inputs["Color"].default_value = (0.92, 0.94, 0.97, 1.0)
    bg.inputs["Strength"].default_value = strength * 0.6
    output = nodes.new(type="ShaderNodeOutputWorld")
    links.new(bg.outputs["Background"], output.inputs["Surface"])

    light_specs = [
        ("KeyLight", (3.5, -3.0, 5.0), 1800, 1.0),
        ("FillLight", (-4.0, -1.0, 3.0), 900, 0.7),
        ("RimLight", (0.0, 4.0, 4.5), 700, 0.5),
    ]

    for name, location, energy, size in light_specs:
        light_data = bpy.data.lights.new(name=name, type="AREA")
        light_data.energy = energy * strength
        light_data.shape = "RECTANGLE"
        light_data.size = size
        light_data.size_y = size
        light_object = bpy.data.objects.new(name, light_data)
        bpy.context.collection.objects.link(light_object)
        light_object.location = location
        light_object.rotation_euler = (math.radians(55), 0.0, math.radians(-35))

    return warnings


def apply_material_overrides(objects: list[bpy.types.Object], config: dict) -> list[str]:
    warnings = []
    override = config.get("materialOverride", {})
    if not override.get("enabled", False):
        return warnings

    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if material is None:
                continue
            material.use_nodes = True
            reduce_reflective_materials(
                material,
                roughness_target=float(override.get("roughness", 0.82)),
                metallic_target=float(override.get("metallic", 0.15)),
                specular_target=float(override.get("specular", 0.25)),
                clearcoat_target=float(override.get("clearcoat", 0.0)),
                warnings=warnings,
            )
            principled = None
            for node in material.node_tree.nodes:
                if node.type == "BSDF_PRINCIPLED":
                    principled = node
                    break
            if principled and "Transmission" in principled.inputs:
                if not principled.inputs["Transmission"].is_linked:
                    principled.inputs["Transmission"].default_value = 0.0
    return warnings


def set_render_settings(config: dict) -> None:
    scene = bpy.context.scene
    scene.render.engine = config["render"]["engine"]
    scene.render.resolution_x = int(config["render"]["resolution"])
    scene.render.resolution_y = int(config["render"]["resolution"])
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = bool(config["render"].get("transparentBackground", True))
    scene.cycles.samples = int(config["render"].get("samples", 64))


def render_angles(config: dict, root: bpy.types.Object, output_dir: Path) -> tuple[list[str], list[str]]:
    frames_dir = output_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    generated = []
    warnings = []
    render_mode = config.get("renderMode", "turntable_3d")

    for angle in config["angles"]:
        if render_mode == "gameplay_2d":
            root.rotation_euler = (0.0, math.radians(float(angle)), 0.0)
        else:
            root.rotation_euler = (0.0, 0.0, math.radians(float(angle)))
        bpy.context.view_layer.update()
        file_name = f"angle_{int(angle):03d}.png"
        output_path = frames_dir / file_name
        bpy.context.scene.render.filepath = str(output_path)
        bpy.ops.render.render(write_still=True)
        generated.append(str(output_path))

    return generated, warnings


def write_report(config: dict, input_model: Path, output_dir: Path, generated_frames: list[str], warnings: list[str]) -> None:
    report = {
        "id": config["id"],
        "inputModel": str(input_model),
        "renderMode": config.get("renderMode", "turntable_3d"),
        "generatedFrames": generated_frames,
        "warnings": warnings,
        "blenderVersion": bpy.app.version_string,
    }
    report_path = output_dir / "render-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    config = load_config(args.config)

    if "inputModel" not in config:
        fail("Config is missing inputModel.")

    input_model = Path(config["inputModel"]).resolve()
    if not input_model.exists():
        fail(f"Input model does not exist: {input_model}")

    output_dir = Path(config["outputDir"]).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    clear_scene()
    set_render_settings(config)
    warnings = create_studio_lighting(float(config.get("lighting", {}).get("strength", 0.8)))

    imported_objects = import_model(input_model)
    root = center_and_normalize(imported_objects)
    warnings.extend(apply_material_overrides(imported_objects, config))
    create_camera(config)

    generated_frames, render_warnings = render_angles(config, root, output_dir)
    warnings.extend(render_warnings)
    write_report(config, input_model, output_dir, generated_frames, warnings)
    print(f"Rendered {len(generated_frames)} frames to {output_dir}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Render failed: {exc}", file=sys.stderr)
        raise
