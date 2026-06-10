#!/usr/bin/env python3
import argparse
import json
import math
import numpy as np
import os
import sys

import bpy


def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1:] if "--" in argv else []

    p = argparse.ArgumentParser()

    p.add_argument("--mesh", required=True)
    p.add_argument("--source-image", required=True)
    p.add_argument("--output-glb", required=True)
    p.add_argument("--output-texture", required=True)
    p.add_argument("--side-texture", required=True)
    p.add_argument("--output-report", required=True)

    p.add_argument("--depth-axis", type=int, default=1, choices=[0, 1, 2])

    p.add_argument("--source-face-threshold", type=float, default=0.30)
    p.add_argument("--source-face-sign", type=int, default=1, choices=[-1, 1])
    p.add_argument("--use-source-both-faces", dest="use_source_both_faces", action="store_true")
    p.add_argument("--single-source-face", dest="use_source_both_faces", action="store_false")
    p.set_defaults(use_source_both_faces=True)

    p.add_argument("--white-hard-clip", type=float, default=0.965)
    p.add_argument("--white-soft-clip", type=float, default=0.920)
    p.add_argument("--white-hard-spread", type=float, default=0.060)
    p.add_argument("--white-soft-spread", type=float, default=0.090)

    # Compat UI / anciens réglages (acceptés même si non utilisés directement)
    p.add_argument("--side-base", type=float, default=0.115)
    p.add_argument("--side-noise", type=float, default=0.115)
    p.add_argument("--side-highlight", type=float, default=0.120)
    p.add_argument("--side-crack", type=float, default=0.180)
    p.add_argument("--side-purple", type=float, default=0.220)
    p.add_argument("--side-edge-darkness", type=float, default=0.200)

    # Nouveau système : warp de la source
    p.add_argument("--warp-upscale", type=float, default=1.35)
    p.add_argument("--warp-stretch-x", type=float, default=1.18)
    p.add_argument("--warp-stretch-y", type=float, default=1.08)
    p.add_argument("--warp-contrast", type=float, default=1.08)
    p.add_argument("--warp-brightness", type=float, default=1.00)
    p.add_argument("--warp-expand-passes", type=int, default=3)
    p.add_argument("--warp-alpha-threshold", type=float, default=0.02)
    p.add_argument("--lock-alpha-threshold", type=float, default=0.02)

    # Si l'UI veut forcer une taille
    p.add_argument("--side-texture-width", type=int, default=0)
    p.add_argument("--side-texture-height", type=int, default=0)

    p.add_argument("--edge-band-px", type=float, default=18.0)

    p.add_argument("--source-inset-px", type=float, default=2.0)

    p.add_argument("--gradient-span-px", type=float, default=28.0)

    return p.parse_args(argv)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for coll in [bpy.data.meshes, bpy.data.materials, bpy.data.images]:
        for item in list(coll):
            try:
                coll.remove(item)
            except Exception:
                pass


def import_mesh(path):
    bpy.ops.import_scene.gltf(filepath=os.path.abspath(path))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"No mesh imported from: {path}")
    obj = meshes[0]
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    return obj


def compute_bounds(obj):
    coords = [obj.matrix_world @ v.co for v in obj.data.vertices]
    mins = [min(c[i] for c in coords) for i in range(3)]
    maxs = [max(c[i] for c in coords) for i in range(3)]
    size = [maxs[i] - mins[i] for i in range(3)]
    return {"min": mins, "max": maxs, "size": size}


def create_planar_uv(obj, uv_name, depth_axis=1):
    mesh = obj.data

    if uv_name in mesh.uv_layers:
        uv_layer = mesh.uv_layers[uv_name]
    else:
        uv_layer = mesh.uv_layers.new(name=uv_name)

    axis_pairs = {
        0: (1, 2),
        1: (0, 2),
        2: (0, 1),
    }
    u_axis, v_axis = axis_pairs[depth_axis]

    bounds = compute_bounds(obj)
    mins = bounds["min"]
    maxs = bounds["max"]

    span_u = max(1e-8, maxs[u_axis] - mins[u_axis])
    span_v = max(1e-8, maxs[v_axis] - mins[v_axis])

    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            co = obj.matrix_world @ mesh.vertices[vi].co
            u = (co[u_axis] - mins[u_axis]) / span_u
            v = (co[v_axis] - mins[v_axis]) / span_v
            uv_layer.data[li].uv = (u, v)

    return uv_name


