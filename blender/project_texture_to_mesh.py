#!/usr/bin/env python3
import argparse
import json
import math
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []

    parser = argparse.ArgumentParser()
    parser.add_argument("--mesh", required=True)
    parser.add_argument("--source-image", required=True)
    parser.add_argument("--output-glb", required=True)
    parser.add_argument("--output-texture", required=True)
    parser.add_argument("--output-report", required=True)
    parser.add_argument("--bake-resolution", type=int, default=2048)
    parser.add_argument("--projection-mode", default="algorithmic_base_then_source_overlay")
    return parser.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_mesh(path):
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError("No mesh imported")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)

    bpy.context.view_layer.objects.active = meshes[0]

    if len(meshes) > 1:
        bpy.ops.object.join()

    obj = bpy.context.view_layer.objects.active
    obj.name = "AOF_WeaponMesh"

    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


def compute_bounds(obj):
    mins = [float("inf"), float("inf"), float("inf")]
    maxs = [float("-inf"), float("-inf"), float("-inf")]

    for v in obj.data.vertices:
        co = obj.matrix_world @ v.co
        for i in range(3):
            mins[i] = min(mins[i], co[i])
            maxs[i] = max(maxs[i], co[i])

    extents = [maxs[i] - mins[i] for i in range(3)]
    order = sorted(range(3), key=lambda i: extents[i], reverse=True)

    return {
        "mins": mins,
        "maxs": maxs,
        "extents": extents,
        "v_axis": order[0],
        "u_axis": order[1],
        "depth_axis": order[2],
    }


def create_planar_uv(obj, uv_name, bounds):
    mesh = obj.data
    uv = mesh.uv_layers.get(uv_name)
    if uv is None:
        uv = mesh.uv_layers.new(name=uv_name)

    mesh.uv_layers.active = uv
    uv.active_render = True

    u_axis = bounds["u_axis"]
    v_axis = bounds["v_axis"]

    u_min = bounds["mins"][u_axis]
    v_min = bounds["mins"][v_axis]

    u_size = max(bounds["maxs"][u_axis] - u_min, 1e-6)
    v_size = max(bounds["maxs"][v_axis] - v_min, 1e-6)

    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            co = obj.matrix_world @ mesh.vertices[vi].co

            u = (co[u_axis] - u_min) / u_size
            v = (co[v_axis] - v_min) / v_size

            uv.data[li].uv = (u, v)

    return uv_name


def clean_source_to_alpha(source_path, output_path):
    src = bpy.data.images.load(str(source_path), check_existing=False)
    src.colorspace_settings.name = "sRGB"

    width, height = src.size
    pixels = list(src.pixels[:])
    out = [0.0] * len(pixels)

    removed_white = 0
    kept = 0

    for i in range(0, len(pixels), 4):
        r, g, b, a = pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]

        mn = min(r, g, b)
        mx = max(r, g, b)
        spread = mx - mn

        # Remove white / near-white background only.
        # Never reject dark pixels, because the sword itself is dark.
        if a <= 0.001:
            alpha = 0.0
        elif mn > 0.965 and spread < 0.060:
            alpha = 0.0
            removed_white += 1
        elif mn > 0.920 and spread < 0.090:
            alpha = max(0.0, min(1.0, (0.980 - mn) / 0.060)) * a
            if alpha < 0.05:
                removed_white += 1
        else:
            alpha = a
            kept += 1

        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        out[i + 3] = alpha

    img = bpy.data.images.new("AOF_CleanSourceAlpha", width=width, height=height, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = "STRAIGHT"
    img.pixels[:] = out
    img.filepath_raw = str(output_path)
    img.file_format = "PNG"
    img.save()

    return img, {
        "width": width,
        "height": height,
        "removedWhitePixels": removed_white,
        "keptPixelsApprox": kept,
    }


def sample_colors(source_img):
    pixels = list(source_img.pixels[:])
    dark = []
    purple = []

    for i in range(0, len(pixels), 4):
        r, g, b, a = pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3]
        if a < 0.20:
            continue

        lum = r * 0.2126 + g * 0.7152 + b * 0.0722

        if lum < 0.35:
            dark.append((r, g, b))

        if b > g * 1.10 and r > g * 1.05:
            purple.append((r, g, b))

    def avg(items, fallback):
        if not items:
            return fallback
        n = len(items)
        return (
            sum(c[0] for c in items) / n,
            sum(c[1] for c in items) / n,
            sum(c[2] for c in items) / n,
        )

    return {
        "dark": avg(dark, (0.065, 0.065, 0.080)),
        "purple": avg(purple, (0.42, 0.12, 0.72)),
    }


