"""Rebuild a compile-only runtime bootstrap after slice-v6 cleanup lost its assets.

This intentionally does not claim production fidelity. The v7 production node must
replace or explicitly re-author every raster whose hash differs from the approved
inventory, then regenerate real Godot evidence.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

from PIL import Image
import matplotlib


PROJECT = Path(__file__).resolve().parents[2]
INVENTORY = PROJECT / "design/production-assets/first-delivery/inventory.json"
SOURCE_WORLD = PROJECT / "design/scene-targets/continuity-source/continuous-world-basis.png"
REPORT = PROJECT / "design/recovery/runtime-bootstrap.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atlas_size(component: dict) -> tuple[int, int]:
    native = component["nativeSize"]
    animation = component.get("animation", {})
    frames = max(1, int(animation.get("frames", 1)))
    grid = animation.get("grid")
    if grid:
        columns, rows = int(grid[0]), int(grid[1])
    else:
        columns, rows = frames, 1
    return int(native["width"]) * columns, int(native["height"]) * rows


def main() -> None:
    inventory = json.loads(INVENTORY.read_text(encoding="utf-8"))
    generated: list[dict] = []
    for component in inventory["components"]:
        output = component.get("output", "")
        if not output.endswith(".png"):
            continue
        destination = PROJECT / output
        destination.parent.mkdir(parents=True, exist_ok=True)
        if component["id"] == "village-environment":
            image = Image.open(SOURCE_WORLD).convert("RGBA")
            image = image.resize((480, 270), Image.Resampling.NEAREST)
        else:
            image = Image.new("RGBA", atlas_size(component), (0, 0, 0, 0))
        image.save(destination, format="PNG", optimize=False)
        actual = sha256(destination)
        generated.append({
            "id": component["id"],
            "path": output,
            "expectedSha256": component["outputSha256"],
            "actualSha256": actual,
            "matchesApprovedInventory": actual == component["outputSha256"],
            "bootstrapTreatment": "approved whole-scene basis" if component["id"] == "village-environment" else "transparent compile shim",
        })

    font_root = Path(matplotlib.get_data_path()) / "fonts/ttf"
    for font in inventory.get("fonts", []):
        source_name = "LICENSE_DEJAVU" if font["role"] == "license" else Path(font["path"]).name
        source = font_root / source_name
        destination = PROJECT / font["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        actual = sha256(destination)
        if actual != font["sha256"]:
            raise RuntimeError(f"Bundled font hash mismatch for {font['path']}")
        generated.append({
            "id": f"font-{font['role']}",
            "path": font["path"],
            "expectedSha256": font["sha256"],
            "actualSha256": actual,
            "matchesApprovedInventory": True,
            "bootstrapTreatment": "exact licensed recovery from matplotlib DejaVu distribution",
        })

    REPORT.write_text(json.dumps({
        "schema": "gamefactory.runtime-bootstrap/v1",
        "status": "compile-only-not-production",
        "sourceRun": "alchemy-delivery-boys-v2-slice-v6-fb222ddd1d59bd57",
        "reason": "The rejected candidate was cleaned after preserving reports but not its runtime asset files.",
        "productionRequirement": "Before acceptance, replace or explicitly re-author every mismatched raster, update inventory provenance, and regenerate both Godot scenarios and visual captures.",
        "assets": generated,
    }, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