def save_image(name, width, height, pixels, path):
    existing = bpy.data.images.get(name)
    if existing is not None:
        try:
            bpy.data.images.remove(existing)
        except Exception:
            pass

    width = int(width)
    height = int(height)

    arr = np.asarray(pixels, dtype=np.float32).reshape((height, width, 4))
    arr = np.clip(arr, 0.0, 1.0)

    img = bpy.data.images.new(name, width=width, height=height, alpha=True)
    img.colorspace_settings.name = "sRGB"
    img.alpha_mode = "STRAIGHT"
    img.pixels[:] = arr.reshape(-1).tolist()
    img.filepath_raw = os.path.abspath(path)
    img.file_format = "PNG"
    img.save()
    return img


def clean_source_to_alpha(
    source_path,
    white_hard_clip,
    white_soft_clip,
    white_hard_spread,
    white_soft_spread,
):
    src = bpy.data.images.load(os.path.abspath(source_path), check_existing=False)
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

        if a <= 0.001:
            alpha = 0.0
        elif mn > white_hard_clip and spread < white_hard_spread:
            alpha = 0.0
            removed_white += 1
        elif mn > white_soft_clip and spread < white_soft_spread:
            alpha = max(0.0, min(1.0, (white_hard_clip - mn) / max(1e-8, (white_hard_clip - white_soft_clip)))) * a
            if alpha < 0.05:
                removed_white += 1
            else:
                kept += 1
        else:
            alpha = a
            kept += 1

        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        out[i + 3] = alpha

    return width, height, out, {
        "width": width,
        "height": height,
        "removedWhitePixels": removed_white,
        "keptPixelsApprox": kept,
    }


def bilinear_sample(pixels, width, height, u, v):
    if u < 0.0 or u > 1.0 or v < 0.0 or v > 1.0:
        return (0.0, 0.0, 0.0, 0.0)

    x = u * (width - 1)
    y = v * (height - 1)

    x0 = int(math.floor(x))
    y0 = int(math.floor(y))
    x1 = min(width - 1, x0 + 1)
    y1 = min(height - 1, y0 + 1)

    tx = x - x0
    ty = y - y0

    def px(ix, iy):
        i = (iy * width + ix) * 4
        return (
            pixels[i],
            pixels[i + 1],
            pixels[i + 2],
            pixels[i + 3],
        )

    c00 = px(x0, y0)
    c10 = px(x1, y0)
    c01 = px(x0, y1)
    c11 = px(x1, y1)

    def lerp(a, b, t):
        return a + (b - a) * t

    c0 = tuple(lerp(c00[k], c10[k], tx) for k in range(4))
    c1 = tuple(lerp(c01[k], c11[k], tx) for k in range(4))
    c = tuple(lerp(c0[k], c1[k], ty) for k in range(4))
    return c


