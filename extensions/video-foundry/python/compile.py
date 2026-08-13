#!/usr/bin/env python3
"""Compile ordered transparent PNG frames into a compact atlas and diagnostics."""
from __future__ import annotations
import glob, json, math, os
from pathlib import Path
from typing import Any

def centroid(alpha):
    import numpy as np
    y, x = np.nonzero(alpha > 0)
    return (float(x.mean()), float(y.mean())) if len(x) else (0.0, 0.0)

def main() -> None:
    import numpy as np
    from PIL import Image
    request_path = Path(os.environ["GAMEFACTORY_ANIMATION_REQUEST"])
    result_path = Path(os.environ["GAMEFACTORY_ANIMATION_RESULT"])
    request = json.loads(request_path.read_text("utf-8"))
    results: list[dict[str, Any]] = []
    for job in request["jobs"]:
        frames = sorted(Path(path) for path in glob.glob(str(Path(job["sourceDirectory"]) / job["frameGlob"])))
        frames = frames[:: int(job["frameStride"])]
        if not frames: raise ValueError(f"{job['id']}: no frames matched {job['frameGlob']}")
        images = [Image.open(frame).convert("RGBA") for frame in frames]
        size = images[0].size
        if any(image.size != size for image in images): raise ValueError(f"{job['id']}: frames do not share dimensions")
        arrays = [np.asarray(image) for image in images]
        if job["trimTransparent"]:
            union = np.maximum.reduce([array[:, :, 3] for array in arrays])
            y, x = np.nonzero(union > 0)
            box = (int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1) if len(x) else (0, 0, *size)
            images = [image.crop(box) for image in images]
            arrays = [np.asarray(image) for image in images]
        else: box = (0, 0, *size)
        width, height = images[0].size
        columns = int(job.get("columns") or math.ceil(math.sqrt(len(images))))
        rows = math.ceil(len(images) / columns)
        atlas = Image.new("RGBA", (width * columns, height * rows), (0, 0, 0, 0))
        for index, image in enumerate(images): atlas.paste(image, ((index % columns) * width, (index // columns) * height))
        output = Path(job["outputDirectory"]); output.mkdir(parents=True, exist_ok=True)
        atlas_path = output / "atlas.png"; metadata_path = output / "animation.json"; atlas.save(atlas_path, optimize=True)
        alpha = [array[:, :, 3].astype(np.float32) / 255.0 for array in arrays]
        differences = [float(np.mean(np.abs(alpha[index] - alpha[index - 1]))) for index in range(1, len(alpha))]
        centers = [centroid(item) for item in alpha]
        drift = [math.dist(centers[index], centers[index - 1]) / max(1.0, math.hypot(width, height)) for index in range(1, len(centers))]
        diagnostics = {"frameCount": len(images), "sourceSize": list(size), "frameSize": [width, height], "atlasSize": list(atlas.size), "alphaTemporalJitter": sum(differences) / len(differences) if differences else 0.0, "centroidDrift": sum(drift) / len(drift) if drift else 0.0, "loopSeamError": float(np.mean(np.abs(alpha[-1] - alpha[0]))) if job["loop"] else None, "estimatedGpuBytes": atlas.width * atlas.height * 4}
        metadata = {"apiVersion": "gamefactory.animation/v1", "id": job["id"], "atlas": "atlas.png", "frames": len(images), "columns": columns, "rows": rows, "frameWidth": width, "frameHeight": height, "trimBox": list(box), "loop": bool(job["loop"]), "diagnostics": diagnostics}
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", "utf-8")
        results.append({"id": job["id"], "atlasPath": str(atlas_path.resolve()), "metadataPath": str(metadata_path.resolve()), "diagnostics": diagnostics})
    result_path.write_text(json.dumps({"apiVersion": "gamefactory.animation/v1", "jobs": results}, indent=2) + "\n", "utf-8")

if __name__ == "__main__": main()
