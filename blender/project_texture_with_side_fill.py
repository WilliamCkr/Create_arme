#!/usr/bin/env python3
import argparse
import json
import math
import os
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args():
    argv = []
    if "--" in os.sys.argv:
        argv = os.sys.argv[os.sys.argv.index("--") + 1:]

    p = argparse.ArgumentParser()
    p.add_argument("--mesh", required=True)
    p.add_argument("--source-image", required=True)
    p.add_argument("--locked-source-texture", default="")
    p.add_argument("--output-glb", required=True)
    p.add_argument("--output-texture", required=True)
    p.add_argument("--side-texture", required=True)
    p.add_argument("--output-report", required=True)

    p.add_argument("--source-face-threshold", type=float, default=0.30)
    p.add_argument("--source-face-sign", type=int, default=1, choices=[-1, 1])
    p.add_argument("--use-source-both-faces", type=int, default=1, choices=[0, 1])

    p.add_argument("--source-flip-u", type=int, default=0, choices=[0, 1])
    p.add_argument("--source-flip-v", type=int, default=0, choices=[0, 1])
    p.add_argument("--source-swap-uv", type=int, default=0, choices=[0, 1])

    # Kept for UI compatibility, but ignored in source-lock mode.
    p.add_argument("--source-alpha-soft-start", type=float, default=0.02)
    p.add_argument("--source-alpha-soft-end", type=float, default=0.22)
    p.add_argument("--white-hard-clip", type=float, default=0.965)
    p.add_argument("--white-soft-clip", type=float, default=0.920)
    p.add_argument("--white-hard-spread", type=float, default=0.060)
    p.add_argument("--white-soft-spread", type=float, default=0.090)

    p.add_argument("--side-base", type=float, default=0.115)
    p.add_argument("--side-noise", type=float, default=0.115)
    p.add_argument("--side-highlight", type=float, default=0.120)
    p.add_argument("--side-crack", type=float, default=0.180)
    p.add_argument("--side-purple", type=float, default=0.220)
    p.add_argument("--side-edge-darkness", type=float, default=0.200)
    p.add_argument("--side-width", type=int, default=1024)
    p.add_argument("--side-height", type=int, default=2048)

    return p.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)


def import_mesh(path):
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh imported from {path}")

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
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    mins = [min(c[i] for c in corners) for i in range(3)]
    maxs = [max(c[i] for c in corners) for i in range(3)]
    size = [maxs[i] - mins[i] for i in range(3)]

    depth_axis = min(range(3), key=lambda i: size[i])
    axes = [0, 1, 2]
    axes.remove(depth_axis)

    return {
        "min": mins,
        "max": maxs,
        "size": size,
        "depthAxis": depth_axis,
        "uAxis": axes[0],
        "vAxis": axes[1],
    }


def create_projected_uv(obj, uv_name, bounds, flip_u=False, flip_v=False, swap_uv=False):
    mesh = obj.data
    layer = mesh.uv_layers.get(uv_name) or mesh.uv_layers.new(name=uv_name)
    mesh.uv_layers.active = layer

    u_axis = bounds["uAxis"]
    v_axis = bounds["vAxis"]

    u_min = bounds["min"][u_axis]
    u_size = max(bounds["size"][u_axis], 1e-6)
    v_min = bounds["min"][v_axis]
    v_size = max(bounds["size"][v_axis], 1e-6)

    for poly in mesh.polygons:
        for loop_index in poly.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index
            co = obj.matrix_world @ mesh.vertices[vertex_index].co

            u = (co[u_axis] - u_min) / u_size
            v = (co[v_axis] - v_min) / v_size

            if swap_uv:
                u, v = v, u
            if flip_u:
                u = 1.0 - u
            if flip_v:
                v = 1.0 - v

            layer.data[loop_index].uv = (u, v)

    return uv_name


def create_side_uv(obj, uv_name):
    mesh = obj.data
    layer = mesh.uv_layers.get(uv_name) or mesh.uv_layers.new(name=uv_name)
    mesh.uv_layers.active = layer

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=66.0, island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")

    return uv_name


