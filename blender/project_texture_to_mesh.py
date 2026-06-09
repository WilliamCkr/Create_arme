#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path

import bpy


def parse_args():
    argv = sys.argv
    if "--" in argv:
        argv = argv[argv.index("--") + 1 :]
    else:
        argv = []

    parser = argparse.ArgumentParser(description="Project a source texture onto a mesh and export a textured GLB.")
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--source-image", required=True)
    parser.add_argument("--output-glb", required=True)
    parser.add_argument("--output-texture", required=True)
    parser.add_argument("--output-report", required=True)
    parser.add_argument("--bake-resolution", type=int, default=2048)
    parser.add_argument("--projection-mode", default="smart_uv")
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for data_block_collection in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.textures,
        bpy.data.cameras,
        bpy.data.lights,
    ):
        for block in list(data_block_collection):
            if block.users == 0:
                data_block_collection.remove(block)


def import_mesh(mesh_path: Path):
    suffix = mesh_path.suffix.lower()
    if suffix in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=str(mesh_path))
    else:
        raise RuntimeError(f"Unsupported mesh format: {mesh_path}")

    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not mesh_objects:
        raise RuntimeError("No mesh objects were imported from the GLB.")
    return mesh_objects


def apply_object_transforms(mesh_objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)


def compute_world_bounds(mesh_objects):
    mins = [float("inf"), float("inf"), float("inf")]
    maxs = [float("-inf"), float("-inf"), float("-inf")]

    for obj in mesh_objects:
        for vertex in obj.data.vertices:
            co = obj.matrix_world @ vertex.co
            for i in range(3):
                mins[i] = min(mins[i], co[i])
                maxs[i] = max(maxs[i], co[i])

    extents = [maxs[i] - mins[i] for i in range(3)]
    axis_order = sorted(range(3), key=lambda i: extents[i], reverse=True)
    v_axis = axis_order[0]  # longest axis -> vertical
    u_axis = axis_order[1]  # second longest -> horizontal
    depth_axis = axis_order[2]

    return {
        "mins": mins,
        "maxs": maxs,
        "extents": extents,
        "u_axis": u_axis,
        "v_axis": v_axis,
        "depth_axis": depth_axis,
    }


def clean_source_image(source_path: Path):
    src = bpy.data.images.load(str(source_path), check_existing=False)
    src.colorspace_settings.name = "sRGB"

    width, height = src.size[0], src.size[1]
    src_pixels = list(src.pixels[:])

    has_useful_alpha = False
    for i in range(3, len(src_pixels), 4):
        if src_pixels[i] < 0.999:
            has_useful_alpha = True
            break

    clean_pixels = [0.0] * len(src_pixels)
    removed_background_pixels = 0

    for i in range(0, len(src_pixels), 4):
        r = src_pixels[i + 0]
        g = src_pixels[i + 1]
        b = src_pixels[i + 2]
        a = src_pixels[i + 3]

        if has_useful_alpha:
            alpha = a
        else:
            brightness = (r + g + b) / 3.0
            near_white = min(r, g, b) > 0.94 and brightness > 0.96
            alpha = 0.0 if near_white else 1.0
            if near_white:
                removed_background_pixels += 1

        if alpha <= 0.001:
            clean_pixels[i + 0] = 0.0
            clean_pixels[i + 1] = 0.0
            clean_pixels[i + 2] = 0.0
            clean_pixels[i + 3] = 0.0
        else:
            clean_pixels[i + 0] = r
            clean_pixels[i + 1] = g
            clean_pixels[i + 2] = b
            clean_pixels[i + 3] = alpha

    out_img = bpy.data.images.new(
        name="HunyuanProjectedTexture",
        width=width,
        height=height,
        alpha=True,
    )
    out_img.alpha_mode = "STRAIGHT"
    out_img.colorspace_settings.name = "sRGB"
    out_img.pixels[:] = clean_pixels
    out_img.filepath_raw = str(source_path.parent / "__temp_clean_projection_texture.png")
    out_img.file_format = "PNG"
    out_img.save()

    return {
        "image": out_img,
        "width": width,
        "height": height,
        "has_useful_alpha": has_useful_alpha,
        "removed_background_pixels": removed_background_pixels,
    }