def resample_source_to_canvas(
    source_pixels,
    source_width,
    source_height,
    target_width,
    target_height,
    stretch_x=1.0,
    stretch_y=1.0,
    contrast=1.0,
    brightness=1.0,
):
    """
    Resample source to target canvas, but first remove white matte contamination.

    Key point:
    Transparent or semi-transparent edge pixels may still contain white RGB.
    If we resample before cleaning that RGB, white fringes survive.
    This function replaces RGB under transparent/white-fringe pixels with the
    nearest trusted non-white opaque source RGB before any interpolation.
    """
    source_width = int(source_width)
    source_height = int(source_height)
    target_width = int(target_width)
    target_height = int(target_height)

    src = np.asarray(source_pixels, dtype=np.float32).reshape((source_height, source_width, 4)).copy()
    src = np.clip(src, 0.0, 1.0)

    height = source_height
    width = source_width

    def shifted_bool(mask, dy, dx):
        out = np.zeros_like(mask, dtype=bool)

        if dy >= 0:
            src_y0 = 0
            src_y1 = height - dy
            dst_y0 = dy
            dst_y1 = height
        else:
            src_y0 = -dy
            src_y1 = height
            dst_y0 = 0
            dst_y1 = height + dy

        if dx >= 0:
            src_x0 = 0
            src_x1 = width - dx
            dst_x0 = dx
            dst_x1 = width
        else:
            src_x0 = -dx
            src_x1 = width
            dst_x0 = 0
            dst_x1 = width + dx

        if src_y1 > src_y0 and src_x1 > src_x0:
            out[dst_y0:dst_y1, dst_x0:dst_x1] = mask[src_y0:src_y1, src_x0:src_x1]

        return out

    def shifted_int(a, dy, dx, fill):
        out = np.full_like(a, fill)

        if dy >= 0:
            src_y0 = 0
            src_y1 = height - dy
            dst_y0 = dy
            dst_y1 = height
        else:
            src_y0 = -dy
            src_y1 = height
            dst_y0 = 0
            dst_y1 = height + dy

        if dx >= 0:
            src_x0 = 0
            src_x1 = width - dx
            dst_x0 = dx
            dst_x1 = width
        else:
            src_x0 = -dx
            src_x1 = width
            dst_x0 = 0
            dst_x1 = width + dx

        if src_y1 > src_y0 and src_x1 > src_x0:
            out[dst_y0:dst_y1, dst_x0:dst_x1] = a[src_y0:src_y1, src_x0:src_x1]

        return out

    alpha = src[:, :, 3]
    alpha_valid = alpha > 0.02
    alpha_strong = alpha > 0.60
    alpha_invalid = ~alpha_valid

    rgb = src[:, :, :3]
    rgb_max = rgb.max(axis=2)
    rgb_min = rgb.min(axis=2)
    rgb_mean = rgb.mean(axis=2)
    rgb_chroma = rgb_max - rgb_min

    near_invalid = np.zeros((height, width), dtype=bool)
    matte_radius = 10

    for dy in range(-matte_radius, matte_radius + 1):
        for dx in range(-matte_radius, matte_radius + 1):
            if dx == 0 and dy == 0:
                continue
            near_invalid |= shifted_bool(alpha_invalid, dy, dx)

    # White / grey fringe near cutout edge.
    # Aggressive enough to remove the white matte, but restricted to edge proximity.
    edge_white_matte = (
        alpha_valid
        & near_invalid
        & (
            ((rgb_mean >= 0.62) & (rgb_chroma <= 0.34))
            | ((rgb_mean >= 0.78) & (rgb_chroma <= 0.52))
        )
    )

    # Fully/mostly transparent pixels must also have their RGB fixed before resampling,
    # otherwise bilinear filtering pulls hidden white back into the visible edge.
    needs_rgb_replace = alpha_invalid | edge_white_matte

    # Trusted seeds: real opaque pixels, not matte-looking edge pixels.
    trusted = alpha_strong & (~edge_white_matte)

    # Avoid pure white seeds anywhere, unless they have strong chroma.
    pure_white_seed = (rgb_mean >= 0.88) & (rgb_chroma <= 0.22)
    trusted = trusted & (~pure_white_seed)

    if np.any(trusted):
        yy, xx = np.indices((height, width), dtype=np.int32)

        nearest_y = np.where(trusted, yy, -1).astype(np.int32)
        nearest_x = np.where(trusted, xx, -1).astype(np.int32)
        best_dist = np.where(trusted, 0.0, np.inf).astype(np.float32)

        max_dim = max(width, height)
        step = 1
        while step < max_dim:
            step *= 2
        step //= 2

        while step >= 1:
            for dy in (-step, 0, step):
                for dx in (-step, 0, step):
                    if dx == 0 and dy == 0:
                        continue

                    cand_y = shifted_int(nearest_y, dy, dx, -1)
                    cand_x = shifted_int(nearest_x, dy, dx, -1)

                    has = (cand_y >= 0) & (cand_x >= 0)
                    if not np.any(has):
                        continue

                    dist = (yy - cand_y).astype(np.float32) ** 2 + (xx - cand_x).astype(np.float32) ** 2
                    take = has & (dist < best_dist)

                    nearest_y[take] = cand_y[take]
                    nearest_x[take] = cand_x[take]
                    best_dist[take] = dist[take]

            step //= 2

        has_nearest = (nearest_y >= 0) & (nearest_x >= 0)
        replace = needs_rgb_replace & has_nearest

        src[replace, :3] = src[nearest_y[replace], nearest_x[replace], :3]

        # For matte edge pixels, keep alpha. For fully transparent pixels, keep alpha 0.
        # Only RGB is decontaminated here.

    xs = (np.arange(target_width, dtype=np.float32) + 0.5) / max(1, target_width)
    ys = (np.arange(target_height, dtype=np.float32) + 0.5) / max(1, target_height)

    su = 0.5 + (xs - 0.5) / max(1e-6, float(stretch_x))
    sv = 0.5 + (ys - 0.5) / max(1e-6, float(stretch_y))

    valid_x = (su >= 0.0) & (su <= 1.0)
    valid_y = (sv >= 0.0) & (sv <= 1.0)
    valid = valid_y[:, None] & valid_x[None, :]

    sx = np.clip(su, 0.0, 1.0) * (source_width - 1)
    sy = np.clip(sv, 0.0, 1.0) * (source_height - 1)

    x0 = np.floor(sx).astype(np.int32)
    y0 = np.floor(sy).astype(np.int32)
    x1 = np.minimum(x0 + 1, source_width - 1)
    y1 = np.minimum(y0 + 1, source_height - 1)

    tx = (sx - x0).astype(np.float32)[None, :, None]
    ty = (sy - y0).astype(np.float32)[:, None, None]

    c00 = src[y0[:, None], x0[None, :], :]
    c10 = src[y0[:, None], x1[None, :], :]
    c01 = src[y1[:, None], x0[None, :], :]
    c11 = src[y1[:, None], x1[None, :], :]

    c0 = c00 * (1.0 - tx) + c10 * tx
    c1 = c01 * (1.0 - tx) + c11 * tx
    out = c0 * (1.0 - ty) + c1 * ty

    out[~valid, :] = 0.0

    alpha_mask = out[:, :, 3:4] > 0.0
    out[:, :, :3] = np.where(
        alpha_mask,
        0.5 + (out[:, :, :3] - 0.5) * float(contrast),
        out[:, :, :3],
    )
    out[:, :, :3] = np.where(
        alpha_mask,
        out[:, :, :3] * float(brightness),
        out[:, :, :3],
    )

    out = np.clip(out, 0.0, 1.0).astype(np.float32)
    return out.reshape(-1)


