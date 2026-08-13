#!/usr/bin/env python3
"""Bundled, intentionally thin SAM 3 image worker.

The TypeScript extension owns request validation, containment, provenance, and
artifact hashing. This worker owns model inference and deterministic mask/cutout
post-processing only.
"""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
from pathlib import Path
import sys
from typing import Any


def doctor() -> int:
    report: dict[str, Any] = {"ok": False, "python": sys.version.split()[0]}
    try:
        import torch
        import PIL
        import sam3

        report.update(
            {
                "torch": torch.__version__,
                "pillow": PIL.__version__,
                "sam3": importlib.metadata.version("sam3"),
                "cudaAvailable": bool(torch.cuda.is_available()),
                "cudaVersion": torch.version.cuda,
                "sam3Module": str(Path(sam3.__file__).resolve()),
            }
        )
        requested_device = os.environ.get("GAMEFACTORY_SAM3_DEVICE", "cuda")
        report["requestedDevice"] = requested_device
        report["ok"] = requested_device == "cpu" or bool(torch.cuda.is_available())
        if not report["ok"]:
            report["message"] = "SAM 3 is installed, but the official CUDA runtime is unavailable."
    except Exception as error:  # doctor must explain incomplete optional setups
        report["message"] = f"{type(error).__name__}: {error}"
    print(json.dumps(report, sort_keys=True))
    return 0 if report["ok"] else 1


def as_numpy_mask(value: Any):
    import numpy as np

    if hasattr(value, "detach"):
        value = value.detach().float().cpu().numpy()
    array = np.asarray(value)
    while array.ndim > 2 and array.shape[0] == 1:
        array = array[0]
    if array.ndim == 3 and array.shape[-1] == 1:
        array = array[..., 0]
    if array.ndim != 2:
        raise ValueError(f"Expected a 2D instance mask, received shape {array.shape}")
    return array > 0.5


def tensor_items(value: Any) -> list[Any]:
    if hasattr(value, "detach"):
        value = value.detach().cpu()
    if hasattr(value, "ndim") and value.ndim == 4 and value.shape[0] == 1:
        value = value[0]
    return list(value)


def scalar_items(value: Any, count: int) -> list[float]:
    if value is None:
        return [1.0] * count
    if hasattr(value, "detach"):
        value = value.detach().float().cpu().flatten().tolist()
    else:
        try:
            value = list(value)
        except TypeError:
            value = [value]
    output = [float(item) for item in value]
    return (output + [1.0] * count)[:count]


def safe_stem(value: str) -> str:
    return "".join(character if character.isalnum() or character in "-_" else "-" for character in value)


def process_job(model: Any, processor_type: Any, job: dict[str, Any]) -> dict[str, Any]:
    import numpy as np
    from PIL import Image, ImageFilter

    image = Image.open(job["sourcePath"]).convert("RGBA")
    processor = processor_type(model, confidence_threshold=float(job["threshold"]))
    state = processor.set_image(image.convert("RGB"))
    inference = processor.set_text_prompt(state=state, prompt=job["prompt"])
    raw_masks = tensor_items(inference.get("masks", []))
    scores = scalar_items(inference.get("scores"), len(raw_masks))
    ranked = sorted(zip(raw_masks, scores), key=lambda item: item[1], reverse=True)
    ranked = [item for item in ranked if item[1] >= float(job["threshold"])][: int(job["maxInstances"])]
    output_directory = Path(job["outputDirectory"])
    output_directory.mkdir(parents=True, exist_ok=True)
    instances: list[dict[str, Any]] = []
    source = np.asarray(image)
    for index, (raw_mask, score) in enumerate(ranked, start=1):
        mask = as_numpy_mask(raw_mask)
        ys, xs = np.nonzero(mask)
        if xs.size == 0 or ys.size == 0:
            continue
        mask_image = Image.fromarray((mask.astype(np.uint8) * 255), mode="L")
        expand = int(job["maskExpandPixels"])
        if expand > 0:
            mask_image = mask_image.filter(ImageFilter.MaxFilter(expand * 2 + 1))
        elif expand < 0:
            mask_image = mask_image.filter(ImageFilter.MinFilter(abs(expand) * 2 + 1))
        feather = float(job["maskFeatherPixels"])
        if feather > 0:
            mask_image = mask_image.filter(ImageFilter.GaussianBlur(feather))
        processed_mask = np.asarray(mask_image)
        nonzero_y, nonzero_x = np.nonzero(processed_mask)
        if nonzero_x.size == 0 or nonzero_y.size == 0:
            continue
        padding = int(job["cropPaddingPixels"])
        left = max(0, int(nonzero_x.min()) - padding)
        top = max(0, int(nonzero_y.min()) - padding)
        right = min(image.width, int(nonzero_x.max()) + 1 + padding)
        bottom = min(image.height, int(nonzero_y.max()) + 1 + padding)
        identifier = f"{safe_stem(job['id'])}-{index:03d}"
        mask_path = output_directory / f"{identifier}.mask.png"
        cutout_path = output_directory / f"{identifier}.cutout.png"
        mask_image.save(mask_path)
        cutout = source.copy()
        cutout[..., 3] = processed_mask
        Image.fromarray(cutout, mode="RGBA").crop((left, top, right, bottom)).save(cutout_path)
        instances.append(
            {
                "index": index,
                "score": score,
                "bbox": [left, top, right, bottom],
                "maskPath": str(mask_path),
                "cutoutPath": str(cutout_path),
            }
        )
    return {"id": job["id"], "prompt": job["prompt"], "instances": instances}


def run() -> int:
    request_path = os.environ.get("GAMEFACTORY_SAM3_REQUEST")
    result_path = os.environ.get("GAMEFACTORY_SAM3_RESULT")
    if not request_path or not result_path:
        raise RuntimeError("GAMEFACTORY_SAM3_REQUEST and GAMEFACTORY_SAM3_RESULT are required")
    request = json.loads(Path(request_path).read_text(encoding="utf-8"))
    from sam3.model_builder import build_sam3_image_model
    from sam3.model.sam3_image_processor import Sam3Processor

    checkpoint = request.get("checkpointPath")
    model = build_sam3_image_model(
        device=request.get("device", "cuda"),
        checkpoint_path=checkpoint,
        load_from_HF=checkpoint is None,
    )
    jobs = [process_job(model, Sam3Processor, job) for job in request["jobs"]]
    result = {
        "provider": "meta",
        "model": request.get("model", "sam3"),
        "checkpoint": Path(checkpoint).name if checkpoint else "huggingface-gated",
        "jobs": jobs,
    }
    Path(result_path).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"jobs": len(jobs), "instances": sum(len(job["instances"]) for job in jobs)}))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--doctor", action="store_true")
    arguments = parser.parse_args()
    return doctor() if arguments.doctor else run()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        raise