def load_locked_source_texture(args):
    candidates = []

    if args.locked_source_texture:
        candidates.append(Path(args.locked_source_texture))

    candidates.append(Path("output/hunyuan_cursed_sword/source-lock.png"))
    candidates.append(Path(args.source_image))

    for p in candidates:
        rp = p.resolve()
        if rp.exists():
            img = bpy.data.images.load(str(rp), check_existing=False)
            img.colorspace_settings.name = "sRGB"
            img.alpha_mode = "STRAIGHT"
            return img, str(rp)

    raise FileNotFoundError("No source texture found.")


def create_source_over_algorithm_texture(source_image, output_path, args):
    width = int(source_image.size[0])
    height = int(source_image.size[1])

    src_pixels = list(source_image.pixels[:])
    out = [0.0] * (width * height * 4)

    def algorithm_pixel(u, v):
        noise = (
            math.sin((u * 83.0 + v * 37.0) * 12.9898)
            + math.sin((u * 19.0 - v * 71.0) * 78.233) * 0.50
            + math.sin((u * 147.0 + v * 13.0) * 37.719) * 0.25
        ) / 1.75
        noise = noise * 0.5 + 0.5

        vertical = abs(math.sin((v * 95.0 + u * 6.0) * math.pi))
        crack_a = abs(math.sin((u * 17.0 + v * 11.0 + math.sin(v * 22.0) * 0.25) * math.pi))
        crack_b = abs(math.sin((u * 37.0 - v * 4.0 + math.sin(u * 16.0) * 0.25) * math.pi))

        base = args.side_base + noise * args.side_noise

        r = base * 0.95
        g = base * 0.90
        b = base * 1.04

        if vertical > 0.94:
            r += args.side_highlight
            g += args.side_highlight
            b += args.side_highlight * 1.15

        crack = 0.0
        if crack_a < 0.035:
            crack = max(crack, 1.0 - crack_a / 0.035)
        if crack_b < 0.026:
            crack = max(crack, 1.0 - crack_b / 0.026)

        if crack > 0.0:
            r = max(r, 0.16 + crack * args.side_crack)
            g = max(g, 0.06 + crack * args.side_crack * 0.40)
            b = max(b, 0.20 + crack * (args.side_crack + args.side_purple))

        edge = min(u, v, 1.0 - u, 1.0 - v)
        if edge < 0.04:
            dark = 1.0 - args.side_edge_darkness * (1.0 - edge / 0.04)
            r *= dark
            g *= dark
            b *= dark

        return (
            max(0.0, min(r, 1.0)),
            max(0.0, min(g, 1.0)),
            max(0.0, min(b, 1.0)),
        )

    source_kept_pixels = 0
    algorithm_pixels = 0
    mixed_pixels = 0

    for y in range(height):
        v = y / max(1, height - 1)

        for x in range(width):
            u = x / max(1, width - 1)
            n = y * width + x
            i = n * 4

            sr = src_pixels[i]
            sg = src_pixels[i + 1]
            sb = src_pixels[i + 2]
            sa = src_pixels[i + 3]

            ar, ag, ab = algorithm_pixel(u, v)

            # Source lock rule:
            # alpha >= 0.999 -> source RGB copied exactly.
            # alpha <= 0.001 -> algorithm only.
            # between -> normal alpha composite.
            if sa >= 0.999:
                r, g, b = sr, sg, sb
                source_kept_pixels += 1
            elif sa <= 0.001:
                r, g, b = ar, ag, ab
                algorithm_pixels += 1
            else:
                r = sr * sa + ar * (1.0 - sa)
                g = sg * sa + ag * (1.0 - sa)
                b = sb * sa + ab * (1.0 - sa)
                mixed_pixels += 1

            out[i] = r
            out[i + 1] = g
            out[i + 2] = b
            out[i + 3] = 1.0

    img = bpy.data.images.new(
        "AOF_ExportableSourceOverAlgorithm",
        width=width,
        height=height,
        alpha=True,
    )
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = "STRAIGHT"
    img.pixels[:] = out
    img.filepath_raw = str(Path(output_path).resolve())
    img.file_format = "PNG"
    img.save()

    stats = {
        "width": width,
        "height": height,
        "sourceKeptPixels": source_kept_pixels,
        "algorithmOnlyPixels": algorithm_pixels,
        "mixedPixels": mixed_pixels,
        "sourceLocked": True,
        "exportableComposite": True,
    }

    return img, stats