def compute_average_opaque_color(pixels, alpha_threshold):
    sr = sg = sb = 0.0
    count = 0

    for i in range(0, len(pixels), 4):
        if pixels[i + 3] > alpha_threshold:
            sr += pixels[i]
            sg += pixels[i + 1]
            sb += pixels[i + 2]
            count += 1

    if count == 0:
        return (0.08, 0.08, 0.08)

    return (sr / count, sg / count, sb / count)


def directional_fill(base, width, height, alpha_threshold, direction):
    out = base[:]

    if direction == "left":
        for y in range(height):
            last = None
            for x in range(width):
                i = (y * width + x) * 4
                if base[i + 3] > alpha_threshold:
                    last = (base[i], base[i + 1], base[i + 2])
                elif last is not None:
                    out[i] = last[0]
                    out[i + 1] = last[1]
                    out[i + 2] = last[2]
                    out[i + 3] = 1.0

    elif direction == "right":
        for y in range(height):
            last = None
            for x in range(width - 1, -1, -1):
                i = (y * width + x) * 4
                if base[i + 3] > alpha_threshold:
                    last = (base[i], base[i + 1], base[i + 2])
                elif last is not None:
                    out[i] = last[0]
                    out[i + 1] = last[1]
                    out[i + 2] = last[2]
                    out[i + 3] = 1.0

    elif direction == "up":
        for x in range(width):
            last = None
            for y in range(height):
                i = (y * width + x) * 4
                if base[i + 3] > alpha_threshold:
                    last = (base[i], base[i + 1], base[i + 2])
                elif last is not None:
                    out[i] = last[0]
                    out[i + 1] = last[1]
                    out[i + 2] = last[2]
                    out[i + 3] = 1.0

    elif direction == "down":
        for x in range(width):
            last = None
            for y in range(height - 1, -1, -1):
                i = (y * width + x) * 4
                if base[i + 3] > alpha_threshold:
                    last = (base[i], base[i + 1], base[i + 2])
                elif last is not None:
                    out[i] = last[0]
                    out[i + 1] = last[1]
                    out[i + 2] = last[2]
                    out[i + 3] = 1.0

    return out


def combine_directional_fills(base, fills, width, height, alpha_threshold):
    out = base[:]
    fallback = compute_average_opaque_color(base, alpha_threshold)

    for i in range(0, len(base), 4):
        if base[i + 3] > alpha_threshold:
            out[i + 3] = 1.0
            continue

        samples = []
        for arr in fills:
            if arr[i + 3] > alpha_threshold:
                samples.append((arr[i], arr[i + 1], arr[i + 2]))

        if samples:
            r = sum(s[0] for s in samples) / len(samples)
            g = sum(s[1] for s in samples) / len(samples)
            b = sum(s[2] for s in samples) / len(samples)
        else:
            r, g, b = fallback

        out[i] = r
        out[i + 1] = g
        out[i + 2] = b
        out[i + 3] = 1.0

    return out


