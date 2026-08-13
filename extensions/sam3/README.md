# SAM 3 extension

`gamefactory.sam3` keeps Meta SAM 3 and its Python/CUDA stack outside the factory kernel. It contributes:

- `agent:sam3.segment`, an agent driver that reads a candidate-local `sam3.request.json` and produces masks plus transparent cutouts;
- `engine:sam3.runtime`, a doctor-only runtime check for the configured worker.

The default bundled worker uses the official `sam3` Python package. It does not install Python, PyTorch, CUDA, checkpoints, or credentials. Install those separately in an isolated environment and authenticate with Hugging Face when using gated checkpoints. Campaigns that do not require this capability never activate or load it.

## Agent graph use

An earlier writer creates the source image and request. A graph node can then invoke the extension directly:

```json
{
  "id": "segment-concept-art",
  "adapter": "agent-driver",
  "driver": "sam3.segment",
  "role": "worker",
  "permissions": "write",
  "dependsOn": ["concept-artist"],
  "instructions": "Execute the candidate's segmentation request."
}
```

The campaign must activate both `agent:agent.team` and `agent:sam3.segment`. The default request path is `sam3.request.json`:

```json
{
  "apiVersion": "gamefactory.sam3/v1",
  "jobs": [
    {
      "id": "brass-fixtures",
      "sourcePath": "art/concept-sheet.png",
      "prompt": "brass eyelet or cleat",
      "outputDirectory": "assets/generated/brass-fixtures",
      "threshold": 0.55,
      "maxInstances": 12,
      "cropPaddingPixels": 8,
      "maskExpandPixels": 1,
      "maskFeatherPixels": 1
    }
  ]
}
```

Every output is canonical-path checked, hashed, and returned as an artifact. The worker report records the provider, model, checkpoint, prompt, confidence, bounding box, masks, cutouts, and post-processing parameters. SAM selects pixels; later image-editing or compositor agents remain responsible for generative modification, relighting, reconstruction of occluded edges, and engine assembly.

## Configuration

```json
{
  "parameters": {
    "sam3": {
      "requestPath": "sam3.request.json",
      "command": ["python", "{worker}"],
      "model": "sam3",
      "device": "cuda",
      "checkpointPath": "D:/models/sam3.pt",
      "timeoutSeconds": 900,
      "maxOutputCharacters": 30000,
      "environmentAllowlist": ["HF_TOKEN", "HF_HOME", "CUDA_VISIBLE_DEVICES"]
    }
  }
}
```

`checkpointPath` is optional. Without it, the official package resolves the gated checkpoint through Hugging Face. Secrets are inherited only by the worker process, are never copied into requests or traces, and their values are not recorded.
