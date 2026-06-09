"""Experimental placeholder for future texture projection and UV baking.

Planned future behavior:

1. Load a mesh asset.
2. Load a source texture image.
3. Project the source image from a front-facing camera.
4. Bake the projection into UV space.
5. Write out a corrected textured GLB.

This file intentionally does not implement the full pipeline yet.
It exists as a documented stub so the project structure is ready for a
future texture projection pass without pretending the feature is complete.
"""

from __future__ import annotations


def main() -> None:
    raise NotImplementedError("Texture projection is not implemented yet.")


if __name__ == "__main__":
    main()