def build_warp_fill_from_source(
    seed_pixels,
    width,
    height,
    alpha_threshold=0.02,
    expand_passes=2,
):
    """
    Pixel-wise outward gradient fill.

    No blur.
    No average over large zones.
    Each fill pixel samples a different point to create a visible per-pixel gradient.
    """
    import numpy as np

    width = int(width)
    height = int(height)
    threshold = float(alpha_threshold)

    edge_band_px = float(globals().get("EDGE_BAND_PX", 18.0))
    source_inset_px = float(globals().get("SOURCE_INSET_PX", 2.0))
    gradient_span_px = float(globals().get("GRADIENT_SPAN_PX", 28.0))

    arr = np.asarray(seed_pixels, dtype=np.float32).reshape((height, width, 4)).copy()
    arr = np.clip(arr, 0.0, 1.0)

    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3]

    a = np.maximum(alpha[:, :, None], 1e-4)
    dematted_rgb = np.clip((rgb - (1.0 - alpha[:, :, None])) / a, 0.0, 1.0)
    dematted_rgb[alpha <= 1e-4] = rgb[alpha <= 1e-4]

    material_mask = alpha > max(0.08, threshold)
    if not np.any(material_mask):
        material_mask = alpha > threshold

    if not np.any(material_mask):
        out = arr.copy()
        out[:, :, 3] = 1.0
        return out.reshape(-1)

    yy, xx = np.indices((height, width), dtype=np.int32)

    def shifted_int(a, dy, dx, fill):
        out = np.full_like(a, fill)

        if dy >= 0:
            src_y0 = 0
            src_y1 = height - dy
            dst_y0 = dy
            dst_y1 = height
        else:
            src_y0 = -dy
            src_y1 = height
            dst_y0 = 0
            dst_y1 = height + dy

        if dx >= 0:
            src_x0 = 0
            src_x1 = width - dx
            dst_x0 = dx
            dst_x1 = width
        else:
            src_x0 = -dx
            src_x1 = width
            dst_x0 = 0
            dst_x1 = width + dx

        if src_y1 > src_y0 and src_x1 > src_x0:
            out[dst_y0:dst_y1, dst_x0:dst_x1] = a[src_y0:src_y1, src_x0:src_x1]

        return out

    def bilinear_sample(img, xs, ys):
        xs = np.clip(xs, 0.0, width - 1.0)
        ys = np.clip(ys, 0.0, height - 1.0)

        x0 = np.floor(xs).astype(np.int32)
        y0 = np.floor(ys).astype(np.int32)
        x1 = np.clip(x0 + 1, 0, width - 1)
        y1 = np.clip(y0 + 1, 0, height - 1)

        wx = (xs - x0).astype(np.float32)[:, :, None]
        wy = (ys - y0).astype(np.float32)[:, :, None]

        c00 = img[y0, x0]
        c10 = img[y0, x1]
        c01 = img[y1, x0]
        c11 = img[y1, x1]

        c0 = c00 * (1.0 - wx) + c10 * wx
        c1 = c01 * (1.0 - wx) + c11 * wx
        return c0 * (1.0 - wy) + c1 * wy

    nearest_y = np.where(material_mask, yy, -1).astype(np.int32)
    nearest_x = np.where(material_mask, xx, -1).astype(np.int32)
    best_d2 = np.where(material_mask, 0.0, np.inf).astype(np.float32)

    max_dim = max(width, height)
    step = 1
    while step < max_dim:
        step *= 2
    step //= 2

    while step >= 1:
        for dy in (-step, 0, step):
            for dx in (-step, 0, step):
                if dx == 0 and dy == 0:
                    continue

                cand_y = shifted_int(nearest_y, dy, dx, -1)
                cand_x = shifted_int(nearest_x, dy, dx, -1)

                valid = (cand_y >= 0) & (cand_x >= 0)
                if not np.any(valid):
                    continue

                d2 = (yy - cand_y).astype(np.float32) ** 2 + (xx - cand_x).astype(np.float32) ** 2
                take = valid & (d2 < best_d2)

                nearest_y[take] = cand_y[take]
                nearest_x[take] = cand_x[take]
                best_d2[take] = d2[take]

        step //= 2

    out = arr.copy()
    fill_mask = ~material_mask
    valid_fill = fill_mask & (nearest_y >= 0) & (nearest_x >= 0)

    dx = (xx - nearest_x).astype(np.float32)
    dy = (yy - nearest_y).astype(np.float32)
    dist = np.sqrt(np.maximum(best_d2, 0.0)).astype(np.float32)

    inv = np.zeros_like(dist, dtype=np.float32)
    nz = dist > 1e-6
    inv[nz] = 1.0 / dist[nz]

    dir_x = dx * inv
    dir_y = dy * inv

    span = max(1.0, gradient_span_px)
    t = np.clip(dist / span, 0.0, 1.0)

    # Dégradé pixel par pixel:
    # près de l'arme => couleur plus intérieure
    # loin de l'arme => couleur plus proche du bord / halo extérieur
    sample_offset = source_inset_px + (1.0 - t) * edge_band_px

    sample_x = nearest_x.astype(np.float32) - dir_x * sample_offset
    sample_y = nearest_y.astype(np.float32) - dir_y * sample_offset

    fill_rgb = bilinear_sample(dematted_rgb, sample_x, sample_y)

    out[valid_fill, :3] = fill_rgb[valid_fill]

    # TRUE FILL OVERLAY MODE:
    # Do not restore the clean source inside material_mask.
    # Layer 1 must remain the generated fill layer, so when it is composited above
    # source_lock, the fill is really visible on top.
    #
    # For source/material pixels, generate a local fill color too by sampling slightly
    # inward from their own position. This avoids keeping the original clean source
    # inside Layer 1.
    material_y, material_x = np.where(material_mask)
    if material_y.size:
        mat_x = material_x.astype(np.float32)
        mat_y = material_y.astype(np.float32)

        # Use a small deterministic pseudo-direction from the texture center.
        cx = width * 0.5
        cy = height * 0.5
        vx = mat_x - cx
        vy = mat_y - cy
        vd = np.sqrt(vx * vx + vy * vy)
        safe = vd > 1e-6
        vx[safe] /= vd[safe]
        vy[safe] /= vd[safe]

        # Where direction is undefined, sample directly.
        sample_offset = max(1.0, source_inset_px + edge_band_px * 0.35)
        sample_x = np.clip(mat_x - vx * sample_offset, 0.0, width - 1.0)
        sample_y = np.clip(mat_y - vy * sample_offset, 0.0, height - 1.0)

        # Bilinear sample expects full grids, so do direct nearest here for speed/stability.
        sx = np.clip(np.round(sample_x).astype(np.int32), 0, width - 1)
        sy = np.clip(np.round(sample_y).astype(np.int32), 0, height - 1)

        out[material_y, material_x, :3] = dematted_rgb[sy, sx, :3]

    out[:, :, 3] = 1.0

    print(
        f"Pixel gradient fill: edge_band_px={edge_band_px}, "
        f"source_inset_px={source_inset_px}, gradient_span_px={gradient_span_px}"
    )

    return np.clip(out, 0.0, 1.0).astype(np.float32).reshape(-1)


