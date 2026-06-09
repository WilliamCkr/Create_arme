"""
Material helpers for Arena Object Forge.

Purpose:
Reduce overly reflective SF3D-style materials without destroying existing
texture nodes.

This file is intentionally conservative:
- keep existing texture maps
- only adjust Principled BSDF numeric inputs when they exist
- support Blender 4.x input name differences
- never touch fragile inputs like Sheen Tint with the wrong value type
"""

def _as_object_list(objects):
    if objects is None:
        return []
    if isinstance(objects, (list, tuple, set)):
        return list(objects)
    return [objects]


def _safe_set_socket(socket, value):
    if socket is None:
        return False

    try:
        current = socket.default_value
    except Exception:
        return False

    try:
        if isinstance(current, (float, int)):
            socket.default_value = float(value)
            return True

        if hasattr(current, "__len__"):
            values = list(current)
            if len(values) == 1:
                socket.default_value = (float(value),)
                return True
            if len(values) == 3:
                socket.default_value = (float(value), float(value), float(value))
                return True
            if len(values) == 4:
                socket.default_value = (float(value), float(value), float(value), values[3])
                return True

        return False
    except Exception:
        return False


def _set_first_existing_input(node, names, value):
    for name in names:
        socket = node.inputs.get(name)
        if socket is not None:
            if _safe_set_socket(socket, value):
                return name
    return None


def _find_principled_nodes(material):
    if material is None or not getattr(material, "use_nodes", False):
        return []

    nodes = getattr(material.node_tree, "nodes", [])
    result = []

    for node in nodes:
        if getattr(node, "type", "") == "BSDF_PRINCIPLED":
            result.append(node)
        elif getattr(node, "name", "") == "Principled BSDF":
            result.append(node)

    return result


def reduce_reflective_materials(
    objects,
    metallic=0.15,
    roughness=0.82,
    specular=0.25,
    clearcoat=0.0,
    alpha=1.0,
    **kwargs
):
    """
    Reduce glass-like / white reflection issues.

    Args are intentionally simple so render_weapon_angles.py can call this
    directly. Returns a list of warning strings.
    """
    warnings = []
    changed_materials = 0
    seen = set()

    for obj in _as_object_list(objects):
        data = getattr(obj, "data", None)
        materials = getattr(data, "materials", []) if data else []

        for material in materials:
            if material is None:
                continue

            key = getattr(material, "name", str(id(material)))
            if key in seen:
                continue
            seen.add(key)

            nodes = _find_principled_nodes(material)
            if not nodes:
                warnings.append(f"No Principled BSDF found on material: {key}")
                continue

            for principled in nodes:
                _set_first_existing_input(principled, ["Metallic"], metallic)
                _set_first_existing_input(principled, ["Roughness"], roughness)

                # Blender 4.x renamed some Principled BSDF inputs.
                _set_first_existing_input(
                    principled,
                    ["Specular IOR Level", "Specular", "Specular Tint"],
                    specular
                )

                _set_first_existing_input(
                    principled,
                    ["Coat Weight", "Clearcoat", "Clear Coat Weight"],
                    clearcoat
                )

                _set_first_existing_input(principled, ["Alpha"], alpha)

                changed_materials += 1

            try:
                material.blend_method = "BLEND" if alpha < 1.0 else "OPAQUE"
            except Exception:
                pass

    if changed_materials == 0:
        warnings.append("No material inputs were changed.")

    return warnings