def create_planar_uvs(mesh_objects, bounds_info, uv_name="ProjectedUV"):
    u_axis = bounds_info["u_axis"]
    v_axis = bounds_info["v_axis"]
    mins = bounds_info["mins"]
    maxs = bounds_info["maxs"]

    u_min = mins[u_axis]
    u_max = maxs[u_axis]
    v_min = mins[v_axis]
    v_max = maxs[v_axis]

    u_size = max(u_max - u_min, 1e-6)
    v_size = max(v_max - v_min, 1e-6)

    for obj in mesh_objects:
        mesh = obj.data
        uv_layer = mesh.uv_layers.get(uv_name)
        if uv_layer is None:
            uv_layer = mesh.uv_layers.new(name=uv_name)
        mesh.uv_layers.active = uv_layer

        for poly in mesh.polygons:
            for loop_index in poly.loop_indices:
                vertex_index = mesh.loops[loop_index].vertex_index
                co = obj.matrix_world @ mesh.vertices[vertex_index].co
                u = (co[u_axis] - u_min) / u_size
                v = (co[v_axis] - v_min) / v_size
                uv_layer.data[loop_index].uv = (u, v)

    return uv_name


def build_material(texture_image, uv_name):
    material = bpy.data.materials.new(name="ProjectedTextureMaterial")
    material.use_nodes = True
    material.blend_method = "OPAQUE"
    if hasattr(material, "shadow_method"):
        material.shadow_method = "OPAQUE"

    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()

    out = nodes.new(type="ShaderNodeOutputMaterial")
    out.location = (700, 0)

    bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
    bsdf.location = (420, 0)
    bsdf.inputs["Metallic"].default_value = 0.10
    bsdf.inputs["Roughness"].default_value = 0.60

    tex = nodes.new(type="ShaderNodeTexImage")
    tex.location = (-420, 40)
    tex.image = texture_image
    tex.interpolation = "Linear"

    uv = nodes.new(type="ShaderNodeUVMap")
    uv.location = (-650, 40)
    uv.uv_map = uv_name

    mix = nodes.new(type="ShaderNodeMixRGB")
    mix.location = (120, 80)
    mix.blend_type = "MIX"
    mix.inputs["Color1"].default_value = (0.07, 0.07, 0.08, 1.0)  # dark fallback, not white

    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Alpha"], mix.inputs["Fac"])
    links.new(tex.outputs["Color"], mix.inputs["Color2"])
    links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    return material


def assign_material(mesh_objects, material):
    for obj in mesh_objects:
        mesh = obj.data
        mesh.materials.clear()
        mesh.materials.append(material)


def save_output_texture(clean_image, output_texture: Path):
    output_texture.parent.mkdir(parents=True, exist_ok=True)
    clean_image.filepath_raw = str(output_texture)
    clean_image.file_format = "PNG"
    clean_image.save()


def export_glb(output_glb: Path):
    output_glb.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(output_glb),
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )


def write_report(output_report: Path, report_data: dict):
    output_report.parent.mkdir(parents=True, exist_ok=True)
    output_report.write_text(json.dumps(report_data, indent=2), encoding="utf-8")


def main():
    args = parse_args()

    mesh_path = Path(args.mesh).resolve()
    source_image_path = Path(args.source_image).resolve()
    output_glb = Path(args.output_glb).resolve()
    output_texture = Path(args.output_texture).resolve()
    output_report = Path(args.output_report).resolve()

    clear_scene()

    mesh_objects = import_mesh(mesh_path)
    apply_object_transforms(mesh_objects)
    bounds_info = compute_world_bounds(mesh_objects)

    cleaned = clean_source_image(source_image_path)
    uv_name = create_planar_uvs(mesh_objects, bounds_info, uv_name="ProjectedUV")
    material = build_material(cleaned["image"], uv_name)
    assign_material(mesh_objects, material)

    save_output_texture(cleaned["image"], output_texture)
    export_glb(output_glb)

    axis_names = ["X", "Y", "Z"]
    report = {
        "mesh": str(mesh_path),
        "sourceImage": str(source_image_path),
        "outputGlb": str(output_glb),
        "outputTexture": str(output_texture),
        "projectionModeRequested": args.projection_mode,
        "projectionModeEffective": "planar_bbox_projection",
        "uvMap": uv_name,
        "uAxis": axis_names[bounds_info["u_axis"]],
        "vAxis": axis_names[bounds_info["v_axis"]],
        "depthAxis": axis_names[bounds_info["depth_axis"]],
        "extents": {
            axis_names[i]: bounds_info["extents"][i] for i in range(3)
        },
        "sourceHadUsefulAlpha": cleaned["has_useful_alpha"],
        "removedBackgroundPixels": cleaned["removed_background_pixels"],
        "fallbackBaseColor": [0.07, 0.07, 0.08],
    }
    write_report(output_report, report)

    print(f"Textured GLB written: {output_glb}")
    print(f"Baked texture written: {output_texture}")
    print(f"Report written: {output_report}")


if __name__ == "__main__":
    main()