def compose_lock_over_fill(fill_img, source_lock_img, lock_alpha_threshold=0.02):
    """
    Step 2 final composite:
    source image base -> layer1 gradient/fill above.
    """

    def infer_shape(a, b):
        aa = np.asarray(a)
        bb = np.asarray(b)

        for arr in (aa, bb):
            if arr.ndim == 3 and arr.shape[2] in (3, 4):
                return (int(arr.shape[0]), int(arr.shape[1]), 4)

        # Known current sword atlas: 2774368 = 1448 * 479 * 4
        for arr in (aa, bb):
            if arr.ndim == 1 and arr.size == 2774368:
                return (1448, 479, 4)

        for arr in (aa, bb):
            if arr.ndim == 1 and arr.size % 4 == 0:
                pixels = arr.size // 4
                root = int(np.sqrt(pixels))
                candidates = []
                for w in range(1, root + 1):
                    if pixels % w == 0:
                        h = pixels // w
                        ratio = max(w, h) / max(1, min(w, h))
                        if 1.5 <= ratio <= 8.0:
                            candidates.append((abs(ratio - 3.0), min(w, h), max(w, h)))
                if candidates:
                    candidates.sort(key=lambda x: (x[0], -x[1]))
                    _, w, h = candidates[0]
                    return (int(h), int(w), 4)

        raise ValueError(f"could not infer RGBA shape. source shape={np.asarray(source_lock_img).shape}, fill shape={np.asarray(fill_img).shape}")

    def to_rgba_float(value, shape, label):
        arr = np.asarray(value).astype(np.float32)

        if arr.ndim == 1:
            expected = int(np.prod(shape))
            if arr.size != expected:
                raise ValueError(f"{label} wrong flat size: got {arr.size}, expected {expected}")
            arr = arr.reshape(shape)

        elif arr.ndim == 3:
            if arr.shape[2] == 3:
                alpha = np.ones((arr.shape[0], arr.shape[1], 1), dtype=np.float32)
                arr = np.concatenate([arr, alpha], axis=2)
            elif arr.shape[2] != 4:
                raise ValueError(f"{label} unsupported channels: {arr.shape}")
        else:
            raise ValueError(f"{label} unsupported shape: {arr.shape}")

        if arr.size and float(np.nanmax(arr)) > 1.5:
            arr = arr / 255.0

        return np.clip(arr, 0.0, 1.0)

    shape = infer_shape(fill_img, source_lock_img)

    source = to_rgba_float(source_lock_img, shape, "source_lock_img")
    fill = to_rgba_float(fill_img, shape, "fill_img")

    # Source image as base.
    out = source.copy()

    # Layer1 above source.
    alpha = np.clip(fill[:, :, 3:4], 0.0, 1.0)
    out[:, :, 0:3] = source[:, :, 0:3] * (1.0 - alpha) + fill[:, :, 0:3] * alpha
    out[:, :, 3] = np.maximum(source[:, :, 3], fill[:, :, 3])

    print(f"Composite order: source base + layer1 above | shape={shape} fill_alpha_pixels={int((fill[:, :, 3] > lock_alpha_threshold).sum())}")

    return np.clip(out, 0.0, 1.0).astype(np.float32).reshape(-1)


