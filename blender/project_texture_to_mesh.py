"""Project and bake source-image texture onto a mesh, then export a GLB."""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

import bpy
import mathutils


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Project source texture onto a mesh and export a textured GLB.")
    parser.add_argument("--mesh", required=True, help="Path to the input mesh GLB/GLTF/OBJ.")
    parser.add_argument("--source-image", required=True, help="Path to the source image used as the visible texture.")
    parser.add_argument("--output-glb", required=True, help="Path for the textured GLB to write.")
    parser.add_argument("--output-texture", required=True, help="Path for the baked texture PNG.")
    parser.add_argument("--output-report", required=True, help="Path for the JSON bake report.")
    parser.add_argument("--bake-resolution", type=int, default=2048, help="Bake image resolution.")
    parser.add_argument("--projection-mode", default="smart_uv", help="UV projection mode label to record in the report.")
    raw_args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    return parser.parse_args(raw_args)


def fail(message: str) -> None:
    raise RuntimeError(message)


def path_or_fail(path_value: str, label: str) -> Path:
    file_path = Path(path_value).resolve()
    if not file_path.exists():
        fail(f"{label} not found: {file_path}")
    return file_path


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in list(bpy.data.images):
        if block.users == 0:
            bpy.data.images.remove(block)


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
        fail(f"Unsupported mesh format: {model_path.suffix}")

    imported = [obj for obj in bpy.data.objects if obj not in before]
    mesh_objects = [obj for obj in imported if obj.type == "MESH"]
    if not mesh_objects:
        fail("No mesh objects were imported.")
    return mesh_objects


def join_meshes(mesh_objects: list[bpy.types.Object]) -> bpy.types.Object:
    if len(mesh_objects) == 1:
        return mesh_objects[0]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    bpy.ops.object.join()
    joined = bpy.context.view_layer.objects.active
    if joined is None or joined.type != "MESH":
        fail("Could not join imported mesh objects.")
    return joined


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

    root = bpy.data.objects.new("HunyuanRoot", None)
    bpy.context.collection.objects.link(root)

    for obj in objects:
        obj.parent = root
        obj.matrix_parent_inverse = root.matrix_world.inverted()

    root.location = (-center.x, -center.y, -center.z)
    root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    return root


def ensure_uvs(mesh_object: bpy.types.Object) -> str:
    if mesh_object.data.uv_layers and len(mesh_object.data.uv_layers) > 0:
        return "existing"

    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    bpy.context.view_layer.objects.active = mesh_object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.03)
    bpy.ops.object.mode_set(mode="OBJECT")
    return "smart_project"


def create_bake_material(mesh_object: bpy.types.Object, source_image: Path, baked_image: bpy.types.Image) -> bpy.types.Material:
    material = bpy.data.materials.new(name="SourceTextureBakeMaterial")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    for node in list(nodes):
        nodes.remove(node)

    output = nodes.new(type="ShaderNodeOutputMaterial")
    output.location = (520, 0)
    emission = nodes.new(type="ShaderNodeEmission")
    emission.location = (260, 0)
    texture = nodes.new(type="ShaderNodeTexImage")
    texture.location = (0, 0)
    texture.image = bpy.data.images.load(str(source_image))

    bake_node = nodes.new(type="ShaderNodeTexImage")
    bake_node.location = (0, -250)
    bake_node.image = baked_image
    bake_node.select = True
    nodes.active = bake_node

    links.new(texture.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    material.blend_method = "OPAQUE"

    mesh_object.data.materials.clear()
    mesh_object.data.materials.append(material)
    return material


def create_export_material(mesh_object: bpy.types.Object, texture_path: Path) -> bpy.types.Material:
    material = bpy.data.materials.new(name="SourceTextureMaterial")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links

    for node in list(nodes):
        nodes.remove(node)

    output = nodes.new(type="ShaderNodeOutputMaterial")
    output.location = (520, 0)
    principled = nodes.new(type="ShaderNodeBsdfPrincipled")
    principled.location = (260, 0)
    texture = nodes.new(type="ShaderNodeTexImage")
    texture.location = (0, 0)
    texture.image = bpy.data.images.load(str(texture_path))

    links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    links.new(principled.outputs["BSDF"], output.inputs["Surface"])
    material.blend_method = "OPAQUE"

    mesh_object.data.materials.clear()
    mesh_object.data.materials.append(material)
    return material


def set_render_settings() -> None:
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.render.resolution_x = 1024
    scene.render.resolution_y = 1024


def bake_texture(mesh_object: bpy.types.Object, baked_image: bpy.types.Image, bake_resolution: int) -> bool:
    bpy.ops.object.select_all(action="DESELECT")
    mesh_object.select_set(True)
    bpy.context.view_layer.objects.active = mesh_object
    bpy.context.scene.render.engine = "CYCLES"
    bpy.context.scene.cycles.samples = 1
    bpy.context.scene.cycles.preview_samples = 1
    baked_image.scale(bake_resolution, bake_resolution)

    try:
        bpy.ops.object.bake(type="EMIT", margin=8)
        return True
    except Exception:
        return False


def export_glb(output_glb: Path) -> None:
    output_glb.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(output_glb), export_format="GLB")


def write_report(report_path: Path, report: dict) -> None:
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    mesh_path = path_or_fail(args.mesh, "Mesh")
    source_image_path = path_or_fail(args.source_image, "Source image")
    output_glb = Path(args.output_glb).resolve()
    output_texture = Path(args.output_texture).resolve()
    output_report = Path(args.output_report).resolve()

    clear_scene()

    imported_objects = import_model(mesh_path)
    mesh_object = join_meshes(imported_objects)
    root = center_and_normalize([mesh_object])
    uv_mode = ensure_uvs(mesh_object)
    set_render_settings()

    baked_image = bpy.data.images.new("HunyuanBakedTexture", width=max(1, int(args.bake_resolution)), height=max(1, int(args.bake_resolution)))
    baked_image.file_format = "PNG"
    create_bake_material(mesh_object, source_image_path, baked_image)

    baked = bake_texture(mesh_object, baked_image, max(1, int(args.bake_resolution)))
    if baked:
        baked_image.filepath_raw = str(output_texture)
        baked_image.file_format = "PNG"
        baked_image.save()
    else:
        shutil.copyfile(source_image_path, output_texture)

    create_export_material(mesh_object, output_texture)

    export_glb(output_glb)

    report = {
        "meshPath": str(mesh_path),
        "sourceImage": str(source_image_path),
        "outputGlb": str(output_glb),
        "outputTexture": str(output_texture),
        "projectionMode": args.projection_mode,
        "uvMode": uv_mode,
        "baked": baked,
        "meshObjectCount": len(imported_objects),
        "activeRoot": root.name
    }
    write_report(output_report, report)
    print(f"Textured GLB written: {output_glb}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001
        print(f"Texture projection failed: {exc}", file=sys.stderr)
        raise