def create_algorithmic_base(source_img, output_path, resolution):
    colors = sample_colors(source_img)
    dark = colors["dark"]
    purple = colors["purple"]

    width = resolution
    height = resolution

    img = bpy.data.images.new("AOF_AlgorithmicBase", width=width, height=height, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = "STRAIGHT"

    pixels = [0.0] * (width * height * 4)

    for y in range(height):
        v = y / max(height - 1, 1)

        for x in range(width):
            u = x / max(width - 1, 1)

            noise = (
                math.sin((u * 91.7 + v * 34.1) * 12.9898) +
                math.sin((u * 18.3 - v * 77.9) * 78.233) * 0.45 +
                math.sin((u * 143.2 + v * 13.7) * 37.719) * 0.25
            ) / 1.70
            noise = noise * 0.5 + 0.5

            brushed = abs(math.sin((v * 105.0 + u * 4.0) * math.pi))
            crack_a = abs(math.sin((u * 31.0 + v * 5.0 + math.sin(v * 20.0) * 0.25) * math.pi))
            crack_b = abs(math.sin((u * 11.0 - v * 24.0 + math.sin(u * 26.0) * 0.20) * math.pi))

            metal = 0.75 + noise * 0.35
            if brushed > 0.94:
                metal += 0.30

            r = dark[0] * metal
            g = dark[1] * metal
            b = dark[2] * metal

            crack = 0.0
            if crack_a < 0.035:
                crack = max(crack, 1.0 - crack_a / 0.035)
            if crack_b < 0.026:
                crack = max(crack, 1.0 - crack_b / 0.026)

            crack = crack ** 1.8

            if crack > 0.0:
                r = max(r, purple[0] * (0.45 + crack * 0.75))
                g = max(g, purple[1] * (0.35 + crack * 0.55))
                b = max(b, purple[2] * (0.55 + crack * 0.85))

            idx = (y * width + x) * 4
            pixels[idx] = max(0.0, min(r, 1.0))
            pixels[idx + 1] = max(0.0, min(g, 1.0))
            pixels[idx + 2] = max(0.0, min(b, 1.0))
            pixels[idx + 3] = 1.0

    img.pixels[:] = pixels
    img.filepath_raw = str(output_path)
    img.file_format = "PNG"
    img.save()

    return img


def build_material_for_bake(uv_name, base_img, source_img):
    mat = bpy.data.materials.new("AOF_BaseThenSourceOverlay")
    mat.use_nodes = True

    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (800, 0)

    emission = nodes.new("ShaderNodeEmission")
    emission.location = (600, 0)
    emission.inputs["Strength"].default_value = 1.0

    mix = nodes.new("ShaderNodeMixRGB")
    mix.location = (380, 0)
    mix.blend_type = "MIX"

    uv = nodes.new("ShaderNodeUVMap")
    uv.location = (-500, 0)
    uv.uv_map = uv_name

    base_tex = nodes.new("ShaderNodeTexImage")
    base_tex.location = (-250, 140)
    base_tex.image = base_img
    base_tex.interpolation = "Cubic"

    source_tex = nodes.new("ShaderNodeTexImage")
    source_tex.location = (-250, -120)
    source_tex.image = source_img
    source_tex.interpolation = "Cubic"

    links.new(uv.outputs["UV"], base_tex.inputs["Vector"])
    links.new(uv.outputs["UV"], source_tex.inputs["Vector"])

    links.new(base_tex.outputs["Color"], mix.inputs["Color1"])
    links.new(source_tex.outputs["Color"], mix.inputs["Color2"])
    links.new(source_tex.outputs["Alpha"], mix.inputs["Fac"])

    links.new(mix.outputs["Color"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], out.inputs["Surface"])

    return mat


def assign_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def bake_emission(obj, uv_name, output_path, resolution):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 1
    scene.render.bake.use_clear = True
    scene.render.bake.margin = 24

    obj.data.uv_layers[uv_name].active_render = True

    baked = bpy.data.images.new("AOF_FinalBakedTexture", width=resolution, height=resolution, alpha=True)
    baked.colorspace_settings.name = "sRGB"
    baked.alpha_mode = "STRAIGHT"

    mat = obj.active_material
    nodes = mat.node_tree.nodes
    bake_node = nodes.new("ShaderNodeTexImage")
    bake_node.image = baked
    nodes.active = bake_node

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    bpy.ops.object.bake(type="EMIT")

    baked.filepath_raw = str(output_path)
    baked.file_format = "PNG"
    baked.save()

    return baked


def build_export_material(uv_name, baked_img):
    mat = bpy.data.materials.new("AOF_ExportFinalTexture")
    mat.use_nodes = True

    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (500, 0)

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (260, 0)

    uv = nodes.new("ShaderNodeUVMap")
    uv.location = (-260, 0)
    uv.uv_map = uv_name

    tex = nodes.new("ShaderNodeTexImage")
    tex.location = (0, 0)
    tex.image = baked_img
    tex.interpolation = "Cubic"

    bsdf.inputs["Metallic"].default_value = 0.18
    bsdf.inputs["Roughness"].default_value = 0.54

    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    return mat


def export_glb(obj, output_path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
    )


def main():
    args = parse_args()

    mesh_path = os.path.abspath(args.mesh)
    source_path = os.path.abspath(args.source_image)
    output_glb = os.path.abspath(args.output_glb)
    output_texture = os.path.abspath(args.output_texture)
    output_report = os.path.abspath(args.output_report)

    output_dir = os.path.dirname(output_glb)
    os.makedirs(output_dir, exist_ok=True)

    clean_source_path = os.path.join(output_dir, "clean-source-alpha.png")
    algorithmic_base_path = os.path.join(output_dir, "algorithmic-base.png")

    clear_scene()

    obj = import_mesh(mesh_path)
    bounds = compute_bounds(obj)

    uv_name = create_planar_uv(obj, "AOF_ProjectUV", bounds)

    clean_source, source_stats = clean_source_to_alpha(source_path, clean_source_path)

    algorithmic_base = create_algorithmic_base(
        source_img=clean_source,
        output_path=algorithmic_base_path,
        resolution=args.bake_resolution,
    )

    bake_material = build_material_for_bake(
        uv_name=uv_name,
        base_img=algorithmic_base,
        source_img=clean_source,
    )

    assign_material(obj, bake_material)

    baked = bake_emission(
        obj=obj,
        uv_name=uv_name,
        output_path=output_texture,
        resolution=args.bake_resolution,
    )

    export_material = build_export_material(
        uv_name=uv_name,
        baked_img=baked,
    )

    assign_material(obj, export_material)

    export_glb(obj, output_glb)

    report = {
        "mesh": mesh_path,
        "sourceImage": source_path,
        "outputGlb": output_glb,
        "outputTexture": output_texture,
        "cleanSource": clean_source_path,
        "algorithmicBase": algorithmic_base_path,
        "projectionMode": args.projection_mode,
        "uvName": uv_name,
        "bounds": bounds,
        "sourceStats": source_stats,
        "bakeResolution": args.bake_resolution,
        "important": "Algorithmic base is applied first. Clean source alpha is overlaid last using the same planar UV mapping.",
    }

    with open(output_report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("Textured GLB written:", output_glb)
    print("Baked texture written:", output_texture)
    print("Clean source written:", clean_source_path)
    print("Algorithmic base written:", algorithmic_base_path)
    print("Report written:", output_report)


if __name__ == "__main__":
    main()