def build_material(material_name, texture_image, uv_name, use_alpha=True):
    mat = bpy.data.materials.new(material_name)
    mat.use_nodes = True

    nt = mat.node_tree
    nodes = nt.nodes
    links = nt.links

    for n in list(nodes):
        nodes.remove(n)

    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (500, 0)

    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (220, 0)

    tex = nodes.new("ShaderNodeTexImage")
    tex.location = (-150, 0)
    tex.image = texture_image
    tex.interpolation = "Linear"
    tex.extension = "CLIP"

    uv = nodes.new("ShaderNodeUVMap")
    uv.location = (-400, 0)
    uv.uv_map = uv_name

    links.new(uv.outputs["UV"], tex.inputs["Vector"])
    links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    if use_alpha and "Alpha" in tex.outputs and "Alpha" in bsdf.inputs:
        links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        if hasattr(mat, "blend_method"):
            mat.blend_method = "BLEND"
        if hasattr(mat, "shadow_method"):
            mat.shadow_method = "HASHED"

    links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def assign_materials_by_normal(
    obj,
    source_mat,
    side_mat,
    depth_axis=1,
    threshold=0.30,
    source_face_sign=1,
    use_source_both_faces=True,
):
    mesh = obj.data
    mesh.materials.clear()
    mesh.materials.append(source_mat)
    mesh.materials.append(side_mat)

    world_m = obj.matrix_world.to_3x3()

    source_faces = 0
    side_faces = 0

    for poly in mesh.polygons:
        n = world_m @ poly.normal
        n.normalize()

        axis_value = [n.x, n.y, n.z][depth_axis]
        abs_value = abs(axis_value)

        is_source = abs_value >= threshold
        if is_source and not use_source_both_faces:
            sign = 1 if axis_value >= 0.0 else -1
            is_source = sign == source_face_sign

        poly.material_index = 0 if is_source else 1

        if is_source:
            source_faces += 1
        else:
            side_faces += 1

    return {
        "sourceFaces": source_faces,
        "sideFillFaces": side_faces,
        "threshold": threshold,
        "depthAxis": depth_axis,
        "useSourceBothFaces": use_source_both_faces,
        "sourceFaceSign": source_face_sign,
    }


def export_glb(output_path):
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(output_path),
        export_format="GLB",
        export_image_format="AUTO",
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
    )