def create_side_fill_texture(width, height, output_path, args):
    img = bpy.data.images.new("AOF_SideFillTextureLockedSource", width=width, height=height, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = "STRAIGHT"

    pixels = [0.0] * (width * height * 4)

    for y in range(height):
        v = y / max(1, height - 1)

        for x in range(width):
            u = x / max(1, width - 1)

            noise = (
                math.sin((u * 83.0 + v * 37.0) * 12.9898)
                + math.sin((u * 19.0 - v * 71.0) * 78.233) * 0.50
                + math.sin((u * 147.0 + v * 13.0) * 37.719) * 0.25
            ) / 1.75
            noise = noise * 0.5 + 0.5

            vertical = abs(math.sin((v * 95.0 + u * 6.0) * math.pi))
            crack_a = abs(math.sin((u * 17.0 + v * 11.0 + math.sin(v * 22.0) * 0.25) * math.pi))
            crack_b = abs(math.sin((u * 37.0 - v * 4.0 + math.sin(u * 16.0) * 0.25) * math.pi))

            base = args.side_base + noise * args.side_noise

            r = base * 0.95
            g = base * 0.90
            b = base * 1.04

            if vertical > 0.94:
                r += args.side_highlight
                g += args.side_highlight
                b += args.side_highlight * 1.15

            crack = 0.0
            if crack_a < 0.035:
                crack = max(crack, 1.0 - crack_a / 0.035)
            if crack_b < 0.026:
                crack = max(crack, 1.0 - crack_b / 0.026)

            if crack > 0.0:
                r = max(r, 0.16 + crack * args.side_crack)
                g = max(g, 0.06 + crack * args.side_crack * 0.40)
                b = max(b, 0.20 + crack * (args.side_crack + args.side_purple))

            edge = min(u, v, 1.0 - u, 1.0 - v)
            if edge < 0.04:
                dark = 1.0 - args.side_edge_darkness * (1.0 - edge / 0.04)
                r *= dark
                g *= dark
                b *= dark

            idx = (y * width + x) * 4
            pixels[idx] = max(0.0, min(r, 1.0))
            pixels[idx + 1] = max(0.0, min(g, 1.0))
            pixels[idx + 2] = max(0.0, min(b, 1.0))
            pixels[idx + 3] = 1.0

    img.pixels[:] = pixels
    img.filepath_raw = str(Path(output_path).resolve())
    img.file_format = "PNG"
    img.save()

    return img


def build_source_material(source_composite_image, source_uv):
    mat = bpy.data.materials.new(name="AOF_EXPORTABLE_SourceComposite")
    mat.use_nodes = True

    if hasattr(mat, "blend_method"):
        mat.blend_method = "OPAQUE"
    if hasattr(mat, "shadow_method"):
        mat.shadow_method = "OPAQUE"

    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (500, 0)

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (260, 0)

    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.60
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.12
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.38
    elif "Specular" in bsdf.inputs:
        bsdf.inputs["Specular"].default_value = 0.38

    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = source_uv
    uv.location = (-500, 0)

    tex = nodes.new("ShaderNodeTexImage")
    tex.image = source_composite_image
    tex.location = (-240, 0)
    tex.interpolation = "Linear"
    tex.extension = "CLIP"

    # glTF-safe simple material:
    # Image Texture -> Principled Base Color.
    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    return mat


def build_side_material(side_image, side_uv):
    mat = bpy.data.materials.new(name="AOF_SideFillOnly")
    mat.use_nodes = True

    if hasattr(mat, "blend_method"):
        mat.blend_method = "OPAQUE"
    if hasattr(mat, "shadow_method"):
        mat.shadow_method = "OPAQUE"

    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links
    nodes.clear()

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (500, 0)

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (260, 0)
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.75
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = 0.10

    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = side_uv
    uv.location = (-500, 0)

    tex = nodes.new("ShaderNodeTexImage")
    tex.image = side_image
    tex.location = (-260, 0)
    tex.interpolation = "Cubic"
    tex.extension = "REPEAT"

    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    return mat


def assign_materials_by_normal(obj, source_mat, side_mat, bounds, threshold, use_source_both_faces, source_face_sign):
    mesh = obj.data
    mesh.materials.clear()
    mesh.materials.append(source_mat)
    mesh.materials.append(side_mat)

    depth_axis = bounds["depthAxis"]

    source_faces = 0
    side_faces = 0

    for poly in mesh.polygons:
        n = poly.normal.normalized()
        align = n[depth_axis]

        if use_source_both_faces:
            use_source = abs(align) >= threshold
        else:
            use_source = (align * source_face_sign) >= threshold

        poly.material_index = 0 if use_source else 1

        if use_source:
            source_faces += 1
        else:
            side_faces += 1

    return {
        "sourceFaces": source_faces,
        "sideFillFaces": side_faces,
        "threshold": threshold,
        "depthAxis": depth_axis,
        "useSourceBothFaces": bool(use_source_both_faces),
        "sourceFaceSign": source_face_sign,
    }


def export_glb(obj, output_path):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj

    bpy.ops.export_scene.gltf(
        filepath=str(Path(output_path).resolve()),
        export_format="GLB",
        use_selection=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )


def main():
    args = parse_args()

    output_dir = Path(args.output_glb).resolve().parent
    output_dir.mkdir(parents=True, exist_ok=True)

    clear_scene()

    obj = import_mesh(Path(args.mesh).resolve())
    bounds = compute_bounds(obj)

    source_uv = create_projected_uv(
        obj,
        "ProjectedUV",
        bounds,
        flip_u=bool(args.source_flip_u),
        flip_v=bool(args.source_flip_v),
        swap_uv=bool(args.source_swap_uv),
    )
    side_uv = create_side_uv(obj, "SideUV")

    source_image, locked_source_path = load_locked_source_texture(args)

    side_image = create_side_fill_texture(
        width=args.side_width,
        height=args.side_height,
        output_path=args.side_texture,
        args=args,
    )

    source_composite_image, source_composite_stats = create_source_over_algorithm_texture(
        source_image=source_image,
        output_path=args.output_texture,
        args=args,
    )

    source_mat = build_source_material(source_composite_image, source_uv)
    side_mat = build_side_material(side_image, side_uv)

    material_stats = assign_materials_by_normal(
        obj=obj,
        source_mat=source_mat,
        side_mat=side_mat,
        bounds=bounds,
        threshold=args.source_face_threshold,
        use_source_both_faces=bool(args.use_source_both_faces),
        source_face_sign=args.source_face_sign,
    )

    export_glb(obj, args.output_glb)

    report = {
        "mesh": str(Path(args.mesh).resolve()),
        "sourceImageArg": str(Path(args.source_image).resolve()),
        "lockedSourceTexture": locked_source_path,
        "outputGlb": str(Path(args.output_glb).resolve()),
        "outputTexture": str(Path(args.output_texture).resolve()),
        "sideTexture": str(Path(args.side_texture).resolve()),
        "uvNameSource": source_uv,
        "uvNameSide": side_uv,
        "bounds": bounds,
        "sourceStats": {
            "sourceLocked": True,
            "whiteControlsIgnored": True,
            "alphaControlsIgnored": True,
            "message": "The visible source texture is loaded from source-lock.png and copied exactly where alpha is opaque. Transparent zones are filled by algorithm before GLB export.",
            "composite": source_composite_stats,
        },
        "materialStats": material_stats,
        "params": {
            "sourceFaceThreshold": args.source_face_threshold,
            "sourceFaceSign": args.source_face_sign,
            "useSourceBothFaces": bool(args.use_source_both_faces),
            "sourceFlipU": bool(args.source_flip_u),
            "sourceFlipV": bool(args.source_flip_v),
            "sourceSwapUV": bool(args.source_swap_uv),
            "sideBase": args.side_base,
            "sideNoise": args.side_noise,
            "sideHighlight": args.side_highlight,
            "sideCrack": args.side_crack,
            "sidePurple": args.side_purple,
            "sideEdgeDarkness": args.side_edge_darkness,
            "sideWidth": args.side_width,
            "sideHeight": args.side_height,
        },
    }

    with open(args.output_report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("Textured GLB written:", str(Path(args.output_glb).resolve()))
    print("Locked source texture:", locked_source_path)
    print("Side fill texture written:", str(Path(args.side_texture).resolve()))
    print("Report written:", str(Path(args.output_report).resolve()))
    print("Material stats:", material_stats)


if __name__ == "__main__":
    main()
