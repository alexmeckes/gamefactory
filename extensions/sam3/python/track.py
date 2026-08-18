#!/usr/bin/env python3
"""SAM3 Video worker: decode MP4, track a text concept, write masks/cutouts."""
from __future__ import annotations
import json, os
from pathlib import Path

def main() -> None:
    import av
    import numpy as np
    import torch
    from PIL import Image
    from transformers import Sam3VideoModel, Sam3VideoProcessor
    request = json.loads(Path(os.environ["GAMEFACTORY_SAM3_VIDEO_REQUEST"]).read_text("utf-8"))
    device = request.get("device", "cuda")
    dtype = {"float32": torch.float32, "float16": torch.float16, "bfloat16": torch.bfloat16}[request.get("precision", "bfloat16")]
    source = request.get("modelSource", "facebook/sam3")
    processor = Sam3VideoProcessor.from_pretrained(source)
    tokenizer_limit = int(processor.tokenizer.model_max_length)
    for job in request["jobs"]:
        token_count = len(processor.tokenizer(job["prompt"], add_special_tokens=True)["input_ids"])
        if token_count > tokenizer_limit:
            raise ValueError(
                f"{job['id']}: text concept uses {token_count} tokens but {source} accepts at most "
                f"{tokenizer_limit}; use one short positive object description"
            )
    model = Sam3VideoModel.from_pretrained(source, torch_dtype=dtype, low_cpu_mem_usage=True).to(device).eval()
    results = []
    for job in request["jobs"]:
        container = av.open(job["sourcePath"])
        frames = [frame.to_image().convert("RGB") for frame in container.decode(video=0)][: int(job["maxFrames"])]
        container.close()
        if not frames: raise ValueError(f"{job['id']}: video decoded to zero frames")
        session = processor.init_video_session(video=frames, inference_device=device, processing_device="cpu", video_storage_device="cpu", dtype=dtype)
        processor.add_text_prompt(session, job["prompt"])
        output = Path(job["outputDirectory"]); output.mkdir(parents=True, exist_ok=True)
        output_frames = []
        with torch.inference_mode():
            for model_output in model.propagate_in_video_iterator(session, max_frame_num_to_track=len(frames), show_progress_bar=False):
                processed = processor.postprocess_outputs(session, model_output)
                index = int(model_output.frame_idx)
                masks = processed["masks"].detach().cpu().numpy()
                object_ids = [int(value) for value in processed["object_ids"].tolist()]
                scores = [float(value) for value in processed["scores"].tolist()]
                union = np.any(masks, axis=0) if len(masks) else np.zeros((frames[index].height, frames[index].width), dtype=bool)
                alpha = union.astype(np.uint8) * 255
                rgba = np.asarray(frames[index].convert("RGBA")).copy(); rgba[:, :, 3] = alpha
                stem = f"{index:06d}"; mask_path = output / f"{stem}.mask.png"; cutout_path = output / f"{stem}.cutout.png"
                Image.fromarray(alpha).save(mask_path); Image.fromarray(rgba).save(cutout_path)
                output_frames.append({"index": index, "objectIds": object_ids, "scores": scores, "maskPath": str(mask_path.resolve()), "cutoutPath": str(cutout_path.resolve())})
        results.append({"id": job["id"], "prompt": job["prompt"], "frames": output_frames})
        del session
        if torch.cuda.is_available(): torch.cuda.empty_cache()
    Path(os.environ["GAMEFACTORY_SAM3_VIDEO_RESULT"]).write_text(json.dumps({"provider": "huggingface-transformers", "model": source, "checkpoint": source, "jobs": results}, indent=2) + "\n", "utf-8")

if __name__ == "__main__": main()