def main():
    args = parse_args()


    global EDGE_BAND_PX, SOURCE_INSET_PX, GRADIENT_SPAN_PX
    EDGE_BAND_PX = float(getattr(args, "edge_band_px", 18.0))
    SOURCE_INSET_PX = float(getattr(args, "source_inset_px", 2.0))
    GRADIENT_SPAN_PX = float(getattr(args, "gradient_span_px", 28.0))
    output_dir = os.path.dirname(os.path.abspath(args.output_glb))
    os.makedirs(output_dir, exist_ok=True)

    clear_scene()

    obj = import_mesh(args.mesh)
    uv_name = create_planar_uv(obj, "ProjectedUV", depth_axis=args.depth_axis)

    src_w, src_h, clean_source_pixels, source_stats = clean_source_to_alpha(
        args.source_image,
        args.white_hard_clip,
        args.white_soft_clip,
        args.white_hard_spread,
        args.white_soft_spread,
    )

    target_w = args.side_texture_width if args.side_texture_width > 0 else max(64, int(round(src_w * args.warp_upscale)))
    target_h = args.side_texture_height if args.side_texture_height > 0 else max(64, int(round(src_h * args.warp_upscale)))

    source_lock_pixels = resample_source_to_canvas(
        clean_source_pixels,
        src_w,
        src_h,
        target_w,
        target_h,
        stretch_x=1.0,
        stretch_y=1.0,
        contrast=1.0,
        brightness=1.0,
    )

    warp_seed_pixels = resample_source_to_canvas(
        clean_source_pixels,
        src_w,
        src_h,
        target_w,
        target_h,
        stretch_x=args.warp_stretch_x,
        stretch_y=args.warp_stretch_y,
        contrast=args.warp_contrast,
        brightness=args.warp_brightness,
    )

    side_fill_pixels = build_warp_fill_from_source(
        warp_seed_pixels,
        target_w,
        target_h,
        alpha_threshold=args.warp_alpha_threshold,
        expand_passes=args.warp_expand_passes,
    )

    composite_pixels = compose_lock_over_fill(
        source_lock_pixels,
        side_fill_pixels,
        lock_alpha_threshold=args.lock_alpha_threshold,
    )

    source_lock_path = os.path.join(output_dir, "source-lock.png")

    source_lock_img = save_image("AOF_SourceLock", target_w, target_h, source_lock_pixels, source_lock_path)
    side_fill_img = save_image("AOF_SideFillWarped", target_w, target_h, side_fill_pixels, args.side_texture)
    composite_img = save_image("AOF_CompositeSideTexture", target_w, target_h, composite_pixels, args.output_texture)

    source_mat = build_material("AOF_SourceComposite_Mat", composite_img, uv_name, use_alpha=False)
    side_mat = build_material("AOF_CompositeSide_Mat", composite_img, uv_name, use_alpha=False)

    material_stats = assign_materials_by_normal(
        obj=obj,
        source_mat=source_mat,
        side_mat=side_mat,
        depth_axis=args.depth_axis,
        threshold=args.source_face_threshold,
        source_face_sign=args.source_face_sign,
        use_source_both_faces=args.use_source_both_faces,
    )

    export_glb(args.output_glb)

    report = {
        "mesh": os.path.abspath(args.mesh),
        "sourceImage": os.path.abspath(args.source_image),
        "outputGlb": os.path.abspath(args.output_glb),
        "outputTexture": os.path.abspath(args.output_texture),
        "sideTexture": os.path.abspath(args.side_texture),
        "sourceLockTexture": os.path.abspath(source_lock_path),
        "uvName": uv_name,
        "sourceStats": source_stats,
        "materialStats": material_stats,
        "targetTextureSize": {"width": target_w, "height": target_h},
        "pixelGradientSettings": {
            "edgeBandPx": float(getattr(args, "edge_band_px", 18.0)),
            "sourceInsetPx": float(getattr(args, "source_inset_px", 2.0)),
            "gradientSpanPx": float(getattr(args, "gradient_span_px", 28.0))
        },
        "warpSettings": {
            "warpUpscale": args.warp_upscale,
            "warpStretchX": args.warp_stretch_x,
            "warpStretchY": args.warp_stretch_y,
            "warpContrast": args.warp_contrast,
            "warpBrightness": args.warp_brightness,
            "warpExpandPasses": args.warp_expand_passes,
            "warpAlphaThreshold": args.warp_alpha_threshold,
            "lockAlphaThreshold": args.lock_alpha_threshold,
        },
        "important": "Layer 1 = fill / gradient. Final composite = source base + layer1 gradient above.",
    }

    with open(args.output_report, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    print("Textured GLB written:", os.path.abspath(args.output_glb))
    print("Composite texture written:", os.path.abspath(args.output_texture))
    print("Warped fill texture written:", os.path.abspath(args.side_texture))
    print("Source lock texture written:", os.path.abspath(source_lock_path))
    print("Report written:", os.path.abspath(args.output_report))
    print("Material stats:", material_stats)


if __name__ == "__main__":
    main()
